const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { executeSkill, skillRequiresShellConfirmation } = require("../skills");

test("Calculator Skill", async () => {
  const result = await executeSkill(
    {
      function: {
        name: "calculator",
        arguments: JSON.stringify({ expression: "2 + 2 * 4" }),
      },
    },
    {},
  );
  assert.strictEqual(result, "Result: 10");

  const result2 = await executeSkill(
    {
      function: {
        name: "calculator",
        arguments: JSON.stringify({ expression: "16 / 4" }),
      },
    },
    {},
  );
  assert.strictEqual(result2, "Result: 4");

  const resultErr = await executeSkill(
    {
      function: {
        name: "calculator",
        arguments: JSON.stringify({ expression: "abc" }),
      },
    },
    {},
  );
  assert.ok(
    resultErr.startsWith("Error") || resultErr.startsWith("Calculator Error"),
  );
});

test("Time and Date Skill", async () => {
  const result = await executeSkill(
    {
      function: {
        name: "time_and_date",
        arguments: "{}",
      },
    },
    {},
  );
  assert.ok(result.includes("Current time"));
  assert.ok(result.includes("Current date"));
  assert.ok(result.includes("Day of the week"));
});

test("Local Notes Skill - Read and Append", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-test-"));
  try {
    // Read empty notes
    const read1 = await executeSkill(
      {
        function: {
          name: "local_notes",
          arguments: JSON.stringify({ action: "read" }),
        },
      },
      { dataDir: tmpDir },
    );
    assert.strictEqual(read1, "Your notes are currently empty.");

    // Append notes
    const append = await executeSkill(
      {
        function: {
          name: "local_notes",
          arguments: JSON.stringify({
            action: "append",
            content: "Test note 123",
          }),
        },
      },
      { dataDir: tmpDir },
    );
    assert.strictEqual(append, 'Successfully appended to your note "Notes".');
    // Notes are individual Markdown files now.
    assert.ok(
      fs.existsSync(path.join(tmpDir, "notes", "Notes.md")),
      "expected notes/Notes.md to exist",
    );

    // Read again
    const read2 = await executeSkill(
      {
        function: {
          name: "local_notes",
          arguments: JSON.stringify({ action: "read" }),
        },
      },
      { dataDir: tmpDir },
    );
    assert.ok(read2.includes("Test note 123"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Mode snapshots isolate built-in and custom skill availability", async () => {
  const customSkill = {
    name: "mode_only_skill",
    description: "Only available in one mode snapshot.",
    type: "javascript",
    code: "return 'mode-specific';",
  };
  const call = (context) =>
    executeSkill(
      {
        function: {
          name: "mode_only_skill",
          arguments: "{}",
        },
      },
      context,
    );

  assert.equal(
    await call({ mode: "ollama", customSkills: [], skillsConfig: {} }),
    "Unknown skill: mode_only_skill",
  );
  assert.equal(
    await call({
      mode: "cloud",
      customSkills: [customSkill],
      skillsConfig: {},
    }),
    "mode-specific",
  );
  assert.match(
    await executeSkill(
      {
        function: {
          name: "calculator",
          arguments: JSON.stringify({ expression: "2 + 2" }),
        },
      },
      { mode: "cloud", skillsConfig: { calculator: false } },
    ),
    /disabled for cloud mode/,
  );
});

test("Mode snapshots isolate installed plugin activation", async () => {
  const pluginSkill = {
    name: "snapshot_plugin_skill",
    pluginName: "snapshot-plugin",
    execute: async () => "plugin result",
    requiresConfirmation: false,
    timeoutMs: 1000,
    def: {
      type: "function",
      function: {
        name: "snapshot_plugin_skill",
        description: "Snapshot test plugin skill",
        parameters: { type: "object", properties: {} },
      },
    },
  };
  const call = (pluginSkills) =>
    executeSkill(
      {
        function: {
          name: "snapshot_plugin_skill",
          arguments: "{}",
        },
      },
      { mode: "cloud", pluginSkills, skillsConfig: {} },
    );
  assert.equal(await call([]), "Unknown skill: snapshot_plugin_skill");
  assert.equal(await call([pluginSkill]), "plugin result");
});

test("Custom JS Skill Worker", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-test-"));
  try {
    const customSkills = [
      {
        name: "test_js_skill",
        type: "javascript",
        code: "return 'hello ' + args.name;",
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "custom_skills.json"),
      JSON.stringify(customSkills),
    );

    const result = await executeSkill(
      {
        function: {
          name: "test_js_skill",
          arguments: JSON.stringify({ name: "world" }),
        },
      },
      { dataDir: tmpDir },
    );

    assert.strictEqual(result, "hello world");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Run Code Skill - executes JS with confirmation gate", async () => {
  const denied = await executeSkill(
    {
      function: {
        name: "run_code",
        arguments: JSON.stringify({ code: "return 1 + 1;" }),
      },
    },
    {},
  );
  assert.match(denied, /requires explicit user confirmation/);
  assert.strictEqual(skillRequiresShellConfirmation("run_code", null), true);

  const allowed = await executeSkill(
    {
      function: {
        name: "run_code",
        arguments: JSON.stringify({
          code: "console.log('sum:', [1,2,3].reduce((a,b)=>a+b,0)); return 'done';",
        }),
      },
    },
    { allowShellCommand: true },
  );
  assert.match(allowed, /sum: 6/);
  assert.match(allowed, /done/);

  const failed = await executeSkill(
    {
      function: {
        name: "run_code",
        arguments: JSON.stringify({ code: "throw new Error('boom');" }),
      },
    },
    { allowShellCommand: true },
  );
  assert.match(failed, /boom/);
});

test("File Operations Skill - sandboxed workspace", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-test-"));
  const call = (args) =>
    executeSkill(
      {
        function: {
          name: "file_operations",
          arguments: JSON.stringify(args),
        },
      },
      { dataDir: tmpDir },
    );
  try {
    const write = await call({
      action: "write",
      path: "reports/summary.md",
      content: "# Report",
    });
    assert.match(write, /Wrote workspace\/reports\/summary\.md/);
    assert.strictEqual(
      fs.readFileSync(
        path.join(tmpDir, "workspace", "reports", "summary.md"),
        "utf8",
      ),
      "# Report",
    );

    const read = await call({ action: "read", path: "reports/summary.md" });
    assert.strictEqual(read, "# Report");

    const list = await call({ action: "list", path: "reports" });
    assert.match(list, /summary\.md/);

    const found = await call({ action: "find", pattern: "*.md" });
    assert.match(found, /reports\/summary\.md/);

    const escape = await call({
      action: "read",
      path: "../custom_skills.json",
    });
    assert.match(escape, /escapes the workspace/);

    const missing = await call({ action: "read", path: "nope.txt" });
    assert.match(missing, /does not exist/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HTTP Request Skill - guards and validation", async () => {
  const local = await executeSkill(
    {
      function: {
        name: "http_request",
        arguments: JSON.stringify({ url: "http://127.0.0.1:8080/admin" }),
      },
    },
    {},
  );
  assert.match(local, /local or private network/);

  const badProto = await executeSkill(
    {
      function: {
        name: "http_request",
        arguments: JSON.stringify({ url: "file:///etc/passwd" }),
      },
    },
    {},
  );
  assert.match(badProto, /Only http and https/);

  const badMethod = await executeSkill(
    {
      function: {
        name: "http_request",
        arguments: JSON.stringify({
          url: "https://example.com",
          method: "TRACE",
        }),
      },
    },
    {},
  );
  assert.match(badMethod, /unsupported method/);
});

test("SSRF guard blocks internal ranges, IPv6, and encodings", async () => {
  // Literal IPs (loopback beyond .1, cloud metadata, RFC1918, CGNAT, IPv6
  // loopback/ULA/link-local) — all resolved structurally, no network.
  const blockedHosts = [
    "http://127.0.0.2/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/x",
    "http://100.64.0.1/x",
    "http://[::1]/x",
    "http://[fd00::1]/x",
    "http://[fe80::1]/x",
    "http://2130706433/x", // decimal-encoded 127.0.0.1
  ];
  for (const url of blockedHosts) {
    const r = await executeSkill(
      {
        function: { name: "http_request", arguments: JSON.stringify({ url }) },
      },
      {},
    );
    assert.match(
      r,
      /local or private network/,
      `expected ${url} to be blocked`,
    );
  }
});

test("Custom shell skills require explicit confirmation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chat-test-"));
  try {
    fs.writeFileSync(
      path.join(tmpDir, "custom_skills.json"),
      JSON.stringify([
        {
          name: "test_shell_skill",
          type: "shell",
          code: "printf '{{message}}'",
          description: "test shell command",
        },
      ]),
    );

    assert.strictEqual(
      skillRequiresShellConfirmation("test_shell_skill", tmpDir),
      true,
    );

    const denied = await executeSkill(
      {
        function: {
          name: "test_shell_skill",
          arguments: JSON.stringify({ message: "hello" }),
        },
      },
      { dataDir: tmpDir },
    );
    assert.match(denied, /requires explicit user confirmation/);

    const allowed = await executeSkill(
      {
        function: {
          name: "test_shell_skill",
          arguments: JSON.stringify({ message: "hello" }),
        },
      },
      { dataDir: tmpDir, allowShellCommand: true },
    );
    assert.match(allowed, /STDOUT:\nhello/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
