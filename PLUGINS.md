# Dive Plugins

Dive loads plugins from `~/dive/plugins`. A plugin adds **skills** (tools any
non-Pi model can call) and optional **slash commands**, with no changes to the
app itself. Manage them under Settings > Skills > Plugins.

## Trust model

A plugin is a plain Node.js module running inside the Dive server with full
local access — the same model as Obsidian plugins. Only install code you
trust. A broken plugin never takes the app down: load and execution errors
are isolated and shown next to the plugin in Settings.

## Anatomy

Two forms are accepted:

```
~/dive/plugins/
  my-plugin/            directory form
    plugin.json         optional metadata
    index.js            the module
  quick-hack.js         single-file form (same export shape)
```

`plugin.json` (optional):

```json
{
  "name": "my-plugin",
  "description": "What it does.",
  "version": "1.0.0"
}
```

`index.js`:

```js
module.exports = {
  skills: [
    {
      // Tool name the model calls: letters, digits, underscores.
      name: "my_skill",
      // Tell the model when to call it — this is the most important line.
      description: "Fetches X. Use when the user asks about X.",
      // JSON Schema for the arguments (OpenAI tool format).
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look up" },
        },
      },
      // Return a string (or any JSON-serializable value). Errors are caught
      // and reported to the model; executions time out after 60 seconds.
      async execute(args, context) {
        return `Result for ${args.query}`;
      },
    },
  ],
  // Optional: /myskill in the chat input forces the skill.
  commands: { myskill: "my_skill" },
};
```

## Rules

- Skill names must be unique across the app; a clash with another plugin is
  reported as a plugin error.
- Plugin slash commands never override built-in commands.
- Every plugin skill gets an enable/disable toggle in Settings > Skills,
  like the built-in skills.
- Press RELOAD PLUGINS in Settings after adding or editing a plugin
  (plugins are also loaded fresh on every app start).
- `execute(args, context)` receives `context.dataDir` (the `~/dive` data
  directory) among other fields; treat everything else as internal.

## Example

A working example ships in `~/dive/plugins/example-dice` the first time you
look at it — roll dice with `/roll` or by asking the model to roll dice.
Copy the folder, rename things, and you have a new skill.
