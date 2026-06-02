#!/usr/bin/env node
const {
  buildLibraryContext,
  getLibraryStatus,
  searchLibrary,
} = require("./store");

function readQueryFromArgs() {
  return process.argv.slice(2).filter((arg) => !arg.startsWith("--")).join(" ");
}

function readLimitFromArgs() {
  const index = process.argv.indexOf("--limit");
  if (index === -1) return undefined;
  const value = Number.parseInt(process.argv[index + 1], 10);
  return Number.isFinite(value) ? value : undefined;
}

async function main() {
  if (process.argv.includes("--status")) {
    process.stdout.write(`${JSON.stringify(await getLibraryStatus(), null, 2)}\n`);
    return;
  }
  const query = readQueryFromArgs();
  if (!query) {
    throw new Error('Usage: node library/search.js "your question" [--limit 5]');
  }
  const results = await searchLibrary(query, { limit: readLimitFromArgs() });
  if (process.argv.includes("--context")) {
    process.stdout.write(`${buildLibraryContext(results)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ query, results }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
