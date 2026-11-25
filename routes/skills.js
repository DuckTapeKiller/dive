// Skills domain routes: custom skills, per-mode skill toggles, MCP server
// config/purge, and the book_search provider credentials. The skills config
// helpers stay in server.js because the chat handlers consult them on every
// request.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PLUGINS_DIR, listPlugins, loadPlugins } = require("../plugins.js");
const {
  checkForUpdate,
  installPlugin,
  pluginSource,
  updatePlugin,
} = require("../plugin-sources.js");

// The plugins as listed, each with where it comes from (`origin`: the
// repository its folder is a clone of, or null). Local only, no network.
async function pluginsWithSources() {
  return Promise.all(
    listPlugins().map(async (plugin) => ({
      ...plugin,
      origin: pluginFolder(plugin) ? await pluginSource(plugin.source) : null,
    })),
  );
}

// A plugin's folder when it is one directly inside the plugins directory, or
// "" (a single-file plugin, or anything that is not where it should be).
function pluginFolder(plugin) {
  const source =
    plugin && typeof plugin.source === "string" ? plugin.source : "";
  if (!source) return "";
  const resolved = path.resolve(source);
  return path.dirname(resolved) === path.resolve(PLUGINS_DIR) &&
    fs.existsSync(resolved) &&
    fs.statSync(resolved).isDirectory()
    ? resolved
    : "";
}

function findPluginByName(name) {
  return listPlugins().find((plugin) => plugin.name === name) || null;
}
const { requireNonPiMode } = require("../mode-state.js");
const { INPUT_SKILL_NAMES } = require("../slash_commands.js");
const {
  describeAgentSkills,
  saveConfiguredSkillPaths,
  scanAgentSkills,
  skillConfigKey,
} = require("../agent-skills.js");

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
        send(200, {
          mode,
          directory: PLUGINS_DIR,
          plugins: await pluginsWithSources(),
        });
      } catch (e) {
        send(e.statusCode || 400, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/plugins/reload") {
      try {
        const body = await parseJsonBody(req);
        const mode = requestMode(ctx, body);
        loadPlugins();
        send(200, {
          ok: true,
          mode,
          directory: PLUGINS_DIR,
          plugins: await pluginsWithSources(),
        });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    // Plugins installed from a repository can be brought up to date without a
    // new Dive (see plugin-sources.js). Each step is the user's: CHECK asks the
    // repositories what is new, UPDATE fast-forwards one plugin, ADD clones a
    // GitHub repository into the plugins directory. Nothing runs on its own.
    if (req.method === "POST" && urlPath === "/api/plugins/check-updates") {
      try {
        const body = await parseJsonBody(req);
        const only = typeof body?.name === "string" ? body.name : "";
        const results = {};
        await Promise.all(
          listPlugins()
            .filter((plugin) => !only || plugin.name === only)
            .map(async (plugin) => {
              const folder = pluginFolder(plugin);
              results[plugin.name] = folder
                ? await checkForUpdate(folder)
                : {
                    status: "no-source",
                    message:
                      "Not installed from a repository, so there is nothing to check.",
                  };
            }),
        );
        send(200, { results });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/plugins/update") {
      try {
        const body = await parseJsonBody(req);
        const plugin = findPluginByName(String(body?.name || ""));
        const folder = plugin ? pluginFolder(plugin) : "";
        if (!folder) {
          send(404, { error: "No plugin folder by that name." });
          return true;
        }
        const result = await updatePlugin(folder);
        if (result.ok) loadPlugins();
        send(result.ok ? 200 : 409, {
          result,
          plugins: await pluginsWithSources(),
        });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/plugins/install") {
      try {
        const body = await parseJsonBody(req);
        const result = await installPlugin(
          String(body?.url || ""),
          PLUGINS_DIR,
        );
        if (result.ok) loadPlugins();
        send(result.ok ? 200 : 400, {
          result,
          plugins: await pluginsWithSources(),
        });
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

    // Agent Skills: SKILL.md folders in the format Claude Code, pi and other
    // agents share. Listed per mode, because each skill's on/off state is.
    if (req.method === "GET" && urlPath === "/api/agent-skills") {
      try {
        const mode = requestMode(ctx);
        send(200, { mode, ...describeAgentSkills(loadSkillsConfig(mode)) });
      } catch (e) {
        send(e.statusCode || 400, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/agent-skills/reload") {
      try {
        const body = await parseJsonBody(req);
        const mode = requestMode(ctx, body);
        send(200, {
          ok: true,
          mode,
          ...describeAgentSkills(loadSkillsConfig(mode), { force: true }),
        });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    // Extra folders to scan, shared by every mode (skill-paths.json).
    if (req.method === "POST" && urlPath === "/api/agent-skills/paths") {
      try {
        const body = await parseJsonBody(req);
        const mode = requestMode(ctx, body);
        saveConfiguredSkillPaths(body?.paths);
        send(200, {
          ok: true,
          mode,
          ...describeAgentSkills(loadSkillsConfig(mode), { force: true }),
        });
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
        // The StoryGraph login, cleaned as Global Book Search cleans it: a
        // value pasted with its name ("remember_user_token=…") is accepted,
        // and characters a cookie value can never hold are dropped so the
        // header stays well formed.
        for (const [key, name] of [
          ["storygraphSessionCookie", "_storygraph_session"],
          ["storygraphRememberToken", "remember_user_token"],
        ]) {
          if (typeof raw[key] !== "string") continue;
          let value = raw[key].trim();
          if (value.startsWith(`${name}=`))
            value = value.slice(name.length + 1);
          value = value.replace(/[\s;,"\\]/g, "");
          if (value) clean[key] = value;
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

        const VALID_SKILL_KEYS = new Set(
          Object.keys(defaultSkillsConfig()).filter(
            (key) => key !== "inputSkills",
          ),
        );
        for (const plugin of listPlugins()) {
          for (const skillName of plugin.skills)
            VALID_SKILL_KEYS.add(skillName);
        }
        for (const skill of scanAgentSkills().skills) {
          VALID_SKILL_KEYS.add(skillConfigKey(skill.name));
        }
        const filtered = Object.fromEntries(
          Object.entries(submittedSettings).filter(([k]) =>
            VALID_SKILL_KEYS.has(k),
          ),
        );
        if (
          Object.prototype.hasOwnProperty.call(submittedSettings, "inputSkills")
        ) {
          const rawInputSkills = submittedSettings.inputSkills;
          if (
            !rawInputSkills ||
            typeof rawInputSkills !== "object" ||
            Array.isArray(rawInputSkills)
          ) {
            send(400, { error: "inputSkills must be an object" });
            return true;
          }
          filtered.inputSkills = Object.fromEntries(
            Object.entries(rawInputSkills)
              .filter(
                ([skillName, shown]) =>
                  INPUT_SKILL_NAMES.has(skillName) && shown === true,
              )
              .map(([skillName]) => [skillName, true]),
          );
        }
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
