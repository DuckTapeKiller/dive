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
    assert.strictEqual(append, "Successfully appended to your notes.");

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
