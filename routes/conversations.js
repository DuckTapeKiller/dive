// Conversation history routes. Storage helpers (loadConversations, etc.)
// stay in server.js because the chat/stream handlers persist through them
// too; this module only owns the HTTP surface.
module.exports = function createConversationsDomain(deps) {
  const {
    parseJsonBody,
    loadConversations,
    saveConversations,
    saveClientConversation,
    UI_SETTINGS_MODE_KEYS,
  } = deps;

  async function handleRequest(ctx) {
    const { req, urlPath, send } = ctx;

    if (req.method === "GET" && urlPath === "/api/conversations") {
      send(200, loadConversations());
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/conversations") {
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          send(400, { error: "Conversation body required" });
          return true;
        }
        const id = typeof body.id === "string" ? body.id : "";
        if (!id) {
          send(400, { error: "Conversation id required" });
          return true;
        }
        saveClientConversation(
          id,
          body.title,
          typeof body.mode === "string" ? body.mode : "ollama",
          body.messages,
        );
        send(200, { ok: true });
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    const deleteModeMatch =
      req.method === "DELETE" &&
      urlPath.match(/^\/api\/conversations\/mode\/([^/]+)$/);
    if (deleteModeMatch) {
      const requestedMode = decodeURIComponent(deleteModeMatch[1] || "");
      // Every chat mode keeps its own history — local modes included.
      const allowedModes = new Set(UI_SETTINGS_MODE_KEYS);
      if (!allowedModes.has(requestedMode)) {
        send(400, { error: "Invalid conversation mode" });
        return true;
      }
      const convs = loadConversations();
      const next = convs.filter((conv) => {
        const convMode =
          typeof conv.mode === "string" && conv.mode ? conv.mode : "ollama";
        return convMode !== requestedMode;
      });
      saveConversations(next);
      send(200, {
        ok: true,
        mode: requestedMode,
        deleted: convs.length - next.length,
      });
      return true;
    }

    if (req.method === "DELETE" && urlPath === "/api/conversations") {
      saveConversations([]);
      send(200, { ok: true });
      return true;
    }

    const deleteMatch =
      req.method === "DELETE" &&
      urlPath.match(/^\/api\/conversations\/id\/([^/]+)$/);
    if (deleteMatch) {
      const encodedId = deleteMatch[1];
      const convId = decodeURIComponent(encodedId || "");
      if (!convId) {
        send(400, { error: "Conversation id is required" });
        return true;
      }
      const convs = loadConversations();
      const next = convs.filter((c) => c.id !== convId);
      if (next.length === convs.length) {
        send(404, { error: "Conversation not found" });
        return true;
      }
      saveConversations(next);
      send(200, { ok: true });
      return true;
    }

    if (req.method === "GET" && urlPath.startsWith("/api/conversations/id/")) {
      const id = urlPath.slice("/api/conversations/id/".length).trim();
      if (!id) {
        send(400, { error: "Conversation id is required" });
        return true;
      }
      const convs = loadConversations();
      const conv = convs.find((c) => c.id === id);
      if (!conv) {
        send(404, { error: "Conversation not found" });
        return true;
      }
      send(200, conv);
      return true;
    }

    if (
      req.method === "DELETE" &&
      (urlPath === "/api/conversations/id" ||
        urlPath === "/api/conversations/id/")
    ) {
      send(400, {
        error:
          "Conversation id is required in the URL path, e.g. /api/conversations/id/{id}",
      });
      return true;
    }

    if (req.method === "DELETE" && urlPath.startsWith("/api/conversations/")) {
      const parts = urlPath.split("/");
      const idxStr = parts.pop();
      const idx = parseInt(idxStr, 10);
      const convs = loadConversations();
      if (isNaN(idx) || idx < 0 || idx >= convs.length) {
        send(400, { error: "Invalid conversation index" });
        return true;
      }
      convs.splice(idx, 1);
      saveConversations(convs);
      send(200, { ok: true });
      return true;
    }

    return false;
  }

  return { handleRequest };
};
