// LanguageTool checking for Dive's prose text boxes: the message box, notes,
// saved prompts, system prompts and lessons. A textarea cannot style its own
// text, so each one gets a transparent mirror laid over it that repeats the
// text with the flagged ranges underlined. Clicking an underlined word opens
// the suggestions. Checks go through /api/languagetool/check, which forwards
// them to the LanguageTool server set in Settings > MAIN.

const LT_FIELD_IDS = [
  "input",
  "notesArea",
  "promptContent",
  "systemPromptDbOff",
  "systemPromptDbOn",
  "lessonsTextarea",
];
const LT_CHECK_DELAY_MS = 700;
const LT_MIRRORED_STYLES = [
  "boxSizing",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontStretch",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textTransform",
  "textIndent",
  "textAlign",
  "direction",
  "tabSize",
  "whiteSpace",
  "overflowWrap",
  "wordBreak",
  "paddingTop",
  "paddingLeft",
  "paddingBottom",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
];

let ltSettings = {
  enabled: false,
  serverUrl: "http://localhost:8010",
  language: "auto",
  preferredVariants: "en-GB,es-ES",
  spelling: "languagetool",
  dictionary: [],
  disabledRules: [],
};
const ltFields = new Map();
// "Ignore" lasts until Dive is closed, across every text box.
const ltIgnored = new Set();
let ltPopup = null;

function ltIgnoreKey(match) {
  return `${match.ruleId}\u0000${match.text}`;
}

function ltMarkClass(match) {
  if (match.issueType === "misspelling") return "lt-mark lt-mark-spelling";
  if (match.issueType === "grammar") return "lt-mark lt-mark-grammar";
  return "lt-mark lt-mark-style";
}

function ltVisibleMatches(state) {
  return state.matches.filter((m) => !ltIgnored.has(ltIgnoreKey(m)));
}

function ltIsShown(textarea) {
  return textarea.isConnected && textarea.getClientRects().length > 0;
}

function ltLayout(state) {
  const { textarea, mirror } = state;
  if (!ltSettings.enabled || !state.matches.length || !ltIsShown(textarea)) {
    mirror.hidden = true;
    return;
  }
  mirror.hidden = false;
  const style = getComputedStyle(textarea);
  for (const name of LT_MIRRORED_STYLES) mirror.style[name] = style[name];
  // A scrollbar narrows the textarea's text column; widen the mirror's right
  // padding by the same amount so lines wrap at the same place.
  const scrollbar =
    textarea.offsetWidth -
    textarea.clientWidth -
    parseFloat(style.borderLeftWidth) -
    parseFloat(style.borderRightWidth);
  mirror.style.paddingRight = `${parseFloat(style.paddingRight) + Math.max(0, scrollbar)}px`;
  mirror.style.left = `${textarea.offsetLeft}px`;
  mirror.style.top = `${textarea.offsetTop}px`;
  mirror.style.width = `${textarea.offsetWidth}px`;
  mirror.style.height = `${textarea.offsetHeight}px`;
  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;
}

function ltRender(state) {
  const { textarea, mirror } = state;
  mirror.textContent = "";
  const matches = ltSettings.enabled ? ltVisibleMatches(state) : [];
  if (matches.length) {
    const text = textarea.value;
    let cursor = 0;
    for (const match of matches) {
      if (match.offset < cursor) continue;
      if (match.offset > cursor) {
        mirror.appendChild(
          document.createTextNode(text.slice(cursor, match.offset)),
        );
      }
      const mark = document.createElement("span");
      mark.className = ltMarkClass(match);
      mark.dataset.ltOffset = String(match.offset);
      mark.textContent = text.slice(match.offset, match.offset + match.length);
      mirror.appendChild(mark);
      cursor = match.offset + match.length;
    }
    // The zero-width space keeps a trailing newline's empty line, which a
    // textarea shows and a div would otherwise collapse.
    mirror.appendChild(document.createTextNode(`${text.slice(cursor)}​`));
  }
  ltLayout(state);
}

// Keeps the underlines on their words while the text changes, until the next
// check answers: matches before the edit stay, matches after it move with it,
// and matches it touched are dropped.
function ltShift(state, next) {
  const prev = state.text;
  if (prev === next) return;
  let start = 0;
  const shortest = Math.min(prev.length, next.length);
  while (start < shortest && prev[start] === next[start]) start++;
  let tail = 0;
  while (
    tail < shortest - start &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail++;
  }
  const oldEnd = prev.length - tail;
  const delta = next.length - prev.length;
  state.matches = state.matches
    .filter((m) => m.offset + m.length <= start || m.offset >= oldEnd)
    .map((m) => (m.offset >= oldEnd ? { ...m, offset: m.offset + delta } : m));
  state.text = next;
}

