// The client is seven classic scripts sharing one global scope, so ESLint's
// per-file analysis cannot check no-undef/no-unused-vars there (see
// eslint.config.js). scripts/lint-frontend.js checks the whole program instead.
// Running it here means a misspelled cross-file name fails `npm test`, not just
// the pre-commit hook.
const assert = require("assert");
const path = require("path");
const test = require("node:test");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "lint-frontend.js");

test("the frontend passes whole-program lint", () => {
  let output = "";
  let failed = false;
  try {
    output = execFileSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch (error) {
    failed = true;
    output = `${error.stdout || ""}${error.stderr || ""}`;
  }
  assert.ok(!failed, `frontend lint reported errors:\n${output}`);
  assert.match(output, /frontend clean/);
});
