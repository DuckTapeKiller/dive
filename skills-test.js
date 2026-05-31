const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const vm = require("vm");

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15000;

function fetchJson(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { headers: { "User-Agent": "Ollama-Pi-Chat/1.0" } },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0)
            return reject(new Error("Too many redirects"));
          return fetchJson(res.headers.location, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy());
    req.on("error", reject);
  });
}

function fetchText(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0" } },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0)
            return reject(new Error("Too many redirects"));
          return fetchText(res.headers.location, redirectsLeft - 1)
            .then(resolve)
            .catch(reject);
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy());
    req.on("error", reject);
  });
}

async function executeWikipedia({ query, language = "en" }) {
  try {
    const wikiBase = `https://${language.toLowerCase().slice(0, 2)}.wikipedia.org`;
    const searchUrl = `${wikiBase}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`;
    const searchData = await fetchJson(searchUrl);
    const searchArr = searchData?.query?.search || [];
    if (searchArr.length === 0)
      return `No Wikipedia results found for "${query}".`;

    const pageTitle = searchArr[0].title;
    const summaryUrl = `${wikiBase}/api/rest_v1/page/summary/${encodeURIComponent(pageTitle.replace(/ /g, "_"))}`;
    const summaryData = await fetchJson(summaryUrl);

    let output = `## Wikipedia: ${pageTitle}\n\n`;
    if (summaryData.extract) {
      output += `**Summary:** ${summaryData.extract}\n\n`;
    }
    output += `\n<!-- ${wikiBase}/wiki/${encodeURIComponent(pageTitle.replace(/ /g, "_"))} -->`;
    return output;
  } catch (e) {
    return `Wikipedia Error: ${e.message}`;
  }
}

async function executeWiktionary({ word, language = "en" }) {
  try {
    const url = `https://${language}.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`;
    const data = await fetchJson(url);
    if (data.title === "Not found")
      return `No dictionary entry found for "${word}".`;

    let output = `## Definitions for "${word}"\n`;
    const langs = Object.keys(data);
    for (const lang of langs) {
      if (!Array.isArray(data[lang])) continue;
      output += `\n**Language: ${lang}**\n`;
      data[lang].forEach((part) => {
        output += `*Part of speech: ${part.partOfSpeech}*\n`;
        part.definitions.forEach((def) => {
          const text = (def.definition || "").replace(/<[^>]*>?/gm, "");
          output += `- ${text}\n`;
        });
      });
    }
    output += `\n<!-- https://${language}.wiktionary.org/wiki/${encodeURIComponent(word)} -->`;
    return output || `No clear definition found.`;
  } catch (e) {
    return `Wiktionary Error: ${e.message}`;
  }
}

async function executeDuckDuckGo({ query }) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const html = await fetchText(url);
    const results = [];
    const resultRegex =
      /<a class="result__url"[^>]*href="([^"]+)"[^>]*>.*?<\/a>[\s\S]*?<a class="result__snippet[^>]*>(.*?)<\/a>/gi;
    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < 5) {
      let href = match[1];
      if (href.startsWith("//")) href = "https:" + href;
      else if (href.startsWith("/"))
        href = "https://html.duckduckgo.com" + href;
      if (href.includes("/url?q=")) {
        href = decodeURIComponent(href.split("/url?q=")[1].split("&")[0]);
      }
      const snippet = match[2].replace(/<b>|<\/b>/g, "").trim();
      results.push(`${results.length + 1}. ${snippet}\n<!-- ${href} -->`);
    }
    if (results.length === 0)
      return "No web results found (duckduckgo may have blocked the request).";
    return results.join("\n\n");
  } catch (e) {
    return `Web Search Error: ${e.message}`;
  }
}

async function executeFactCheck({ claim, language = "en" }) {
  const wiki = await executeWikipedia({ query: claim, language });
  const ddg = await executeDuckDuckGo({ query: claim });
  return `### Wikipedia findings:\n${wiki}\n\n### Web search findings:\n${ddg}`;
}

async function executeWebScraper({ url }) {
  try {
    const html = await fetchText(url);
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    let content = bodyMatch ? bodyMatch[1] : html;

    // Preserve links by converting <a href="URL">text</a> to "text (URL)"
    content = content.replace(
      /<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi,
      (match, href, textContent) => {
        const cleanText = textContent.replace(/<[^>]+>/g, "").trim();
        if (href && !href.startsWith("javascript:")) {
          // Resolve relative URLs if needed, but for simplicity we just append the raw href
          return ` ${cleanText} (Link: ${href}) `;
        }
        return ` ${cleanText} `;
      },
    );

    const text = content
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text.substring(0, 10000);
  } catch (e) {
    return `Web Scraper Error: ${e.message}`;
  }
}

async function executeCalculator({ expression }) {
  try {
    if (!/^[0-9+\-*/().\s]*$/.test(expression)) {
      return "Error: Expression contains invalid characters.";
    }
    const result = vm.runInNewContext(expression, Object.create(null), {
      timeout: 1000,
    });
    return `Result: ${result}`;
  } catch (e) {
    return `Calculator Error: ${e.message}`;
  }
}

