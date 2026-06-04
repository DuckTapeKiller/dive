const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");

test("package version is 1.0.5 for this release", () => {
  assert.strictEqual(pkg.version, "1.0.5");
});
