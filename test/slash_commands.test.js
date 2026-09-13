const test = require("node:test");
const assert = require("node:assert");
const {
  buildForcedSkillToolCall,
  isDatabaseSlashCommand,
  isSkillSlashCommand,
  parseSlashCommand,
  INPUT_SKILL_NAMES,
} = require("../slash_commands");

test("parses global database slash command", () => {
  const command = parseSlashCommand("/db who was Nijinsky?");
  assert.strictEqual(command.name, "db");
  assert.strictEqual(command.input, "who was Nijinsky?");
  assert.strictEqual(isDatabaseSlashCommand(command), true);
  assert.strictEqual(isSkillSlashCommand(command), false);
});

test("unknown slash command falls through to normal chat", () => {
  assert.strictEqual(parseSlashCommand("/unknown hello"), null);
  assert.strictEqual(parseSlashCommand("/snapshot hello", null), null);
});

test("uses the supplied mode plugin command snapshot", () => {
  assert.strictEqual(parseSlashCommand("/snapshot hello", {}), null);
  const command = parseSlashCommand("/snapshot hello", {
    snapshot: "calculator",
  });
  assert.strictEqual(command.skillName, "calculator");
  assert.strictEqual(command.input, "hello");
});

test("builds forced Wikipedia skill call with language prefix", () => {
  const command = parseSlashCommand("/wiki es: Nijinsky");
  const toolCall = buildForcedSkillToolCall(command);
  assert.deepStrictEqual(JSON.parse(toolCall.function.arguments), {
    query: "Nijinsky",
    language: "es",
  });
  assert.strictEqual(toolCall.function.name, "wikipedia");
});

test("builds quick input skill commands", () => {
  const book = buildForcedSkillToolCall(
    parseSlashCommand("/book_search The Name of the Rose"),
  );
  assert.strictEqual(book.function.name, "book_search");
  assert.deepStrictEqual(JSON.parse(book.function.arguments), {
    query: "The Name of the Rose",
  });

  const research = buildForcedSkillToolCall(
    parseSlashCommand("/deep_research who was Ada Lovelace?"),
  );
  assert.strictEqual(research.function.name, "deep_research");
  assert.deepStrictEqual(JSON.parse(research.function.arguments), {
    query: "who was Ada Lovelace?",
  });

  assert.ok(INPUT_SKILL_NAMES.has("book_search"));
  assert.ok(INPUT_SKILL_NAMES.has("larousse"));
  assert.ok(INPUT_SKILL_NAMES.has("scholarpedia"));
  const scholarpedia = buildForcedSkillToolCall(
    parseSlashCommand("/scholarpedia neural networks"),
  );
  assert.strictEqual(scholarpedia.function.name, "scholarpedia");
});

test("builds calculator and notes commands", () => {
  const calculator = buildForcedSkillToolCall(
    parseSlashCommand("/calc 12 * 44"),
  );
  assert.deepStrictEqual(JSON.parse(calculator.function.arguments), {
    expression: "12 * 44",
  });

  const notes = buildForcedSkillToolCall(
    parseSlashCommand("/notes append remember this"),
  );
  assert.deepStrictEqual(JSON.parse(notes.function.arguments), {
    action: "append",
    content: "remember this",
  });
});

// The mode's plugin skill snapshot, shaped like plugins.getPluginSkillSnapshot()
// entries. The schema is the real ~/dive/plugins/humaniser skill's.
const HUMANISER_SNAPSHOT = [
  {
    name: "humanise",
    pluginName: "humaniser",
    def: {
      type: "function",
      function: {
        name: "humanise",
        description: "Returns the Humaniser editing guide.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "The text to humanise." },
            voice_sample: { type: "string", description: "Writing sample." },
          },
        },
      },
    },
  },
];

test("a plugin slash command becomes a tool call with the typed text", () => {
  const command = parseSlashCommand("/humanise Make this sound human.", {
    humanise: "humanise",
  });
  assert.strictEqual(isSkillSlashCommand(command), true);
  const toolCall = buildForcedSkillToolCall(command, HUMANISER_SNAPSHOT);
  assert.strictEqual(toolCall.function.name, "humanise");
  assert.deepStrictEqual(JSON.parse(toolCall.function.arguments), {
    text: "Make this sound human.",
  });
});

function pluginSnapshot(name, parameters) {
  return [
    {
      name,
      pluginName: "test-plugin",
      def: {
        type: "function",
        function: { name, description: "Test skill.", parameters },
      },
    },
  ];
}

test("a plugin command fills the only required string before earlier optional ones", () => {
  const snapshot = pluginSnapshot("read_aloud", {
    type: "object",
    properties: { voice: { type: "string" }, path: { type: "string" } },
    required: ["path"],
  });
  const commands = { read: "read_aloud" };
  const toolCall = buildForcedSkillToolCall(
    parseSlashCommand("/read ~/notes.md", commands),
    snapshot,
  );
  assert.deepStrictEqual(JSON.parse(toolCall.function.arguments), {
    path: "~/notes.md",
  });
  assert.throws(
    () =>
      buildForcedSkillToolCall(parseSlashCommand("/read", commands), snapshot),
    /\/read requires path\./,
  );
});

test("a plugin command with no string argument passes the text as input", () => {
  const snapshot = pluginSnapshot("dice_roll", {
    type: "object",
    properties: { rolls: { type: "number" }, sides: { type: "number" } },
  });
  const commands = { roll: "dice_roll" };
  const typed = buildForcedSkillToolCall(
    parseSlashCommand("/roll 2d6", commands),
    snapshot,
  );
  assert.deepStrictEqual(JSON.parse(typed.function.arguments), {
    input: "2d6",
  });
  const bare = buildForcedSkillToolCall(
    parseSlashCommand("/roll", commands),
    snapshot,
  );
  assert.deepStrictEqual(JSON.parse(bare.function.arguments), {});
  const humaniserBare = buildForcedSkillToolCall(
    parseSlashCommand("/humanise", { humanise: "humanise" }),
    HUMANISER_SNAPSHOT,
  );
  assert.deepStrictEqual(
    JSON.parse(humaniserBare.function.arguments),
    {},
    "an optional argument left empty sends no arguments",
  );
  const nullable = pluginSnapshot("note", {
    type: "object",
    properties: {
      count: { type: "number" },
      body: { type: ["string", "null"] },
    },
  });
  const note = buildForcedSkillToolCall(
    parseSlashCommand("/note hello", { note: "note" }),
    nullable,
  );
  assert.deepStrictEqual(JSON.parse(note.function.arguments), {
    body: "hello",
  });
});

test("a plugin command resolves only from the calling mode's snapshot", () => {
  const command = parseSlashCommand("/humanise hello", {
    humanise: "humanise",
  });
  assert.throws(
    () => buildForcedSkillToolCall(command),
    /Unsupported slash command: \/humanise/,
  );
  assert.throws(
    () => buildForcedSkillToolCall(command, []),
    /Unsupported slash command: \/humanise/,
  );
  assert.throws(
    () =>
      buildForcedSkillToolCall(
        command,
        pluginSnapshot("other_skill", { type: "object", properties: {} }),
      ),
    /Unsupported slash command: \/humanise/,
  );
});

test("built-in commands keep their own argument mapping", () => {
  const calc = buildForcedSkillToolCall(
    parseSlashCommand("/calc 2+2"),
    HUMANISER_SNAPSHOT,
  );
  assert.deepStrictEqual(JSON.parse(calc.function.arguments), {
    expression: "2+2",
  });
});