async function executeLocalNotes({ action, content }, DATA_DIR) {
  const notesFile = path.join(DATA_DIR, "notes.json");
  let currentText = "";
  try {
    if (fs.existsSync(notesFile)) {
      const raw = JSON.parse(fs.readFileSync(notesFile, "utf8"));
      currentText = raw.text || "";
    }
  } catch (e) {}

  if (action === "read") {
    return currentText ? currentText : "Your notes are currently empty.";
  } else if (action === "append") {
    if (!content) return "Error: Content is required for append action.";
    const newText = currentText ? `${currentText}\n\n${content}` : content;
    fs.writeFileSync(
      notesFile,
      JSON.stringify(
        {
          text: newText,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return "Successfully appended to your notes.";
  }
  return "Error: Invalid action. Use 'read' or 'append'.";
}

async function executeTimeAndDate() {
  const now = new Date();
  return `Current local time: ${now.toLocaleTimeString()}\nCurrent date: ${now.toLocaleDateString()}\nDay of the week: ${now.toLocaleDateString(undefined, { weekday: "long" })}`;
}

async function executeShellCommand({ command }) {
  console.warn(`[shell_command] Executing: ${String(command).slice(0, 200)}`);
  return new Promise((resolve) => {
    exec(command, { timeout: 5000 }, (error, stdout, stderr) => {
      let output = "";
      if (stdout) output += `STDOUT:\n${stdout}\n`;
      if (stderr) output += `STDERR:\n${stderr}\n`;
      if (error) output += `ERROR:\n${error.message}\n`;
      resolve(output || "Command executed successfully with no output.");
    });
  });
}

const ALL_SKILLS = [
  {
    type: "function",
    function: {
      name: "wikipedia",
      description:
        "Searches Wikipedia for factual information, summaries, and verification of claims.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search term or claim to verify.",
          },
          language: {
            type: "string",
            description:
              "Wikipedia language code (e.g. 'en', 'es'). Defaults to 'en'.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wiktionary",
      description: "Looks up definitions of words in the dictionary.",
      parameters: {
        type: "object",
        properties: {
          word: { type: "string", description: "The word to define." },
          language: {
            type: "string",
            description: "Language code. Defaults to 'en'.",
          },
        },
        required: ["word"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "duckduckgo",
      description:
        "Performs a web search using DuckDuckGo to find recent information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fact_check",
      description:
        "Checks both Wikipedia and the web to verify a specific claim or fact.",
      parameters: {
        type: "object",
        properties: {
          claim: { type: "string", description: "The claim to verify." },
          language: {
            type: "string",
            description:
              "Language code for the search (e.g. 'en', 'es'). Defaults to 'en'.",
          },
        },
        required: ["claim"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_scraper",
      description: "Reads and extracts text content from a given URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full URL to scrape." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description: "Evaluates mathematical expressions.",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "The math expression (e.g., '2 + 2 * 4').",
          },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "local_notes",
      description: "Reads or appends to your local notes file.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["read", "append"],
            description: "Action to perform.",
          },
          content: {
            type: "string",
            description: "The text to append (required if action is 'append').",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "time_and_date",
      description: "Gets the current local time, date, and day of the week.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_command",
      description: "Executes a shell command on the local machine (macOS).",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
        },
        required: ["command"],
      },
    },
  },
];

async function executeSkill(toolCall, context) {
  const name = toolCall.function.name;
  let args = {};
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch (e) {}

  switch (name) {
    case "wikipedia":
      return await executeWikipedia(args);
    case "wiktionary":
      return await executeWiktionary(args);
    case "duckduckgo":
      return await executeDuckDuckGo(args);
    case "fact_check":
      return await executeFactCheck(args);
    case "web_scraper":
      return await executeWebScraper(args);
    case "calculator":
      return await executeCalculator(args);
    case "local_notes":
      return await executeLocalNotes(args, context.dataDir);
    case "time_and_date":
      return await executeTimeAndDate();
    case "shell_command":
      return await executeShellCommand(args);
    default:
      const customSkillsFile = path.join(context.dataDir, "custom_skills.json");
      try {
        if (fs.existsSync(customSkillsFile)) {
          const skills = JSON.parse(fs.readFileSync(customSkillsFile, "utf8"));
          const skill = skills.find((s) => s.name === name);
          if (skill) {
            if (skill.type === "shell") {
              let cmd = skill.code;
              for (const [key, value] of Object.entries(args)) {
                cmd = cmd.replace(new RegExp(`{{${key}}}`, "g"), String(value));
              }
              return await executeShellCommand({ command: cmd });
            } else if (skill.type === "javascript") {
              const sandbox = { args, console, Buffer };
              vm.createContext(sandbox);
              const script = new vm.Script(`(async () => { ${skill.code} })()`);
              const result = await script.runInContext(sandbox, {
                timeout: 10000,
              });
              return typeof result === "object"
                ? JSON.stringify(result)
                : String(result);
            }
          }
        }
      } catch (e) {
        return `Custom Skill Error (${name}): ${e.message}`;
      }
      return `Unknown skill: ${name}`;
  }
}

module.exports = {
  ALL_SKILLS,
  executeSkill,
};
