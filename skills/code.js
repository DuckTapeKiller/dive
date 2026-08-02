"use strict";

// Skills that read the user's code and drive local tooling: code search,
// read-only git, Python and JS execution, workspace file operations, shell
// commands and macOS automation.
//
// Every path these take is resolved through skills/sandbox.js — either against
// the user's declared allowed directories or the skill workspace. The gated
// ones (shell_command, run_python, run_code, macos_control) additionally
// require interactive confirmation, which skills.js enforces before dispatch.
//
// Moved out of skills.js unchanged.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { exec, execFile } = require("child_process");
const { Worker } = require("worker_threads");
const {
  expandHomePath,
  resolveAllowedPath,
  globToRegex,
  resolveWorkspacePath,
} = require("./sandbox.js");

async function executeShellCommand({ command, timeout_seconds, cwd }) {
  console.warn(`[shell_command] Executing: ${String(command).slice(0, 200)}`);
  const timeoutMs =
    Math.max(1, Math.min(Number(timeout_seconds) || 5, 300)) * 1000;
  let workDir = os.homedir();
  if (cwd && String(cwd).trim()) {
    const resolved = resolveAllowedPath(String(cwd).trim(), {
      allowHome: true,
    });
    if (resolved.error) return `Shell Command Error: cwd — ${resolved.error}`;
    workDir = resolved.target;
  }
  return new Promise((resolve) => {
    exec(
      command,
      { timeout: timeoutMs, cwd: workDir, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let output = "";
        if (stdout) output += `STDOUT:\n${stdout}\n`;
        if (stderr) output += `STDERR:\n${stderr}\n`;
        if (error) output += `ERROR:\n${error.message}\n`;
        resolve(output || "Command executed successfully with no output.");
      },
    );
  });
}

const CODING_SETTINGS_FILE = path.join(
  os.homedir(),
  "dive",
  "coding-settings.json",
);

const CODE_SEARCH_MAX_MATCHES = 200;

const CODE_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;

const CODE_SEARCH_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  ".next",
  "target",
]);

function walkAllowedTree(dir, onFile, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || CODE_SEARCH_SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (walkAllowedTree(full, onFile, depth + 1) === false) return false;
    } else if (entry.isFile()) {
      if (onFile(full) === false) return false;
    }
  }
}

