"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runPythonCommand } = require("../src/python-bridge");

function tempProject(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeScript(projectRoot, name, source) {
  const scriptPath = path.join(projectRoot, name);
  fs.writeFileSync(scriptPath, source, "utf8");
  return scriptPath;
}

test("runPythonCommand streams output without blocking the Node event loop", async () => {
  const projectRoot = tempProject("neo-cast-async-bridge-");
  const scriptPath = writeScript(
    projectRoot,
    "slow-output.js",
    [
      '"use strict";',
      'process.stdout.write("start\\n");',
      'setTimeout(() => { process.stdout.write("done\\n"); }, 120);',
    ].join("\n"),
  );

  const chunks = [];
  const run = runPythonCommand(projectRoot, [scriptPath], {
    pythonCommand: process.execPath,
    capture: true,
    onStdout: (chunk) => chunks.push(chunk),
  });

  let timerFired = false;
  setTimeout(() => {
    timerFired = true;
  }, 10);

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(timerFired, true, "event loop should keep processing timers while child process runs");

  const result = await run;
  assert.equal(result.status, 0);
  assert.match(chunks.join(""), /start/);
  assert.match(chunks.join(""), /done/);
});

test("runPythonCommand can abort a running child process", async () => {
  const projectRoot = tempProject("neo-cast-abort-bridge-");
  const scriptPath = writeScript(
    projectRoot,
    "wait.js",
    [
      '"use strict";',
      'process.stdout.write("ready\\n");',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const controller = new AbortController();

  const result = await runPythonCommand(projectRoot, [scriptPath], {
    pythonCommand: process.execPath,
    capture: true,
    signal: controller.signal,
    onStdout: (chunk) => {
      if (chunk.includes("ready")) {
        const logDir = path.join(projectRoot, ".neo-cast", "logs");
        const live = fs.readFileSync(path.join(logDir, fs.readdirSync(logDir)[0]), "utf8");
        assert.match(live, /ready/, "output must be on disk before completion");
        controller.abort();
      }
    },
  });

  const records = fs.readFileSync(result.logPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records[0].event, "started");
  assert.equal(records.at(-1).event, "canceled");
  assert.ok(records.at(-1).durationMs >= 0);
  assert.equal(result.aborted, true);
  assert.equal(result.status, null);
});

test("runPythonCommand enforces a Node-side timeout", async () => {
  const projectRoot = tempProject("neo-cast-timeout-bridge-");
  const scriptPath = writeScript(
    projectRoot,
    "hang.js",
    [
      '"use strict";',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );

  const started = Date.now();
  const result = await runPythonCommand(projectRoot, [scriptPath], {
    pythonCommand: process.execPath,
    capture: true,
    timeoutMs: 50,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.status, null);
  assert.ok(Date.now() - started < 1000, "timeout should stop the child without waiting for script completion");
});
