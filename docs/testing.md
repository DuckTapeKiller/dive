# Testing

```bash
npm test        # 406 tests across 40 files
```

Plain `node:test`. No framework, no mocking library, no snapshots.

## The rule

**Break the thing on purpose. If the test still passes, it is decoration.**

Every test in this suite has been checked this way: revert the behaviour it
covers and confirm it fails. This is not a formality — it has repeatedly caught
tests that looked thorough and proved nothing:

- An abort test that asserted on an already-settled `fetch()` promise.
- Four library tests that called a function which does not touch the field they
  asserted on.
- A drum-removal test that passed vacuously because the mode defaulted to
  something else.
- An SSRF test matching `/Error/i`, which also passes on a connection failure and
  therefore says nothing about the guard.
- A `:only-child` assertion that could never fail, because `:only-child` ignores
  text nodes.

Each of those was written in good faith and was worthless. Only mutation testing
found them.

When you add a test, do this:

```bash
# 1. it passes
node --test test/your.test.js

# 2. break the code it covers, and watch it fail
#    (edit, run, restore)

# 3. it passes again
node --test test/your.test.js
```

If step 2 does not fail, the test is not testing what you think.

## When a mutation does not fail

Sometimes that is correct, and worth recording. Two real cases:

- The `shuttingDown` re-entrancy guard cannot be observed from outside: shutdown
  completes in under 40 ms, so a second signal always arrives after exit and the
  guarded and unguarded builds are indistinguishable. There is a comment in
  `test/shutdown_ordering.test.js` saying so, rather than a test that would pass
  either way.
- Two structural guards in the candidate-button parser are redundant: removing
  either alone changes nothing. The test pins the behaviour, and removing both
  together does fail.

Write the note. A future reader otherwise assumes the gap is an oversight.

## Isolation

Every test that starts a server sets `DIVE_DATA_DIR` to a temporary directory.
This is not optional. `test/cloud_skills.test.js` used to run against the real
`~/dive` and restore afterwards — the restore ran only in the cleanup path, so
any crash left the user's real cloud settings overwritten with a fake key.

That test now fingerprints the real `cloud-settings.json` before it starts and
asserts it is byte-identical afterwards.

Tests must not spawn the machine's real `pi`. Use a fake: `test/pi_rpc.test.js`,
`test/pi_sse_channel.test.js` and `test/pi_library_errors.test.js` each write a
small Node script that speaks the RPC protocol.

Ports are allocated per file. Check for a clash before picking one; a leftover
listener from a crashed run produces a confusing `EADDRINUSE` in an unrelated
file.

## Frontend tests

`test/dom.test.js` and friends boot the real `index.html` in jsdom with the real
scripts inlined, then drive the actual functions.

**jsdom does no layout and applies no CSS cascade.** These tests prove an element
exists, carries the right text, and survives a re-render. They prove nothing
about what is on screen. A rule hiding an element, a z-index problem, or an
off-screen mount passes every assertion. Do not claim visual verification from a
jsdom test.

Two practical notes:

- Close windows in `test.after()`. Each jsdom instance keeps timers alive and the
  suite hangs after its assertions otherwise.
- Vendor bundles must load. The map points at `node_modules/marked/lib/marked.umd.js`
  — an `existsSync` guard silently skipping it turns every failure into a
  `ReferenceError` inside an error handler, hiding the real cause.

## What is covered

Contract tests for every streaming endpoint including Cloud; the upload API; the
conversations API; MCP leases and shutdown; the Pi RPC bridge, SSE replay and
library semantics; the library lifecycle; mode registry, mode switching and
abort; shutdown ordering; packaging; skills; slash commands; research quality;
attachment loss; and the frontend renderer.

## What is not

- Real network calls. Skills hitting live upstreams are covered for argument
  handling and guards, not for their responses.
- Real models. Every backend is faked at the wire format.
- Anything visual. See above.
- Electron itself. `electron/main.js` is exercised only through
  `test/packaging.test.js`.
