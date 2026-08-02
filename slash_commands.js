const COMMANDS = {
  db: { type: "database", label: "database-only" },
  wiki: { type: "skill", skillName: "wikipedia", label: "wikipedia" },
  wikipedia: { type: "skill", skillName: "wikipedia", label: "wikipedia" },
  britannica: { type: "skill", skillName: "britannica", label: "britannica" },
  larousse: { type: "skill", skillName: "larousse", label: "larousse" },
  scholarpedia: {
    type: "skill",
    skillName: "scholarpedia",
    label: "scholarpedia",
  },
  book_search: {
    type: "skill",
    skillName: "book_search",
    label: "book search",
  },
  deep_research: {
    type: "skill",
    skillName: "deep_research",
    label: "deep research",
  },
  academic_search: {
    type: "skill",
    skillName: "academic_search",
    label: "academic search",
  },
  fetch_paper: {
    type: "skill",
    skillName: "fetch_paper",
    label: "fetch paper",
  },
  wiktionary: { type: "skill", skillName: "wiktionary", label: "wiktionary" },
  etymology: {
    type: "skill",
    skillName: "deep_etymology",
    label: "etymology",
  },
  deep_etymology: {
    type: "skill",
    skillName: "deep_etymology",
    label: "deep etymology",
  },
  duckduckgo: {
    type: "skill",
    skillName: "duckduckgo",
    label: "duckduckgo",
  },
  scrape: { type: "skill", skillName: "web_scraper", label: "web scraper" },
  web_scraper: {
    type: "skill",
    skillName: "web_scraper",
    label: "web scraper",
  },
  calc: { type: "skill", skillName: "calculator", label: "calculator" },
  calculator: { type: "skill", skillName: "calculator", label: "calculator" },
  time: { type: "skill", skillName: "time_and_date", label: "time/date" },
  time_and_date: {
    type: "skill",
    skillName: "time_and_date",
    label: "time/date",
  },
  factcheck: { type: "skill", skillName: "fact_check", label: "fact check" },
  fact_check: { type: "skill", skillName: "fact_check", label: "fact check" },
  notes: { type: "skill", skillName: "local_notes", label: "local notes" },
  local_notes: {
    type: "skill",
    skillName: "local_notes",
    label: "local notes",
  },
  book: { type: "skill", skillName: "book_search", label: "book search" },
  isbn: { type: "skill", skillName: "book_search", label: "book search" },
  shell: { type: "skill", skillName: "shell_command", label: "shell" },
  remember: {
    type: "skill",
    skillName: "remember_lesson",
    label: "remember lesson",
  },
  remember_lesson: {
    type: "skill",
    skillName: "remember_lesson",
    label: "remember lesson",
  },
};

const INPUT_SKILL_NAMES = new Set([
  "wikipedia",
  "britannica",
  "larousse",
  "scholarpedia",
  "book_search",
  "deep_research",
  "academic_search",
  "fetch_paper",
  "wiktionary",
  "deep_etymology",
  "duckduckgo",
  "web_scraper",
  "calculator",
  "time_and_date",
  "fact_check",
  "local_notes",
  "remember_lesson",
]);

// `pluginCommands` is the caller's mode-scoped command→skill snapshot (see
// plugins.getPluginCommandSnapshot). There is deliberately no fallback to the
// global plugin registry: a plugin installed but not activated for the calling
// mode must not be reachable by slash command.
function parseSlashCommand(message, pluginCommands = null) {
  const raw = typeof message === "string" ? message : "";
  const match = raw.match(/^\s*\/([a-z][a-z0-9_-]*)\b\s*([\s\S]*)$/i);
  if (!match) return null;
  const commandName = match[1].toLowerCase();
  const pluginSkillName =
    pluginCommands && typeof pluginCommands === "object"
      ? pluginCommands[commandName]
      : null;
  const config =
    COMMANDS[commandName] ||
    (pluginSkillName
      ? { type: "skill", skillName: pluginSkillName, label: commandName }
      : null);
  if (!config) return null;
  const input = String(match[2] || "").trim();
  return {
    name: commandName,
    type: config.type,
    skillName: config.skillName || null,
    label: config.label,
    input,
    original: raw,
  };
}

