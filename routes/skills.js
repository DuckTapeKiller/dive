// Skills domain routes: custom skills, per-mode skill toggles, MCP server
// config/purge, and the book_search provider credentials. The skills config
// helpers stay in server.js because the chat handlers consult them on every
// request.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PLUGINS_DIR, listPlugins, loadPlugins } = require("../plugins.js");
const { requireNonPiMode } = require("../mode-state.js");

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
    stopMcpServers,
  } = deps;

  function requestMode(ctx, body = null) {
    const fromBody = body && typeof body.mode === "string" ? body.mode : null;
    const fromQuery = ctx.requestUrl?.searchParams?.get("mode") || null;
    return requireNonPiMode(fromBody || fromQuery || undefined);
  }

  async function handleRequest(ctx) {
    const { req, urlPath, send } = ctx;

    if (req.method === "GET" && urlPath === "/api/plugins") {
      try {
        const mode = requestMode(ctx);
        send(200, { mode, directory: PLUGINS_DIR, plugins: listPlugins() });
      } catch (e) {
        send(e.statusCode || 400, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/plugins/reload") {
      try {
        const body = await parseJsonBody(req);
        const mode = requestMode(ctx, body);
        const plugins = loadPlugins();
        send(200, { ok: true, mode, directory: PLUGINS_DIR, plugins });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    // Model-drafted plugins awaiting human approval. Drafts live in
    // DATA_DIR/plugin-drafts and are inert until approved (moved into the
    // live plugins directory) by the user.
    if (req.method === "GET" && urlPath === "/api/plugins/drafts") {
      const draftsDir = path.join(DATA_DIR, "plugin-drafts");
      const drafts = [];
      try {
        for (const entry of fs.readdirSync(draftsDir, {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory()) continue;
          const dir = path.join(draftsDir, entry.name);
          let manifest = {};
          try {
            manifest = JSON.parse(
              fs.readFileSync(path.join(dir, "plugin.json"), "utf8"),
            );
          } catch (_e) {
            // A draft without a manifest still lists, with empty metadata.
          }
          let code = "";
          try {
            code = fs.readFileSync(path.join(dir, "index.js"), "utf8");
          } catch (_e) {
            // Listed with no code rather than hidden, so the user can delete it.
          }
          drafts.push({
            name: entry.name,
            description: manifest.description || "",
            draftedAt: manifest.draftedAt || "",
            code,
          });
        }
      } catch (_e) {
        // No drafts directory yet, or it is unreadable: report an empty list.
      }
      send(200, { drafts });
      return true;
    }

    if (
      req.method === "POST" &&
      (urlPath === "/api/plugins/drafts/approve" ||
        urlPath === "/api/plugins/drafts/delete")
    ) {
      try {
        const body = await parseJsonBody(req);
        const name = String(body?.name || "").replace(/[^a-z0-9-]/g, "");
        if (!name) {
          send(400, { error: "Draft name required" });
          return true;
        }
        const draftDir = path.join(DATA_DIR, "plugin-drafts", name);
        if (!fs.existsSync(draftDir)) {
          send(404, { error: "Draft not found" });
          return true;
        }
        if (urlPath.endsWith("/approve")) {
          const target = path.join(PLUGINS_DIR, name);
          if (fs.existsSync(target)) {
            send(409, { error: `A plugin named "${name}" already exists.` });
            return true;
          }
          fs.mkdirSync(PLUGINS_DIR, { recursive: true });
          fs.renameSync(draftDir, target);
          loadPlugins();
          send(200, { ok: true, approved: name, plugins: listPlugins() });
        } else {
          fs.rmSync(draftDir, { recursive: true, force: true });
          send(200, { ok: true, deleted: name });
        }
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/custom-skills") {
      try {
        const mode = requestMode(ctx);
        send(200, { mode, skills: loadCustomSkills(mode) });
      } catch (e) {
        send(e.statusCode || 400, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/mcp/config") {
      try {
        const body = await parseJsonBody(req);
        const mode = requestMode(ctx, body);
        const servers = await initMcpServers(mode, body.config ?? "");
        send(200, { success: true, mode, servers: servers || [] });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
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
        const mode = requestMode(ctx, body);
        await stopMcpServers(mode);
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
        const mode = requestMode(ctx, body);
        const skills = body?.skills;
        if (!Array.isArray(skills)) {
          send(400, { error: "Custom skills must be an array" });
          return true;
        }
        const valid = skills.every(
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
        saveCustomSkills(skills, mode);
        send(200, { ok: true, mode, skills });
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
      try {
        const mode = requestMode(ctx);
        send(200, { mode, settings: loadSkillsConfig(mode) });
      } catch (e) {
        send(e.statusCode || 400, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/ollama/skills/settings") {
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          send(400, { error: "Settings object is required" });
          return true;
        }
        const mode = requestMode(ctx, body);
        const submittedSettings = body.settings;
        if (
          !submittedSettings ||
          typeof submittedSettings !== "object" ||
          Array.isArray(submittedSettings)
        ) {
          send(400, { error: "settings object is required" });
          return true;
        }

        const VALID_SKILL_KEYS = new Set(Object.keys(defaultSkillsConfig()));
        for (const plugin of listPlugins()) {
          for (const skillName of plugin.skills)
            VALID_SKILL_KEYS.add(skillName);
        }
        const filtered = Object.fromEntries(
          Object.entries(submittedSettings).filter(([k]) =>
            VALID_SKILL_KEYS.has(k),
          ),
        );
        const nextSettings = { ...loadSkillsConfig(mode), ...filtered };

        saveSkillsConfig(nextSettings, mode);
        send(200, { ok: true, mode, settings: nextSettings });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    return false;
  }

  return { handleRequest };
};
