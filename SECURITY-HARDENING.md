# Dive Security Hardening

This checklist maps to the top 10 hardening goals and tells you what is implemented in this repo versus what must be applied in your real Pi runtime.

## Implemented In Dive Code

1. Shared-page traffic defaults to Ollama safety flow and requires explicit override before Pi mode execution.
2. Pi RPC permission dialogs are handled interactively (`extension_ui_request`/`extension_ui_response`) to prevent silent hangs.
3. Pi RPC sessions auto-timeout and stale sessions are cleaned up.
4. Frontend JSON parsing is hardened with HTTP status checks and empty-body handling.
5. Security event logging is added at `~/dive/security-events.jsonl`:
   - prompt source
   - permission prompt shown
   - permission approval/denial responses
   - tool execution start events
   - session cleanup and timeout reasons
6. Root execution is blocked (`server.js` exits if started as root).
7. Built-in and custom shell skills require explicit interactive confirmation before execution.

## Must Be Applied In Real Pi Runtime

1. Install and enable `npm:pi-sandbox` in Pi's agent settings.
2. Configure the active sandbox policy in:
   - `~/.pi/agent/sandbox.json` for global rules
   - `.pi/sandbox.json` for project-specific rules
3. Keep `allowRead` and `allowWrite` narrow. `allowWrite` also grants read
   access, and paths in `denyWrite` remain hard-blocked.
4. Reload/restart Pi so the policy is enforced. When Dive launches Pi in RPC
   mode, `routes/pi-rpc-ui-compat.js` bridges pi-sandbox's terminal-only
   permission screen to Dive's existing RPC dialog.

The older `security/pi-permissions.strict.jsonc` file targets a different
permission extension and is not read by the active `pi-sandbox` runtime.

## Operational Rules

1. Do not auto-run commands copied from fetched web/repo/video content.
2. Keep unknown or side-effecting extensions disabled until reviewed.
3. Pin extension versions where possible and review changelogs before updating.
