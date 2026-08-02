"use strict";

// Self-contained utility skills: arithmetic, the local notes file, time/date,
// the in-memory task plan, and the general HTTP client.
//
// http_request lives here rather than with the research skills because it is a
// generic client the model drives directly, not part of a research flow — but
// it shares the SSRF guard with them, which is why that guard is its own module.
//
// Moved out of skills.js unchanged.

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const {
  MAX_REDIRECTS,
  REQUEST_TIMEOUT_MS,
  assertUrlAllowed,
} = require("./sandbox.js");

const vm = require("vm");

async function executeCalculator({ expression }) {
  try {
    if (!/^[0-9+\-*/().\s]*$/.test(expression)) {
      return "Error: Expression contains invalid characters.";
    }
    const result = vm.runInNewContext(expression, Object.create(null), {
      timeout: 1000,
    });
    return `Result: ${result}`;
  } catch (e) {
    return `Calculator Error: ${e.message}`;
  }
}

// Notes live as individual Markdown files in DATA_DIR/notes. The skill
// targets the note currently open in the Notes panel (DATA_DIR/notes/.active),
// falling back to "Notes", so "add this to my notes" lands where the user is
// looking. The legacy single-note notes.json is read as a last resort.
function resolveActiveNoteFile(DATA_DIR) {
  const notesDir = path.join(DATA_DIR, "notes");
  let name = "";
  try {
    name = fs
      .readFileSync(path.join(notesDir, ".active"), "utf8")
      .trim()
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
  } catch {
    name = "";
  }
  if (!name) name = "Notes";
  const filePath = path.join(notesDir, `${name}.md`);
  if (!filePath.startsWith(notesDir + path.sep)) {
    return {
      notesDir,
      name: "Notes",
      filePath: path.join(notesDir, "Notes.md"),
    };
  }
  return { notesDir, name, filePath };
}

async function executeLocalNotes({ action, content }, DATA_DIR) {
  const { notesDir, name, filePath } = resolveActiveNoteFile(DATA_DIR);
  let currentText = "";
  try {
    if (fs.existsSync(filePath)) {
      currentText = fs.readFileSync(filePath, "utf8");
    } else {
      // Legacy fallback: the old single-note blob.
      const legacyFile = path.join(DATA_DIR, "notes.json");
      if (fs.existsSync(legacyFile)) {
        const raw = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
        currentText = raw.text || "";
      }
    }
  } catch (e) {}

  if (action === "read") {
    return currentText
      ? `[Note: ${name}]\n\n${currentText}`
      : "Your notes are currently empty.";
  } else if (action === "append") {
    if (!content) return "Error: Content is required for append action.";
    const newText = currentText ? `${currentText}\n\n${content}` : content;
    fs.mkdirSync(notesDir, { recursive: true });
    fs.writeFileSync(filePath, newText, "utf8");
    return `Successfully appended to your note "${name}".`;
  }
  return "Error: Invalid action. Use 'read' or 'append'.";
}

async function executeTimeAndDate({ timezone } = {}) {
  const now = new Date();
  try {
    const timeOpts = timezone ? { timeZone: timezone } : {};
    const localTime = now.toLocaleTimeString("en-US", timeOpts);
    const localDate = now.toLocaleDateString("en-US", timeOpts);
    const dayOfWeek = now.toLocaleDateString("en-US", {
      ...timeOpts,
      weekday: "long",
    });
    return `Current time${timezone ? " in " + timezone : ""}: ${localTime}\nCurrent date: ${localDate}\nDay of the week: ${dayOfWeek}`;
  } catch (e) {
    return `Error: Invalid timezone '${timezone}'. Please use a standard IANA Time Zone string (e.g., 'Australia/Sydney', 'Europe/Paris', 'America/New_York').`;
  }
}

const TASK_PLANS = new Map();

const TASK_PLAN_TTL_MS = 2 * 60 * 60 * 1000;

const TASK_PLAN_MAX_PLANS = 50;

