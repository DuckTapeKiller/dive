"use strict";

// Cloud provider transport: which providers exist, their defaults, the saved
// settings file, and building and streaming a request to whichever one is
// selected.
//
// A factory rather than a plain module, matching routes/*.js. The image, SSE
// and usage helpers it needs are shared with the local-model transport that
// stays in server.js, so they are injected instead of being pulled into yet
// another shared module — and that also keeps server.js -> cloud.js a
// one-directional require.
//
// Moved out of server.js unchanged.

const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("../data-dir.js");

module.exports = function createCloudTransport(deps) {
  const {
    clampNumber,
    createHttpError,
    collectMessageImages,
    applyOpenAiImages,
    createSseParser,
    normalizeUsage,
  } = deps;

  const CLOUD_SETTINGS_FILE = path.join(DATA_DIR, "cloud-settings.json");

  const CLOUD_PROVIDERS = ["openai", "anthropic", "mistral", "google"];

  const CLOUD_PROVIDER_SET = new Set(CLOUD_PROVIDERS);

  const CLOUD_DEFAULT_MODELS = {
    openai: "gpt-5",
    anthropic: "claude-opus-4-8",
    mistral: "mistral-large-latest",
    google: "gemini-2.5-pro",
  };

  const CLOUD_DEFAULT_BASE_URLS = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    mistral: "https://api.mistral.ai/v1",
    google: "https://generativelanguage.googleapis.com/v1beta/openai",
  };

  const CLOUD_ENV_KEY_NAMES = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    mistral: "MISTRAL_API_KEY",
    google: "GEMINI_API_KEY",
  };

  const CLOUD_MIN_MAX_TOKENS = 1;

  const CLOUD_MAX_MAX_TOKENS = 128000;

  const CLOUD_DEFAULT_MAX_TOKENS = 2048;

  function defaultCloudSettings() {
    return {
      provider: "openai",
      models: { ...CLOUD_DEFAULT_MODELS },
      baseUrls: { ...CLOUD_DEFAULT_BASE_URLS },
      apiKeys: {},
      maxTokens: CLOUD_DEFAULT_MAX_TOKENS,
      // Agent mode: plan-first prompting and a larger tool-call budget.
      agentMode: false,
      agentMaxRounds: 25,
    };
  }

  function normalizeCloudBaseUrl(value, fallback) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) return fallback;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return fallback;
      }
      return parsed.toString().replace(/\/+$/, "");
    } catch (e) {
      return fallback;
    }
  }

  function sanitizeCloudSettings(rawInput, existingInput = null) {
    const defaults = defaultCloudSettings();
    const existing =
      existingInput &&
      typeof existingInput === "object" &&
      !Array.isArray(existingInput)
        ? existingInput
        : {};
    const raw =
      rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? rawInput
        : {};

    const next = {
      provider: CLOUD_PROVIDER_SET.has(existing.provider)
        ? existing.provider
        : defaults.provider,
      models: { ...defaults.models, ...(existing.models || {}) },
      baseUrls: { ...defaults.baseUrls, ...(existing.baseUrls || {}) },
      apiKeys: { ...(existing.apiKeys || {}) },
      maxTokens: clampNumber(
        existing.maxTokens,
        CLOUD_MIN_MAX_TOKENS,
        CLOUD_MAX_MAX_TOKENS,
        defaults.maxTokens,
      ),
      agentMode: existing.agentMode === true,
      agentMaxRounds: clampNumber(existing.agentMaxRounds, 1, 50, 25),
    };

    if (CLOUD_PROVIDER_SET.has(raw.provider)) {
      next.provider = raw.provider;
    }
    if (typeof raw.agentMode === "boolean") {
      next.agentMode = raw.agentMode;
    }
    if (raw.agentMaxRounds !== undefined) {
      next.agentMaxRounds = clampNumber(raw.agentMaxRounds, 1, 50, 25);
    }

    if (
      raw.models &&
      typeof raw.models === "object" &&
      !Array.isArray(raw.models)
    ) {
      for (const provider of CLOUD_PROVIDERS) {
        if (typeof raw.models[provider] === "string") {
          const model = raw.models[provider].trim().slice(0, 200);
          if (model) next.models[provider] = model;
        }
      }
    }

    if (
      raw.baseUrls &&
      typeof raw.baseUrls === "object" &&
      !Array.isArray(raw.baseUrls)
    ) {
      for (const provider of CLOUD_PROVIDERS) {
        next.baseUrls[provider] = normalizeCloudBaseUrl(
          raw.baseUrls[provider],
          next.baseUrls[provider] || defaults.baseUrls[provider],
        );
      }
    }

    if (
      raw.apiKeys &&
      typeof raw.apiKeys === "object" &&
      !Array.isArray(raw.apiKeys)
    ) {
      for (const provider of CLOUD_PROVIDERS) {
        if (typeof raw.apiKeys[provider] !== "string") continue;
        const value = raw.apiKeys[provider].trim();
        if (value) {
          next.apiKeys[provider] = value.slice(0, 4000);
        }
      }
    }

    if (
      raw.clearApiKeys &&
      typeof raw.clearApiKeys === "object" &&
      !Array.isArray(raw.clearApiKeys)
    ) {
      for (const provider of CLOUD_PROVIDERS) {
        if (raw.clearApiKeys[provider] === true) {
          delete next.apiKeys[provider];
        }
      }
    }

    next.maxTokens = clampNumber(
      raw.maxTokens,
      CLOUD_MIN_MAX_TOKENS,
      CLOUD_MAX_MAX_TOKENS,
      next.maxTokens,
    );

    return next;
  }

  function saveCloudSettings(settings) {
    const sanitized = sanitizeCloudSettings(settings, defaultCloudSettings());
    fs.writeFileSync(CLOUD_SETTINGS_FILE, JSON.stringify(sanitized, null, 2), {
      mode: 0o600,
    });
    try {
      fs.chmodSync(CLOUD_SETTINGS_FILE, 0o600);
    } catch (error) {
      // This file holds API keys. If it cannot be made owner-only the user
      // should know rather than assume it is protected.
      console.warn(
        `[cloud] could not restrict permissions on ${CLOUD_SETTINGS_FILE}:`,
        error.message,
      );
    }
    return sanitized;
  }

  function loadCloudSettings() {
    if (fs.existsSync(CLOUD_SETTINGS_FILE)) {
      try {
        const raw = JSON.parse(fs.readFileSync(CLOUD_SETTINGS_FILE, "utf8"));
        const sanitized = sanitizeCloudSettings(raw, defaultCloudSettings());
        if (JSON.stringify(raw) !== JSON.stringify(sanitized)) {
          saveCloudSettings(sanitized);
        }
        return sanitized;
      } catch (e) {
        console.warn("Failed to load Cloud settings:", e.message || e);
      }
    }
    return defaultCloudSettings();
  }

  // Resolve "Automatic" (empty model) to a concrete model id for a local server.
  // Ollama JIT-loads on any request, but LM Studio returns 400 "No models
  // loaded" when asked to chat with no model specified and none loaded. So when
  // the user picked Automatic we name a model explicitly: prefer one that is
  // already loaded (no reload cost), else the first non-embedding model the
  // server reports (LM Studio JIT-loads it). Returns "" if none can be found, in
  // which case the request proceeds as before (llama.cpp serves its loaded model).
  // Is a given model already loaded on the server? (LM Studio native endpoint.)
  // Explicitly load a model into LM Studio. JIT loading is unreliable / can be
  // disabled, so we don't depend on it: the REST load endpoint deterministically
  // loads the model (and does NOT evict an already-loaded embedding model, so
  // library indexing keeps working). Best-effort: returns true on success, false
  // if the endpoint is unavailable or the load fails, in which case the caller
  // proceeds and lets the chat request surface any real error.
  // For LM Studio: make sure the chosen chat model is loaded before we send the
  // chat request, so the user never has to load one manually (their indexer may
  // have loaded only an embedding model). No-op for llama.cpp (it always serves
  // the model it was started with) and when there is no concrete model to load.
  // Shared streaming handler for the bespoke local modes (LM Studio, llama.cpp).
  // Remove any skill-call syntax that survived the streaming loop so it can never
  // reach the chat bubble. Covers three cases the local models produce that Ollama
  // does not: a completed <call:...></call> when skills were disabled (DB on), a
  // malformed call missing its closing tag, and a dangling opener at end of text.
  // Derive the source pills (title + URL) from a skill result so the UI can show
  // every source it consulted, the same way library passages are surfaced. Covers
  // web_search result lists, <!-- url --> citation comments, and web_scraper URLs.
  // Parse a tool-call argument string without throwing.
  // Skill web sources must survive into the saved conversation: merge them into
  // the librarySources persisted on the assistant message (deduped by URL) so
  // the source pills re-render when the chat is reopened from history.
  function getCloudApiKey(settings, provider) {
    const envKeyName = CLOUD_ENV_KEY_NAMES[provider];
    const envValue = envKeyName ? process.env[envKeyName] : "";
    if (typeof settings.apiKeys?.[provider] === "string") {
      const saved = settings.apiKeys[provider].trim();
      if (saved) return saved;
    }
    return typeof envValue === "string" ? envValue.trim() : "";
  }

  // Cloud keys the web-search skills can reuse as high-quality search backends.
  // Whichever the user already saved (or set via env) is used, else DuckDuckGo.
  function redactCloudSettings(settings) {
    const sanitized = sanitizeCloudSettings(settings, defaultCloudSettings());
    return {
      provider: sanitized.provider,
      models: sanitized.models,
      baseUrls: sanitized.baseUrls,
      maxTokens: sanitized.maxTokens,
      agentMode: sanitized.agentMode,
      agentMaxRounds: sanitized.agentMaxRounds,
      hasApiKey: Object.fromEntries(
        CLOUD_PROVIDERS.map((provider) => [
          provider,
          Boolean(getCloudApiKey(sanitized, provider)),
        ]),
      ),
      envKeyNames: { ...CLOUD_ENV_KEY_NAMES },
    };
  }

  function buildCloudEndpoint(baseUrl, pathSuffix) {
    const normalized = String(baseUrl || "").replace(/\/+$/, "");
    return `${normalized}${pathSuffix}`;
  }

  function buildCloudRequest(provider, settings, messages, images) {
    const model = settings.models?.[provider] || CLOUD_DEFAULT_MODELS[provider];
    const baseUrl =
      settings.baseUrls?.[provider] || CLOUD_DEFAULT_BASE_URLS[provider];
    const maxTokens = clampNumber(
      settings.maxTokens,
      CLOUD_MIN_MAX_TOKENS,
      CLOUD_MAX_MAX_TOKENS,
      CLOUD_DEFAULT_MAX_TOKENS,
    );
    const apiKey = getCloudApiKey(settings, provider);
    if (!apiKey) {
      throw createHttpError(
        400,
        `Missing ${provider} API key. Add it in Cloud settings or set ${CLOUD_ENV_KEY_NAMES[provider]}.`,
      );
    }

    if (provider === "anthropic") {
      const systemParts = [];
      const anthropicMessages = [];
      for (const entry of collectMessageImages(messages, images)) {
        const item = entry.message;
        if (!item || typeof item !== "object") continue;
        if (item.role === "system") {
          if (typeof item.content === "string" && item.content.trim()) {
            systemParts.push(item.content.trim());
          }
          continue;
        }
        // The skill-call loop can produce consecutive same-role messages;
        // merge them so the request stays valid for strict role alternation.
        const previous = anthropicMessages[anthropicMessages.length - 1];
        if (previous && previous.role === item.role) {
          previous.content = `${previous.content}\n\n${item.content}`;
          previous.images = [...previous.images, ...entry.images];
          continue;
        }
        anthropicMessages.push({
          role: item.role,
          content: item.content,
          images: entry.images,
        });
      }
      // Attach each turn's images to it as content blocks.
      for (const item of anthropicMessages) {
        const attached = item.images;
        delete item.images;
        if (!attached.length) continue;
        const textContent =
          typeof item.content === "string" ? item.content : "";
        const blocks = [];
        if (textContent) blocks.push({ type: "text", text: textContent });
        for (const img of attached) {
          blocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mimeType,
              data: img.dataBase64,
            },
          });
        }
        item.content = blocks;
      }
      return {
        url: buildCloudEndpoint(baseUrl, "/messages"),
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: {
          model,
          max_tokens: maxTokens,
          system: systemParts.join("\n\n"),
          messages: anthropicMessages,
          stream: true,
        },
      };
    }

    // OpenAI-compatible vision: a turn carrying images has its content rendered
    // as an array of text + image_url (data URL) parts.
    const body = {
      model,
      messages: applyOpenAiImages(messages, images),
      max_tokens: maxTokens,
      stream: true,
    };
    if (provider === "openai") {
      body.stream_options = { include_usage: true };
    }

    return {
      url: buildCloudEndpoint(baseUrl, "/chat/completions"),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body,
    };
  }

  async function streamCloudCompletion({
    provider,
    settings,
    messages,
    images,
    signal,
    onDelta,
    onUsage,
  }) {
    const request = buildCloudRequest(provider, settings, messages, images);
    const upstreamRes = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });

    if (!upstreamRes.ok) {
      const raw = await upstreamRes.text().catch(() => "");
      throw createHttpError(
        upstreamRes.status,
        `Cloud provider request failed (${upstreamRes.status}): ${(raw || upstreamRes.statusText || "empty response body").slice(0, 700)}`,
      );
    }
    if (!upstreamRes.body) {
      throw createHttpError(502, "Cloud provider returned no stream body.");
    }

    let latestUsage = null;
    const parser = createSseParser((_eventName, data) => {
      if (data === "[DONE]") return;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (e) {
        return;
      }

      if (parsed?.type === "error" || parsed?.error) {
        const message =
          parsed.error?.message ||
          parsed.message ||
          "Cloud provider stream error.";
        throw createHttpError(502, message);
      }

      if (provider === "anthropic") {
        if (parsed.type === "message_start" && parsed.message?.usage) {
          latestUsage = normalizeUsage(provider, parsed.message.usage);
          if (latestUsage && typeof onUsage === "function")
            onUsage(latestUsage);
        }
        if (parsed.type === "message_delta" && parsed.usage) {
          latestUsage = {
            ...(latestUsage || {}),
            ...normalizeUsage(provider, parsed.usage),
          };
          if (latestUsage && typeof onUsage === "function")
            onUsage(latestUsage);
        }
        const textDelta =
          parsed.type === "content_block_delta" &&
          parsed.delta?.type === "text_delta" &&
          typeof parsed.delta.text === "string"
            ? parsed.delta.text
            : "";
        if (textDelta && typeof onDelta === "function") {
          onDelta(textDelta);
        }
        return;
      }

      if (parsed.usage) {
        latestUsage = normalizeUsage(provider, parsed.usage);
        if (latestUsage && typeof onUsage === "function") onUsage(latestUsage);
      }
      const delta = parsed.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta && typeof onDelta === "function") {
        onDelta(delta);
      }
    });

    const reader = upstreamRes.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(value);
    }
    parser.flush();

    return latestUsage;
  }
  return {
    CLOUD_PROVIDERS,
    CLOUD_PROVIDER_SET,
    CLOUD_DEFAULT_MODELS,
    CLOUD_DEFAULT_BASE_URLS,
    CLOUD_DEFAULT_MAX_TOKENS,
    defaultCloudSettings,
    normalizeCloudBaseUrl,
    sanitizeCloudSettings,
    saveCloudSettings,
    loadCloudSettings,
    getCloudApiKey,
    redactCloudSettings,
    buildCloudEndpoint,
    buildCloudRequest,
    streamCloudCompletion,
  };
};
