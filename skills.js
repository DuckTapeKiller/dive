const {
  executePluginSkill,
  pluginSkillRequiresConfirmation,
} = require("./plugins.js");
const fs = require("fs");
const { Worker } = require("worker_threads");
const path = require("path");

// URL and filesystem guards live in skills/sandbox.js; they are shared by the
// research skills, the code skills and http_request.
const { resolveAllowedPath, globToRegex } = require("./skills/sandbox.js");
// Lessons and plugin proposals: skills that act on Dive itself.
const {
  executeRememberLesson,
  executeProposePlugin,
  lessonsFilePath,
  lessonsHeader,
  LESSON_MODES,
} = require("./skills/meta.js");
// Calculator, notes, time/date, task plan and the generic HTTP client.
const {
  executeCalculator,
  executeLocalNotes,
  executeTimeAndDate,
  executeTaskPlan,
  executeHttpRequest,
} = require("./skills/utility.js");
// Code search, git, local execution, workspace files and macOS automation.
const {
  executeCodeSearch,
  executeGitTools,
  executeRunPython,
  executeRunCode,
  executeFileOperations,
  executeShellCommand,
  executeMacosControl,
} = require("./skills/code.js");
// Encyclopaedia, dictionary, web search, page fetching, academic and book
// search — everything that answers a question from the web.
const {
  executeWikipedia,
  executeWiktionary,
  executeBritannica,
  executeDuckDuckGo,
  executeFactCheck,
  executeWebScraper,
  executeDeepResearch,
  executeAcademicSearch,
  executeFetchPaper,
  executeDeepEtymology,
  executeBookSearch,
  readUrlContent,
  reconstructOpenAlexAbstract,
  normalizeDoi,
  mergeAcademicResults,
} = require("./skills/research.js");

// ---- Web search. Uses the cloud API keys the user already saved (OpenAI /
// Anthropic / Google) for high-quality provider search, and always falls back
// to keyless DuckDuckGo scraping. Each returns [{ title, url, snippet }]. ----

// --- Academic Search Implementation ---
// Keyless federated scholarly search across OpenAlex, Crossref, arXiv,
// Semantic Scholar, and PubMed. Providers are queried in parallel and each
// failure is tolerated independently; results are merged and de-duplicated
// by DOI (then by normalized title).

// ============================================================================
// CODING & COMPUTER MANAGEMENT — code_search and git_tools are read-only and
// confined to the user-editable allowlist in ~/dive/allowed-dirs.json;
// run_python and macos_control mutate state and are confirmation-gated (see
// skillRequiresShellConfirmation). The read-only/mutating split keeps the
// name-based confirmation gate sufficient.
// ============================================================================

// ============================================================================
// TASK PLAN — a lightweight checklist the model creates at the start of a
// multi-step agent task and updates as it works. Purely in-memory (plans are
// scratch state for one session, keyed by plan id since conversation ids do
// not reach executeSkill); entries expire after 2 hours.
// ============================================================================

// plan id -> { steps, createdAt, updatedAt }

// ============================================================================
// HTTP REQUEST — agent-grade HTTP client. Unlike web_scraper (which extracts
// readable text for humans), this returns the raw response with status code
// and headers, supports every method, custom headers, request bodies, and
// per-session cookie jars so multi-step API flows (login -> fetch) work.
// SSRF-guarded like web_scraper. In-memory jars only; nothing is persisted.
// ============================================================================

// session name -> Map(host -> Map(cookieName -> value))

// ============================================================================
// RUN CODE — executes a model-written JavaScript snippet in an isolated
// worker_threads Worker with a hard timeout and memory limits. Same isolation
// caveats as custom JS skills (workers can require Node built-ins), which is
// why every call is gated behind the same explicit user confirmation as
// shell_command. Console output is captured and returned with the result.
// ============================================================================

// ============================================================================
// FILE OPERATIONS — read/write/list/find inside a dedicated workspace folder
// (DATA_DIR/workspace). Everything is confined to that folder by a resolved-
// path check, which is why this skill does not need the shell confirmation
// gate: it can touch nothing outside its sandbox.
// ============================================================================

