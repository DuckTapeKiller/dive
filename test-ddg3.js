const { executeSkill } = require("./skills.js");
executeSkill(
  {
    function: {
      name: "duckduckgo",
      arguments: '{"query": "current time in Colombia"}',
    },
  },
  { dataDir: __dirname },
)
  .then((res) => {
    console.log("DDG RESULT:");
    console.log(res);
  })
  .catch((err) => {
    console.log("DDG ERROR:");
    console.error(err);
  });