async function executeCodeSearch({
  action,
  path: targetPath,
  pattern,
  glob,
  start_line,
  end_line,
  max_results,
}) {
  const act = ["grep", "find", "read", "tree"].includes(action) ? action : null;
  if (!act) {
    return "Code Search Error: action must be grep, find, read, or tree.";
  }
  const resolved = resolveAllowedPath(targetPath || "~/dive/workspace");
  if (resolved.error) return `Code Search Error: ${resolved.error}`;
  const target = resolved.target;
  const cap = Math.max(
    1,
    Math.min(Number(max_results) || 50, CODE_SEARCH_MAX_MATCHES),
  );

  try {
    if (act === "read") {
      const stat = fs.statSync(target);
      if (!stat.isFile()) return `Code Search Error: not a file: ${target}`;
      if (stat.size > CODE_SEARCH_MAX_FILE_BYTES) {
        return `Code Search Error: file exceeds ${CODE_SEARCH_MAX_FILE_BYTES / 1024 / 1024} MB; read a line range of a smaller file.`;
      }
      const lines = fs.readFileSync(target, "utf8").split("\n");
      const from = Math.max(1, Number(start_line) || 1);
      const to = Math.min(lines.length, Number(end_line) || from + 399);
      const body = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)}  ${l}`)
        .join("\n");
      return `## ${target} (lines ${from}-${to} of ${lines.length})\n\n${body}`;
    }

    if (act === "tree") {
      const stat = fs.statSync(target);
      if (!stat.isDirectory())
        return `Code Search Error: not a directory: ${target}`;
      const rows = [];
      const list = (dir, prefix, depth) => {
        if (depth > 3 || rows.length >= 300) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (
            entry.name.startsWith(".") ||
            CODE_SEARCH_SKIP_DIRS.has(entry.name)
          )
            continue;
          if (rows.length >= 300) return;
          rows.push(`${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
          if (entry.isDirectory())
            list(path.join(dir, entry.name), prefix + "  ", depth + 1);
        }
      };
      list(target, "", 0);
      return `## ${target}\n\n${rows.join("\n") || "(empty)"}${rows.length >= 300 ? "\n… (truncated at 300 entries)" : ""}`;
    }

    if (act === "find") {
      if (!glob && !pattern) {
        return "Code Search Error: find needs a glob (e.g. '*.py' or '**/config*').";
      }
      const rx = globToRegex(glob || pattern);
      const hits = [];
      walkAllowedTree(target, (file) => {
        if (rx.test(file)) hits.push(file);
        if (hits.length >= cap) return false;
      });
      return hits.length
        ? `## find ${glob || pattern} under ${target} (${hits.length} matches)\n\n${hits.join("\n")}`
        : `No files matching ${glob || pattern} under ${target}.`;
    }

    // act === "grep"
    if (!pattern) return "Code Search Error: grep needs a pattern (regex).";
    let rx;
    try {
      rx = new RegExp(pattern, "i");
    } catch (e) {
      return `Code Search Error: invalid regex — ${e.message}`;
    }
    const fileFilter = glob ? globToRegex(glob) : null;
    const hits = [];
    const stat = fs.statSync(target);
    const scanFile = (file) => {
      if (fileFilter && !fileFilter.test(file)) return;
      let statF;
      try {
        statF = fs.statSync(file);
      } catch {
        return;
      }
      if (statF.size > CODE_SEARCH_MAX_FILE_BYTES) return;
      let content;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch {
        return;
      }
      if (content.includes("\u0000")) return; // binary
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (rx.test(lines[i])) {
          hits.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= cap) return false;
        }
      }
    };
    if (stat.isFile()) scanFile(target);
    else walkAllowedTree(target, scanFile);
    return hits.length
      ? `## grep /${pattern}/ under ${target} (${hits.length} matches${hits.length >= cap ? ", capped" : ""})\n\n${hits.join("\n")}`
      : `No matches for /${pattern}/ under ${target}.`;
  } catch (e) {
    return `Code Search Error: ${e.message}`;
  }
}

// Read-only git subcommands via argv arrays — no shell, no mutation. Anything
// that writes (commit, push, checkout, …) must go through the gated
// shell_command skill instead.
const GIT_READONLY_ACTIONS = {
  status: () => ["status", "--short", "--branch"],
  log: (a) => [
    "log",
    `--max-count=${Math.max(1, Math.min(Number(a.count) || 20, 100))}`,
    "--oneline",
    "--decorate",
    ...(a.path_filter ? ["--", String(a.path_filter)] : []),
  ],
  diff: (a) => [
    "diff",
    ...(a.ref ? [String(a.ref)] : []),
    "--stat",
    "--patch",
    ...(a.path_filter ? ["--", String(a.path_filter)] : []),
  ],
  show: (a) => ["show", "--stat", "--patch", String(a.ref || "HEAD")],
  branch: () => ["branch", "--all", "--verbose"],
  blame: (a) => [
    "blame",
    ...(a.start_line && a.end_line
      ? ["-L", `${Number(a.start_line)},${Number(a.end_line)}`]
      : []),
    "--",
    String(a.path_filter || ""),
  ],
};

