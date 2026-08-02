"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

// Installed plugin definitions may be shared by every mode. Mutable skill
// activation and custom-skill availability are deliberately stored separately
// for each non-Pi runtime, however. Keep this list small and explicit:
// accepting arbitrary mode names here would make it too easy for a new route to
// accidentally create an unowned state bucket.
const NON_PI_MODES = Object.freeze(["ollama", "cloud", "lmstudio", "llamacpp"]);
const NON_PI_MODE_SET = new Set(NON_PI_MODES);

function isNonPiMode(mode) {
  return typeof mode === "string" && NON_PI_MODE_SET.has(mode);
}

function normalizeNonPiMode(mode, fallback = "ollama") {
  if (isNonPiMode(mode)) return mode;
  return isNonPiMode(fallback) ? fallback : "ollama";
}

function requireNonPiMode(mode, fallback = "ollama") {
  if (mode === undefined || mode === null || mode === "") {
    return normalizeNonPiMode(fallback);
  }
  if (!isNonPiMode(mode)) {
    const error = new Error(`mode must be one of: ${NON_PI_MODES.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
  return mode;
}

function stateFilePath(dataDir, kind, mode) {
  const normalized = requireNonPiMode(mode);
  const prefix = kind === "skills" ? "skills_config" : "custom_skills";
  return path.join(dataDir, `${prefix}-${normalized}.json`);
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { exists: false, value: null };
    return {
      exists: true,
      value: JSON.parse(fs.readFileSync(filePath, "utf8")),
    };
  } catch (_error) {
    return { exists: true, value: null };
  }
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function writeJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_cleanupError) {}
    throw error;
  }
}

function loadSkillsConfig({
  dataDir,
  mode,
  legacyPath,
  defaults,
  onError = () => {},
}) {
  const normalized = requireNonPiMode(mode);
  const modePath = stateFilePath(dataDir, "skills", normalized);
  const modeData = readJsonFile(modePath);
  if (modeData.exists && isPlainObject(modeData.value)) {
    return { ...defaults(), ...modeData.value };
  }

  const legacyData = legacyPath
    ? readJsonFile(legacyPath)
    : { exists: false, value: null };
  const base = isPlainObject(legacyData.value)
    ? { ...defaults(), ...legacyData.value }
    : defaults();

  // A legacy global file is a migration source only. Once a mode has its own
  // file, edits in another mode can never overwrite it. If the legacy file is
  // absent, materialise defaults so future writes are always mode-local.
  if (!modeData.exists) {
    try {
      writeJsonAtomically(modePath, base);
    } catch (error) {
      onError(error);
    }
  }
  return base;
}

function saveSkillsConfig({
  dataDir,
  mode,
  config,
  defaults,
  onError = () => {},
}) {
  try {
    const normalized = requireNonPiMode(mode);
    const next = isPlainObject(config)
      ? { ...defaults(), ...config }
      : defaults();
    writeJsonAtomically(stateFilePath(dataDir, "skills", normalized), next);
    return next;
  } catch (error) {
    onError(error);
    return null;
  }
}

function loadCustomSkills({ dataDir, mode, legacyPath, onError = () => {} }) {
  const normalized = requireNonPiMode(mode);
  const modePath = stateFilePath(dataDir, "custom", normalized);
  const modeData = readJsonFile(modePath);
  if (modeData.exists && Array.isArray(modeData.value)) {
    return modeData.value;
  }

  const legacyData = legacyPath
    ? readJsonFile(legacyPath)
    : { exists: false, value: null };
  const base = Array.isArray(legacyData.value) ? legacyData.value : [];
  if (!modeData.exists) {
    try {
      writeJsonAtomically(modePath, base);
    } catch (error) {
      onError(error);
    }
  }
  return base;
}

function saveCustomSkills({ dataDir, mode, skills, onError = () => {} }) {
  try {
    const normalized = requireNonPiMode(mode);
    const next = Array.isArray(skills) ? skills : [];
    writeJsonAtomically(stateFilePath(dataDir, "custom", normalized), next);
    return next;
  } catch (error) {
    onError(error);
    return null;
  }
}

module.exports = {
  NON_PI_MODES,
  isNonPiMode,
  normalizeNonPiMode,
  requireNonPiMode,
  stateFilePath,
  loadSkillsConfig,
  saveSkillsConfig,
  loadCustomSkills,
  saveCustomSkills,
  writeJsonAtomically,
};
