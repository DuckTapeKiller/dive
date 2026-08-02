"use strict";

// Turning live stream events into something safe to keep on disk.
//
// Trace events come from models, tools and the Pi process, so they can quote a
// credential or carry an unbounded payload. Everything written into a saved
// conversation passes through here first: fields are picked explicitly rather
// than copied wholesale, strings are length-capped, and the result is scrubbed
// by redact.js.
//
// Moved out of server.js unchanged.

const {
  redactText: redactTraceText,
  redactValue: redactTraceValue,
  boundedValue: boundedTraceValue,
} = require("../redact.js");

function serializeLibraryResults(results, options = {}) {
  const includeSourcePaths = options?.includeSourcePaths !== false;
  return (Array.isArray(results) ? results : []).map((result) => ({
    chunkId: result.chunkId,
    title: result.title,
    author: result.author,
    path: includeSourcePaths ? result.path : "",
    heading: result.heading,
    kind: result.kind,
    score: result.score,
    snippet: result.snippet,
  }));
}

function sanitizeStoredTraceLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines
    .slice(0, 400)
    .map((line) => redactTraceText(line).slice(0, 4000))
    .filter((line) => line.length > 0);
}

function sanitizeTraceEventForStorage(event) {
  if (!event || typeof event !== "object") return null;
  const type = typeof event.type === "string" ? event.type : "";
  // Streaming micro-events are not stored: the full thinking text is already
  // persisted separately (metadata.thinking) and history replay never reads
  // them — keeping hundreds of one-word deltas only bloats conversations.
  if (
    !type ||
    type === "delta" ||
    type === "done" ||
    type === "heartbeat" ||
    type === "thinking_start" ||
    type === "thinking_delta" ||
    type === "thinking_end" ||
    type === "session_start" ||
    type === "pi_raw_event"
  ) {
    return null;
  }
  const clean = { type };
  for (const key of [
    "label",
    "detail",
    "error",
    "command",
    "name",
    "skillName",
    "toolName",
    "toolCallId",
    "argsPreview",
    "outputPreview",
    "eventType",
    "phase",
    "chunk",
    "delta",
    "key",
    "text",
    "message",
    "noticeType",
    "model",
    "jobId",
    "status",
  ]) {
    if (typeof event[key] === "string") clean[key] = event[key].slice(0, 4000);
  }
  for (const key of [
    "isError",
    "failure",
    "success",
    "retrievedCount",
    "injectedCount",
    "uniqueSourceCount",
    "maxContextChars",
    "input",
    "output",
    "cost",
    "tokensBefore",
    "attempt",
    "maxAttempts",
    "delayMs",
    "contentIndex",
    "sequence",
  ]) {
    if (typeof event[key] === "boolean" || typeof event[key] === "number") {
      clean[key] = event[key];
    }
  }
  if (type === "gallery_preview") {
    if (typeof event.previewId === "string")
      clean.previewId = event.previewId.slice(0, 120);
    if (typeof event.destinationPath === "string") {
      clean.destinationPath = event.destinationPath.slice(0, 1000);
    }
    if (typeof event.strategy === "string")
      clean.strategy = event.strategy.slice(0, 80);
    if (Array.isArray(event.sourceUrls)) {
      clean.sourceUrls = event.sourceUrls
        .slice(0, 20)
        .map((url) => String(url).slice(0, 4000));
    }
    if (Array.isArray(event.candidates)) {
      clean.candidates = event.candidates.slice(0, 500).map((item) => {
        const metadata =
          item && item.metadata && typeof item.metadata === "object"
            ? item.metadata
            : null;
        return {
          index: Number.isInteger(item?.index) ? item.index : 0,
          url: String(item?.url || "").slice(0, 4000),
          displayName: String(item?.displayName || "image").slice(0, 500),
          duplicateOf: Number.isInteger(item?.duplicateOf)
            ? item.duplicateOf
            : null,
          metadata: metadata
            ? {
                dimensions:
                  metadata.dimensions && typeof metadata.dimensions === "object"
                    ? {
                        widthPx: Number(metadata.dimensions.widthPx) || 0,
                        heightPx: Number(metadata.dimensions.heightPx) || 0,
                      }
                    : null,
                sizeBytes: Number.isSafeInteger(metadata.sizeBytes)
                  ? metadata.sizeBytes
                  : null,
                mimeType: String(metadata.mimeType || "").slice(0, 100),
                error: String(metadata.error || "").slice(0, 500),
              }
            : null,
        };
      });
    }
    if (Array.isArray(event.warnings)) {
      clean.warnings = event.warnings.slice(0, 20).map((warning) => ({
        url: String(warning?.url || "").slice(0, 4000),
        detail: String(warning?.detail || "").slice(0, 1000),
      }));
    }
  }
  if (type === "media_playlist_preview") {
    if (typeof event.previewId === "string")
      clean.previewId = event.previewId.slice(0, 120);
    if (typeof event.destinationPath === "string") {
      clean.destinationPath = event.destinationPath.slice(0, 1000);
    }
    for (const key of [
      "mode",
      "audioFormat",
      "videoContainer",
      "compatibilityProfile",
    ]) {
      if (typeof event[key] === "string") clean[key] = event[key].slice(0, 100);
    }
    if (Array.isArray(event.sourceUrls)) {
      clean.sourceUrls = event.sourceUrls
        .slice(0, 20)
        .map((url) => String(url).slice(0, 4000));
    }
    if (Array.isArray(event.candidates)) {
      clean.candidates = event.candidates.slice(0, 500).map((item) => ({
        index: Number.isInteger(item?.index) ? item.index : 0,
        url: String(item?.url || "").slice(0, 4000),
        webpageUrl: String(item?.webpageUrl || "").slice(0, 4000),
        mediaUrl: String(item?.mediaUrl || "").slice(0, 4000),
        title: String(item?.title || "").slice(0, 1000),
        displayName: String(
          item?.displayName || item?.title || "media entry",
        ).slice(0, 1000),
        description: String(item?.description || "").slice(0, 1000),
        availability: String(item?.availability || "").slice(0, 100),
        date: String(item?.date || "").slice(0, 100),
        durationSeconds: Number.isFinite(Number(item?.durationSeconds))
          ? Number(item.durationSeconds)
          : null,
        duration: String(item?.duration || "").slice(0, 50),
        thumbnail: String(item?.thumbnail || "").slice(0, 4000),
        series: String(item?.series || "").slice(0, 500),
        season: String(item?.season || "").slice(0, 100),
        episode: String(item?.episode || "").slice(0, 500),
        episodeNumber: Number.isFinite(Number(item?.episodeNumber))
          ? Number(item.episodeNumber)
          : null,
        playlistIndex: Number.isInteger(item?.playlistIndex)
          ? item.playlistIndex
          : null,
        extractor: String(item?.extractor || "").slice(0, 200),
      }));
    }
    if (Array.isArray(event.warnings)) {
      clean.warnings = event.warnings.slice(0, 20).map((warning) => ({
        url: String(warning?.url || "").slice(0, 4000),
        detail: String(warning?.detail || "").slice(0, 1000),
      }));
    }
  }
  if (event.result && typeof event.result === "object") {
    clean.result = boundedTraceValue(redactTraceValue(event.result));
  }
  if (event.payload && typeof event.payload === "object") {
    clean.payload = boundedTraceValue(redactTraceValue(event.payload));
  }
  if (Array.isArray(event.lines)) {
    clean.lines = event.lines
      .slice(0, 80)
      .map((line) => String(line).slice(0, 400));
  } else if (event.lines === null) {
    clean.lines = null;
  }
  if (Array.isArray(event.results)) {
    clean.results = serializeLibraryResults(event.results).slice(0, 50);
  }
  if (Array.isArray(event.sources)) {
    clean.sources = event.sources
      .slice(0, 50)
      .map((source) => ({
        title: String(source?.title || "source").slice(0, 140),
        url: String(source?.url || "").slice(0, 4000),
      }))
      .filter((source) => /^https?:\/\//i.test(source.url));
  }
  if (
    event.meta &&
    typeof event.meta === "object" &&
    !Array.isArray(event.meta)
  ) {
    clean.meta = {};
    for (const [key, value] of Object.entries(event.meta)) {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        clean.meta[key] =
          typeof value === "string" ? value.slice(0, 1000) : value;
      }
    }
  }
  // Most fields above are copied verbatim, so the whole event still needs a
  // redaction pass. `result`/`payload` were already redacted before bounding
  // (bounding an unredacted value could split a secret across the truncation
  // point), so they are held out rather than walked a second time.
  const { result, payload, ...rest } = clean;
  const redacted = redactTraceValue(rest);
  if (result !== undefined) redacted.result = result;
  if (payload !== undefined) redacted.payload = payload;
  return redacted;
}

module.exports = {
  serializeLibraryResults,
  sanitizeStoredTraceLines,
  sanitizeTraceEventForStorage,
};
