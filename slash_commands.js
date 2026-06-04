const COMMANDS = {
  db: { type: "database", label: "database-only" },
  wiki: { type: "skill", skillName: "wikipedia", label: "wikipedia" },
  wikipedia: { type: "skill", skillName: "wikipedia", label: "wikipedia" },
  britannica: { type: "skill", skillName: "britannica", label: "britannica" },
  wiktionary: { type: "skill", skillName: "wiktionary", label: "wiktionary" },
  etymology: {
    type: "skill",
    skillName: "deep_etymology",
    label: "etymology",
  },
  duckduckgo: {
    type: "skill",
    skillName: "duckduckgo",
    label: "duckduckgo",
  },
  scrape: { type: "skill", skillName: "web_scraper", label: "web scraper" },
  calc: { type: "skill", skillName: "calculator", label: "calculator" },
  calculator: { type: "skill", skillName: "calculator", label: "calculator" },
  time: { type: "skill", skillName: "time_and_date", label: "time/date" },
  factcheck: { type: "skill", skillName: "fact_check", label: "fact check" },
  fact_check: { type: "skill", skillName: "fact_check", label: "fact check" },
  notes: { type: "skill", skillName: "local_notes", label: "local notes" },
  shell: { type: "skill", skillName: "shell_command", label: "shell" },
};

function parseSlashCommand(message) {
  const raw = typeof message === "string" ? message : "";
  const match = raw.match(/^\s*\/([a-z][a-z0-9_-]*)\b\s*([\s\S]*)$/i);
  if (!match) return null;
  const commandName = match[1].toLowerCase();
  const config = COMMANDS[commandName];
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
};
