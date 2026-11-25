"use strict";

// Where a plugin comes from, and keeping it up to date.
//
// A plugin folder in ~/dive/plugins that is a clone of a git repository can
// be checked against that repository and brought up to date without a new
// Dive: the gallery-dl and yt-dlp plugins are clones of their GitHub
// repositories. A plugin's code runs inside Dive with full local access, so
// nothing here happens on its own: Settings shows what a check found and the
// user presses UPDATE or ADD. An update only ever fast-forwards: a folder with
// local changes, or a history that has moved apart, is left alone and the user
// is told why.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const GIT_CANDIDATES = [
  "/opt/homebrew/bin/git",
  "/usr/local/bin/git",
  "/usr/bin/git",
];
const NETWORK_TIMEOUT_MS = 60000;
const LOCAL_TIMEOUT_MS = 15000;
const MAX_CHANGES_LISTED = 20;

function gitBinary() {
  return GIT_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || "git";
}

// Runs git without a shell and never stops to ask for a password: a private
// repository fails with a message instead of hanging the server.
function git(args, cwd, timeoutMs = LOCAL_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      gitBinary(),
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          LC_ALL: "C",
        },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || "").trim(),
          stderr: String(stderr || "").trim() || (error ? error.message : ""),
        });
      },
    );
  });
}

// A repository address as it can be shown: no user name or token, no ".git".
function displayRepoUrl(raw) {
  try {
    const url = new URL(String(raw));
    url.username = "";
    url.password = "";
    return url
      .toString()
      .replace(/\.git$/, "")
      .replace(/\/$/, "");
  } catch {
    // scp-style git@host:owner/repo
    const match = String(raw || "").match(
      /^[^@\s]+@([^:\s]+):(.+?)(?:\.git)?$/,
    );
    return match ? `https://${match[1]}/${match[2]}` : "";
  }
}

