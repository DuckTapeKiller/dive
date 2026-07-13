// Conversation history routes. Storage lives in server.js (per-mode files
// under DATA_DIR/conversations with serialized writes and delete
// tombstones); this module only owns the HTTP surface.
module.exports = function createConversationsDomain(deps) {
  const {
    parseJsonBody,
    loadConversations,
    loadConversationsForMode,
    saveClientConversation,
    getConversationById,
    deleteConversationById,
    deleteConversationsByMode,
    deleteAllConversations,
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
        await saveClientConversation(
          id,
          body.title,
          typeof body.mode === "string" ? body.mode : "ollama",
          body.messages,
          typeof body.clientId === "string" ? body.clientId : "",
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
      const before = loadConversationsForMode(requestedMode).length;
      await deleteConversationsByMode(requestedMode);
      send(200, {
        ok: true,
        mode: requestedMode,
        deleted: before,
      });
      return true;
    }

    if (req.method === "DELETE" && urlPath === "/api/conversations") {
      await deleteAllConversations();
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
      const deleted = await deleteConversationById(convId);
      if (!deleted) {
        send(404, { error: "Conversation not found" });
        return true;
      }
      send(200, { ok: true });
      return true;
    }

    if (req.method === "GET" && urlPath.startsWith("/api/conversations/id/")) {
      const id = urlPath.slice("/api/conversations/id/".length).trim();
      if (!id) {
        send(400, { error: "Conversation id is required" });
        return true;
      }
      const conv = getConversationById(id);
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
      // Legacy index-based delete: resolve the index against the merged,
      // recency-sorted list, then delete by id.
      const parts = urlPath.split("/");
      const idxStr = parts.pop();
      const idx = parseInt(idxStr, 10);
      const convs = loadConversations();
      if (isNaN(idx) || idx < 0 || idx >= convs.length) {
        send(400, { error: "Invalid conversation index" });
        return true;
      }
      await deleteConversationById(convs[idx].id);
      send(200, { ok: true });
      return true;
    }

    return false;
  }

  return { handleRequest };
};
