const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const loadMode = require("../routes/llamacpp-load-mode.js");

// Excerpts of real `llama-server --help` output. 0.8.0 (build 11960) lists
// `-lm, --load-mode` and mentions mlock only inside descriptions; builds before
// it list `--mlock` as an option of its own.
const HELP_080 = [
  "-dt,   --defrag-thold N                 KV cache defragmentation threshold (DEPRECATED)",
  "-lm,   --load-mode MODE                 model loading mode (default: auto)",
  "                                        - mmap: memory-map model (if mmap disabled, slower load but may reduce",
  "                                        pageouts if not using mlock)",
  "                                        - mmap+mlock: mmap + force system to keep model in RAM rather than",
  "-lzm,  --lazy-mode MODE                 on-demand reading of certain tensors",
].join("\n");
const HELP_OLD = [
  "--mlock                                 force system to keep model in RAM rather than swapping or compressing",
  "--no-mmap                               do not memory-map model (slower load but may reduce pageouts if not",
  "                                        using mlock)",
].join("\n");

test("0.8.0 help offers --load-mode, not --mlock", () => {
  assert.deepStrictEqual(loadMode.parseLoadFlags(HELP_080), {
    loadMode: true,
    mlock: false,
  });
});

test("older help offers --mlock, not --load-mode", () => {
  assert.deepStrictEqual(loadMode.parseLoadFlags(HELP_OLD), {
    loadMode: false,
    mlock: true,
  });
});

test("the argv follows whichever flag the binary lists", () => {
  assert.deepStrictEqual(
    loadMode.keepInRamArgs({ loadMode: true, mlock: true }),
    ["--load-mode", "mmap+mlock"],
  );
  assert.deepStrictEqual(
    loadMode.keepInRamArgs({ loadMode: false, mlock: true }),
    ["--mlock"],
  );
  assert.deepStrictEqual(
    loadMode.keepInRamArgs({ loadMode: false, mlock: false }),
    [],
  );
  assert.deepStrictEqual(loadMode.keepInRamArgs(null), []);
});

test("the help is read once per binary and re-read when the file changes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-load-mode-"));
  const bin = path.join(dir, "llama-server");
  fs.writeFileSync(bin, "a");
  let reads = 0;
  const probe = loadMode.createLoadFlagProbe({
    readHelp: async () => {
      reads += 1;
      return reads === 1 ? HELP_OLD : HELP_080;
    },
  });
  assert.deepStrictEqual(await probe(bin), { loadMode: false, mlock: true });
  assert.deepStrictEqual(await probe(bin), { loadMode: false, mlock: true });
  assert.strictEqual(reads, 1);
  // An upgrade in place: different size, so a different cache key.
  fs.writeFileSync(bin, "a longer binary");
  assert.deepStrictEqual(await probe(bin), { loadMode: true, mlock: false });
  assert.strictEqual(reads, 2);
});

test("a help that cannot be read is not cached and adds nothing, with a note", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-load-mode-"));
  const bin = path.join(dir, "llama-server");
  fs.writeFileSync(bin, "a");
  let reads = 0;
  const probe = loadMode.createLoadFlagProbe({
    readHelp: async () => {
      reads += 1;
      return null;
    },
  });
  const first = await loadMode.resolveKeepInRam(bin, probe);
  assert.deepStrictEqual(first.args, []);
  assert.match(first.note, /could not be read/);
  await loadMode.resolveKeepInRam(bin, probe);
  assert.strictEqual(reads, 2);
});

// The real thing: a stand-in binary that, like llama-server, prints its help
// and treats any option it does not know as fatal.
function fakeServer(dir, help) {
  const bin = path.join(dir, "llama-server");
  const helpFile = path.join(dir, "help.txt");
  fs.writeFileSync(helpFile, help);
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "--help" ]; then cat "${helpFile}"; exit 0; fi\nexit 1\n`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("the default probe asks the binary itself", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dive-load-mode-"));
  const probe = loadMode.createLoadFlagProbe();
  const keep = await loadMode.resolveKeepInRam(
    fakeServer(dir, HELP_080),
    probe,
  );
  assert.deepStrictEqual(keep, {
    args: ["--load-mode", "mmap+mlock"],
    note: "",
  });

  const old = fs.mkdtempSync(path.join(os.tmpdir(), "dive-load-mode-"));
  const keepOld = await loadMode.resolveKeepInRam(
    fakeServer(old, HELP_OLD),
    loadMode.createLoadFlagProbe(),
  );
  assert.deepStrictEqual(keepOld, { args: ["--mlock"], note: "" });
});

test("a binary that is missing gives no flag and says why", async () => {
  const keep = await loadMode.resolveKeepInRam(
    path.join(os.tmpdir(), "no-such-llama-server-binary"),
    loadMode.createLoadFlagProbe(),
  );
  assert.deepStrictEqual(keep.args, []);
  assert.match(keep.note, /could not be read/);
});
