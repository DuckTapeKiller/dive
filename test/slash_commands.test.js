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