function findCustomSkill(name, dataDir, customSkills = null) {
  // An explicitly supplied array is a request snapshot. An empty array means
  // that this mode has no custom skills; do not fall back to the legacy global
  // file and accidentally re-enable another mode's definitions.
  if (Array.isArray(customSkills)) {
    return customSkills.find((skill) => skill && skill.name === name) || null;
  }
  if (!dataDir) return null;
  const customSkillsFile = path.join(dataDir, "custom_skills.json");
  if (!fs.existsSync(customSkillsFile)) return null;
  const skills = JSON.parse(fs.readFileSync(customSkillsFile, "utf8"));
  if (!Array.isArray(skills)) return null;
  return skills.find((skill) => skill && skill.name === name) || null;
}

const GATED_BUILTIN_SKILLS = new Set([
  "shell_command",
  "run_code",
  "run_python",
  "macos_control",
]);

function skillRequiresShellConfirmation(name, dataDir, context = {}) {
  if (GATED_BUILTIN_SKILLS.has(name)) return true;
  try {
    if (pluginSkillRequiresConfirmation(name, context.pluginSkills))
      return true;
    return (
      findCustomSkill(name, dataDir, context.customSkills)?.type === "shell"
    );
  } catch (_error) {
    return false;
  }
}

const ALL_SKILLS = [
  {
    type: "function",
    function: {
      name: "wikipedia",
      description:
        "Looks up a single Wikipedia article summary. Use ONLY when the user explicitly asks for Wikipedia. For general factual, biographical, or research questions, use deep_research instead (it reads Wikipedia AND several other independent sources in one step).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search term" },
          language: {
            type: "string",
            description:
              "Language code (e.g., en, es). Other editions are consulted automatically when the requested one has no exact title match.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "britannica",
      description:
        "Searches Encyclopedia Britannica for factual information. Unless the user specifically asks for another source, ALWAYS check Wikipedia AND Britannica for general queries to cross-reference.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search term" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "book_search",
      description:
        "Searches a net of book providers (Open Library, Google Books, Goodreads, StoryGraph, and configured Hardcover/LibraryThing/Calibre) in parallel for book metadata, merges the results and returns a ready-made markdown table plus description and sources. Use for any question about a book's publication details, editions or metadata. The query can be a title, an author, or an ISBN. IMPORTANT: this tool's output is already formatted for the user — reproduce the returned markdown table (and description) VERBATIM in your reply; do not paraphrase it into prose.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Book title, author name, or ISBN (10 or 13 digits)",
          },
          language: {
            type: "string",
            description: "Optional 2-letter language preference, e.g. 'es'",
          },
          provider: {
            type: "string",
            description:
              "Optional: restrict to one source (openlibrary, google, goodreads, storygraph, hardcover, librarything, calibre)",
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
        "Quick web search that returns a numbered list of results (title, snippet, URL). Use for a single lookup. For any 'who/what is', biographical, or research question that needs a THOROUGH answer, use the deep_research skill instead. Never repeat the same query twice.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The web search query." },
          max_results: {
            type: "number",
            description: "How many results to return (1-10, default 6).",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deep_research",
      description:
        "PREFERRED for any factual, biographical, current-events, or 'who/what is X' question. In ONE call it searches the web across multiple angles and reads several independent sources (different websites), returning their full content plus every source URL. For thorough coverage, pass 'queries' with 2-4 VARIED angles (different phrasing and scope), e.g. ['Dean Benedetti biography', 'Dean Benedetti Charlie Parker recordings', 'Dean Benedetti jazz history'] — not one query. After it returns, write a comprehensive, multi-paragraph answer that synthesizes ALL the sources.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A single research topic/question. Prefer 'queries' with multiple angles for thorough research.",
          },
          queries: {
            type: "array",
            items: { type: "string" },
            description:
              "2-4 varied search angles (different phrasing/scope) for broad coverage. Preferred over a single query.",
          },
          max_sources: {
            type: "number",
            description: "How many sources to read (4-8, default 6).",
          },
          academic: {
            type: "boolean",
            description:
              "Set true for scholarly topics: seeds the source pool with peer-reviewed papers (OpenAlex/Crossref/arXiv/Semantic Scholar/PubMed) and prefers .edu/.gov/journal domains.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "academic_search",
      description:
        "PREFERRED for scholarly/scientific questions: searches OpenAlex, Crossref, arXiv, Semantic Scholar, and PubMed in one keyless call and returns merged, de-duplicated papers with authors, year, venue, DOI, citation counts, abstracts, and open-access PDF links. Use for literature reviews, 'what does the research say about X', finding papers by topic/author, or verifying scientific claims. Follow up with fetch_paper on the most relevant open-access results, then answer citing authors and years.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Scholarly search query (topic, phenomenon, author, paper title). English queries get the best coverage.",
          },
          year_from: {
            type: "number",
            description: "Earliest publication year to include.",
          },
          year_to: {
            type: "number",
            description: "Latest publication year to include.",
          },
          max_results: {
            type: "number",
            description: "How many papers to return (3-25, default 12).",
          },
          providers: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional subset of providers: openalex, crossref, arxiv, semanticscholar, pubmed. Omit to query all.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_paper",
      description:
        "Fetches a scientific paper by DOI, arXiv link, or URL: resolves its metadata, reads the full text or abstract, and saves the open-access PDF into workspace/papers/ when one exists. Use after academic_search to actually read the papers you plan to cite.",
      parameters: {
        type: "object",
        properties: {
          url_or_doi: {
            type: "string",
            description:
              "A DOI (10.xxxx/...), a doi.org URL, an arXiv abs/pdf URL, or any paper landing-page/PDF URL.",
          },
          save: {
            type: "boolean",
            description:
              "Save the open-access PDF into workspace/papers/ (default true).",
          },
        },
        required: ["url_or_doi"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deep_etymology",
      description: `Cross-references multiple authoritative etymology and dictionary sources. Use this to determine word origins, cognates, false cognates, and false friends.
      
RULES:
1. Cognate: Same form, shared etymology (meaning doesn't matter).
2. False Cognate: Same form, NO shared etymology (meaning doesn't matter).
3. False Friend: Same form, NO shared meaning (etymology doesn't matter).

When asked about these relationships, ALWAYS query both words and explain the distinction using these rules.`,
      parameters: {
        type: "object",
        properties: {
          word: { type: "string", description: "The word to look up" },
          language: {
            type: "string",
            description: "Language code (en, es, fr)",
          },
        },
        required: ["word", "language"],
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
      description:
        "Fetches a URL and returns its clean main text/markdown (no nav/ads). Use this after the duckduckgo skill to read a result you selected, then answer the user from what you read.",
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
      name: "remember_lesson",
      description:
        "Permanently saves a short lesson, correction, or preference the user taught you (e.g. formatting rules, terminology, standing instructions). The lesson is injected into your system prompt in every future conversation of the CURRENT mode only (each mode keeps independent lessons). Use when the user corrects you or says something like 'remember this' or 'from now on'.",
      parameters: {
        type: "object",
        properties: {
          lesson: {
            type: "string",
            description:
              "The lesson as one short imperative sentence, e.g. 'Always answer in Spanish unless asked otherwise.'",
          },
        },
        required: ["lesson"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_plugin",
      description:
        "Drafts a new Dive plugin (a reusable skill) for the user to review. The draft is saved DISABLED and only becomes active after the user approves it in Settings > Skills > Plugins. Use when the user asks you to build a new tool/skill/capability for the app.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Plugin name in kebab-case, e.g. 'weather-lookup'",
          },
          description: {
            type: "string",
            description: "One sentence: what the plugin does.",
          },
          code: {
            type: "string",
            description:
              "Complete CommonJS module source for index.js following the Dive plugin format: module.exports = { skills: [{ name, description, parameters, async execute(args, context) { ... } }] }. No external npm dependencies.",
          },
        },
        required: ["name", "description", "code"],
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
      description:
        "Gets the current time, date, and day of the week. If you need the time for a specific city, you MUST provide its standard IANA Time Zone string (e.g. 'Australia/Sydney', 'Europe/Paris', 'America/New_York'). If you don't provide a timezone, it returns the user's local time.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description:
              "Optional. The IANA Time Zone string (e.g. 'Australia/Sydney').",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_command",
      description:
        "Executes a shell command on the local machine (macOS). Default timeout is 5 seconds — pass timeout_seconds for longer work (max 300). cwd sets the working directory (home or an allowed directory).",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute.",
          },
          timeout_seconds: {
            type: "number",
            description: "Timeout in seconds (default 5, max 300).",
          },
          cwd: {
            type: "string",
            description:
              "Working directory (absolute or ~/ path inside home or the allowed directories). Defaults to the home directory.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "http_request",
      description:
        "Full-control HTTP client for calling APIs: any method, custom headers (auth tokens, API keys, Accept), request body, timeout, and optional named cookie sessions that persist across calls (login then fetch). Returns the status code, key response headers, and the raw body (JSON pretty-printed). Use this for REST/JSON APIs and endpoints that need specific headers; use web_scraper instead when you just want the readable text of a web page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full URL to request." },
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
            description: "HTTP method. Defaults to GET.",
          },
          headers: {
            type: "object",
            description:
              'Request headers, e.g. {"Authorization": "Bearer ...", "Accept": "application/json"}.',
          },
          body: {
            type: ["string", "object"],
            description:
              "Request body. Objects are sent as JSON with Content-Type application/json.",
          },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds (1000-60000, default 15000).",
          },
          follow_redirects: {
            type: "boolean",
            description:
              "Follow 3xx redirects (default true). Set false to inspect the redirect response itself.",
          },
          session: {
            type: "string",
            description:
              "Optional cookie-session name. Calls sharing the same name share cookies (Set-Cookie is stored and replayed), enabling login flows.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_code",
      description:
        "Executes a JavaScript (Node.js) snippet in an isolated worker and returns its console output and return value. Use it to parse or transform data, run real calculations or simulations, test logic, or format output — anything too complex for the calculator. The snippet runs inside an async function: use console.log(...) for output and 'return' for a final value; await is allowed. Each call requires the user's explicit confirmation.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description:
              "The JavaScript code to run. Log results with console.log or end with a return statement.",
          },
          timeout_ms: {
            type: "number",
            description: "Timeout in milliseconds (1000-60000, default 15000).",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_operations",
      description:
        "Reads, writes and organizes files inside a dedicated workspace folder (sandboxed; it cannot touch anything outside it). Use it to save reports or drafts, keep scratch data between steps, and read files back later. Actions: list, read, write, append, delete, mkdir, info, and find (glob pattern like '*.md'). Paths are relative to the workspace root.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "list",
              "read",
              "write",
              "append",
              "delete",
              "mkdir",
              "info",
              "find",
            ],
            description: "The operation to perform.",
          },
          path: {
            type: "string",
            description:
              "Path relative to the workspace root, e.g. 'reports/summary.md'. Defaults to the root.",
          },
          content: {
            type: "string",
            description: "Text to write (required for write/append).",
          },
          pattern: {
            type: "string",
            description: "Filename glob for find, e.g. '*.json' (default '*').",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "task_plan",
      description:
        "Tracks a checklist for multi-step tasks. At the START of any task needing 3+ steps, call with action:'create' and steps:[...] (short imperative phrases); it returns a plan id. After finishing each step call action:'update' with plan_id, step (number), and status done/failed/skipped (optional note). action:'show' redisplays the checklist. Keeps you on track and shows the user your progress.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "update", "show"],
            description: "The plan operation.",
          },
          steps: {
            type: "array",
            items: { type: "string" },
            description: "Step descriptions for create (max 20).",
          },
          plan_id: {
            type: "string",
            description: "Plan id returned by create (for update/show).",
          },
          step: {
            type: "number",
            description: "1-based step number for update.",
          },
          status: {
            type: "string",
            enum: ["done", "failed", "skipped"],
            description: "New status for the step (default done).",
          },
          note: {
            type: "string",
            description: "Short note about the outcome of the step.",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_search",
      description:
        "Read-only exploration of code and text files in the user's allowed directories (~/dive/workspace plus anything listed in ~/dive/allowed-dirs.json). Actions: grep (regex search across files, optional glob filter), find (locate files by glob), read (show a file with line numbers, optional start_line/end_line), tree (directory listing, 3 levels). Use this to understand a codebase before proposing changes; use file_operations to write inside the workspace and shell_command for anything else.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["grep", "find", "read", "tree"],
            description: "The operation to perform.",
          },
          path: {
            type: "string",
            description:
              "Absolute or ~/ path to the file or directory to operate on. Defaults to ~/dive/workspace.",
          },
          pattern: {
            type: "string",
            description: "Regex for grep (case-insensitive).",
          },
          glob: {
            type: "string",
            description:
              "Filename glob, e.g. '*.py' or '**/config*'. Filters grep, or is the target of find.",
          },
          start_line: {
            type: "number",
            description: "First line for read (1-based).",
          },
          end_line: { type: "number", description: "Last line for read." },
          max_results: {
            type: "number",
            description: "Cap on grep/find matches (default 50, max 200).",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_tools",
      description:
        "Read-only git inspection of a repository inside the allowed directories: status, log, diff, show, branch, blame. Never modifies the repository — for commits or other mutating git commands use shell_command (which asks the user first). Use path_filter to focus log/diff/blame on one file.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "log", "diff", "show", "branch", "blame"],
            description: "The git query to run.",
          },
          repo: {
            type: "string",
            description:
              "Absolute or ~/ path to the repository (must be inside the allowed directories).",
          },
          ref: {
            type: "string",
            description:
              "Commit/branch/range for diff or show, e.g. 'HEAD~3' or 'main..feature'.",
          },
          path_filter: {
            type: "string",
            description: "Restrict log/diff/blame to this file or directory.",
          },
          count: {
            type: "number",
            description: "Number of log entries (default 20, max 100).",
          },
          start_line: {
            type: "number",
            description: "First line for blame.",
          },
          end_line: { type: "number", description: "Last line for blame." },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_python",
      description:
        "Runs a Python script with the system python3 (or the venv configured in ~/dive/coding-settings.json as pythonVenv) and returns stdout/stderr. The user must approve each run. Use for data processing, calculations beyond the calculator skill, and quick scripts; the script file itself is temporary, so write any outputs you need to keep into the workspace via absolute paths or use file_operations afterwards.",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "The complete Python source to execute.",
          },
          timeout_seconds: {
            type: "number",
            description: "Execution timeout (default 30, max 120).",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "macos_control",
      description:
        "Controls the user's Mac (each action needs user approval): run_applescript (osascript), open (file/URL/app, optional app name), notify (notification with title/message), list_processes (optional filter), kill_process (pid, optional force). Use only when the user asks to control apps, open things, or manage processes.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "run_applescript",
              "open",
              "notify",
              "list_processes",
              "kill_process",
            ],
            description: "The control action to perform.",
          },
          script: {
            type: "string",
            description: "AppleScript source for run_applescript.",
          },
          target: {
            type: "string",
            description: "File path, URL, or app name for open.",
          },
          app: {
            type: "string",
            description: "Application to open the target with.",
          },
          title: { type: "string", description: "Notification title." },
          message: { type: "string", description: "Notification message." },
          filter: {
            type: "string",
            description: "Substring filter for list_processes.",
          },
          pid: { type: "number", description: "Process id for kill_process." },
          force: {
            type: "boolean",
            description: "Use SIGKILL instead of SIGTERM.",
          },
        },
        required: ["action"],
      },
    },
  },
];