function ltSchedule(state, delay = LT_CHECK_DELAY_MS) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (!ltSettings.enabled) return;
  state.timer = window.setTimeout(() => {
    state.timer = null;
    ltCheck(state);
  }, delay);
}

async function ltCheck(state) {
  const { textarea } = state;
  const text = textarea.value;
  if (!ltSettings.enabled) return;
  if (!ltIsShown(textarea)) {
    // Checked when it is shown again (see the ResizeObserver in ltAttach).
    state.stale = true;
    return;
  }
  state.stale = false;
  if (state.controller) state.controller.abort();
  if (!text.trim()) {
    state.matches = [];
    ltRender(state);
    return;
  }
  const controller = new AbortController();
  state.controller = controller;
  let payload = null;
  let ok = false;
  try {
    const res = await fetch(apiUrl("/api/languagetool/check"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    ok = res.ok;
    payload = await res.json();
  } catch (error) {
    if (controller.signal.aborted) return;
    payload = { error: error.message || String(error) };
  }
  if (state.controller === controller) state.controller = null;
  if (controller.signal.aborted || textarea.value !== text) return;
  if (!ok) {
    ltSetStatus(payload?.error || "LanguageTool check failed.", true);
    return;
  }
  ltSetStatus("");
  state.text = text;
  state.language = payload.language;
  state.matches = (payload.matches || []).sort((a, b) => a.offset - b.offset);
  ltRender(state);
}

function ltValueChanged(state) {
  ltShift(state, state.textarea.value);
  ltRender(state);
  ltSchedule(state);
}

function ltAttach(textarea) {
  if (ltFields.has(textarea)) return;
  const mirror = document.createElement("div");
  mirror.className = "lt-mirror";
  mirror.setAttribute("aria-hidden", "true");
  mirror.hidden = true;
  const parent = textarea.parentElement;
  if (getComputedStyle(parent).position === "static") {
    // The mirror is positioned against the textarea's own parent so that it
    // scrolls and clips with it.
    parent.style.position = "relative";
  }
  textarea.insertAdjacentElement("afterend", mirror);

  const state = {
    textarea,
    mirror,
    text: textarea.value,
    matches: [],
    language: null,
    timer: null,
    controller: null,
    stale: true,
    spellcheck: textarea.getAttribute("spellcheck"),
  };
  ltFields.set(textarea, state);

  // Dive fills these boxes by assigning .value (loading a note, clearing the
  // message box after sending), which fires no input event.
  const native = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  );
  Object.defineProperty(textarea, "value", {
    configurable: true,
    get() {
      return native.get.call(this);
    },
    set(next) {
      native.set.call(this, next);
      ltValueChanged(state);
    },
  });

  textarea.addEventListener("input", () => {
    ltClosePopup();
    ltValueChanged(state);
  });
  textarea.addEventListener("scroll", () => {
    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
    ltClosePopup();
  });
  textarea.addEventListener("click", () => ltOnClick(state));
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ltPopup) {
      event.stopPropagation();
      ltClosePopup();
    }
  });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      ltLayout(state);
      if (state.stale && ltIsShown(textarea)) ltSchedule(state, 0);
    }).observe(textarea);
  }
  ltApplySpellcheck(state);
  ltSchedule(state, 0);
}

// The system spellchecker (macOS's, in the app) would draw a second line
// under the same words, so it is off while LanguageTool checks spelling,
// unless the settings ask for both.
function ltApplySpellcheck(state) {
  if (ltSettings.enabled && ltSettings.spelling === "languagetool") {
    state.textarea.setAttribute("spellcheck", "false");
  } else if (state.spellcheck === null) {
    state.textarea.removeAttribute("spellcheck");
  } else {
    state.textarea.setAttribute("spellcheck", state.spellcheck);
  }
}

function ltOnClick(state) {
  ltClosePopup();
  const { textarea } = state;
  if (!ltSettings.enabled || textarea.selectionStart !== textarea.selectionEnd)
    return;
  const caret = textarea.selectionStart;
  const match = ltVisibleMatches(state).find(
    (m) => caret >= m.offset && caret <= m.offset + m.length,
  );
  if (!match) return;
  const mark = state.mirror.querySelector(`[data-lt-offset="${match.offset}"]`);
  if (!mark) return;
  ltOpenPopup(state, match, mark);
}