// The address of a public GitHub repository, as https://github.com/owner/repo,
// with the folder name it installs under; or an error. Only GitHub, only
// https, only owner/repo: anything else is refused.
function parseGithubRepoUrl(raw) {
  const text = String(raw || "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    return {
      error:
        "Give the address of a GitHub repository, such as https://github.com/owner/repo.",
    };
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com"
  ) {
    return {
      error: "Only https://github.com/owner/repo addresses can be added.",
    };
  }
  if (url.username || url.password) {
    return { error: "Leave the user name and password out of the address." };
  }
  const parts = url.pathname
    .replace(/\.git$/, "")
    .split("/")
    .filter(Boolean);
  if (
    parts.length !== 2 ||
    !parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part)) ||
    parts.some((part) => /^\.+$/.test(part))
  ) {
    return {
      error:
        "The address must name one repository: https://github.com/owner/repo.",
    };
  }
  const [owner, repo] = parts;
  return {
    url: `https://github.com/${owner}/${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    folder: repo,
  };
}

// What a plugin folder says about its source, without the network: the
// repository it is a clone of, the commit it is at, and whether it has local
// changes. null for a folder that is not a clone (or a single-file plugin).
async function pluginSource(dir) {
  try {
    if (
      !fs.statSync(dir).isDirectory() ||
      !fs.existsSync(path.join(dir, ".git"))
    )
      return null;
  } catch {
    return null;
  }
  const [remote, commit, branch, status] = await Promise.all([
    git(["remote", "get-url", "origin"], dir),
    git(["rev-parse", "--short", "HEAD"], dir),
    git(["rev-parse", "--abbrev-ref", "HEAD"], dir),
    // Untracked files (a stray .DS_Store) do not stop an update; edits do.
    git(["status", "--porcelain", "--untracked-files=no"], dir),
  ]);
  if (!remote.ok || !remote.stdout) return null;
  return {
    repo: displayRepoUrl(remote.stdout),
    commit: commit.ok ? commit.stdout : "",
    branch: branch.ok ? branch.stdout : "",
    localChanges: status.ok ? status.stdout.length > 0 : false,
  };
}

// The version a commit gives: plugin.json first, then the module's own
// `version:` line (which is what Dive shows when they differ).
async function versionAt(dir, ref) {
  const code = await git(["show", `${ref}:index.js`], dir);
  const fromCode = code.ok
    ? code.stdout.match(/^\s*version:\s*["']([^"']+)["']/m)?.[1]
    : "";
  if (fromCode) return fromCode;
  const manifest = await git(["show", `${ref}:plugin.json`], dir);
  if (manifest.ok) {
    try {
      const version = JSON.parse(manifest.stdout).version;
      if (typeof version === "string") return version;
    } catch {
      /* no usable manifest */
    }
  }
  return "";
}

// Asks the repository what is new. Fetches, then compares this folder with
// the branch it follows.
async function checkForUpdate(dir) {
  const source = await pluginSource(dir);
  if (!source)
    return {
      status: "no-source",
      message: "Not installed from a repository, so there is nothing to check.",
    };
  const fetched = await git(
    ["fetch", "--quiet", "origin"],
    dir,
    NETWORK_TIMEOUT_MS,
  );
  if (!fetched.ok) {
    return {
      status: "error",
      source,
      message: `Could not reach ${source.repo}: ${fetched.stderr.split("\n")[0]}`,
    };
  }
  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    dir,
  );
  if (!upstream.ok || !upstream.stdout) {
    return {
      status: "error",
      source,
      message: `The ${source.branch || "current"} branch does not follow a branch of ${source.repo}.`,
    };
  }
  const counts = await git(
    ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    dir,
  );
  const [ahead, behind] = counts.ok
    ? counts.stdout.split(/\s+/).map(Number)
    : [0, 0];
  const log =
    behind > 0
      ? await git(
          [
            "log",
            `--max-count=${MAX_CHANGES_LISTED}`,
            "--format=%h%x09%s",
            "HEAD..@{u}",
          ],
          dir,
        )
      : { ok: true, stdout: "" };
  const changes =
    log.ok && log.stdout
      ? log.stdout.split("\n").map((line) => {
          const [commit, ...subject] = line.split("\t");
          return { commit, subject: subject.join("\t") };
        })
      : [];
  const result = {
    source,
    behind,
    ahead,
    changes,
    currentVersion: await versionAt(dir, "HEAD"),
    latestVersion: behind > 0 ? await versionAt(dir, "@{u}") : "",
  };
  if (behind === 0)
    return { ...result, status: "up-to-date", message: "Up to date." };
  if (source.localChanges) {
    return {
      ...result,
      status: "blocked",
      message:
        "An update is available, but this folder has local changes. Commit or discard them first, so nothing of yours is overwritten.",
    };
  }
  if (ahead > 0) {
    return {
      ...result,
      status: "blocked",
      message: `An update is available, but this folder has ${ahead} commit(s) the repository does not have, so it cannot simply move forward.`,
    };
  }
  return {
    ...result,
    status: "available",
    message: `Update available: ${behind} change(s).`,
  };
}

// Brings the folder up to date with what was fetched, by fast-forward only.
async function updatePlugin(dir) {
  const check = await checkForUpdate(dir);
  if (check.status !== "available") return { ok: false, ...check };
  const merged = await git(["merge", "--ff-only", "--quiet", "@{u}"], dir);
  if (!merged.ok)
    return {
      ok: false,
      ...check,
      status: "error",
      message: `The update failed: ${merged.stderr.split("\n")[0]}`,
    };
  const after = await pluginSource(dir);
  return {
    ok: true,
    ...check,
    status: "updated",
    source: after || check.source,
    message: `Updated to ${check.latestVersion || after?.commit || "the latest version"}.`,
  };
}

// Clones a repository into the plugins folder. The address is checked by
// parseGithubRepoUrl first; `cloneUrl` is passed separately so tests can clone
// a local repository.
async function clonePlugin(cloneUrl, folder, pluginsDir) {
  const root = path.resolve(pluginsDir);
  const target = path.join(root, folder);
  if (path.dirname(target) !== root)
    return { ok: false, message: "That folder name is not allowed." };
  if (fs.existsSync(target))
    return {
      ok: false,
      message: `A plugin folder named "${folder}" already exists.`,
    };
  fs.mkdirSync(root, { recursive: true });
  const cloned = await git(
    ["clone", "--quiet", "--", cloneUrl, target],
    root,
    NETWORK_TIMEOUT_MS * 3,
  );
  if (!cloned.ok) {
    fs.rmSync(target, { recursive: true, force: true });
    return {
      ok: false,
      message: `Could not download ${displayRepoUrl(cloneUrl)}: ${cloned.stderr.split("\n")[0]}`,
    };
  }
  // Only a Dive plugin is kept: a repository without index.js is not one.
  if (!fs.existsSync(path.join(target, "index.js"))) {
    fs.rmSync(target, { recursive: true, force: true });
    return {
      ok: false,
      message: `${displayRepoUrl(cloneUrl)} is not a Dive plugin: it has no index.js.`,
    };
  }
  return { ok: true, folder, target, source: await pluginSource(target) };
}

async function installPlugin(rawUrl, pluginsDir) {
  const parsed = parseGithubRepoUrl(rawUrl);
  if (parsed.error) return { ok: false, message: parsed.error };
  return clonePlugin(parsed.cloneUrl, parsed.folder, pluginsDir);
}

module.exports = {
  checkForUpdate,
  clonePlugin,
  displayRepoUrl,
  installPlugin,
  parseGithubRepoUrl,
  pluginSource,
  updatePlugin,
};