const TASK_PLAN_STATUSES = new Set(["pending", "done", "failed", "skipped"]);

function pruneTaskPlans() {
  const now = Date.now();
  for (const [id, plan] of TASK_PLANS) {
    if (now - plan.updatedAt > TASK_PLAN_TTL_MS) TASK_PLANS.delete(id);
  }
  while (TASK_PLANS.size > TASK_PLAN_MAX_PLANS) {
    const oldest = [...TASK_PLANS.entries()].sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    )[0];
    TASK_PLANS.delete(oldest[0]);
  }
}

function renderTaskPlan(id, plan) {
  const marks = { pending: "[ ]", done: "[x]", failed: "[!]", skipped: "[-]" };
  const lines = plan.steps.map(
    (step, i) =>
      `${marks[step.status]} ${i + 1}. ${step.text}${step.note ? ` — ${step.note}` : ""}`,
  );
  const doneCount = plan.steps.filter((s) => s.status !== "pending").length;
  return `Plan ${id} (${doneCount}/${plan.steps.length} steps resolved):\n${lines.join("\n")}`;
}

function executeTaskPlan({ action, plan_id, steps, step, status, note }) {
  pruneTaskPlans();
  const act = ["create", "update", "show"].includes(action) ? action : null;
  if (!act) return "Task Plan Error: action must be create, update, or show.";

  if (act === "create") {
    const list = (Array.isArray(steps) ? steps : [])
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .slice(0, 20);
    if (!list.length) {
      return "Task Plan Error: create needs steps (an array of short step descriptions).";
    }
    const id = `plan-${Math.random().toString(36).slice(2, 7)}`;
    const plan = {
      steps: list.map((text) => ({ text, status: "pending", note: "" })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    TASK_PLANS.set(id, plan);
    return `${renderTaskPlan(id, plan)}\n\nWork through the steps in order. After finishing each one, call task_plan with action:"update", plan_id:"${id}", the step number, and status done/failed/skipped.`;
  }

  const id = String(plan_id || "").trim();
  const plan = TASK_PLANS.get(id);
  if (!plan) {
    return `Task Plan Error: no plan "${id}" (it may have expired). Create a new one with action:"create".`;
  }

  if (act === "show") return renderTaskPlan(id, plan);

  const index = Number(step) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= plan.steps.length) {
    return `Task Plan Error: step must be 1-${plan.steps.length}.`;
  }
  const newStatus = TASK_PLAN_STATUSES.has(status) ? status : "done";
  plan.steps[index].status = newStatus;
  if (note && String(note).trim()) {
    plan.steps[index].note = String(note).trim().slice(0, 200);
  }
  plan.updatedAt = Date.now();
  const remaining = plan.steps.filter((s) => s.status === "pending").length;
  return `${renderTaskPlan(id, plan)}\n\n${remaining === 0 ? "All steps resolved — write the final answer now." : `${remaining} step(s) remaining.`}`;
}

const HTTP_SESSION_JARS = new Map();

const HTTP_BODY_MAX_CHARS = 8000;

function jarFor(session, host) {
  if (!HTTP_SESSION_JARS.has(session))
    HTTP_SESSION_JARS.set(session, new Map());
  const byHost = HTTP_SESSION_JARS.get(session);
  if (!byHost.has(host)) byHost.set(host, new Map());
  return byHost.get(host);
}

function storeSetCookies(jar, setCookieHeaders) {
  for (const raw of setCookieHeaders || []) {
    const pair = String(raw).split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeaderFrom(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// One raw request; resolves { statusCode, headers, body } with the body
// decompressed. Does NOT follow redirects itself — the caller does, so each
// hop's Set-Cookie lands in the jar.
function rawHttpRequest(url, { method, headers, body, timeout }) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.request(url, { method, headers }, (res) => {
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () =>
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      stream.on("error", reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function executeHttpRequest({
  url,
  method = "GET",
  headers = {},
  body,
  timeout_ms,
  follow_redirects = true,
  session,
}) {
  try {
    const verb = String(method || "GET").toUpperCase();
    if (
      !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
        verb,
      )
    ) {
      return `HTTP Request Error: unsupported method "${method}".`;
    }
    const timeout = Math.max(
      1000,
      Math.min(Number(timeout_ms) || REQUEST_TIMEOUT_MS, 60000),
    );
    const sessionName =
      typeof session === "string" && session.trim() ? session.trim() : "";
    let currentUrl = url;
    let payload =
      body === undefined || body === null
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    let response = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const guardError = await assertUrlAllowed(currentUrl);
      if (guardError) return `HTTP Request Error: ${guardError}`;
      const host = new URL(currentUrl).hostname.toLowerCase();
      const jar = sessionName ? jarFor(sessionName, host) : null;
      const reqHeaders = {
        "User-Agent": "Dive-Agent/1.0",
        "Accept-Encoding": "gzip, deflate, br",
        ...(headers && typeof headers === "object" ? headers : {}),
      };
      if (
        payload !== undefined &&
        !("Content-Type" in reqHeaders) &&
        !("content-type" in reqHeaders)
      ) {
        reqHeaders["Content-Type"] =
          typeof body === "object" ? "application/json" : "text/plain";
      }
      if (jar && jar.size && !reqHeaders.Cookie && !reqHeaders.cookie) {
        reqHeaders.Cookie = cookieHeaderFrom(jar);
      }
      response = await rawHttpRequest(currentUrl, {
        method: verb,
        headers: reqHeaders,
        body: payload,
        timeout,
      });
      if (jar) storeSetCookies(jar, response.headers["set-cookie"]);
      const isRedirect =
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location;
      if (!isRedirect || follow_redirects === false) break;
      if (hop === MAX_REDIRECTS)
        return "HTTP Request Error: too many redirects.";
      currentUrl = new URL(response.headers.location, currentUrl).toString();
      // Per HTTP semantics, redirects after POST are re-requested as GET.
      if (verb !== "GET" && verb !== "HEAD") payload = undefined;
    }
    const shownHeaders = {};
    for (const key of [
      "content-type",
      "content-length",
      "location",
      "retry-after",
      "x-ratelimit-remaining",
      "www-authenticate",
    ]) {
      if (response.headers[key]) shownHeaders[key] = response.headers[key];
    }
    let bodyText = String(response.body || "");
    const contentType = String(response.headers["content-type"] || "");
    if (/json/i.test(contentType)) {
      try {
        bodyText = JSON.stringify(JSON.parse(bodyText), null, 2);
      } catch {
        /* leave the body as-is */
      }
    }
    if (bodyText.length > HTTP_BODY_MAX_CHARS) {
      bodyText =
        bodyText.slice(0, HTTP_BODY_MAX_CHARS) + "\n... [BODY TRUNCATED]";
    }
    let out = `HTTP ${response.statusCode} — ${verb} ${currentUrl}\n`;
    out += `Headers: ${JSON.stringify(shownHeaders)}\n`;
    if (sessionName) {
      out += `Cookie session: "${sessionName}" (cookies persist across http_request calls with this session name)\n`;
    }
    out += `\n${bodyText || "(empty body)"}`;
    return out;
  } catch (e) {
    return `HTTP Request Error: ${e.message}`;
  }
}

module.exports = {
  executeCalculator,
  executeLocalNotes,
  executeTimeAndDate,
  executeTaskPlan,
  executeHttpRequest,
  resolveActiveNoteFile,
  pruneTaskPlans,
  TASK_PLANS,
  renderTaskPlan,
  TASK_PLAN_STATUSES,
  jarFor,
  cookieHeaderFrom,
  rawHttpRequest,
  storeSetCookies,
  HTTP_BODY_MAX_CHARS,
  TASK_PLAN_TTL_MS,
  TASK_PLAN_MAX_PLANS,
  HTTP_SESSION_JARS,
};