function ltButton(label, className, onPick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  // mousedown would move the focus out of the textarea and lose the caret.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    onPick();
  });
  return button;
}

function ltOpenPopup(state, match, mark) {
  const popup = document.createElement("div");
  popup.className = "lt-popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "LanguageTool suggestion");

  const head = document.createElement("div");
  head.className = "lt-popup-head";
  const title = document.createElement("span");
  title.className = "lt-popup-title";
  title.textContent = (
    match.shortMessage ||
    match.category ||
    "Suggestion"
  ).toUpperCase();
  head.appendChild(title);
  // Each paragraph is checked in its own language.
  const language = match.language || state.language;
  if (language?.code) {
    const lang = document.createElement("span");
    lang.className = "lt-popup-lang";
    lang.textContent = language.code.toUpperCase();
    lang.title = language.name || language.code;
    head.appendChild(lang);
  }
  popup.appendChild(head);

  const message = document.createElement("div");
  message.className = "lt-popup-message";
  message.textContent = match.message;
  popup.appendChild(message);

  if (match.replacements.length) {
    const list = document.createElement("div");
    list.className = "lt-popup-replacements";
    for (const replacement of match.replacements) {
      const label =
        replacement === ""
          ? "(delete)"
          : replacement.trim() === ""
            ? JSON.stringify(replacement)
            : replacement;
      list.appendChild(
        ltButton(label, "lt-popup-replacement", () =>
          ltReplace(state, match, replacement),
        ),
      );
    }
    popup.appendChild(list);
  }

  const actions = document.createElement("div");
  actions.className = "lt-popup-actions";
  actions.appendChild(
    ltButton("IGNORE", "lt-popup-action", () => {
      ltIgnored.add(ltIgnoreKey(match));
      ltClosePopup();
      ltRenderAll();
    }),
  );
  if (match.issueType === "misspelling" && !/\s/.test(match.text)) {
    actions.appendChild(
      ltButton("ADD TO DICTIONARY", "lt-popup-action", () =>
        ltAddToList(
          "/api/languagetool/dictionary",
          { word: match.text },
          (m) => m.issueType === "misspelling" && m.text === match.text,
        ),
      ),
    );
  }
  if (match.ruleId) {
    const disable = ltButton("DISABLE RULE", "lt-popup-action", () =>
      ltAddToList(
        "/api/languagetool/disabled-rules",
        { ruleId: match.ruleId },
        (m) => m.ruleId === match.ruleId,
      ),
    );
    disable.title = match.ruleDescription || match.ruleId;
    actions.appendChild(disable);
  }
  popup.appendChild(actions);

  popup.addEventListener("mousedown", (event) => event.stopPropagation());
  document.body.appendChild(popup);
  ltPopup = popup;

  const rect = mark.getClientRects()[0] || mark.getBoundingClientRect();
  const margin = 8;
  const width = popup.offsetWidth;
  const height = popup.offsetHeight;
  let left = Math.min(rect.left, window.innerWidth - width - margin);
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - height - 6);
  }
  left = Math.max(margin, left);
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function ltClosePopup() {
  if (!ltPopup) return;
  ltPopup.remove();
  ltPopup = null;
}