async function executeGitTools(args) {
  const action = GIT_READONLY_ACTIONS[args.action] ? args.action : null;
  if (!action) {
    return `Git Tools Error: action must be one of ${Object.keys(GIT_READONLY_ACTIONS).join(", ")}.`;
  }
  if (action === "blame" && !args.path_filter) {
    return "Git Tools Error: blame requires path_filter (the file to blame).";
  }
  const resolved = resolveAllowedPath(args.repo || "~/dive/workspace");
  if (resolved.error) return `Git Tools Error: ${resolved.error}`;
  // Refs and paths become argv entries, never shell text; reject option-like
  // values so they cannot be smuggled in as git flags.
  for (const field of ["ref", "path_filter"]) {
    if (args[field] && String(args[field]).startsWith("-")) {
      return `Git Tools Error: ${field} must not start with '-'.`;
    }
  }
  const gitArgs = GIT_READONLY_ACTIONS[action](args).filter(Boolean);
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", resolved.target, "--no-pager", ...gitArgs],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve(
            `Git Tools Error: ${(stderr || error.message).trim().slice(0, 2000)}`,
          );
          return;
        }
        const body = String(stdout || "").slice(0, 40000);
        resolve(
          `## git ${gitArgs.join(" ")} @ ${resolved.target}\n\n${body || "(no output)"}${stderr ? `\n\nstderr:\n${String(stderr).slice(0, 1000)}` : ""}`,
        );
      },
    );
  });
}

