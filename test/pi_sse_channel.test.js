// D2 — the Pi SSE channel: replay-gap handling, reconnect dedup, buffer
// eviction under load.
//
// This is the channel that lets the UI reattach to a Pi run it was not watching
// — after a reload, a mode switch, or a dropped connection. Its whole job is to
// be correct across a disconnect, which is exactly the case nobody exercises by
// hand.
//
// Driven through the real domain with a fake `pi` that emits a controllable
// number of events, so eviction is reached honestly rather than simulated.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { promisify, TextDecoder } = require("util");

const createPiDomain = require("../routes/pi.js");

const mkdtemp = promisify(fs.mkdtemp);
const writeFile = promisify(fs.writeFile);

// Must match PI_EVENT_BUFFER_SIZE in routes/pi.js. Asserted against observed
// behaviour below, so a change there fails this file rather than silently
// weakening it.
const BUFFER_SIZE = 256;

function createHttpServer(domain) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, payload) => {
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    domain
      .handleRequest({ req, res, urlPath: url.pathname, send })
      .then((handled) => {
        if (!handled && !res.writableEnded) send(404, { error: "not found" });
      })
      .catch((error) => {
        if (!res.headersSent && !res.writableEnded) {
          send(error.statusCode || 500, { error: error.message });
        }
      });
  });
}

// A fake Pi whose prompt emits one text_delta per requested unit, so a single
// prompt can overflow the replay buffer.
async function makeFakePi(tempDir) {
  const commandPath = path.join(tempDir, "fake-pi-events");
  const source = String.raw`#!/usr/bin/env node
const readline = require("readline");
let currentSession = 0;
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function handle(command) {
  if (command.type === "prompt") {
    // "burst:N" emits N deltas before finishing.
    const match = /burst:(\d+)/.exec(String(command.message || ""));
    const count = match ? Number(match[1]) : 1;
    emit({ type: "agent_start" });
    for (let i = 1; i <= count; i += 1) {
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "d" + i + " " },
      });
    }
    emit({ type: "agent_end", willRetry: false });
    emit({ type: "agent_settled" });
    return;
  }
  if (command.type === "get_state") {
    emit({
      type: "response",
      ...(command.id ? { id: command.id } : {}),
      command: "get_state",
      data: {
        sessionFile: "/tmp/fake-pi-session.jsonl",
        model: { id: "fake/x", provider: "fake", input: ["text"], cost: {} },
        sessionId: String(currentSession),
        isStreaming: false,
      },
    });
    return;
  }
  if (command.type === "new_session") {
    currentSession += 1;
    emit({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId: String(currentSession) } });
    return;
  }
  emit({ type: "response", id: command.id, command: command.type, success: true, data: {} });
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  try {
    handle(JSON.parse(line));
  } catch (error) {
    emit({ type: "error", message: error.message });
  }
});
`;
  await writeFile(commandPath, source, { mode: 0o700 });
  fs.chmodSync(commandPath, 0o700);
  return commandPath;
}

function makeDeps({ tempDir, commandPath }) {
  const settings = {
    commandPath,
    workingDirectory: tempDir,
    timeoutMs: 5000,
    permissionPolicy: "confirm",
    toolOutputMaxChars: 4000,
  };
  return {
    DATA_DIR: tempDir,
    PORT: 0,
    PI_DEFAULT_SERVER_PORT: 0,
    PI_SESSION_TIMEOUT_MS: 30_000,
    PI_SESSION_SWEEP_INTERVAL_MS: 50,
    loadPiSettings: () => ({ ...settings }),
    savePiSettings: () => {},
    sanitizePiSettings: (value) => value,
    getPiCommand: () => commandPath,
    buildExecutablePath: (value) => value,
    getPiVersionSync: () => "fake-pi 1.0",
    parseJsonBody: async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      return text.trim() ? JSON.parse(text) : {};
    },
    createHttpError: (statusCode, message) =>
      Object.assign(new Error(message), { statusCode }),
    upsertConversation: () => {},
    persistAsyncWakeTurn: () => {},
    normalizeStoredConversationMessages: (history, message, images) => [
      ...(Array.isArray(history) ? history : []),
      { role: "user", content: message, images: images || [] },
    ],
    resolveAttachmentImages: () => [],
    extForImageMime: () => ".png",
    piAttachmentStageDir: () => tempDir,
    sweepPiAttachments: () => {},
    emitSlashCommand: () => {},
    getCommandMessage: (_command, message) => message,
    getLibraryRequestForCommand: () => ({ enabled: false, mode: "pi" }),
    serializeLibraryResults: (results) => results,
    getLibraryContextSourceResults: (context) => context.results || [],
    buildPiPromptWithLibraryContext: (message) => message,
    appendSecurityEvent: () => {},
    sanitizeTraceEventForStorage: (event) => event,
    openPathInFileManager: () => {},
    defaultPiSettings: settings,
  };
}

