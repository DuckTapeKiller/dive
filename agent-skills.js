"use strict";

// Agent Skills: folders with a SKILL.md, the open format that Claude Code, pi
// and other agents share (https://agentskills.io). Dive discovers them for the
// modes that run its own tool loop. Pi mode is not involved: pi loads its own.
//
// Discovery follows the client integration guide. Dive scans its own folder,
// the cross-client ~/.agents/skills, and any extra folders listed in
// skill-paths.json; it follows symlinks, skips .git and node_modules, and bounds
// the walk. Parsing is lenient where the guide allows it, so skills written for
// other clients still load: a name that breaks the naming rules is a warning,
// while a missing description or unparseable frontmatter skips the skill.
//
// Progressive disclosure: only the name and description reach the system
// prompt. The body is read when the model calls activate_skill or the user
// types /skill:<name>, and bundled files are read one at a time, confined to
// the skill's own folder.

const fs = require("fs");
const os = require("os");
const path = require("path");
const YAML = require("yaml");

const { DATA_DIR } = require("./data-dir.js");

const SKILLS_DIR = path.join(DATA_DIR, "skills");
const SKILL_PATHS_FILE = path.join(DATA_DIR, "skill-paths.json");
const SKILL_FILE_NAME = "SKILL.md";
const ACTIVATE_SKILL_TOOL = "activate_skill";
const CONFIG_KEY_PREFIX = "skill:";

const MAX_SCAN_DEPTH = 5;
const MAX_SCAN_DIRECTORIES = 2000;
const MAX_CONFIGURED_PATHS = 20;
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RESOURCE_FILES = 200;
const MAX_RESOURCE_DEPTH = 4;
// One tool result. Large enough that real skills load in one call (the
// Spanish editor's SKILL.md is ~89,000 characters); anything bigger is paged.
const PART_CHARS = 100000;
// A rescan per chat turn keeps edits and new skills live without a reload
// button, while a burst of requests reuses one scan.
const SCAN_CACHE_MS = 2000;
const SKIP_DIR_NAMES = new Set(["node_modules"]);
const SPEC_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_COMMAND_RE = /^\s*\/skill:(\S*)\s*([\s\S]*)$/;

let scanCache = null;

function expandHomePath(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch {
    // Missing, unreadable or a dangling symlink: callers treat all as absent.
    return null;
  }
}

function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    // Same as statOrNull: a path that cannot be resolved is not scanned.
    return null;
  }
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Configured folders (skill-paths.json) ----

function normalizeSkillPaths(input) {
  const paths = [];
  const errors = [];
  if (!Array.isArray(input)) {
    return { paths, errors: ["paths must be an array of folder paths"] };
  }
  for (const entry of input) {
    if (typeof entry !== "string") {
      errors.push("every path must be a string");
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (!path.isAbsolute(expandHomePath(trimmed))) {
      errors.push(`"${trimmed}" must be an absolute path or start with ~/`);
      continue;
    }
    if (!paths.includes(trimmed)) paths.push(trimmed);
  }
  if (paths.length > MAX_CONFIGURED_PATHS) {
    errors.push(`list at most ${MAX_CONFIGURED_PATHS} folders`);
  }
  return { paths, errors };
}

function readConfiguredSkillPaths() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SKILL_PATHS_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { paths: [], error: null };
    return {
      paths: [],
      error: `${path.basename(SKILL_PATHS_FILE)} could not be read: ${error.message}`,
    };
  }
  const { paths, errors } = normalizeSkillPaths(raw?.paths);
  return {
    paths: paths.slice(0, MAX_CONFIGURED_PATHS),
    error: errors.length
      ? `${path.basename(SKILL_PATHS_FILE)}: ${errors.join("; ")}`
      : null,
  };
}