/**
 * Runs a custom JavaScript skill in an isolated worker_threads Worker.
 *
 * SECURITY NOTE: worker_threads provides memory/CPU isolation and a hard
 * timeout, but is NOT a complete security sandbox — the worker can still
 * require Node.js built-in modules. Only execute code from sources you fully
 * trust. Do NOT run untrusted third-party custom skill code here.
 */
function runCustomJsSkill(code, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    // Inline worker code as a string evaluated with eval:true
    const workerSrc = `
      const { parentPort, workerData } = require('worker_threads');
      (async () => {
        const args = workerData.args;
        ${code}
      })()
        .then(result => parentPort.postMessage({ ok: true, result }))
        .catch(err => parentPort.postMessage({ ok: false, error: err.message || String(err) }));
    `;
    let worker;
    try {
      worker = new Worker(workerSrc, {
        eval: true,
        workerData: { args },
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
        },
      });
    } catch (e) {
      return reject(new Error(`Failed to start worker: ${e.message}`));
    }

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("Custom JS skill timed out after " + timeoutMs + "ms"));
    }, timeoutMs);

    worker.on("message", ({ ok, result, error }) => {
      clearTimeout(timer);
      worker.terminate();
      if (ok) {
        resolve(
          typeof result === "object"
            ? JSON.stringify(result)
            : String(result ?? ""),
        );
      } else {
        reject(new Error(error || "Custom JS skill failed"));
      }
    });
    worker.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(new Error(`Custom JS skill worker exited with code ${code}`));
    });
  });
}

