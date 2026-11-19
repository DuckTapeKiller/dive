const test = require("node:test");
const assert = require("node:assert");

const { executeCalculator } = require("../skills/utility.js");

// The expressions models actually send. The tool used to accept only digits
// and + - * / ( ), so every one of these but the first came back "invalid
// characters" with nothing to go on.
test("the calculator handles the maths models write", async () => {
  const cases = [
    ["2 + 2 * 4", 10],
    ["(17*23)+sqrt(144)", 403],
    ["2^10", 1024],
    ["2**10", 1024],
    ["ln(e)", 1],
    ["log(1000)", 3],
    ["log2(8)", 3],
    ["max(3, 7, 2)", 7],
    ["Math.sqrt(16)", 4],
    ["12 × 3 ÷ 4", 9],
    ["1e3/4", 250],
    ["7 % 3", 1],
    ["(-2)^2", 4],
    ["round(pi*100)/100", 3.14],
  ];
  for (const [expression, expected] of cases) {
    assert.strictEqual(
      await executeCalculator({ expression }),
      `Result: ${expected}`,
      expression,
    );
  }
});

test("a rejected expression says what the calculator accepts", async () => {
  for (const expression of ["1,000 + 5", "sqrt 4", "(1+2", "", "-2^2"]) {
    const out = await executeCalculator({ expression });
    assert.match(out, /^Calculator Error: /, expression);
    assert.match(out, /sqrt/, `${expression} gave no help`);
  }
});

test("nothing outside the whitelist reaches the evaluator", async () => {
  for (const expression of [
    "process.exit()",
    "this.constructor",
    "constructor",
    "toString(1)",
    "__proto__",
    "globalThis",
    "require('fs')",
    "Math.constructor",
    "sqrt.constructor('return process')()",
    "[1].map(sqrt)",
    "`1`",
  ]) {
    const out = await executeCalculator({ expression });
    assert.match(out, /^Calculator Error: /, expression);
  }
});
