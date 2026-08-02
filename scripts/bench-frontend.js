#!/usr/bin/env node
"use strict";

// Measures the two client render paths Phase 7 was about, so the decision to
// optimise (or not) rests on numbers rather than intuition.
//
//   renderMode()               a full mode-switch repaint
//   renderSessionTranscript()  a full transcript rebuild, at several lengths
//
// Runs in jsdom, which is markedly slower at DOM work than a real browser, so
// these are pessimistic: whatever is fast here is faster in Chrome.
//
// Run: npm run bench

const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const ROOT = path.join(__dirname, "..");
process.chdir(ROOT);

const VENDOR = {
  "marked.umd.js": "node_modules/marked/marked.min.js",
  "purify.min.js": "node_modules/dompurify/dist/purify.min.js",
  "highlight.min.js": "node_modules/@highlightjs/cdn-assets/highlight.min.js",
};

const html = fs
  .readFileSync("index.html", "utf8")
  .replace(
    /<script src="\/assets\/(js\/[^"]+)"><\/script>/g,
    (_m, rel) => `<script>${fs.readFileSync(`assets/${rel}`, "utf8")}</script>`,
  )
  .replace(/<script src="\/vendor\/([^"]+)"><\/script>/g, (_m, name) => {
    const file = VENDOR[name];
    return file && fs.existsSync(file)
      ? `<script>${fs.readFileSync(file, "utf8")}</script>`
      : "";
  });

const json = (body) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

function stubFetch(url) {
  const { pathname } = new URL(
    String(url).replace("http://localhost", ""),
    "http://localhost",
  );
  if (pathname === "/api/prompts") return json([]);
  if (pathname === "/api/version") return json({ version: "1.0.5" });
  if (pathname === "/api/custom-skills") {
    return json({ mode: "ollama", skills: [] });
  }
  if (pathname === "/api/ollama/skills/settings") {
    return json({ mode: "ollama", settings: {} });
  }
  return json({});
}

async function main() {
  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.fetch = stubFetch;
      window.alert = () => {};
      window.scrollTo = () => {};
    },
  });
  const w = dom.window;
  await new Promise((r) => setTimeout(r, 700));

  const bench = (label, code, runs = 5) => {
    const times = [];
    for (let i = 0; i < runs; i++) {
      const started = process.hrtime.bigint();
      w.eval(code);
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(runs / 2)];
    console.log(
      `  ${label.padEnd(44)} median ${median.toFixed(1).padStart(6)} ms   max ${times.at(-1).toFixed(1)} ms`,
    );
  };

  console.log("\nmode switch");
  bench("renderMode()", 'renderMode("ollama")');

  console.log("\nfull transcript rebuild");
  for (const n of [10, 50, 100, 200, 400]) {
    w.eval(`
      const s = getActiveModeSession("ollama");
      s.convId = "bench";
      s.history = Array.from({ length: ${n} }, (_, i) =>
        i % 2 === 0
          ? { role: "user", content: "question number " + i }
          : { role: "assistant", content: "An answer with **markdown**, a list:\\n- one\\n- two\\n\\n\`\`\`js\\nconst x = " + i + ";\\n\`\`\`\\n" });
    `);
    bench(
      `renderSessionTranscript(), ${String(n).padStart(3)} messages`,
      'renderSessionTranscript(getActiveModeSession("ollama"))',
    );
  }

  const nodes = w.eval(
    'document.getElementById("chat").querySelectorAll("*").length',
  );
  console.log(`\n  DOM nodes after 400 messages: ${nodes}`);
  console.log(
    "\n  For reference, one 60fps frame is 16.7 ms. Streaming does not take\n" +
      "  these paths: it updates the single draft bubble via setDraftAssistant.\n",
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
