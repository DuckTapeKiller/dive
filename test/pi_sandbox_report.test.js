// Dive shows the user whether Pi is sandboxed. That indicator is only useful if
// it reads the file pi-sandbox actually enforces.
//
// pi-sandbox's README: "Add a config like this either to
// ~/.pi/agent/sandbox.json (global) or to .pi/sandbox.json (local)."
// Dive previously checked ~/.pi/sandbox.json for the global policy, which
// pi-sandbox does not read, so a correctly sandboxed machine was reported as
// unsandboxed.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "..", "routes", "pi.js"),
  "utf8",
);

test("the global sandbox policy is read from pi-sandbox's own location", () => {
  assert.match(
    source,
    /path\.join\(\s*os\.homedir\(\),\s*"\.pi",\s*"agent",\s*"sandbox\.json",?\s*\)/,
    "the global sandbox path is not ~/.pi/agent/sandbox.json",
  );
  assert.doesNotMatch(
    source,
    /path\.join\(os\.homedir\(\), "\.pi", "sandbox\.json"\)/,
    "the old ~/.pi/sandbox.json path is back; pi-sandbox does not read it",
  );
});

test("a policy that disables itself is not reported as active", () => {
  // Extract the helper and exercise it directly: file existence alone used to
  // count as "sandboxed", including for a policy saying enabled: false.
  const start = source.indexOf("function sandboxPolicyActive(");
  assert.ok(start > 0, "sandboxPolicyActive is gone");
  let depth = 0;
  let end = start;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const sandboxPolicyActive = new Function(
    "fs",
    `${source.slice(start, end)}; return sandboxPolicyActive;`,
  )(fs);

  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "dive-sbx-"));
  try {
    const missing = path.join(dir, "absent.json");
    assert.strictEqual(sandboxPolicyActive(missing), false);

    const on = path.join(dir, "on.json");
    fs.writeFileSync(on, JSON.stringify({ enabled: true, filesystem: {} }));
    assert.strictEqual(sandboxPolicyActive(on), true);

    const off = path.join(dir, "off.json");
    fs.writeFileSync(off, JSON.stringify({ enabled: false }));
    assert.strictEqual(
      sandboxPolicyActive(off),
      false,
      'a policy with "enabled": false was reported as an active sandbox',
    );

    // Comments are legal in these files.
    const commented = path.join(dir, "commented.json");
    fs.writeFileSync(commented, '// a note\n{ "enabled": true }\n');
    assert.strictEqual(sandboxPolicyActive(commented), true);

    // Unparseable: report the file rather than claiming no sandbox at all.
    const broken = path.join(dir, "broken.json");
    fs.writeFileSync(broken, "{ not json");
    assert.strictEqual(sandboxPolicyActive(broken), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the inert permissions file says so at the top", () => {
  // It reads like live security configuration and enforces nothing. Anyone
  // opening it must see that before they trust a "deny" line in it.
  const policy = fs.readFileSync(
    path.join(__dirname, "..", "security", "pi-permissions.strict.jsonc"),
    "utf8",
  );
  assert.match(policy.slice(0, 400), /NOT ACTIVE|NOTHING READS THIS FILE/);
});