function loadCodingSettings() {
  try {
    return JSON.parse(fs.readFileSync(CODING_SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function executeRunPython({ code, timeout_seconds }, dataDir) {
  if (!code || !String(code).trim()) {
    return "Run Python Error: no code provided.";
  }
  const timeoutMs =
    Math.max(1, Math.min(Number(timeout_seconds) || 30, 120)) * 1000;
  const settings = loadCodingSettings();
  let python = "python3";
  if (settings.pythonVenv) {
    const candidate = path.join(
      expandHomePath(settings.pythonVenv),
      "bin",
      "python3",
    );
    if (fs.existsSync(candidate)) python = candidate;
  }
  const runDir = path.join(
    dataDir || path.join(os.homedir(), "dive"),
    "workspace",
    ".run",
  );
  fs.mkdirSync(runDir, { recursive: true });
  const scriptPath = path.join(
    runDir,
    `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.py`,
  );
  fs.writeFileSync(scriptPath, String(code), "utf8");
  return new Promise((resolve) => {
    execFile(
      python,
      [scriptPath],
      {
        timeout: timeoutMs,
        cwd: path.dirname(runDir),
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
        },
      },
      (error, stdout, stderr) => {
        fs.rmSync(scriptPath, { force: true });
        let output = "";
        if (stdout) output += `STDOUT:\n${String(stdout).slice(0, 20000)}\n`;
        if (stderr) output += `STDERR:\n${String(stderr).slice(0, 8000)}\n`;
        if (error) {
          output += error.killed
            ? `ERROR: timed out after ${timeoutMs / 1000}s\n`
            : `ERROR: exit ${error.code}\n`;
        }
        resolve(output || "Python script ran with no output.");
      },
    );
  });
}

const MACOS_CONTROL_ACTIONS = new Set([
  "run_applescript",
  "open",
  "notify",
  "list_processes",
  "kill_process",
]);

async function executeMacosControl(args) {
  const action = MACOS_CONTROL_ACTIONS.has(args.action) ? args.action : null;
  if (!action) {
    return `macOS Control Error: action must be one of ${[...MACOS_CONTROL_ACTIONS].join(", ")}.`;
  }
  const run = (cmd, argv, timeout = 30000) =>
    new Promise((resolve) => {
      execFile(
        cmd,
        argv,
        { timeout, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({
            code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            stdout: String(stdout || ""),
            stderr: String(stderr || (error && error.message) || ""),
          });
        },
      );
    });
  try {
    switch (action) {
      case "run_applescript": {
        if (!args.script || !String(args.script).trim()) {
          return "macOS Control Error: run_applescript needs script.";
        }
        const r = await run("osascript", ["-e", String(args.script)], 60000);
        return r.code === 0
          ? `AppleScript result:\n${r.stdout.trim() || "(no output)"}`
          : `AppleScript failed:\n${r.stderr.trim().slice(0, 2000)}`;
      }
      case "open": {
        const target = String(args.target || "").trim();
        if (!target) {
          return "macOS Control Error: open needs target (file path, URL, or app name).";
        }
        const argv = args.app
          ? ["-a", String(args.app), expandHomePath(target)]
          : /^[a-z]+:\/\//i.test(target)
            ? [target]
            : [expandHomePath(target)];
        const r = await run("open", argv);
        return r.code === 0
          ? `Opened ${target}${args.app ? ` with ${args.app}` : ""}.`
          : `Open failed: ${r.stderr.trim().slice(0, 1000)}`;
      }
      case "notify": {
        const message = String(args.message || "").trim();
        if (!message) return "macOS Control Error: notify needs message.";
        const esc = (s) =>
          String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `display notification "${esc(message)}" with title "${esc(args.title || "Dive")}"`;
        const r = await run("osascript", ["-e", script]);
        return r.code === 0
          ? "Notification shown."
          : `Notify failed: ${r.stderr.trim()}`;
      }
      case "list_processes": {
        const r = await run("ps", ["aux", "-r"]);
        const lines = r.stdout.split("\n");
        const filter = args.filter ? String(args.filter).toLowerCase() : "";
        const kept = filter
          ? [
              lines[0],
              ...lines.slice(1).filter((l) => l.toLowerCase().includes(filter)),
            ]
          : lines;
        return `## Processes${filter ? ` matching "${args.filter}"` : " (top CPU)"}\n\n${kept.slice(0, 40).join("\n")}`;
      }
      case "kill_process": {
        const pid = Number(args.pid);
        if (!Number.isInteger(pid) || pid <= 1) {
          return "macOS Control Error: kill_process needs a valid pid.";
        }
        const r = await run("kill", [args.force ? "-9" : "-15", String(pid)]);
        return r.code === 0
          ? `Sent ${args.force ? "SIGKILL" : "SIGTERM"} to PID ${pid}.`
          : `Kill failed: ${r.stderr.trim() || "process may not exist or belongs to another user"}`;
      }
      default:
        return "macOS Control Error: unsupported action.";
    }
  } catch (e) {
    return `macOS Control Error: ${e.message}`;
  }
}

function executeRunCode({ code, timeout_ms }) {
  const source = String(code || "");
  if (!source.trim()) {
    return Promise.resolve("Run Code Error: no code provided.");
  }
  const timeout = Math.max(1000, Math.min(Number(timeout_ms) || 15000, 60000));
  return new Promise((resolve) => {
    const workerSrc = `
      const { parentPort } = require('worker_threads');
      const logs = [];
      const fmt = (v) => {
        if (typeof v === 'string') return v;
        try { return JSON.stringify(v); } catch { return String(v); }
      };
      for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        console[level] = (...a) => logs.push(a.map(fmt).join(' '));
      }
      (async () => {
        ${source}
      })()
        .then((result) => parentPort.postMessage({ ok: true, result, logs }))
        .catch((err) => parentPort.postMessage({
          ok: false, error: (err && err.stack) || String(err), logs,
        }));
    `;
    let worker;
    try {
      worker = new Worker(workerSrc, {
        eval: true,
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32,
        },
      });
    } catch (e) {
      return resolve(`Run Code Error: failed to start worker: ${e.message}`);
    }
    const finish = (text) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(text);
    };
    const timer = setTimeout(
      () => finish(`Run Code Error: timed out after ${timeout}ms.`),
      timeout,
    );
    worker.on("message", ({ ok, result, logs, error }) => {
      let out = "";
      if (logs && logs.length) out += `Console output:\n${logs.join("\n")}\n\n`;
      if (ok) {
        const value =
          result === undefined
            ? ""
            : typeof result === "object"
              ? JSON.stringify(result, null, 2)
              : String(result);
        if (value) out += `Return value:\n${value}`;
        finish(
          out.trim() ||
            "Code ran successfully with no output. Use console.log or a return statement to produce output.",
        );
      } else {
        finish((out + `Error:\n${error}`).trim());
      }
    });
    worker.on("error", (err) => finish(`Run Code Error: ${err.message}`));
    worker.on("exit", (exitCode) => {
      if (exitCode !== 0)
        finish(`Run Code Error: worker exited with code ${exitCode}.`);
    });
  });
}

const FILE_READ_MAX_CHARS = 50000;

const FILE_FIND_MAX_RESULTS = 100;

function walkWorkspace(dir, root, matcher, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= FILE_FIND_MAX_RESULTS) return;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (matcher(entry.name)) {
      results.push(
        path.relative(root, full) + (entry.isDirectory() ? "/" : ""),
      );
    }
    if (entry.isDirectory()) walkWorkspace(full, root, matcher, results);
  }
}