function parseLanguagePrefix(input, fallbackLanguage = "en") {
  const text = String(input || "").trim();
  const match = text.match(/^(en|es|fr)\s*:\s*([\s\S]+)$/i);
  if (!match) return { language: fallbackLanguage, text };
  return {
    language: match[1].toLowerCase(),
    text: match[2].trim(),
  };
}

function requiredInput(input, commandName) {
  const text = String(input || "").trim();
  if (!text) {
    throw new Error(`/${commandName} requires a query.`);
  }
  return text;
}

function buildForcedSkillToolCall(command) {
  if (!command || command.type !== "skill") {
    throw new Error("A skill slash command is required.");
  }
  const input = String(command.input || "").trim();
  let args = {};

  switch (command.skillName) {
    case "wikipedia": {
      const parsed = parseLanguagePrefix(requiredInput(input, command.name));
      args = { query: parsed.text, language: parsed.language };
      break;
    }
    case "britannica":
    case "larousse":
    case "scholarpedia":
    case "book_search":
    case "deep_research":
    case "academic_search":
    case "duckduckgo":
      args = { query: requiredInput(input, command.name) };
      break;
    case "wiktionary": {
      const parsed = parseLanguagePrefix(requiredInput(input, command.name));
      args = { word: parsed.text, language: parsed.language };
      break;
    }
    case "deep_etymology": {
      const parsed = parseLanguagePrefix(requiredInput(input, command.name));
      args = { word: parsed.text, language: parsed.language };
      break;
    }
    case "duckduckgo":
      args = { query: requiredInput(input, command.name) };
      break;
    case "web_scraper":
      args = { url: requiredInput(input, command.name) };
      break;
    case "fetch_paper":
      args = { url_or_doi: requiredInput(input, command.name) };
      break;
    case "calculator":
      args = { expression: requiredInput(input, command.name) };
      break;
    case "time_and_date":
      args = input ? { timezone: input } : {};
      break;
    case "fact_check": {
      const parsed = parseLanguagePrefix(requiredInput(input, command.name));
      args = { claim: parsed.text, language: parsed.language };
      break;
    }
    case "remember_lesson":
      args = { lesson: requiredInput(input, command.name) };
      break;
    case "local_notes":
      if (!input || /^read\b/i.test(input)) {
        args = { action: "read" };
      } else if (/^append\b/i.test(input)) {
        args = {
          action: "append",
          content: input.replace(/^append\b\s*/i, "").trim(),
        };
      } else {
        args = { action: "append", content: input };
      }
      break;
    case "shell_command":
      args = { command: requiredInput(input, command.name) };
      break;
    case "download_images_with_gallery_dl":
      try {
        args = JSON.parse(requiredInput(input, command.name));
      } catch (_error) {
        throw new Error(`/${command.name} requires a JSON gallery selection.`);
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error(`/${command.name} requires a JSON gallery selection.`);
      }
      break;
    case "download_media_with_ytdlp":
      try {
        args = JSON.parse(requiredInput(input, command.name));
      } catch (_error) {
        throw new Error(`/${command.name} requires a JSON media selection.`);
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error(`/${command.name} requires a JSON media selection.`);
      }
      break;
    default:
      throw new Error(`Unsupported slash command: /${command.name}`);
  }

  return {
    function: {
      name: command.skillName,
      arguments: JSON.stringify(args),
    },
  };
}

function isDatabaseSlashCommand(command) {
  return command?.type === "database";
}

function isSkillSlashCommand(command) {
  return command?.type === "skill";
}

module.exports = {
  buildForcedSkillToolCall,
  isDatabaseSlashCommand,
  isSkillSlashCommand,
  parseSlashCommand,
  INPUT_SKILL_NAMES,
};
