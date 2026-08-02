// Saved-prompt storage and routes. Prompts are a flat JSON array in
// DATA_DIR/prompts.json; the client injects their content into chats.
const fs = require("fs");
const path = require("path");
const { lessonsFilePath } = require("../skills.js");
const { DIVE_SKILL_MODE_IDS } = require("../assets/js/00-modes.js");

module.exports = function createPromptsDomain(deps) {
  const { DATA_DIR, parseJsonBody } = deps;
  const PROMPTS_FILE = path.join(DATA_DIR, "prompts.json");

  function loadPrompts() {
    const RESERVED_PROMPT_IDS = new Set(["custom-assistant", "english-editor"]);

    const maybeNormalizePrompts = (prompts) => {
      if (!Array.isArray(prompts)) return [];
      const next = prompts
        .filter(
          (p) =>
            p &&
            typeof p.id === "string" &&
            typeof p.name === "string" &&
            typeof p.content === "string",
        )
        .filter((p) => !RESERVED_PROMPT_IDS.has(p.id))
        .map((p) => ({ ...p }));
      return next;
    };

    try {
      if (fs.existsSync(PROMPTS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(PROMPTS_FILE, "utf8"));
        const normalized = maybeNormalizePrompts(raw);
        if (Array.isArray(raw) && raw.length !== normalized.length) {
          savePrompts(normalized);
        }
        return normalized;
      }
    } catch (e) {
      console.warn("Failed to load prompts:", e.message || e);
    }

    savePrompts([]);
    return [];
  }

  function savePrompts(prompts) {
    try {
      fs.writeFileSync(PROMPTS_FILE, JSON.stringify(prompts, null, 2));
    } catch (e) {
      console.error("Failed to save prompts:", e);
    }
  }

  // Lessons are strictly per-mode files under DATA_DIR/lessons. The path and
  // the unknown-mode fallback live in skills.js, which also writes them.
  const lessonsFileForMode = (mode) => lessonsFilePath(DATA_DIR, mode);

  async function handleRequest(ctx) {
    const { req, urlPath, requestUrl, send } = ctx;

    if (req.method === "GET" && urlPath === "/api/lessons") {
      const mode = requestUrl?.searchParams?.get("mode") || "ollama";
      const file = lessonsFileForMode(mode);
      let text = "";
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        text = "";
      }
      send(200, { mode, text, path: file, modes: DIVE_SKILL_MODE_IDS });
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/lessons") {
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body.text !== "string") {
          send(400, { error: "text field required" });
          return true;
        }
        const file = lessonsFileForMode(
          typeof body.mode === "string" ? body.mode : "ollama",
        );
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body.text.slice(0, 100000), "utf8");
        send(200, { ok: true });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/prompts") {
      send(200, loadPrompts());
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/prompts") {
      try {
        const body = await parseJsonBody(req);
        if (!Array.isArray(body)) {
          send(400, { error: "Prompts must be an array" });
          return true;
        }
        const valid = body.every(
          (p) =>
            p &&
            typeof p.id === "string" &&
            typeof p.name === "string" &&
            typeof p.content === "string",
        );
        if (!valid) {
          send(400, { error: "Invalid prompt structure" });
          return true;
        }
        savePrompts(body);
        send(200, { ok: true });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    return false;
  }

  return { handleRequest };
};