function ltReplace(state, match, replacement) {
  const { textarea } = state;
  ltClosePopup();
  if (
    textarea.value.slice(match.offset, match.offset + match.length) !==
    match.text
  )
    return;
  textarea.focus();
  textarea.setSelectionRange(match.offset, match.offset + match.length);
  // execCommand keeps the edit on the textarea's undo stack and fires the
  // input event Dive's own handlers listen for.
  const done =
    typeof document.execCommand === "function" &&
    (replacement === ""
      ? document.execCommand("delete", false)
      : document.execCommand("insertText", false, replacement));
  if (!done) {
    textarea.setRangeText(
      replacement,
      match.offset,
      match.offset + match.length,
      "end",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

async function ltAddToList(path, body, drops) {
  ltClosePopup();
  try {
    const data = await postJson(path, body, "Update LanguageTool settings");
    if (data?.settings) ltSettings = { ...ltSettings, ...data.settings };
  } catch (error) {
    ltSetStatus(error.message || String(error), true);
    return;
  }
  for (const state of ltFields.values()) {
    state.matches = state.matches.filter((m) => !drops(m));
  }
  ltRenderAll();
  ltFillSettingsForm();
}

function ltRenderAll() {
  for (const state of ltFields.values()) ltRender(state);
}

function ltSetStatus(message, isError = false) {
  const status = document.getElementById("languageToolStatus");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("lt-status-error", Boolean(isError && message));
}

function ltFillSettingsForm() {
  const enabled = document.getElementById("languageToolEnabledInput");
  const url = document.getElementById("languageToolServerUrl");
  const language = document.getElementById("languageToolLanguageSelect");
  const variants = document.getElementById("languageToolVariantsInput");
  const spelling = document.getElementById("languageToolSpellingSelect");
  const dictionary = document.getElementById("languageToolDictionary");
  const rules = document.getElementById("languageToolDisabledRules");
  if (enabled) enabled.checked = ltSettings.enabled;
  if (url) url.value = ltSettings.serverUrl;
  if (variants) variants.value = ltSettings.preferredVariants;
  const selects = [
    [language, ltSettings.language],
    [spelling, ltSettings.spelling],
  ];
  for (const [select, value] of selects) {
    if (!select) continue;
    select.value = value;
    if (typeof refreshCustomSelectUi === "function") {
      refreshCustomSelectUi(select);
    }
  }
  if (dictionary) dictionary.value = ltSettings.dictionary.join("\n");
  if (rules) rules.value = ltSettings.disabledRules.join("\n");
}

async function ltSaveSettings(patch) {
  try {
    const data = await postJson(
      "/api/languagetool/settings",
      { settings: patch },
      "Save LanguageTool settings",
    );
    if (data?.settings) ltSettings = { ...ltSettings, ...data.settings };
  } catch (error) {
    ltSetStatus(error.message || String(error), true);
    return;
  }
  ltFillSettingsForm();
  for (const state of ltFields.values()) {
    ltApplySpellcheck(state);
    state.matches = [];
    ltRender(state);
    ltSchedule(state, 0);
  }
  if (!ltSettings.enabled) {
    ltClosePopup();
    ltSetStatus("");
  }
}

async function ltTestConnection() {
  ltSetStatus("Connecting…");
  try {
    const res = await fetch(apiUrl("/api/languagetool/status"));
    const data = await res.json();
    if (data.ok) {
      ltSetStatus(
        `Connected to ${data.name}${data.version ? ` ${data.version}` : ""} at ${data.serverUrl}.`,
      );
    } else {
      ltSetStatus(data.error || "LanguageTool is not reachable.", true);
    }
  } catch (error) {
    ltSetStatus(error.message || String(error), true);
  }
}

function ltLines(id) {
  const el = document.getElementById(id);
  return el
    ? el.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function ltWireSettingsForm() {
  const bind = (id, event, handler) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, () => handler(el));
  };
  bind("languageToolEnabledInput", "change", (el) =>
    ltSaveSettings({ enabled: el.checked }),
  );
  bind("languageToolServerUrl", "change", (el) =>
    ltSaveSettings({ serverUrl: el.value.trim() }),
  );
  bind("languageToolLanguageSelect", "change", (el) =>
    ltSaveSettings({ language: el.value }),
  );
  bind("languageToolVariantsInput", "change", (el) =>
    ltSaveSettings({ preferredVariants: el.value }),
  );
  bind("languageToolSpellingSelect", "change", (el) =>
    ltSaveSettings({ spelling: el.value }),
  );
  bind("languageToolDictionary", "change", () =>
    ltSaveSettings({ dictionary: ltLines("languageToolDictionary") }),
  );
  bind("languageToolDisabledRules", "change", () =>
    ltSaveSettings({ disabledRules: ltLines("languageToolDisabledRules") }),
  );
  bind("languageToolTestBtn", "click", () => ltTestConnection());
}

async function initLanguageTool() {
  try {
    const res = await fetch(apiUrl("/api/languagetool/settings"));
    const data = await res.json();
    if (res.ok && data?.settings)
      ltSettings = { ...ltSettings, ...data.settings };
  } catch (_error) {
    // Without the settings LanguageTool stays off; nothing else depends on it.
  }
  ltFillSettingsForm();
  ltWireSettingsForm();
  for (const id of LT_FIELD_IDS) {
    const textarea = document.getElementById(id);
    if (textarea) ltAttach(textarea);
  }
  document.addEventListener("mousedown", ltClosePopup);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") ltClosePopup();
  });
  window.addEventListener("resize", () => {
    ltClosePopup();
    for (const state of ltFields.values()) ltLayout(state);
  });
  window.addEventListener("blur", ltClosePopup);
  // Panels slide and reflow without resizing the textareas themselves.
  document.addEventListener("transitionend", () => {
    for (const state of ltFields.values()) ltLayout(state);
  });
}

document.addEventListener("DOMContentLoaded", initLanguageTool);
