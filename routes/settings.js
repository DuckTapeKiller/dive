// Settings routes for every mode: UI, cloud, Ollama server URL, and the
// LM Studio / llama.cpp local-model config. The underlying load/save
// helpers stay in server.js because the chat/stream handlers read them too.
module.exports = function createSettingsDomain(deps) {
  const {
    parseJsonBody,
    loadUiSettingsWithMeta,
    saveUiSettings,
    loadCloudSettings,
    saveCloudSettings,
    sanitizeCloudSettings,
    redactCloudSettings,
    loadLocalModelSettings,
    saveLocalModelSettings,
    getOllamaBaseUrl,
    saveOllamaBaseUrl,
  } = deps;

  async function handleRequest(ctx) {
    const { req, urlPath, send } = ctx;

    if (req.method === "GET" && urlPath === "/api/ui/settings") {
      const payload = loadUiSettingsWithMeta();
      send(200, payload);
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/ui/settings") {
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          send(400, { error: "Settings object is required" });
          return true;
        }
        const nextSettings =
          body.settings && typeof body.settings === "object"
            ? body.settings
            : body;
        const sanitized = saveUiSettings(nextSettings);
        send(200, { ok: true, settings: sanitized, exists: true });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/cloud/settings") {
      send(200, { settings: redactCloudSettings(loadCloudSettings()) });
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/cloud/settings") {
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          send(400, { error: "Settings object is required" });
          return true;
        }
        const nextSettings =
          body.settings && typeof body.settings === "object"
            ? body.settings
            : body;
        const sanitized = sanitizeCloudSettings(
          nextSettings,
          loadCloudSettings(),
        );
        saveCloudSettings(sanitized);
        send(200, {
          ok: true,
          settings: redactCloudSettings(sanitized),
        });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/ollama/settings") {
      send(200, { baseUrl: getOllamaBaseUrl() });
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/ollama/settings") {
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          send(400, { error: "Settings object is required" });
          return true;
        }
        const saved = saveOllamaBaseUrl(body.baseUrl);
        send(200, { ok: true, baseUrl: saved });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/local-models/settings") {
      send(200, { settings: loadLocalModelSettings() });
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/local-models/settings") {
      try {
        const body = await parseJsonBody(req);
        send(200, { settings: saveLocalModelSettings(body && body.settings) });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    return false;
  }

  return { handleRequest };
};
