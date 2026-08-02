// The single definition of Dive's modes. Loaded as a classic script by the
// browser (first, before 01-core.js) and required directly by the server, so
// both sides answer "which modes exist?" from the same place.
//
// Two orderings, deliberately kept separate because they are different facts:
//
//   MODES      canonical order. Drives storage: object keys in persisted
//              settings files are built by iterating it, and server.js rewrites
//              a settings file when its JSON differs from the sanitised form,
//              so reordering this would rewrite every user's settings.
//   MODE_DEFS  display order. Drives the topbar toggle and "first enabled"
//              resolution, which is why llama.cpp is first.
//
// Removing `pi` from the canonical order yields exactly the mode list used for
// everything Dive itself supplies (skills, MCP, prompts, lessons).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  } else {
    // Classic script: publish each export as a global so the split client
    // files can keep referring to them by bare name.
    for (const key of Object.keys(api)) root[key] = api[key];
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // diveSkills    Dive supplies the tool loop: skills, custom skills, plugins,
  //               MCP, system prompts, lessons. False for Pi, which runs its
  //               own agent loop in an external process and has its own skills,
  //               extensions and context files (~/.pi/agent/AGENTS.md). Pi
  //               documents that it deliberately has no MCP.
  // localEndpoint Local OpenAI-compatible bespoke mode served at
  //               /api/<id>/stream. Ollama is local but speaks its own API, so
  //               it is not one of these.
  const MODES = Object.freeze(
    [
      {
        id: "ollama",
        label: "Ollama",
        btnId: "btnOllama",
        display: 4,
        enabledByDefault: false,
        diveSkills: true,
        localEndpoint: false,
      },
      {
        id: "pi",
        label: "Pi",
        btnId: "btnPi",
        display: 1,
        enabledByDefault: true,
        diveSkills: false,
        localEndpoint: false,
      },
      {
        id: "cloud",
        label: "Cloud",
        btnId: "btnCloud",
        display: 2,
        enabledByDefault: true,
        diveSkills: true,
        localEndpoint: false,
      },
      {
        id: "lmstudio",
        label: "LM Studio",
        btnId: "btnLmStudio",
        display: 3,
        enabledByDefault: false,
        diveSkills: true,
        localEndpoint: true,
      },
      {
        id: "llamacpp",
        label: "llama.cpp",
        btnId: "btnLlamaCpp",
        display: 0,
        enabledByDefault: true,
        diveSkills: true,
        localEndpoint: true,
      },
    ].map(Object.freeze),
  );

  const byDisplay = [...MODES].sort((a, b) => a.display - b.display);
  const idsWhere = (predicate) =>
    Object.freeze(MODES.filter(predicate).map((m) => m.id));

  return {
    MODES,
    // Topbar/settings rendering order.
    MODE_DEFS: Object.freeze(byDisplay),
    // Canonical order.
    MODE_IDS: idsWhere(() => true),
    DIVE_SKILL_MODE_IDS: idsWhere((m) => m.diveSkills),
    LOCAL_MODE_IDS: idsWhere((m) => m.localEndpoint),
    DEFAULT_ENABLED_MODES: Object.freeze(
      byDisplay.filter((m) => m.enabledByDefault).map((m) => m.id),
    ),
    modeById(id) {
      return MODES.find((m) => m.id === id) || null;
    },
  };
});
