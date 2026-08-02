"use strict";

// Shared secret-scrubbing and size-bounding primitives.
//
// Trace events, stored conversation history, and the Pi RPC event stream all
// carry model/tool output that can quote a credential. server.js and
// routes/pi.js previously kept private copies of these three helpers, which had
// already drifted apart by a character. Keep exactly one implementation.

const SENSITIVE_KEY =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|private[_-]?key)/i;

const SENSITIVE_NAMES =
  "api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret|private[_-]?key";

const MAX_REDACT_DEPTH = 8;
const MAX_REDACT_ARRAY_ITEMS = 100;
const MAX_REDACT_OBJECT_KEYS = 200;
const DEFAULT_BOUNDED_CHARS = 64 * 1024;

function redactText(value) {
  return String(value ?? "")
    .replace(
      new RegExp(`("?(?:${SENSITIVE_NAMES})"?\\s*[:=]\\s*)"[^"\\r\\n]*"`, "gi"),
      '$1"[redacted]"',
    )
    .replace(
      new RegExp(`((?:${SENSITIVE_NAMES})\\s*[:=]\\s*)[^\\s,;}]+`, "gi"),
      "$1[redacted]",
    )
    .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[redacted]@")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
      "[redacted]",
    );
}

function redactValue(value, depth = 0) {
  if (depth > MAX_REDACT_DEPTH) return "[redacted-depth]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_REDACT_ARRAY_ITEMS)
      .map((item) => redactValue(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, item] of Object.entries(value).slice(
    0,
    MAX_REDACT_OBJECT_KEYS,
  )) {
    clean[key] = SENSITIVE_KEY.test(key)
      ? "[redacted]"
      : redactValue(item, depth + 1);
  }
  return clean;
}

// Deep-copy `value` while guaranteeing the serialized result stays under
// `maxChars`; oversized or unserialisable values degrade to a truncated preview.
function boundedValue(value, maxChars = DEFAULT_BOUNDED_CHARS) {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxChars) return JSON.parse(serialized);
    return {
      truncated: true,
      originalChars: serialized.length,
      preview: serialized.slice(0, maxChars),
    };
  } catch (_error) {
    return { truncated: true, preview: String(value).slice(0, maxChars) };
  }
}

module.exports = {
  SENSITIVE_KEY,
  redactText,
  redactValue,
  boundedValue,
};
