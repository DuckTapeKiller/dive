const assert = require("node:assert/strict");
const test = require("node:test");

const installPiRpcUiCompat = require("../routes/pi-rpc-ui-compat.js");

function registerAdapter() {
  const handlers = new Map();
  installPiRpcUiCompat({
    on(name, handler) {
      handlers.set(name, handler);
    },
  });
  return handlers.get("session_start");
}

function sandboxPrompt(title, value = "/tmp/outside.txt") {
  return (_tui, theme, _keybindings, done) => {
    let selectedIndex = 0;
    const results = [
      { action: "session", value },
      { action: "abort", value },
      { action: "project", value },
      { action: "global", value },
    ];
    return {
      render() {
        return [theme.fg("warning", title)];
      },
      handleInput(data) {
        if (data === "\u001b[B") {
          selectedIndex = Math.min(results.length - 1, selectedIndex + 1);
        } else if (data === "\r") {
          done(results[selectedIndex]);
        } else if (data === "\u001b") {
          done(results[1]);
        }
      },
    };
  };
}

async function createRpcUi(selection) {
  const sessionStart = registerAdapter();
  const requests = [];
  const ui = {
    custom: async () => undefined,
    async select(title, options) {
      requests.push({ title, options });
      return selection;
    },
  };
  await sessionStart({}, { mode: "rpc", hasUI: true, ui });
  return { requests, ui };
}

test("bridges a pi-sandbox read prompt through RPC select", async () => {
  const { requests, ui } = await createRpcUi("Allow for this project");
  const result = await ui.custom(
    sandboxPrompt('Read blocked: "/tmp/outside.txt" is not in allowRead'),
  );

  assert.deepEqual(result, {
    action: "project",
    value: "/tmp/outside.txt",
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].title,
    'Read blocked: "/tmp/outside.txt" is not in allowRead',
  );
  assert.deepEqual(requests[0].options, [
    "Allow for this session only",
    "Abort (keep blocked)",
    "Allow for this project",
    "Allow for all projects",
  ]);
});

test("fails closed when the RPC dialog is cancelled", async () => {
  const { ui } = await createRpcUi(undefined);
  const result = await ui.custom(
    sandboxPrompt(
      'Network blocked: "example.test" is not in allowedDomains',
      "example.test",
    ),
  );

  assert.deepEqual(result, {
    action: "abort",
    value: "example.test",
  });
});

test("does not replace custom UI outside RPC mode and preserves unknown fallbacks", async () => {
  const sessionStart = registerAdapter();
  let fallbackCalls = 0;
  const ui = {
    custom: async () => {
      fallbackCalls += 1;
      return "fallback";
    },
    async select() {
      throw new Error("select should not be called");
    },
  };

  await sessionStart({}, { mode: "interactive", hasUI: true, ui });
  assert.equal(
    await ui.custom(
      sandboxPrompt('Read blocked: "/tmp/x" is not in allowRead'),
    ),
    "fallback",
  );

  await sessionStart({}, { mode: "rpc", hasUI: true, ui });
  assert.equal(
    await ui.custom(() => ({ render: () => ["unrelated custom UI"] })),
    "fallback",
  );
  assert.equal(fallbackCalls, 2);
});
