"use strict";

// Dive's Pi client speaks RPC, where Pi exposes select/confirm/input dialogs
// but intentionally does not implement ctx.ui.custom(). pi-sandbox's terminal
// permission screen currently uses custom(), so it otherwise returns undefined
// and treats every request as an abort. This adapter is loaded only by Dive's
// Pi RPC process; it leaves the separately maintained pi-sandbox package alone.

const PATCHED_CUSTOM = Symbol("divePiRpcCustomUi");

const SANDBOX_OPTIONS = Object.freeze([
  "Allow for this session only",
  "Abort (keep blocked)",
  "Allow for this project",
  "Allow for all projects",
]);

function isSandboxPermissionTitle(title) {
  return (
    /blocked:\s*"[\s\S]*"\s+is not in\b/i.test(title) ||
    /^Add\s+[\s\S]+\s+to\s+(?:allowedDomains|allowRead|allowWrite)\?\s*$/i.test(
      title,
    )
  );
}

async function inspectSandboxPrompt(factory, done) {
  if (typeof factory !== "function") return null;

  let component;
  try {
    // pi-sandbox's factory only needs requestRender(), theme.fg(), and the
    // callback returned by ctx.ui.custom. Rendering it with a neutral theme
    // lets us identify that one known prompt without depending on package
    // internals or changing the vendor extension.
    component = await factory(
      { requestRender() {} },
      { fg: (_name, value) => String(value ?? "") },
      undefined,
      done,
    );
    if (!component || typeof component.render !== "function") return null;

    const lines = component.render(10000);
    if (!Array.isArray(lines) || typeof lines[0] !== "string") return null;

    const title = lines[0];
    if (!isSandboxPermissionTitle(title)) return null;
    return { title, component };
  } catch (_error) {
    // Unsupported custom components must retain Pi's normal RPC fallback.
    return null;
  }
}

function abortPermissionResult() {
  return { action: "abort", value: "" };
}

function cancelCustomPrompt(prompt) {
  if (typeof prompt.component.handleInput === "function") {
    prompt.component.handleInput("\u001b");
  }
}

async function adaptCustomPermission(factory, ui, fallback) {
  let completedResult;
  const prompt = await inspectSandboxPrompt(factory, (result) => {
    completedResult = result;
  });
  if (!prompt) return fallback(factory);

  let selection;
  try {
    selection = await ui.select(prompt.title, SANDBOX_OPTIONS);
  } catch (_error) {
    // A failed or disconnected UI must fail closed.
    cancelCustomPrompt(prompt);
    return completedResult ?? abortPermissionResult();
  }

  const selectedIndex = SANDBOX_OPTIONS.indexOf(selection);
  if (selectedIndex < 0) {
    cancelCustomPrompt(prompt);
    return completedResult ?? abortPermissionResult();
  }
  if (typeof prompt.component.handleInput !== "function") {
    return abortPermissionResult();
  }

  // Drive the vendor component through its own public Component interface.
  // This preserves pi-sandbox's original validation and value handling rather
  // than duplicating its permission semantics in Dive.
  for (let i = 0; i < selectedIndex; i++) {
    prompt.component.handleInput("\u001b[B");
  }
  prompt.component.handleInput("\r");
  return completedResult ?? abortPermissionResult();
}

module.exports = function divePiRpcUiCompat(pi) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "rpc" || !ctx.hasUI) return;

    const ui = ctx.ui;
    if (!ui || typeof ui.custom !== "function") return;
    if (ui.custom[PATCHED_CUSTOM]) return;

    const originalCustom = ui.custom;
    const fallback = (factory) => originalCustom.call(ui, factory);
    const adaptedCustom = function adaptedCustom(factory) {
      return adaptCustomPermission(factory, ui, fallback);
    };
    Object.defineProperty(adaptedCustom, PATCHED_CUSTOM, { value: true });
    ui.custom = adaptedCustom;
  });
};
