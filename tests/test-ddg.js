const { executeDuckDuckGo } = require("./skills.js");
// Mock the context/exports
const fs = require("fs");
const code = fs.readFileSync("./skills.js", "utf8");
const moduleCode = code.replace(
  "module.exports = { executeSkill };",
  "module.exports = { executeDuckDuckGo };",
);
fs.writeFileSync("./skills-test.js", moduleCode);
const skills = require("./skills-test.js");
skills
  .executeDuckDuckGo({ query: "current time in Colombia" })
  .then(console.log)
  .catch(console.error);
