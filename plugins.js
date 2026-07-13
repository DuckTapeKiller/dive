// Dive plugin loader. A plugin lives in ~/dive/plugins as either:
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
const os = require("os");
const path = require("path");

const PLUGINS_DIR = path.join(os.homedir(), "dive", "plugins");
const SKILL_NAME_RE = /^[a-z][a-z0-9_]*$/i;
const EXECUTE_TIMEOUT_MS = 60 * 1000;

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

function getPluginToolDefs() {
  ensureLoaded();
  return [...state.skills.values()].map((s) => s.def);
}

function getPluginSkill(name) {
  ensureLoaded();
  return state.skills.get(name) || null;
}

function getPluginCommands() {
  ensureLoaded();
  return Object.fromEntries(state.commands);
}

async function executePluginSkill(name, args, context = {}) {
  const skill = getPluginSkill(name);
  if (!skill) return null;
  try {
    const result = await Promise.race([
      Promise.resolve(skill.execute(args || {}, context)),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`timed out after ${EXECUTE_TIMEOUT_MS / 1000}s`)),
          EXECUTE_TIMEOUT_MS,
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
  executePluginSkill,
};