// ============================================================================
// BOOK SEARCH — port of the global-book-search Obsidian plugin (same author).
// A net of providers searched in parallel, results grouped by work, editions
// scored, fields merged with per-field source priority and conflict notes,
// then mutually enriched (missing description/cover/pages filled from the
// other sources). Keyless: Open Library, Google Books, Goodreads, StoryGraph.
// Config-gated (book-search.json in the data dir): Hardcover token,
// LibraryThing Talpa token, Calibre server, Google API key.
// ============================================================================

// --- Providers -------------------------------------------------------------

// --- Orchestration ----------------------------------------------------------

// Files written before v4 carried this description as a plain (non-comment)
// line; skip it so an old file never injects its own header as a lesson.
const LEGACY_LESSONS_HEADER_RE =
  /^Lines starting with "- " are injected into the system prompt/;

function readLessons(dataDir, mode) {
  try {
    const text = fs.readFileSync(lessonsFilePath(dataDir, mode), "utf8");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) =>
          line && !line.startsWith("#") && !LEGACY_LESSONS_HEADER_RE.test(line),
      )
      .map((line) => (line.startsWith("- ") ? line : `- ${line}`))
      .join("\n");
  } catch {
    return "";
  }
}

// One-time migration: the old single lessons.md applied to all non-Pi modes,
// so its lessons are seeded into every mode file; the original is kept as a
// backup, never deleted.
function migrateLegacyLessons(dataDir) {
  const legacy = path.join(dataDir, "lessons.md");
  try {
    if (!fs.existsSync(legacy)) return;
    const lines = fs
      .readFileSync(legacy, "utf8")
      .split("\n")
      .filter((line) => line.trim().startsWith("- "));
    fs.mkdirSync(path.join(dataDir, "lessons"), { recursive: true });
    for (const mode of LESSON_MODES) {
      const file = lessonsFilePath(dataDir, mode);
      let current = "";
      try {
        current = fs.readFileSync(file, "utf8");
      } catch {
        current = lessonsHeader(mode);
      }
      const missing = lines.filter((line) => !current.includes(line));
      if (missing.length) {
        fs.writeFileSync(
          file,
          current.trimEnd() + "\n" + missing.join("\n") + "\n",
          "utf8",
        );
      }
    }
    fs.renameSync(legacy, `${legacy}.migrated-backup`);
    console.log(
      `[lessons] migrated ${lines.length} legacy lessons into per-mode files`,
    );
  } catch (e) {
    console.error("Lesson migration failed:", e.message || e);
  }
}

