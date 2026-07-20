const test = require("node:test");
const assert = require("node:assert");
const pkg = require("../package.json");
const lock = require("../package-lock.json");

// The version lives in exactly ONE place: package.json. These tests derive
// everything from it, so a version bump never needs a second manual edit —
// they only fail when references DRIFT out of sync, which is what actually
// broke CI twice: (1) package-lock.json left behind a bump so `npm ci`
// refused to install, and (2) a hardcoded copy of the version string.

test("package version is valid semver", () => {
  assert.match(
    pkg.version,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    `package.json version "${pkg.version}" is not valid semver`,
  );
});

test("package-lock.json version matches package.json (npm ci needs this)", () => {
  assert.strictEqual(
    lock.version,
    pkg.version,
    "package-lock.json top-level version is out of sync — run `npm install`",
  );
  assert.strictEqual(
    lock.packages?.[""]?.version,
    pkg.version,
    'package-lock.json packages[""] version is out of sync — run `npm install`',
  );
});
