"use strict";

// Skills that act on Dive itself rather than the outside world: the per-mode
// lessons file the model can append to, and the plugin-draft proposal flow.
// Lessons live here because remember_lesson is the only skill that writes them;
// server.js and routes/prompts.js read them through skills.js.
//
// Moved out of skills.js unchanged.

const fs = require("fs");
const path = require("path");
const { DIVE_SKILL_MODE_IDS } = require("../assets/js/00-modes.js");

// Lessons are strictly per-mode: each mode is its own ecosystem, so each
// mode has its own file in DATA_DIR/lessons and never sees another mode's
// lessons. Pi is excluded entirely — it has its own native context system
// (~/.pi/agent/AGENTS.md).
const LESSON_MODES = DIVE_SKILL_MODE_IDS;

function lessonModeKey(mode) {
  return LESSON_MODES.includes(mode) ? mode : "ollama";
}

function lessonsHeader(mode) {
  return `# ${lessonModeKey(mode)} lessons\n# One lesson per line: every non-empty line below (except "#" comments) is injected into the system prompt of every ${lessonModeKey(mode)} chat. Edit or delete freely.\n`;
}

function lessonsFilePath(dataDir, mode) {
  return path.join(dataDir, "lessons", `${lessonModeKey(mode)}-lessons.md`);
}

async function executeRememberLesson(args, dataDir, mode) {
  if (!dataDir) return "Error: no data directory available.";
  const modeKey = lessonModeKey(mode);
  const lesson = String(args.lesson || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!lesson) return "Error: lesson text is required.";
  if (lesson.length > 500) {
    return "Error: keep lessons under 500 characters.";
  }
  const file = lessonsFilePath(dataDir, modeKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    current = lessonsHeader(modeKey);
  }
  const entry = `- ${lesson}`;
  if (current.includes(entry)) {
    return `Already remembered for ${modeKey}: "${lesson}"`;
  }
  fs.writeFileSync(file, current.trimEnd() + "\n" + entry + "\n", "utf8");
  return `Remembered for ${modeKey} mode: "${lesson}" — this now applies to every future ${modeKey} conversation (each mode keeps its own independent lessons). The user can edit or remove lessons in Settings > Skills > Lessons.`;
}

async function executeProposePlugin(args, dataDir) {
  if (!dataDir) return "Error: no data directory available.";
  const rawName = String(args.name || "").toLowerCase();
  const name = rawName
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!name) return "Error: a kebab-case plugin name is required.";
  const code = String(args.code || "");
  if (!code.includes("module.exports")) {
    return "Error: code must be a CommonJS module (module.exports = { skills: [...] }).";
  }
  try {
    // Syntax check without executing.
    new (require("vm").Script)(code, { filename: `${name}/index.js` });
  } catch (e) {
    return `Error: the plugin code has a syntax error: ${e.message}`;
  }
  const draftDir = path.join(dataDir, "plugin-drafts", name);
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(
    path.join(draftDir, "plugin.json"),
    JSON.stringify(
      {
        name,
        description: String(args.description || ""),
        version: "0.1.0",
        draftedBy: "model",
        draftedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(draftDir, "index.js"), code, "utf8");
  return `Draft plugin "${name}" saved. It is NOT active. Tell the user to review and approve it under Settings > Skills > Plugins > Drafts.`;
}

module.exports = {
  executeRememberLesson,
  executeProposePlugin,
  lessonModeKey,
  lessonsFilePath,
  lessonsHeader,
  LESSON_MODES,
};
