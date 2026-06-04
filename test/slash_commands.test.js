const test = require("node:test");
const assert = require("node:assert");
const {
  buildForcedSkillToolCall,
  isDatabaseSlashCommand,
  isSkillSlashCommand,
  parseSlashCommand,
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

test("builds calculator and notes commands", () => {
  const calculator = buildForcedSkillToolCall(parseSlashCommand("/calc 12 * 44"));
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
