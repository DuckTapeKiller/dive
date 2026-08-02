// Dive plugin loader. A plugin lives in <data dir>/plugins (~/dive/plugins by
// default, see data-dir.js) as either:
//   my-plugin/            directory form
//     plugin.json         { "name", "description", "version" } (optional)
//     index.js            module.exports = { skills: [...], commands: {...} }
//   my-plugin.js          single-file form (same export shape)
//
// Export shape:
//   module.exports = {
//     name: "my-plugin",            // falls back to plugin.json, then folder/file name
//     description: "what it does",
//     version: "1.0.0",
//     skills: [
//       {
//         name: "my_skill",         // tool name the model calls
//         description: "when the model should call it",
//         parameters: { type: "object", properties: { ... } },
//         async execute(args, context) { return "result string"; },
//       },
//     ],
//     commands: { myskill: "my_skill" }, // optional /slash-command -> skill map
//   };
//
// TRUST MODEL: plugins are plain Node modules running in-process with full
// local access, exactly like Obsidian plugins. Only install code you trust.
// A broken plugin never takes the app down: every load and every execution
// is isolated with try/catch and surfaced as a per-plugin error.
const fs = require("fs");
const path = require("path");

const { PLUGINS_DIR } = require("./data-dir.js");
const SKILL_NAME_RE = /^[a-z][a-z0-9_]*$/i;
const EXECUTE_TIMEOUT_MS = 60 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

function normalizeTimeoutMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return EXECUTE_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
}

let state = {
  plugins: [], // { name, description, version, source, skills: [names], commands, error }
  skills: new Map(), // skill name -> { def, execute, pluginName }
  commands: new Map(), // slash command -> skill name
  loadedAt: 0,
};

function validateSkill(raw, pluginName) {
  if (!raw || typeof raw !== "object") return "skill entry is not an object";
  if (typeof raw.name !== "string" || !SKILL_NAME_RE.test(raw.name)) {
    return `invalid skill name "${raw.name}" (letters, digits, underscores)`;
  }
  if (typeof raw.description !== "string" || !raw.description.trim()) {
    return `skill "${raw.name}" is missing a description`;
  }
  if (typeof raw.execute !== "function") {
    return `skill "${raw.name}" is missing an execute() function`;
  }
  if (state.skills.has(raw.name)) {
    const owner = state.skills.get(raw.name).pluginName;
    return `skill "${raw.name}" already registered by plugin "${owner}"`;
  }
  void pluginName;
  return null;
}

function loadOnePlugin(entryPath, fallbackName) {
  const plugin = {
    name: fallbackName,
    description: "",
    version: "",
    source: entryPath,
    skills: [],
    commands: {},
    error: null,
  };
  try {
    let modulePath = entryPath;
    if (fs.statSync(entryPath).isDirectory()) {
      const manifestPath = path.join(entryPath, "plugin.json");
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (typeof manifest.name === "string" && manifest.name.trim()) {
          plugin.name = manifest.name.trim();
        }
        if (typeof manifest.description === "string") {
          plugin.description = manifest.description;
        }
        if (typeof manifest.version === "string") {
          plugin.version = manifest.version;
        }
      }
      modulePath = path.join(entryPath, "index.js");
      if (!fs.existsSync(modulePath)) {
        plugin.error = "directory plugin has no index.js";
        return plugin;
      }
    }
    // Fresh require on every reload.
    delete require.cache[require.resolve(modulePath)];
    const mod = require(modulePath);
    if (!mod || typeof mod !== "object") {
      plugin.error = "module.exports is not an object";
      return plugin;
    }
    if (typeof mod.name === "string" && mod.name.trim()) {
      plugin.name = mod.name.trim();
    }
    if (typeof mod.description === "string" && mod.description) {
      plugin.description = mod.description;
    }
    if (typeof mod.version === "string" && mod.version) {
      plugin.version = mod.version;
    }
    const skills = Array.isArray(mod.skills) ? mod.skills : [];
    if (!skills.length) {
      plugin.error = "plugin exports no skills";
      return plugin;
    }
    for (const raw of skills) {
      const problem = validateSkill(raw, plugin.name);
      if (problem) {
        plugin.error = problem;
        continue;
      }
      state.skills.set(raw.name, {
        pluginName: plugin.name,
        execute: raw.execute,
        requiresConfirmation: raw.requiresConfirmation === true,
        timeoutMs: normalizeTimeoutMs(raw.timeoutMs),
        def: {
          type: "function",
          function: {
            name: raw.name,
            description: raw.description,
            parameters:
              raw.parameters && typeof raw.parameters === "object"
                ? raw.parameters
                : { type: "object", properties: {} },
          },
        },
      });
      plugin.skills.push(raw.name);
    }
    if (mod.commands && typeof mod.commands === "object") {
      for (const [cmd, skillName] of Object.entries(mod.commands)) {
        const clean = String(cmd || "").toLowerCase();
        if (!/^[a-z][a-z0-9_-]*$/.test(clean)) continue;
        if (!plugin.skills.includes(skillName)) continue;
        if (state.commands.has(clean)) continue;
        state.commands.set(clean, skillName);
        plugin.commands[clean] = skillName;
      }
    }
  } catch (e) {
    plugin.error = e.message || String(e);
  }
  return plugin;
}

