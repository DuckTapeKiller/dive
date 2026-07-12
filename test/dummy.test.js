const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");

test("package version is 3.0.8 for this release", () => {
  assert.strictEqual(pkg.version, "3.0.8");
});
