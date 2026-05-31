const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");

test("package version starts at 1.0.0 for this release line", () => {
  assert.strictEqual(pkg.version, "1.0.0");
});
