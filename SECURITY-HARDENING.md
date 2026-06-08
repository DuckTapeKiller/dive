# Dive Security Hardening

This checklist maps to the top 10 hardening goals and tells you what is implemented in this repo versus what must be applied in your real Pi runtime.

## Implemented In Dive Code

1. Shared-page traffic defaults to Ollama safety flow and requires explicit override before Pi mode execution.
2. Pi RPC permission dialogs are handled interactively (`extension_ui_request`/`extension_ui_response`) to prevent silent hangs.
3. Pi RPC sessions auto-timeout and stale sessions are cleaned up.
4. Frontend JSON parsing is hardened with HTTP status checks and empty-body handling.
5. Security event logging is added at `~/ollama-pi-chat/security-events.jsonl`:
   - prompt source
   - permission prompt shown
   - permission approval/denial responses
   - tool execution start events
   - session cleanup and timeout reasons
6. Root execution is blocked (`server.js` exits if started as root).
7. Built-in and custom shell skills require explicit interactive confirmation before execution.

## Must Be Applied In Real Pi Runtime

1. Install `@gotgenes/pi-permission-system`.
2. Copy `security/pi-permissions.strict.jsonc` to:
   - `~/.pi/agent/pi-permissions.jsonc`
3. Reload/restart Pi so policy is enforced.

## Operational Rules

1. Do not auto-run commands copied from fetched web/repo/video content.
2. Keep unknown or side-effecting extensions disabled until reviewed.
3. Pin extension versions where possible and review changelogs before updating.
