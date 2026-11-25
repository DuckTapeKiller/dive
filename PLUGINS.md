# Dive Plugins

Dive loads plugins from `~/dive/plugins`. A plugin adds **tools** (functions any
non-Pi model can call) and optional **slash commands**, with no changes to the
app itself. Settings lists them under Tools > External tools.

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
  // The tools this plugin adds. The key is called `skills`, an older name
  // for tools that Dive keeps so existing plugins go on working.
  skills: [
    {
      // Tool name the model calls: letters, digits, underscores.
      name: "my_skill",
      // Tell the model when to call it — this is the most important line.
      description: "Fetches X. Use when the user asks about X.",
      // Optional: one sentence saying when the model MUST call this tool.
      // Dive puts it under "MANDATORY TOOL ROUTING" in the model's tool
      // instructions while the tool is enabled. Small models act on a user's
      // words before they read a tool's description: asked to "download this
      // image https://…", one answered with links nine times. Up to 1,200
      // characters; Dive before 5.0.16 ignores it.
      rule: "X: When the user asks about X, you MUST call my_skill first.",
      // JSON Schema for the arguments (OpenAI tool format).
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look up" },
        },
      },
      // Optional: ask the user before every execution. Dive shows its
      // standard confirmation dialog with the tool name and arguments, and
      // logs request/denial/run to ~/dive/security-events.jsonl. Set this
      // on any skill that downloads, writes files, or runs external
      // binaries.
      requiresConfirmation: true,
      // Optional: per-tool execution timeout in milliseconds.
      // Default 60000 (60 s), clamped to 1 s – 60 min.
      timeoutMs: 15 * 60 * 1000,
      // Return a string (or any JSON-serializable value). Errors are caught
      // and reported to the model; executions time out after `timeoutMs`.
      async execute(args, context) {
        return `Result for ${args.query}`;
      },
    },
  ],
  // Optional: /myskill in the chat input forces the tool.
  commands: { myskill: "my_skill" },
};
```

## Rules

- Tool names must be unique across the app; a clash with another plugin is
  reported as a plugin error.
- Plugin slash commands never override built-in commands.
- A slash command passes the text typed after it to one argument: the only
  required string property if exactly one is required, otherwise the first
  string property in `properties`, otherwise `input`. Declare the main argument
  first.
- Every plugin tool gets an enable/disable toggle in Settings > Tools,
  like the native tools.
- Press RELOAD EXTERNAL TOOLS in Settings after adding or editing a plugin
  (plugins are also loaded fresh on every app start).
- `execute(args, context)` receives `context.dataDir` (the `~/dive` data
  directory) among other fields; treat everything else as internal.
- `context.renderPage(url)` renders a page in Dive's own browser engine and resolves to `{ ok, url, title, html }` or `{ ok: false, error }`: for pages that draw their content with JavaScript or refuse a plain download. It needs the desktop app; elsewhere it answers `{ ok: false }` at once.
- Keep `rule` for actions the model might otherwise refuse or answer in words (downloading, saving, converting). A rule on every tool drowns the ones that matter.
- Publish a plugin as a GitHub repository with `index.js` (and `plugin.json`) at its top, and users can add it from Settings → Tools → External tools → ADD FROM GITHUB and update it there with CHECK FOR UPDATES, without a new Dive. Raise `version` in both files with every change: it is what the update shows.

## Example

A working example ships in `~/dive/plugins/example-dice` the first time you
look at it — roll dice with `/roll` or by asking the model to roll dice.
Copy the folder, rename things, and you have a new tool.