async function executeSkill(toolCall, context = {}) {
  const name = toolCall.function.name;
  const builtinName = ALL_SKILLS.some(
    (skill) => skill.function && skill.function.name === name,
  );
  if (
    builtinName &&
    context.skillsConfig &&
    context.skillsConfig[name] === false
  ) {
    return `Error: skill "${name}" is disabled for ${context.mode || "this"} mode.`;
  }
  let args = {};
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch (error) {
    // The model emitted arguments that are not valid JSON. Running the skill
    // with {} makes it fail further down with an unrelated-looking message, so
    // say plainly what happened.
    console.warn(
      `[skills] ${name}: could not parse tool arguments, running with none:`,
      error.message,
    );
  }

  switch (name) {
    case "wikipedia":
      return await executeWikipedia(args);
    case "britannica":
      return await executeBritannica(args, context);
    case "book_search":
      return await executeBookSearch(args, context);
    case "wiktionary":
      return await executeWiktionary(args);
    case "deep_etymology":
      return await executeDeepEtymology(args);
    case "duckduckgo":
      return await executeDuckDuckGo(args, context);
    case "deep_research":
      return await executeDeepResearch(args, context);
    case "academic_search":
      return await executeAcademicSearch(args);
    case "fetch_paper":
      return await executeFetchPaper(args, context);
    case "fact_check":
      return await executeFactCheck(args, context);
    case "web_scraper":
      return await executeWebScraper(args);
    case "calculator":
      return await executeCalculator(args);
    case "local_notes":
      return await executeLocalNotes(args, context.dataDir);
    case "remember_lesson":
      return await executeRememberLesson(args, context.dataDir, context.mode);
    case "propose_plugin":
      return await executeProposePlugin(args, context.dataDir);
    case "time_and_date":
      return await executeTimeAndDate(args);
    case "shell_command":
      if (!context.allowShellCommand) {
        return "Error: shell command execution requires explicit user confirmation.";
      }
      return await executeShellCommand(args);
    case "http_request":
      return await executeHttpRequest(args);
    case "run_code":
      if (!context.allowShellCommand) {
        return "Error: code execution requires explicit user confirmation.";
      }
      return await executeRunCode(args);
    case "run_python":
      if (!context.allowShellCommand) {
        return "Error: Python execution requires explicit user confirmation.";
      }
      return await executeRunPython(args, context.dataDir);
    case "macos_control":
      if (!context.allowShellCommand) {
        return "Error: macOS control requires explicit user confirmation.";
      }
      return await executeMacosControl(args);
    case "code_search":
      return await executeCodeSearch(args);
    case "task_plan":
      return executeTaskPlan(args);
    case "git_tools":
      return await executeGitTools(args);
    case "file_operations":
      return await executeFileOperations(args, context.dataDir);
    default: {
      // Plugin skills (loaded from ~/dive/plugins) take precedence over the
      // UI-defined custom skills; executePluginSkill returns null when no
      // plugin registered this name.
      const pluginResult = await executePluginSkill(name, args, context);
      if (pluginResult !== null) return pluginResult;
      try {
        const skill = findCustomSkill(
          name,
          context.dataDir,
          context.customSkills,
        );
        if (skill) {
          if (skill.type === "shell") {
            if (!context.allowShellCommand) {
              return "Error: shell command execution requires explicit user confirmation.";
            }
            let cmd = skill.code;
            for (const [key, value] of Object.entries(args)) {
              // Shell-escape each substituted value to prevent injection
              const escaped = "'" + String(value).replace(/'/g, "'\\''") + "'";
              cmd = cmd.replace(new RegExp(`{{${key}}}`, "g"), escaped);
            }
            return await executeShellCommand({ command: cmd });
          } else if (skill.type === "javascript") {
            // WARNING: Custom JavaScript skills run in a worker_threads Worker.
            // worker_threads provides memory/CPU isolation but is NOT a full
            // security sandbox — the worker has access to Node.js built-ins.
            // Only use custom JS skills with code you fully trust.
            return await runCustomJsSkill(skill.code, args);
          }
        }
      } catch (e) {
        return `Custom Skill Error (${name}): ${e.message}`;
      }
      return `Unknown skill: ${name}`;
    }
  }
}

module.exports = {
  lessonsFilePath,
  readLessons,
  migrateLegacyLessons,
  LESSON_MODES,
  ALL_SKILLS,
  executeSkill,
  skillRequiresShellConfirmation,
  // Exported for unit tests.
  readUrlContent,
  reconstructOpenAlexAbstract,
  normalizeDoi,
  mergeAcademicResults,
  resolveAllowedPath,
  globToRegex,
};
