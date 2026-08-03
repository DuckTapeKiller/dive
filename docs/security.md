# Security model

## What Dive assumes

- **The user is trusted.** It is their machine and their data.
- **The model is not.** It may be prompted by a web page it fetched, a document
  it indexed, or a paper it downloaded. Model output is treated as untrusted
  input to every system it can reach.
- **The network is not.** Fetched pages are data, never instructions.

The server binds `127.0.0.1` only and has no authentication, because it has no
remote surface. Exposing that port to a network gives away everything below.

## Controls

### SSRF guard

Every outbound fetch a skill makes goes through `assertUrlAllowed`
([`skills/sandbox.js`](../skills/sandbox.js)). It:

- rejects non-`http`/`https` schemes
- rejects literal loopback, private and link-local addresses
- **resolves the hostname and checks every returned address**, so a public name
  pointing at `127.0.0.1` or `169.254.169.254` is refused

The DNS check is the part that matters. Blocking only literal IPs is trivially
bypassed by a hostname.

Redirects are followed **manually**, re-checking the guard on every hop. The
built-in `fetch()` auto-follows before anything can inspect the target, which is
why the binary downloader is hand-rolled.

All four fetch helpers — `fetchJson`, `fetchText`, `fetchHtml`,
`fetchBinaryGuarded` — apply the guard, and all four apply the Grokipedia block.

### Filesystem sandbox

File skills resolve paths through `resolveAllowedPath`. Access is confined to a
set of roots; anything outside is refused with a message naming the roots. You
extend it deliberately by editing `~/dive/allowed-dirs.json`.

Uploads never use the supplied filename. Images are stored under a hash of their
content, so `../../../etc/passwd.png` has nowhere to go. The upload cap (50 MB)
is enforced against the declared `Content-Length` before a byte is read.

### Confirmation gates

`skillRequiresShellConfirmation` forces a prompt for `shell_command`, any
custom skill of type `shell`, and any plugin skill that asks for confirmation.

The composer launcher deliberately excludes `shell_command`, `file_operations`
and `propose_plugin` — a one-click button is the wrong affordance for those. The
allowlist is enforced **server-side** as well, so a crafted settings request
cannot add them.

`macos_control` is disabled by default.

### Plugins are never auto-run

`propose_plugin` writes to `plugin-drafts/`, which is not loaded. A draft becomes
live only when you approve it. The draft name cannot escape that directory.

### Prompt-injection posture

`deep_research` tells the model explicitly to treat every retrieved source as
untrusted evidence and to ignore instructions inside it. Beyond the instruction,
the pipeline reduces what reaches the model at all: CAPTCHA pages, raw HTML,
error payloads, paywalls and duplicates are rejected before synthesis.

Authority scoring matches domains by **suffix, never substring**. Substring
matching gave `nih.gov.evil-mirror.com` the same authority as `nih.gov`, and
since authority decides what gets read and cited, a registered look-alike could
walk into the evidence set.

Grokipedia is blocked by host label, so subdomains and mirrors are covered.

### Redaction

`redact.js` provides `redactText`, `redactValue` and `boundedValue`, used before
anything is written to a trace, a log or a stored conversation. `boundedValue`
truncates at 64 KB by default and records the original size rather than silently
dropping data. Pi events are additionally capped at 256 KB each.

### Mode isolation

Per-mode configuration is not decorative. A skill enabled in Cloud is not enabled
in llama.cpp, MCP servers are per mode, and `requireNonPiMode` keeps Dive's skill
and MCP routes away from Pi entirely.

### Deletion

Deleting a conversation writes a tombstone with a 24-hour TTL. A turn still
generating when you deleted it cannot write it back. Two independent checks
enforce this in `upsertConversation`.

### Shutdown

`gracefulShutdown` terminates Pi processes, closes Pi's SSE subscribers, closes
the global app-event stream, then closes the HTTP server, with a 5-second
force-exit as a backstop. The force-exit is a backstop, not the normal path —
leaving the app-event stream open made every shutdown take 5 seconds and exit
non-zero.

## Reporting

`security/` holds hardening material; `SECURITY-HARDENING.md` at the repository
root has the summary. `security/pi-permissions.strict.jsonc` is a **sample** and
is marked inert — nothing loads it.

Security events can be recorded through `POST /api/security-event` and land in
`security-events.jsonl`.

## Known limits

- No authentication on the local server. Loopback binding is the control.
- A cloud embedding backend sees the chunks it embeds. Use a local one if that
  matters.
- Approving a plugin runs its code with the server's privileges. Read drafts
  before approving them.
- The sandbox confines paths, not syscalls. `shell_command` with confirmation is
  a real shell.
