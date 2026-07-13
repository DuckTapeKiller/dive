// Skills domain routes: custom skills, per-mode skill toggles, MCP server
// config/purge, and the book_search provider credentials. The skills config
// helpers stay in server.js because the chat handlers consult them on every
// request.
const fs = require("fs");
const os = require("os");
const path = require("path");

module.exports = function createSkillsDomain(deps) {
  const {
    DATA_DIR,
    parseJsonBody,
    loadCustomSkills,
    saveCustomSkills,
    loadSkillsConfig,
    saveSkillsConfig,
    defaultSkillsConfig,
    initMcpServers,
  } = deps;

  async function handleRequest(ctx) {
    const { req, urlPath, send } = ctx;

    if (req.method === "GET" && urlPath === "/api/custom-skills") {
      send(200, loadCustomSkills());
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/mcp/config") {
      try {
        const body = await parseJsonBody(req);
        const servers = await initMcpServers(body.config);
        send(200, { success: true, servers: servers || [] });
      } catch (e) {
        send(500, { error: e.message });
      }
      return true;
    }

    // Stop all MCP servers and delete everything they downloaded. The
    // download locations are the absolute paths in each server's env (npm
    // cache, browser downloads, memory file). Only paths nested at least two
    // levels under the user's home are deleted, so a stray "/" or "~" can
    // never be wiped.
    if (req.method === "POST" && urlPath === "/api/mcp/purge") {
      try {
        const body = await parseJsonBody(req);
        await initMcpServers("");
        const removed = [];
        let config = null;
        try {
          config = JSON.parse(
            typeof body.config === "string" ? body.config : "",
          );
        } catch (_e) {
          config = null;
        }
        const home = os.homedir();
        const candidates = new Set();
        if (config && config.mcpServers) {
          for (const server of Object.values(config.mcpServers)) {
            const env =
              server && typeof server.env === "object" && server.env
                ? server.env
                : {};
            for (const value of Object.values(env)) {
              if (typeof value === "string" && path.isAbsolute(value.trim())) {
                candidates.add(value.trim());
              }
            }
          }
        }
        for (const candidate of candidates) {
          const resolved = path.resolve(candidate);
          if (!resolved.startsWith(home + path.sep)) continue;
          const rel = path.relative(home, resolved);
          if (!rel || rel.split(path.sep).length < 2) continue;
          try {
            fs.rmSync(resolved, { recursive: true, force: true });
            removed.push(resolved);
          } catch (e) {
            console.error(`[MCP] Could not delete ${resolved}:`, e.message);
          }
        }
        send(200, { ok: true, removed });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/custom-skills") {
      try {
        const body = await parseJsonBody(req);
        if (!Array.isArray(body)) {
          send(400, { error: "Custom skills must be an array" });
          return true;
        }
        const valid = body.every(
          (s) =>
            s &&
            typeof s.name === "string" &&
            typeof s.description === "string" &&
            typeof s.type === "string" &&
            typeof s.code === "string",
        );
        if (!valid) {
          send(400, { error: "Invalid custom skill structure" });
          return true;
        }
        saveCustomSkills(body);
        send(200, { ok: true });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/book-search/config") {
      try {
        const file = path.join(DATA_DIR, "book-search.json");
        const cfg = fs.existsSync(file)
          ? JSON.parse(fs.readFileSync(file, "utf8"))
          : {};
        send(200, { config: cfg && typeof cfg === "object" ? cfg : {} });
      } catch (e) {
        send(500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/book-search/config") {
      try {
        const body = await parseJsonBody(req);
        const raw = body?.config;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          send(400, { error: "Config object is required" });
          return true;
        }
        const clean = {};
        for (const key of [
          "googleApiKey",
          "hardcoverToken",
          "librarythingToken",
          "calibreServerUrl",
          "calibreLibraryId",
        ]) {
          if (typeof raw[key] === "string" && raw[key].trim()) {
            clean[key] = raw[key].trim();
          }
        }
        const file = path.join(DATA_DIR, "book-search.json");
        fs.writeFileSync(file, JSON.stringify(clean, null, 2), {
          mode: 0o600,
        });
        send(200, { ok: true, config: clean });
      } catch (e) {
        send(500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/ollama/skills/settings") {
      send(200, loadSkillsConfig());
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/ollama/skills/settings") {
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          send(400, { error: "Settings object is required" });
          return true;
        }

        const VALID_SKILL_KEYS = new Set(Object.keys(defaultSkillsConfig()));
        const filtered = Object.fromEntries(
          Object.entries(body).filter(([k]) => VALID_SKILL_KEYS.has(k)),
        );
        const nextSettings = { ...loadSkillsConfig(), ...filtered };

        saveSkillsConfig(nextSettings);
        send(200, { ok: true, settings: nextSettings });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    return false;
  }

  return { handleRequest };
};