async function boot(t) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "dive-pi-sse-"));
  const commandPath = await makeFakePi(tempDir);
  const domain = createPiDomain(makeDeps({ tempDir, commandPath }));
  const server = createHttpServer(domain);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    domain.api.shutdownAll();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { baseUrl, domain };
}

// Run a prompt to completion over /api/pi/stream.
async function runPrompt(baseUrl, convId, message) {
  const res = await fetch(`${baseUrl}/api/pi/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      saveConv: convId,
      convTitle: "SSE",
      message,
      history: [],
      mode: "pi",
    }),
  });
  await res.text(); // drain to completion
}

// Subscribe, collect frames for `ms`, then disconnect. Returns parsed events
// plus the raw text, because the `id:` lines are part of the contract.
async function collect(baseUrl, convId, { after = 0, ms = 400, headers = {} }) {
  const controller = new AbortController();
  const url =
    after === null
      ? `${baseUrl}/api/pi/events?conv=${encodeURIComponent(convId)}`
      : `${baseUrl}/api/pi/events?conv=${encodeURIComponent(convId)}&after=${after}`;
  const res = await fetch(url, { headers, signal: controller.signal });
  assert.strictEqual(res.status, 200, `subscribe failed: ${res.status}`);

  let raw = "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const timeout = new Promise((r) =>
        setTimeout(
          () => r({ done: true, timedOut: true }),
          deadline - Date.now(),
        ),
      );
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.timedOut) break;
      if (chunk.done) break;
      raw += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    controller.abort();
  }

  const events = [];
  for (const frame of raw.split("\n\n")) {
    const line = frame.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(6)));
    } catch (_e) {
      events.push({ type: "__unparsed__", raw: line });
    }
  }
  return { events, raw, headers: res.headers };
}

test("the channel replays a completed run to a client that was never attached", async (t) => {
  const { baseUrl } = await boot(t);
  await runPrompt(baseUrl, "replay-basic", "burst:5");

  const { events, raw } = await collect(baseUrl, "replay-basic", { after: 0 });
  const deltas = events.filter((e) => e.type !== "__unparsed__" && e.sequence);
  assert.ok(
    deltas.length > 0,
    `nothing was replayed to a fresh subscriber; raw: ${raw.slice(0, 200)}`,
  );
  assert.ok(
    deltas.every((e) => e.replay === true),
    "buffered events were not marked as replays",
  );
  // Every replayed frame carries an id: line, or EventSource cannot resume.
  assert.ok(
    /^id: \d+$/m.test(raw),
    "replayed frames carry no id:, so Last-Event-ID resume is impossible",
  );
  // Sequences are strictly increasing.
  const seqs = deltas.map((e) => e.sequence);
  assert.deepStrictEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
    "replayed sequences are out of order",
  );
  assert.strictEqual(new Set(seqs).size, seqs.length, "replay contains dupes");
});

test("reconnecting with ?after= delivers only what the client has not seen", async (t) => {
  const { baseUrl } = await boot(t);
  await runPrompt(baseUrl, "dedup", "burst:8");

  const first = await collect(baseUrl, "dedup", { after: 0 });
  const seen = first.events.filter((e) => e.sequence).map((e) => e.sequence);
  assert.ok(seen.length >= 2, `expected several events, got ${seen.length}`);

  const cut = seen[Math.floor(seen.length / 2)];
  const second = await collect(baseUrl, "dedup", { after: cut });
  const redelivered = second.events
    .filter((e) => e.sequence && e.type !== "replay_gap")
    .map((e) => e.sequence);

  assert.ok(
    redelivered.every((s) => s > cut),
    `reconnect redelivered events at or before ${cut}: ${redelivered.filter((s) => s <= cut).join(", ")}`,
  );
  assert.deepStrictEqual(
    redelivered,
    seen.filter((s) => s > cut),
    "reconnect did not deliver exactly the unseen tail",
  );
});

test("Last-Event-ID resumes the same way as ?after=", async (t) => {
  // EventSource sends the header, not the query parameter, so both must work.
  const { baseUrl } = await boot(t);
  await runPrompt(baseUrl, "resume-header", "burst:8");

  const all = await collect(baseUrl, "resume-header", { after: 0 });
  const seen = all.events.filter((e) => e.sequence).map((e) => e.sequence);
  const cut = seen[Math.floor(seen.length / 2)];

  const viaHeader = await collect(baseUrl, "resume-header", {
    after: null,
    headers: { "last-event-id": String(cut) },
  });
  const got = viaHeader.events
    .filter((e) => e.sequence && e.type !== "replay_gap")
    .map((e) => e.sequence);
  assert.ok(
    got.every((s) => s > cut),
    `Last-Event-ID was ignored: got ${got.slice(0, 5).join(", ")} after ${cut}`,
  );
});

test("a malformed resume position is treated as a fresh subscribe, not a crash", async (t) => {
  const { baseUrl } = await boot(t);
  await runPrompt(baseUrl, "bad-after", "burst:3");

  for (const bad of ["abc", "-1", "9e99", "", "NaN"]) {
    const res = await fetch(
      `${baseUrl}/api/pi/events?conv=bad-after&after=${encodeURIComponent(bad)}`,
      { signal: AbortSignal.timeout(300) },
    ).catch((error) => {
      // The timeout abort is expected; anything else is a real failure.
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        return { status: 200 };
      }
      throw error;
    });
    assert.strictEqual(res.status, 200, `after=${bad} was not handled`);
  }
});

test("the replay buffer is bounded, and the client is told what it lost", async (t) => {
  // The load case. One prompt emits far more events than the buffer holds, so
  // the early ones are evicted. A client resuming from a position that has
  // fallen out of the buffer must be told — silently sending only the tail
  // would leave a hole in the transcript that nothing ever repairs.
  const { baseUrl } = await boot(t);
  await runPrompt(baseUrl, "evict", `burst:${BUFFER_SIZE * 2}`);

  const fresh = await collect(baseUrl, "evict", { after: 0, ms: 700 });
  const buffered = fresh.events.filter(
    (e) => e.sequence && e.type !== "replay_gap",
  );
  assert.ok(
    buffered.length > 0 && buffered.length <= BUFFER_SIZE,
    `the buffer held ${buffered.length} events; the cap is ${BUFFER_SIZE}`,
  );

  const oldest = buffered[0].sequence;
  assert.ok(
    oldest > 1,
    `nothing was evicted after ${BUFFER_SIZE * 2} events (oldest is ${oldest}); this test is not exercising eviction`,
  );

  // Resume from sequence 1, which has certainly been evicted.
  const stale = await collect(baseUrl, "evict", { after: 1, ms: 700 });
  const gap = stale.events.find((e) => e.type === "replay_gap");
  assert.ok(
    gap,
    "a client resuming from an evicted position was not told it had missed events",
  );
  assert.ok(
    gap.oldestSequence > 2,
    `replay_gap reported oldestSequence ${gap.oldestSequence}, which is not past the resume point`,
  );
});

test("a client that is fully caught up is not told it missed anything", async (t) => {
  // The other half of the gap contract: a false gap makes the UI refetch the
  // whole conversation for nothing, on every reconnect.
  const { baseUrl } = await boot(t);
  await runPrompt(baseUrl, "nogap", "burst:5");

  const all = await collect(baseUrl, "nogap", { after: 0 });
  const seqs = all.events.filter((e) => e.sequence).map((e) => e.sequence);
  const latest = seqs[seqs.length - 1];

  const resumed = await collect(baseUrl, "nogap", { after: latest });
  assert.ok(
    !resumed.events.some((e) => e.type === "replay_gap"),
    "an up-to-date client was told it had missed events",
  );
});
