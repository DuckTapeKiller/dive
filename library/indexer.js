#!/usr/bin/env node
const fs = require("fs");
const {
  collectSourceFiles,
  getLibraryStatus,
  indexLibrary,
  loadLibraryConfig,
} = require("./store");

function hasFlag(name) {
  return process.argv.includes(name);
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function runOnce() {
  const stats = await indexLibrary({ prune: !hasFlag("--no-prune") });
  printJson(stats);
}

function watchLibrary() {
  const config = loadLibraryConfig();
  const debounceMs = config.watch.debounceMs || 2000;
  const rescanIntervalMs = config.watch.rescanIntervalMs || 60000;
  let timer = null;
  let running = false;
  let queued = false;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      try {
        await runOnce();
      } catch (error) {
        console.error(error.message);
      } finally {
        running = false;
        if (queued) {
          queued = false;
          schedule();
        }
      }
    }, debounceMs);
  };

  const files = collectSourceFiles(config);
  const roots = Array.from(new Set(files.map((file) => file.source.path)));
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      fs.watch(root, { recursive: true }, schedule);
      console.error(`Watching ${root}`);
    } catch (error) {
      console.error(`Could not watch ${root}: ${error.message}`);
    }
  }

  setInterval(schedule, rescanIntervalMs);
  schedule();
}

async function main() {
  if (hasFlag("--status")) {
    printJson(await getLibraryStatus());
    return;
  }
  if (hasFlag("--watch")) {
    watchLibrary();
    return;
  }
  await runOnce();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