function saveConfiguredSkillPaths(input) {
  const { paths, errors } = normalizeSkillPaths(input);
  if (errors.length) {
    const error = new Error(errors.join("; "));
    error.statusCode = 400;
    throw error;
  }
  fs.mkdirSync(path.dirname(SKILL_PATHS_FILE), { recursive: true });
  const tempPath = `${SKILL_PATHS_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify({ paths }, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tempPath, SKILL_PATHS_FILE);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Cleanup only; the original write error is rethrown below.
    }
    throw error;
  }
  invalidateAgentSkillCache();
  return paths;
}

function skillRoots() {
  const roots = [
    { path: SKILLS_DIR, source: "dive", configured: null },
    {
      path: path.join(os.homedir(), ".agents", "skills"),
      source: "agents",
      configured: null,
    },
  ];
  const configured = readConfiguredSkillPaths();
  for (const entry of configured.paths) {
    roots.push({
      path: expandHomePath(entry),
      source: "configured",
      configured: entry,
    });
  }
  return { roots, configError: configured.error };
}

// ---- SKILL.md parsing ----

function splitFrontmatter(text) {
  const normalized = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0].trimEnd() !== "---") {
    return { frontmatter: null, body: normalized.trim(), unterminated: false };
  }
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === "---") {
      return {
        frontmatter: lines.slice(1, i).join("\n"),
        body: lines
          .slice(i + 1)
          .join("\n")
          .trim(),
        unterminated: false,
      };
    }
  }
  return { frontmatter: null, body: normalized.trim(), unterminated: true };
}

// Top-level `key: value` lines whose unquoted value contains ": " are invalid
// YAML that other clients' parsers accept (the guide's most common example).
// Quote those values and let the real parser try again.
function quoteUnquotedColonValues(source) {
  return source
    .split("\n")
    .map((line) => {
      const match = line.match(/^([A-Za-z0-9_-]+):[ \t]+(\S.*)$/);
      if (!match) return line;
      const value = match[2].trim();
      if (/^["'|>[{&*!#]/.test(value)) return line;
      if (!/:\s/.test(value)) return line;
      return `${match[1]}: ${JSON.stringify(value)}`;
    })
    .join("\n");
}

function parseYamlLeniently(source) {
  const options = { uniqueKeys: false };
  try {
    return { value: YAML.parse(source, options), repaired: false };
  } catch (firstError) {
    const repaired = quoteUnquotedColonValues(source);
    if (repaired !== source) {
      try {
        return { value: YAML.parse(repaired, options), repaired: true };
      } catch {
        // The repair did not help; report the original, clearer error.
      }
    }
    return { error: firstError };
  }
}

function scalarString(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function parseSkillFile(location, folderName) {
  const warnings = [];
  const stat = statOrNull(location);
  if (!stat || !stat.isFile()) {
    return { error: `${SKILL_FILE_NAME} could not be read` };
  }
  if (stat.size > MAX_SKILL_FILE_BYTES) {
    return { error: `${SKILL_FILE_NAME} is larger than 2 MB` };
  }
  let text;
  try {
    text = fs.readFileSync(location, "utf8");
  } catch (error) {
    return { error: `${SKILL_FILE_NAME} could not be read: ${error.message}` };
  }
  const { frontmatter, unterminated } = splitFrontmatter(text);
  if (frontmatter === null) {
    return {
      error: unterminated
        ? "the frontmatter has no closing --- line"
        : "there is no YAML frontmatter between --- lines at the top",
    };
  }
  const parsed = parseYamlLeniently(frontmatter);
  if (parsed.error) {
    const firstLine = String(parsed.error.message || parsed.error).split(
      "\n",
    )[0];
    return { error: `the frontmatter is not valid YAML: ${firstLine}` };
  }
  if (parsed.repaired) {
    warnings.push(
      "the frontmatter has unquoted values containing colons; loaded after quoting them",
    );
  }
  const data = parsed.value;
  if (!isPlainObject(data)) {
    return { error: "the frontmatter is not a set of key: value fields" };
  }

  let name = scalarString(data.name);
  if (!name) {
    name = folderName;
    warnings.push(
      `the frontmatter has no name; using the folder name "${folderName}"`,
    );
  }
  // A name has to survive "/skill:<name>" and a tool argument unambiguously.
  if (/[\s:\u0000-\u001f\u007f]/.test(name)) {
    return {
      error: `the name "${name}" contains spaces, colons or control characters`,
    };
  }
  const description = scalarString(data.description);
  if (!description) {
    return { error: "the description is missing or empty" };
  }
  if (name.length > 64 || !SPEC_NAME_RE.test(name)) {
    warnings.push(
      `the name "${name}" breaks the naming rules (lowercase letters, digits and single hyphens, up to 64 characters)`,
    );
  }
  if (name !== folderName) {
    warnings.push(
      `the name "${name}" does not match its folder "${folderName}"`,
    );
  }
  if (description.length > 1024) {
    warnings.push(
      `the description is ${description.length} characters; the limit is 1024`,
    );
  }
  return {
    skill: {
      name,
      description,
      modelInvocable: data["disable-model-invocation"] !== true,
    },
    warnings,
  };
}

// ---- Discovery ----

function scanAgentSkills({ force = false } = {}) {
  if (!force && scanCache && Date.now() - scanCache.scannedAt < SCAN_CACHE_MS) {
    return scanCache;
  }
  const skills = [];
  const diagnostics = [];
  const rootsInfo = [];
  const byName = new Map();
  const seenDirectories = new Set();
  let remaining = MAX_SCAN_DIRECTORIES;

  const { roots, configError } = skillRoots();
  if (configError) {
    diagnostics.push({
      level: "error",
      location: SKILL_PATHS_FILE,
      message: configError,
    });
  }

  const addSkill = (location, root) => {
    const baseDir = path.dirname(location);
    const result = parseSkillFile(location, path.basename(baseDir));
    if (result.error) {
      diagnostics.push({ level: "error", location, message: result.error });
      return;
    }
    for (const message of result.warnings) {
      diagnostics.push({ level: "warning", location, message });
    }
    const existing = byName.get(result.skill.name);
    if (existing) {
      diagnostics.push({
        level: "warning",
        location,
        message: `not loaded: a skill named "${result.skill.name}" was already found at ${existing.location}`,
      });
      return;
    }
    const record = {
      ...result.skill,
      location,
      baseDir,
      realBaseDir: realpathOrNull(baseDir) || baseDir,
      source: root.source,
      root: root.path,
      warnings: result.warnings,
    };
    byName.set(record.name, record);
    skills.push(record);
  };

  for (const root of roots) {
    const info = {
      path: root.path,
      source: root.source,
      configured: root.configured,
      exists: false,
    };
    rootsInfo.push(info);
    const realRoot = realpathOrNull(root.path);
    const rootStat = realRoot ? statOrNull(realRoot) : null;
    if (!rootStat) {
      if (root.source === "configured") {
        diagnostics.push({
          level: "warning",
          location: root.path,
          message: "this configured skill folder does not exist",
        });
      }
      continue;
    }
    info.exists = true;
    // A configured entry may name a single skill: its SKILL.md or its folder.
    if (rootStat.isFile()) {
      if (path.basename(root.path) === SKILL_FILE_NAME) {
        addSkill(root.path, root);
      } else {
        diagnostics.push({
          level: "warning",
          location: root.path,
          message: `a configured path must be a folder or a ${SKILL_FILE_NAME} file`,
        });
      }
      continue;
    }

    const stack = [{ dir: root.path, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop();
      const realDir = realpathOrNull(dir);
      if (!realDir || seenDirectories.has(realDir)) continue;
      seenDirectories.add(realDir);
      if (remaining <= 0) {
        diagnostics.push({
          level: "warning",
          location: root.path,
          message: `scanning stopped after ${MAX_SCAN_DIRECTORIES} folders`,
        });
        stack.length = 0;
        break;
      }
      remaining -= 1;

      const skillFile = path.join(dir, SKILL_FILE_NAME);
      const skillStat = statOrNull(skillFile);
      // Dive's own folders hold skills; only a configured path may itself be
      // one skill folder.
      if (skillStat?.isFile() && (depth > 0 || root.source === "configured")) {
        addSkill(skillFile, root);
        continue;
      }
      if (depth >= MAX_SCAN_DEPTH) continue;

      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        diagnostics.push({
          level: "warning",
          location: dir,
          message: `could not list this folder: ${error.message}`,
        });
        continue;
      }
      const children = entries
        .filter(
          (entry) =>
            !entry.name.startsWith(".") && !SKIP_DIR_NAMES.has(entry.name),
        )
        .map((entry) => path.join(dir, entry.name))
        // statSync follows symlinks, so a linked skill folder is a folder.
        .filter((child) => statOrNull(child)?.isDirectory())
        .sort();
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push({ dir: children[i], depth: depth + 1 });
      }
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  scanCache = { scannedAt: Date.now(), skills, diagnostics, roots: rootsInfo };
  return scanCache;
}

function invalidateAgentSkillCache() {
  scanCache = null;
}

// ---- Mode scoping ----

function skillConfigKey(name) {
  return `${CONFIG_KEY_PREFIX}${name}`;
}

function isAgentSkillConfigKey(key) {
  return (
    typeof key === "string" &&
    key.startsWith(CONFIG_KEY_PREFIX) &&
    key.length > CONFIG_KEY_PREFIX.length
  );
}

// The enabled skills for one mode, as a request-owned copy. Skills are enabled
// unless the mode's skills config sets "skill:<name>" to false.
function getAgentSkillSnapshot(skillsConfig = {}) {
  const config = isPlainObject(skillsConfig) ? skillsConfig : {};
  return scanAgentSkills()
    .skills.filter((skill) => config[skillConfigKey(skill.name)] !== false)
    .map((skill) => ({ ...skill, warnings: [...skill.warnings] }));
}

function describeAgentSkills(skillsConfig = {}, { force = false } = {}) {
  const config = isPlainObject(skillsConfig) ? skillsConfig : {};
  const scan = scanAgentSkills({ force });
  return {
    directory: SKILLS_DIR,
    pathsFile: SKILL_PATHS_FILE,
    paths: readConfiguredSkillPaths().paths,
    roots: scan.roots.map((root) => ({ ...root })),
    skills: scan.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      location: skill.location,
      source: skill.source,
      modelInvocable: skill.modelInvocable,
      enabled: config[skillConfigKey(skill.name)] !== false,
      warnings: [...skill.warnings],
    })),
    diagnostics: scan.diagnostics.map((item) => ({ ...item })),
  };
}

function findSkill(snapshot, name) {
  const skills = Array.isArray(snapshot) ? snapshot : [];
  const wanted = String(name || "").trim();
  if (!wanted) return null;
  return (
    skills.find((skill) => skill.name === wanted) ||
    skills.find((skill) => skill.name.toLowerCase() === wanted.toLowerCase()) ||
    null
  );
}

// ---- What the model sees ----

function getActivateSkillToolDef(snapshot) {
  const skills = Array.isArray(snapshot) ? snapshot : [];
  if (!skills.length) return null;
  return {
    type: "function",
    function: {
      name: ACTIVATE_SKILL_TOOL,
      description:
        "Load an Agent Skill: its full instructions, or one file bundled with it. " +
        "Call it with the skill's name when the request matches a skill in the AGENT SKILLS list, before doing the task. " +
        "When the loaded instructions refer to a file such as references/guide.md, call it again with that relative path as file.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            enum: skills.map((skill) => skill.name),
            description: "The skill's name, exactly as listed.",
          },
          file: {
            type: "string",
            description:
              "Optional. A file inside the skill folder, as a relative path such as references/guide.md. Omit it to load the skill's instructions.",
          },
          part: {
            type: "integer",
            minimum: 1,
            description:
              "Optional. Which part to read when a result says it continues in further parts.",
          },
        },
        required: ["name"],
      },
    },
  };
}

function buildAgentSkillsPrompt(snapshot, { nativeToolCalling = true } = {}) {
  const listed = (Array.isArray(snapshot) ? snapshot : []).filter(
    (skill) => skill.modelInvocable,
  );
  if (!listed.length) return "";
  const lines = [
    "### AGENT SKILLS",
    "The skills below give specialised instructions for particular tasks. When the user's request matches a skill's description, load that skill with the activate_skill tool BEFORE doing the task, then follow its instructions. This applies to writing, rewriting, proofreading and translating requests too. For that task, a loaded skill's instructions take precedence over the general answer-format rules above.",
    "When a skill's instructions refer to a file relative to the skill (for example references/guide.md), read it with activate_skill and the file argument. When a skill mentions a tool you do not have, use the fallback its instructions give, or ask the user.",
    "",
    "<available_skills>",
  ];
  for (const skill of listed) {
    lines.push(
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      "  </skill>",
    );
  }
  lines.push("</available_skills>");
  if (!nativeToolCalling) {
    const example = JSON.stringify({ name: listed[0].name });
    lines.push(
      "",
      `To load a skill, output: <call:${ACTIVATE_SKILL_TOOL}>${example}</call>`,
      `To read one of its files: <call:${ACTIVATE_SKILL_TOOL}>${JSON.stringify({ name: listed[0].name, file: "references/guide.md" })}</call>`,
    );
  }
  return lines.join("\n");
}

// ---- Activation ----

// Split at line breaks where possible, so a part never ends mid-sentence when
// a newline is reasonably close. Deterministic, so part N is stable across calls.
function splitIntoParts(text) {
  const parts = [];
  let rest = String(text ?? "");
  while (rest.length > PART_CHARS) {
    let cut = rest.lastIndexOf("\n", PART_CHARS);
    if (cut < PART_CHARS / 2) cut = PART_CHARS;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

function parsePart(value) {
  if (value === undefined || value === null || value === "") return 1;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : NaN;
}

function listSkillResources(record) {
  const files = [];
  let truncated = false;
  const seen = new Set();
  const stack = [{ dir: record.realBaseDir, rel: "", depth: 0 }];
  while (stack.length) {
    const { dir, rel, depth } = stack.pop();
    const realDir = realpathOrNull(dir);
    if (!realDir || seen.has(realDir)) continue;
    seen.add(realDir);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // An unreadable subfolder is left out of the listing, not an error.
      continue;
    }
    const subdirectories = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const stat = statOrNull(full);
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (depth < MAX_RESOURCE_DEPTH) {
          subdirectories.push({ dir: full, rel: relPath, depth: depth + 1 });
        }
        continue;
      }
      if (!stat.isFile() || (depth === 0 && entry.name === SKILL_FILE_NAME)) {
        continue;
      }
      if (files.length >= MAX_RESOURCE_FILES) {
        truncated = true;
        continue;
      }
      files.push(relPath);
    }
    for (let i = subdirectories.length - 1; i >= 0; i -= 1) {
      stack.push(subdirectories[i]);
    }
  }
  files.sort();
  return { files, truncated };
}

function continuationNote(parts, index, args) {
  if (parts.length <= 1) return [];
  const note = [`[Part ${index} of ${parts.length}.`];
  if (index < parts.length) {
    note.push(
      `Call ${ACTIVATE_SKILL_TOOL} with ${JSON.stringify({ ...args, part: index + 1 })} for the next part.]`,
    );
  } else {
    note[0] += " This is the last part.]";
  }
  return ["", note.join(" ")];
}

function renderSkillContent(record, part = 1) {
  const text = fs.readFileSync(record.location, "utf8");
  const parts = splitIntoParts(splitFrontmatter(text).body);
  if (!Number.isInteger(part) || part > parts.length) {
    throw new Error(
      `part ${part} does not exist; the instructions have ${parts.length} part${parts.length === 1 ? "" : "s"}`,
    );
  }
  const { files, truncated } = listSkillResources(record);
  const lines = [
    `<skill_content name="${escapeXml(record.name)}">`,
    parts[part - 1],
    ...continuationNote(parts, part, { name: record.name }),
    "",
    `Skill directory: ${record.baseDir}`,
  ];
  if (files.length) {
    lines.push(
      `Relative paths in this skill are relative to the skill directory. To read one of the files below, call ${ACTIVATE_SKILL_TOOL} with {"name": ${JSON.stringify(record.name)}, "file": "<relative path>"}.`,
      "",
      "<skill_resources>",
      ...files.map((file) => `  <file>${escapeXml(file)}</file>`),
    );
    if (truncated) lines.push("  <!-- more files exist but are not listed -->");
    lines.push("</skill_resources>");
  } else {
    lines.push("This skill has no bundled files.");
  }
  lines.push("</skill_content>");
  return lines.join("\n");
}

function resolveSkillFile(record, requested) {
  const raw = String(requested ?? "")
    .trim()
    .replace(/\\/g, "/");
  if (!raw) {
    return { error: "file must be a relative path inside the skill folder" };
  }
  if (path.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    return {
      error: `"${raw}" is an absolute path; give a path relative to the skill folder`,
    };
  }
  // Refuse a path that climbs out of the folder before touching the disk, so
  // the answer never reveals whether a file outside the skill exists.
  const lexical = path.resolve(record.realBaseDir, raw);
  if (!lexical.startsWith(record.realBaseDir + path.sep)) {
    return {
      error: `"${raw}" is outside the folder of skill "${record.name}"`,
    };
  }
  const real = realpathOrNull(lexical);
  if (!real) {
    return { error: `skill "${record.name}" has no file "${raw}"` };
  }
  // A symlink inside the folder can still point elsewhere.
  if (!real.startsWith(record.realBaseDir + path.sep)) {
    return {
      error: `"${raw}" is outside the folder of skill "${record.name}"`,
    };
  }
  const stat = statOrNull(real);
  if (!stat || !stat.isFile()) {
    return { error: `"${raw}" in skill "${record.name}" is not a file` };
  }
  if (stat.size > MAX_SKILL_FILE_BYTES) {
    return { error: `"${raw}" is larger than 2 MB` };
  }
  const buffer = fs.readFileSync(real);
  if (buffer.subarray(0, 8000).includes(0)) {
    return { error: `"${raw}" is a binary file and cannot be read as text` };
  }
  return {
    text: buffer.toString("utf8"),
    relPath: path.relative(record.realBaseDir, real).split(path.sep).join("/"),
  };
}

function renderSkillFile(record, requested, part = 1) {
  const resolved = resolveSkillFile(record, requested);
  if (resolved.error) throw new Error(resolved.error);
  const parts = splitIntoParts(resolved.text);
  if (!Number.isInteger(part) || part > parts.length) {
    throw new Error(
      `part ${part} does not exist; "${resolved.relPath}" has ${parts.length} part${parts.length === 1 ? "" : "s"}`,
    );
  }
  return [
    `<skill_file skill="${escapeXml(record.name)}" path="${escapeXml(resolved.relPath)}">`,
    parts[part - 1],
    ...continuationNote(parts, part, {
      name: record.name,
      file: resolved.relPath,
    }),
    "</skill_file>",
  ].join("\n");
}

function executeActivateSkill(args, snapshot) {
  const skills = Array.isArray(snapshot) ? snapshot : [];
  if (!skills.length) {
    return "Error: no Agent Skills are enabled for this mode.";
  }
  const input = isPlainObject(args) ? args : {};
  const record = findSkill(skills, input.name);
  if (!record) {
    const requested = String(input.name ?? "").trim();
    return `Error: there is no enabled skill named "${requested}". Enabled skills: ${skills
      .map((skill) => skill.name)
      .join(", ")}.`;
  }
  const part = parsePart(input.part);
  if (Number.isNaN(part)) {
    return "Error: part must be a whole number starting at 1.";
  }
  try {
    const hasFile =
      input.file !== undefined &&
      input.file !== null &&
      String(input.file).trim() !== "";
    return hasFile
      ? renderSkillFile(record, input.file, part)
      : renderSkillContent(record, part);
  } catch (error) {
    return `Error: ${error.message}.`;
  }
}

// ---- /skill:<name> ----

// The user's explicit activation. Like pi, the arguments after the name are
// appended to the skill content as "User: <args>".
function resolveSkillCommand(text, snapshot) {
  if (typeof text !== "string") return null;
  const match = text.match(SKILL_COMMAND_RE);
  if (!match) return null;
  const requested = match[1];
  const args = match[2].trim();
  const record = findSkill(snapshot, requested);
  if (!record) {
    const names = (Array.isArray(snapshot) ? snapshot : []).map(
      (skill) => skill.name,
    );
    return {
      name: requested,
      args,
      error: requested
        ? `There is no enabled skill named "${requested}" in this mode. ${
            names.length
              ? `Enabled skills: ${names.join(", ")}.`
              : "No Agent Skills are enabled."
          }`
        : "Type the skill name after /skill: — for example /skill:my-skill followed by your text.",
    };
  }
  let content;
  try {
    content = renderSkillContent(record, 1);
  } catch (error) {
    return {
      name: record.name,
      args,
      error: `Skill "${record.name}" could not be read: ${error.message}`,
    };
  }
  return {
    name: record.name,
    args,
    message: args ? `${content}\n\nUser: ${args}` : content,
  };
}

// History reaches the server as the user typed it, so a /skill: turn from
// earlier in the conversation is expanded again on every request. Otherwise the
// model would lose the skill's instructions after the first reply.
function expandSkillCommandsInHistory(history, snapshot) {
  if (!Array.isArray(history)) return history;
  return history.map((item) => {
    if (
      !item ||
      item.role !== "user" ||
      typeof item.content !== "string" ||
      !SKILL_COMMAND_RE.test(item.content)
    ) {
      return item;
    }
    const resolved = resolveSkillCommand(item.content, snapshot);
    if (!resolved || resolved.error) return item;
    return { ...item, content: resolved.message };
  });
}

module.exports = {
  ACTIVATE_SKILL_TOOL,
  SKILLS_DIR,
  SKILL_PATHS_FILE,
  scanAgentSkills,
  invalidateAgentSkillCache,
  readConfiguredSkillPaths,
  saveConfiguredSkillPaths,
  skillConfigKey,
  isAgentSkillConfigKey,
  getAgentSkillSnapshot,
  describeAgentSkills,
  getActivateSkillToolDef,
  buildAgentSkillsPrompt,
  executeActivateSkill,
  resolveSkillCommand,
  expandSkillCommandsInHistory,
  // Exported for unit tests.
  splitFrontmatter,
  parseSkillFile,
  splitIntoParts,
  PART_CHARS,
};