async function executeFileOperations(
  { action, path: relPath, content, pattern },
  dataDir,
) {
  if (!dataDir) return "File Operations Error: no data directory available.";
  const resolved = resolveWorkspacePath(dataDir, relPath);
  if (resolved.error) return `File Operations Error: ${resolved.error}`;
  const { root, target } = resolved;
  const rel = path.relative(root, target) || ".";
  try {
    fs.mkdirSync(root, { recursive: true });
    switch (action) {
      case "list": {
        const entries = fs.readdirSync(target, { withFileTypes: true });
        if (!entries.length) return `Directory "${rel}" is empty.`;
        const lines = entries.map((e) => {
          if (e.isDirectory()) return `${e.name}/`;
          const size = fs.statSync(path.join(target, e.name)).size;
          return `${e.name} (${size} bytes)`;
        });
        return `Contents of workspace/${rel}:\n${lines.join("\n")}`;
      }
      case "read": {
        const text = fs.readFileSync(target, "utf8");
        return text.length > FILE_READ_MAX_CHARS
          ? text.slice(0, FILE_READ_MAX_CHARS) + "\n... [FILE TRUNCATED]"
          : text || "(empty file)";
      }
      case "write":
      case "append": {
        if (typeof content !== "string") {
          return "File Operations Error: 'content' (string) is required for write/append.";
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (action === "append") fs.appendFileSync(target, content, "utf8");
        else fs.writeFileSync(target, content, "utf8");
        return `${action === "append" ? "Appended to" : "Wrote"} workspace/${rel} (${content.length} chars).`;
      }
      case "delete": {
        const stat = fs.statSync(target);
        if (stat.isDirectory()) fs.rmdirSync(target);
        else fs.unlinkSync(target);
        return `Deleted workspace/${rel}.`;
      }
      case "mkdir": {
        fs.mkdirSync(target, { recursive: true });
        return `Created directory workspace/${rel}.`;
      }
      case "info": {
        const stat = fs.statSync(target);
        return (
          `workspace/${rel}: ${stat.isDirectory() ? "directory" : "file"}, ` +
          `${stat.size} bytes, modified ${stat.mtime.toISOString()}`
        );
      }
      case "find": {
        const glob = String(pattern || "*");
        const re = new RegExp(
          "^" +
            glob
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*")
              .replace(/\?/g, ".") +
            "$",
          "i",
        );
        const results = [];
        walkWorkspace(target, root, (name) => re.test(name), results);
        if (!results.length)
          return `No files matching "${glob}" under workspace/${rel}.`;
        let out = `Files matching "${glob}":\n${results.join("\n")}`;
        if (results.length >= FILE_FIND_MAX_RESULTS)
          out += "\n... [MORE RESULTS OMITTED]";
        return out;
      }
      default:
        return "File Operations Error: invalid action. Use list, read, write, append, delete, mkdir, info, or find.";
    }
  } catch (e) {
    if (e.code === "ENOENT")
      return `File Operations Error: "${rel}" does not exist.`;
    if (e.code === "ENOTEMPTY")
      return `File Operations Error: directory "${rel}" is not empty.`;
    return `File Operations Error: ${e.message}`;
  }
}

module.exports = {
  executeCodeSearch,
  executeGitTools,
  executeRunPython,
  executeRunCode,
  executeFileOperations,
  executeShellCommand,
  executeMacosControl,
  CODE_SEARCH_MAX_MATCHES,
  CODE_SEARCH_MAX_FILE_BYTES,
  CODE_SEARCH_SKIP_DIRS,
  walkAllowedTree,
  GIT_READONLY_ACTIONS,
  loadCodingSettings,
  FILE_READ_MAX_CHARS,
  walkWorkspace,
  FILE_FIND_MAX_RESULTS,
  MACOS_CONTROL_ACTIONS,
  CODING_SETTINGS_FILE,
};
