const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");

test("package version is 2.0.0 for this release", () => {
  assert.strictEqual(pkg.version, "2.0.0");
});