function loadPlugins() {
  state = {
    plugins: [],
    skills: new Map(),
    commands: new Map(),
    loadedAt: Date.now(),
  };
  let entries = [];
  try {
    entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  } catch {
    return state.plugins; // no plugins dir yet — that is fine
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(PLUGINS_DIR, entry.name);
    if (entry.isDirectory()) {
      state.plugins.push(loadOnePlugin(full, entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      state.plugins.push(loadOnePlugin(full, entry.name.replace(/\.js$/, "")));
    }
  }
  const loaded = state.plugins.filter((p) => !p.error).length;
  if (state.plugins.length) {
    console.log(
      `[plugins] loaded ${loaded}/${state.plugins.length} plugins, ` +
        `${state.skills.size} skills, ${state.commands.size} commands`,
    );
  }
  return state.plugins;
}

function ensureLoaded() {
  if (!state.loadedAt) loadPlugins();
}

function listPlugins() {
  ensureLoaded();
  return state.plugins.map((p) => ({ ...p }));
}

function clonePluginDefinition(def) {
  try {
    return JSON.parse(JSON.stringify(def));
  } catch (_error) {
    // Plugin definitions are expected to be JSON-shaped. If a malformed plugin
    // supplied a non-serialisable parameter object, omit that definition rather
    // than exposing mutable global state to a request.
    return null;
  }
}

// A request receives a read-only snapshot of the globally installed plugin
// definitions. The execute function remains available to the server, but the
// activation decision is made against this snapshot and the request's
// mode-scoped skills configuration.
function getPluginSkillSnapshot() {
  ensureLoaded();
  return [...state.skills.entries()]
    .map(([name, skill]) => {
      const def = clonePluginDefinition(skill.def);
      if (!def) return null;
      return {
        name,
        pluginName: skill.pluginName,
        execute: skill.execute,
        requiresConfirmation: skill.requiresConfirmation === true,
        timeoutMs: skill.timeoutMs,
        def,
      };
    })
    .filter(Boolean);
}

function snapshotSkill(snapshot, name) {
  if (!Array.isArray(snapshot)) return null;
  return snapshot.find((skill) => skill && skill.name === name) || null;
}

function getPluginToolDefs(snapshot = null) {
  const skills = Array.isArray(snapshot) ? snapshot : getPluginSkillSnapshot();
  return skills.map((skill) => skill.def).filter(Boolean);
}

function getPluginSkill(name, snapshot = null) {
  if (Array.isArray(snapshot)) return snapshotSkill(snapshot, name);
  ensureLoaded();
  return state.skills.get(name) || null;
}

function pluginSkillRequiresConfirmation(name, snapshot = null) {
  return getPluginSkill(name, snapshot)?.requiresConfirmation === true;
}

function getPluginCommands() {
  ensureLoaded();
  return Object.fromEntries(state.commands);
}

// Immutable command-to-skill mapping for a request. Chat mode contexts filter
// this global definition against their own activation settings before parsing
// slash commands.
function getPluginCommandSnapshot() {
  return { ...getPluginCommands() };
}

// The only context fields a plugin's execute() receives. An allowlist, not a
// denylist: internal request state (the mode's skill snapshots, the MCP
// session, the lease release hook) must stay server-side, and a field added to
// the skill context later must not start leaking to plugins by default.
const PLUGIN_CONTEXT_KEYS = ["dataDir", "mode", "allowShellCommand"];

async function executePluginSkill(name, args, context = {}) {
  // When a request supplies a snapshot, a plugin that was installed globally
  // but not activated for this mode is intentionally invisible here.
  const snapshot = Array.isArray(context.pluginSkills)
    ? context.pluginSkills
    : null;
  const skill = getPluginSkill(name, snapshot);
  if (!skill) return null;
  const timeoutMs = skill.timeoutMs || EXECUTE_TIMEOUT_MS;
  const pluginContext = {};
  for (const key of PLUGIN_CONTEXT_KEYS) {
    if (context[key] !== undefined) pluginContext[key] = context[key];
  }
  try {
    const result = await Promise.race([
      Promise.resolve(skill.execute(args || {}, pluginContext)),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs / 1000}s`)),
          timeoutMs,
        ).unref?.(),
      ),
    ]);
    if (result === undefined || result === null) return "";
    return typeof result === "string"
      ? result
      : JSON.stringify(result, null, 2);
  } catch (e) {
    return `Plugin Skill Error (${name}, from plugin "${skill.pluginName}"): ${e.message || e}`;
  }
}

module.exports = {
  PLUGINS_DIR,
  loadPlugins,
  listPlugins,
  getPluginToolDefs,
  getPluginSkill,
  getPluginCommands,
  getPluginCommandSnapshot,
  pluginSkillRequiresConfirmation,
  getPluginSkillSnapshot,
  executePluginSkill,
};
