"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runtimeReady } = require("../src/runtime");

function createRuntimeRoot(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-runtime-"));
  const binDir = path.join(root, ".neo-cast", "runtime", ".venv", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const pythonPath = path.join(binDir, "python");
  fs.writeFileSync(pythonPath, `#!/bin/sh\necho '${version}'\n`, "utf8");
  fs.chmodSync(pythonPath, 0o755);
  return root;
}

test("runtimeReady rejects missing or unsupported project runtimes", () => {
  assert.equal(runtimeReady(createRuntimeRoot("Python 3.9.6")), false);
  assert.equal(runtimeReady(createRuntimeRoot("not python")), false);
  assert.equal(runtimeReady(path.join(os.tmpdir(), "missing-neo-cast-runtime")), false);
});

test("runtimeReady accepts project runtimes with Python 3.10 or newer", () => {
  assert.equal(runtimeReady(createRuntimeRoot("Python 3.10.14")), true);
  assert.equal(runtimeReady(createRuntimeRoot("Python 3.12.0")), true);
});
