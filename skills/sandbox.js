"use strict";

// The safety boundary shared by every skill that reaches outside the process.
//
// Two kinds of guard live here because they answer the same question — "is this
// destination allowed?" — and each is used by more than one skill family:
//
//   URL guards   block SSRF: loopback, private, link-local and unique-local
//                ranges, IPv4-mapped IPv6, and hosts resolving to any of those.
//                Used by the research skills and by http_request.
//   Path guards  keep file access inside an allowed root — the user's declared
//                directories, or the skill workspace. Used by the code skills
//                and by the research skills' paper downloads.
//
// Moved out of skills.js unchanged. One module so a fix to either guard applies
// everywhere, and so both stay directly testable.

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const dnsPromises = require("dns").promises;
const { DATA_DIR, WORKSPACE_DIR } = require("../data-dir.js");

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15000;

// SSRF guard shared by web_scraper, deep_research and http_request: only
// http(s), and never local or private network addresses. Returns an error
// string, or null when the URL is safe to fetch.
const SSRF_BLOCK_MESSAGE =
  "Access to local or private network addresses is not allowed.";

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n >>> 0;
}

// True for loopback, link-local (incl. 169.254.169.254 cloud metadata),
// RFC1918 private, CGNAT, and unspecified IPv4 ranges.
function isBlockedIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  const inRange = (base, bits) => {
    const b = ipv4ToInt(base);
    const shift = 32 - bits;
    return n >>> shift === b >>> shift;
  };
  return (
    inRange("0.0.0.0", 8) ||
    inRange("10.0.0.0", 8) ||
    inRange("100.64.0.0", 10) ||
    inRange("127.0.0.0", 8) ||
    inRange("169.254.0.0", 16) ||
    inRange("172.16.0.0", 12) ||
    inRange("192.168.0.0", 16)
  );
}

// True for IPv6 loopback/unspecified, ULA (fc00::/7), link-local (fe80::/10),
// and IPv4-mapped/embedded addresses whose inner IPv4 is itself blocked.
function isBlockedIpv6(ip) {
  const s = ip
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  if (s === "::1" || s === "::") return true;
  const v4embedded = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4embedded) return isBlockedIpv4(v4embedded[1]);
  const first = s.split(":")[0];
  if (/^f[cd]/.test(first)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(first)) return true; // fe80::/10 link-local
  return false;
}

function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) return isBlockedIpv6(ip);
  return false;
}

// Synchronous structural guard: protocol + literal-host checks. Fast path used
// before every fetch. Alternate IP encodings (decimal/hex/octal) and DNS
// rebinding are caught by assertUrlAllowed() below, which resolves the host.
function urlGuardError(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "Invalid URL.";
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "Only http and https URLs are allowed.";
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return SSRF_BLOCK_MESSAGE;
  }
  if (net.isIP(host) && isBlockedIp(host)) {
    return SSRF_BLOCK_MESSAGE;
  }
  return null;
}

// Full async guard: the structural check, then DNS resolution so that
// hostnames pointing at internal IPs (DNS rebinding) and numeric-encoded IPs
// (getaddrinfo normalizes 2130706433 / 0x7f000001 to 127.0.0.1) are blocked.
// Residual TOCTOU (a host that resolves differently between this check and the
// real connection) is out of scope for this local, single-user app.
async function assertUrlAllowed(url) {
  const structural = urlGuardError(url);
  if (structural) return structural;
  let host;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "Invalid URL.";
  }
  if (net.isIP(host)) return null; // already checked literally above
  let addresses;
  try {
    addresses = await dnsPromises.lookup(host, { all: true });
  } catch {
    return null; // unresolvable — the request will fail on its own
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) return SSRF_BLOCK_MESSAGE;
  }
  return null;
}

const ALLOWED_DIRS_FILE = path.join(DATA_DIR, "allowed-dirs.json");

function expandHomePath(value) {
  const trimmed = String(value || "").trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/"))
    return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

// The allowlist of directories the coding skills may read. Users edit the
// JSON directly; the workspace sandbox is always included.
function loadAllowedDirs() {
  const dirs = [WORKSPACE_DIR];
  try {
    const raw = JSON.parse(fs.readFileSync(ALLOWED_DIRS_FILE, "utf8"));
    for (const entry of raw.directories || []) {
      const expanded = expandHomePath(entry);
      if (expanded && path.isAbsolute(expanded)) dirs.push(expanded);
    }
  } catch {
    /* no file yet — workspace-only defaults apply */
  }
  return [...new Set(dirs)];
}

// Resolve a path and verify it sits inside an allowed directory (realpath
// prefix check, so symlinks cannot escape). options.allowHome additionally
// accepts anything under the home directory (used by shell_command's cwd,
// which is already confirmation-gated).
function resolveAllowedPath(rawPath, options = {}) {
  const expanded = expandHomePath(rawPath);
  if (!path.isAbsolute(expanded)) {
    return { error: `Path must be absolute or start with ~/: ${rawPath}` };
  }
  let real;
  try {
    real = fs.realpathSync(expanded);
  } catch {
    return { error: `Path does not exist: ${expanded}` };
  }
  const roots = loadAllowedDirs();
  if (options.allowHome) roots.push(os.homedir());
  for (const root of roots) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    if (real === realRoot || real.startsWith(realRoot + path.sep)) {
      return { target: real };
    }
  }
  return {
    error:
      `Path is outside the allowed directories. Allowed roots: ` +
      `${roots.join(", ")}. The user can add more in ~/dive/allowed-dirs.json ` +
      `({"directories": ["~/some/project"]}).`,
  };
}

function globToRegex(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`(^|/)${escaped}$`, "i");
}

function resolveWorkspacePath(dataDir, relPath) {
  const root = path.join(dataDir, "workspace");
  const target = path.resolve(root, String(relPath || "."));
  if (target !== root && !target.startsWith(root + path.sep)) {
    return {
      error: "Path escapes the workspace. Use relative paths inside it.",
    };
  }
  return { root, target };
}

module.exports = {
  MAX_REDIRECTS,
  REQUEST_TIMEOUT_MS,
  SSRF_BLOCK_MESSAGE,
  ALLOWED_DIRS_FILE,
  ipv4ToInt,
  isBlockedIpv4,
  isBlockedIpv6,
  isBlockedIp,
  urlGuardError,
  assertUrlAllowed,
  expandHomePath,
  loadAllowedDirs,
  resolveAllowedPath,
  globToRegex,
  resolveWorkspacePath,
};
