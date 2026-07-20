const test = require("node:test");
const assert = require("node:assert");
const { executeSkill } = require("../skills.js");

const call = (args) =>
  executeSkill(
    { function: { name: "task_plan", arguments: JSON.stringify(args) } },
    { dataDir: "/tmp", mode: "test" },
  );

test("task_plan create/update/show lifecycle", async () => {
  const created = await call({
    action: "create",
    steps: ["Search sources", "Read papers", "Write summary"],
  });
  assert.match(created, /Plan plan-[a-z0-9]{5} \(0\/3 steps resolved\)/);
  const planId = created.match(/plan-[a-z0-9]{5}/)[0];

  const updated = await call({
    action: "update",
    plan_id: planId,
    step: 1,
    status: "done",
    note: "found 8 papers",
  });
  assert.match(updated, /\[x\] 1\. Search sources — found 8 papers/);
  assert.match(updated, /2 step\(s\) remaining/);

  await call({ action: "update", plan_id: planId, step: 2, status: "failed" });
  const finished = await call({
    action: "update",
    plan_id: planId,
    step: 3,
    status: "done",
  });
  assert.match(finished, /All steps resolved/);

  const shown = await call({ action: "show", plan_id: planId });
  assert.match(shown, /\[!\] 2\. Read papers/);
});

test("task_plan rejects bad input", async () => {
  assert.match(await call({ action: "create", steps: [] }), /needs steps/);
  assert.match(
    await call({ action: "update", plan_id: "plan-zzzzz", step: 1 }),
    /no plan/,
  );
  const created = await call({ action: "create", steps: ["only step"] });
  const planId = created.match(/plan-[a-z0-9]{5}/)[0];
  assert.match(
    await call({ action: "update", plan_id: planId, step: 9 }),
    /step must be 1-1/,
  );
});
