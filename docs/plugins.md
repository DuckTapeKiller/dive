# Plugins

A plugin adds skills — and optionally slash commands — without changing the
application. They live in `~/dive/plugins`.

**[PLUGINS.md](../PLUGINS.md) is the authoring reference**: the export shape,
`plugin.json`, the parameter schema, confirmation flags, timeouts, and a worked
example. Read that to write one. This page covers the parts around it.

## Trust

A plugin is a plain Node module running inside the Dive server with full local
access — the Obsidian model. Only install code you trust.

A broken plugin does not take the app down: load and execution errors are
isolated and shown beside the plugin in Settings.

## Drafts and approval

The `propose_plugin` skill lets a model write a plugin. It never installs one.

```
propose_plugin  →  ~/dive/plugin-drafts/     (not on the load path)
      approve   →  ~/dive/plugins/           (loaded, runs)
```

Drafts are inert. Nothing scans `plugin-drafts/`, and a draft name cannot escape
that directory — `test/skills_untested.test.js` pins the traversal case.

| Endpoint                           | Purpose                      |
| ---------------------------------- | ---------------------------- |
| `GET /api/plugins/drafts`          | List drafts                  |
| `POST /api/plugins/drafts/approve` | Move a draft into `plugins/` |
| `POST /api/plugins/drafts/delete`  | Discard                      |

**Read a draft before approving it.** Approval is the moment model-written code
gains the server's privileges. This is the one step in Dive where that happens,
and it is deliberately manual.

## Loading

Plugins are discovered at startup and on `POST /api/plugins/reload`, so you can
iterate without restarting. `GET /api/plugins` lists what loaded and what failed.

## Mode scoping

Plugin skills are subject to the same per-mode configuration as built-in ones,
and they are not available in Pi.

Plugin slash commands resolve from a **mode-scoped snapshot** with deliberately
no fallback to the global registry. A plugin installed but not activated for the
calling mode must not be reachable by typing its command — that fallback would
be a per-mode isolation hole.

## Confirmation

A plugin skill can require confirmation. `skillRequiresShellConfirmation` honours
that alongside `shell_command` and custom shell skills, so a plugin that shells
out gets the same gate as the built-in path.

Plugin skills are **not** eligible for the composer launcher; that allowlist is
fixed and built-in only.
