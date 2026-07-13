// Notes domain: individual Markdown files in DATA_DIR/notes, plus the
// legacy single-note (notes.json) migration and every /api/notes* route.
// The local_notes skill in skills.js has its own independent implementation.
const fs = require("fs");
const path = require("path");

module.exports = function createNotesDomain(deps) {
  const { DATA_DIR, parseJsonBody } = deps;

  const NOTES_FILE = path.join(DATA_DIR, "notes.json");
  const NOTES_DIR = path.join(DATA_DIR, "notes");
  const ACTIVE_NOTE_FILE = path.join(NOTES_DIR, ".active");
  const NOTE_MAX_CHARS = 200000;

  // A note name is the .md filename without extension. Strict allowlist
  // keeps path traversal impossible and filenames portable.
  function sanitizeNoteName(raw) {
    const cleaned = String(raw || "")
      .replace(/\.md$/i, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 80)
      .trim();
    return cleaned;
  }

  function noteFilePath(name) {
    const clean = sanitizeNoteName(name);
    if (!clean) {
      const error = new Error("Invalid note name.");
      error.statusCode = 400;
      throw error;
    }
    const filePath = path.join(NOTES_DIR, `${clean}.md`);
    if (!filePath.startsWith(NOTES_DIR + path.sep)) {
      const error = new Error("Invalid note path.");
      error.statusCode = 400;
      throw error;
    }
    return { name: clean, filePath };
  }

  // One-time migration: the legacy single note (notes.json) becomes
  // Notes.md. The legacy file is kept as a backup, never deleted.
  function migrateLegacyNotes() {
    try {
      fs.mkdirSync(NOTES_DIR, { recursive: true });
      const hasNotes = fs
        .readdirSync(NOTES_DIR)
        .some((entry) => entry.toLowerCase().endsWith(".md"));
      if (hasNotes || !fs.existsSync(NOTES_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(NOTES_FILE, "utf8"));
      const text = typeof raw.text === "string" ? raw.text : "";
      if (text.trim()) {
        fs.writeFileSync(path.join(NOTES_DIR, "Notes.md"), text, "utf8");
        setActiveNoteName("Notes");
      }
    } catch (e) {
      console.error("Notes migration failed:", e.message || e);
    }
  }

  function getActiveNoteName() {
    try {
      const raw = fs.readFileSync(ACTIVE_NOTE_FILE, "utf8").trim();
      const clean = sanitizeNoteName(raw);
      if (clean && fs.existsSync(path.join(NOTES_DIR, `${clean}.md`))) {
        return clean;
      }
    } catch {
      /* no active marker yet */
    }
    return "";
  }

  function setActiveNoteName(name) {
    try {
      fs.mkdirSync(NOTES_DIR, { recursive: true });
      fs.writeFileSync(ACTIVE_NOTE_FILE, sanitizeNoteName(name), "utf8");
    } catch (e) {
      console.error("Could not persist active note:", e.message || e);
    }
  }

  function listNotes() {
    migrateLegacyNotes();
    let entries = [];
    try {
      entries = fs.readdirSync(NOTES_DIR).filter((entry) => {
        return entry.toLowerCase().endsWith(".md") && !entry.startsWith(".");
      });
    } catch {
      entries = [];
    }
    const notes = entries
      .map((entry) => {
        const filePath = path.join(NOTES_DIR, entry);
        let stat = null;
        try {
          stat = fs.statSync(filePath);
        } catch {
          return null;
        }
        return {
          name: entry.replace(/\.md$/i, ""),
          updatedAt: new Date(stat.mtimeMs).toISOString(),
          sizeBytes: stat.size,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    let active = getActiveNoteName();
    if (!active && notes.length) active = notes[0].name;
    return { notes, active };
  }

  function readNote(name) {
    const { name: clean, filePath } = noteFilePath(name);
    let text = "";
    let updatedAt = null;
    try {
      text = fs.readFileSync(filePath, "utf8");
      updatedAt = new Date(fs.statSync(filePath).mtimeMs).toISOString();
    } catch {
      text = "";
    }
    return { name: clean, text, updatedAt };
  }

  function writeNote(name, text) {
    const { name: clean, filePath } = noteFilePath(name);
    const body =
      String(text || "").length > NOTE_MAX_CHARS
        ? String(text).slice(0, NOTE_MAX_CHARS)
        : String(text || "");
    fs.mkdirSync(NOTES_DIR, { recursive: true });
    fs.writeFileSync(filePath, body, "utf8");
    setActiveNoteName(clean);
    return { name: clean, text: body, updatedAt: new Date().toISOString() };
  }

  // Create a note with a unique name derived from the requested title.
  function createNote(title) {
    migrateLegacyNotes();
    const base = sanitizeNoteName(title) || "Untitled";
    let candidate = base;
    let counter = 2;
    while (fs.existsSync(path.join(NOTES_DIR, `${candidate}.md`))) {
      candidate = `${base} ${counter}`;
      counter += 1;
      if (counter > 500) throw new Error("Could not allocate a note name.");
    }
    return writeNote(candidate, "");
  }

  function renameNote(name, title) {
    const { name: fromName, filePath: fromPath } = noteFilePath(name);
    const toBase = sanitizeNoteName(title);
    if (!toBase) {
      const error = new Error("Invalid note title.");
      error.statusCode = 400;
      throw error;
    }
    if (toBase === fromName) return { name: fromName };
    const { name: toName, filePath: toPath } = noteFilePath(toBase);
    if (fs.existsSync(toPath)) {
      const error = new Error(`A note named "${toName}" already exists.`);
      error.statusCode = 409;
      throw error;
    }
    fs.renameSync(fromPath, toPath);
    if (getActiveNoteName() === fromName) setActiveNoteName(toName);
    return { name: toName };
  }

  function deleteNote(name) {
    const { name: clean, filePath } = noteFilePath(name);
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already gone */
    }
    if (getActiveNoteName() === clean) {
      const { notes } = listNotes();
      setActiveNoteName(notes.length ? notes[0].name : "");
    }
    return listNotes();
  }

  // Legacy single-note API compatibility: reads/writes the active note.
  function loadNotes() {
    migrateLegacyNotes();
    const active = getActiveNoteName() || listNotes().active;
    if (active) return readNote(active);
    return { name: "", text: "", updatedAt: null };
  }

  function saveNotes(text) {
    const active = getActiveNoteName() || listNotes().active || "Notes";
    return writeNote(active, text);
  }

  async function handleRequest(ctx) {
    const { req, urlPath, requestUrl, send } = ctx;

    if (req.method === "GET" && urlPath === "/api/notes/list") {
      try {
        send(200, listNotes());
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "GET" && urlPath === "/api/notes") {
      try {
        const requestedName = requestUrl.searchParams.get("name");
        if (requestedName) {
          const note = readNote(requestedName);
          // Opening a note in the panel makes it the target of the
          // local_notes skill ("append this to my notes" lands where the
          // user is looking).
          setActiveNoteName(note.name);
          send(200, note);
          return true;
        }
        send(200, loadNotes());
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/notes/create") {
      try {
        const body = await parseJsonBody(req);
        send(200, createNote(body?.title || ""));
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/notes/rename") {
      try {
        const body = await parseJsonBody(req);
        send(200, renameNote(body?.name || "", body?.title || ""));
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (req.method === "POST" && urlPath === "/api/notes/delete") {
      try {
        const body = await parseJsonBody(req);
        send(200, deleteNote(body?.name || ""));
      } catch (e) {
        send(e.statusCode || 500, { error: e.message });
      }
      return true;
    }

    if (
      (req.method === "PUT" || req.method === "POST") &&
      urlPath === "/api/notes"
    ) {
      try {
        const body = await parseJsonBody(req);
        if (!body || typeof body.text !== "string") {
          send(400, { error: "text field required" });
          return true;
        }
        const saved = body.name
          ? writeNote(body.name, body.text)
          : saveNotes(body.text);
        send(200, saved);
      } catch (e) {
        const status = e && e.statusCode ? e.statusCode : 500;
        send(status, { error: e?.message || "Failed to save notes" });
      }
      return true;
    }

    return false;
  }

  return { handleRequest };
};
