"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { printHelp, runPythonScript } = require("../src/cli");
const { getRuntimeInstallRoot } = require("../src/runtime");

const REPO_ROOT = path.resolve(__dirname, "..");

test("package metadata uses an explicit npm file boundary", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

  assert.equal(pkg.bin["neo-cast"], "bin/neo-cast.js");
  assert.deepEqual(pkg.publishConfig, { access: "public" });
  assert.equal(pkg.scripts.test, "npm run test:all");
  assert.equal(pkg.scripts["test:node"], "node scripts/run-node-tests.js");
  assert.equal(pkg.scripts["test:python"], "node --test test/python-unit.test.js");
  assert.equal(pkg.scripts["test:all"], "npm run test:node && npm run test:python");
  assert.match(pkg.scripts["test:pack"], /--cache \.artifacts\/npm-cache/);
  assert.equal(pkg.scripts.prepublishOnly, "node scripts/prepublish-only.js");
  assert.match(pkg.scripts["test:publish"], /--tag alpha/);
  assert.match(pkg.scripts["test:publish"], /--cache \.artifacts\/npm-cache/);
  assert.match(pkg.scripts["publish:alpha"], /--tag alpha/);
  assert.match(pkg.scripts["publish:alpha"], /--cache \.artifacts\/npm-cache/);
  assert.ok(Array.isArray(pkg.files));
  assert.ok(pkg.files.includes("bin/"));
  assert.ok(pkg.files.includes("src/"));
  assert.ok(pkg.files.includes("py/"));
  assert.ok(pkg.files.includes("runner-manifest.json"));
  assert.ok(!pkg.files.includes("test/"));
  assert.ok(!pkg.files.includes("datasets (1)/"));
});

test("node test runner excludes the Python unit test wrapper", () => {
  const runner = fs.readFileSync(path.join(REPO_ROOT, "scripts/run-node-tests.js"), "utf8");

  assert.match(runner, /python-unit\.test\.js/);
  assert.match(runner, /--test/);
});

test("npm pack excludes generated and local-only artifacts", () => {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--cache", ".artifacts/npm-cache"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 15_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout)[0];
  const files = packed.files.map((file) => file.path);

  assert.ok(files.includes("src/cli.js"));
  assert.ok(files.includes("py/runner.py"));
  assert.ok(files.includes("runner-manifest.json"));
  assert.ok(files.every((file) => !file.includes(".egg-info/")));
  assert.ok(files.every((file) => !file.includes("__pycache__/")));
  assert.ok(files.every((file) => !file.endsWith(".pyc")));
  assert.ok(files.every((file) => !file.startsWith("test/")));
  assert.ok(files.every((file) => !file.startsWith("datasets (1)/")));
});

test("publish guard requires the alpha npm tag", () => {
  const guard = fs.readFileSync(path.join(REPO_ROOT, "scripts/prepublish-only.js"), "utf8");

  assert.match(guard, /npm_config_tag/);
  assert.match(guard, /tag === "alpha"/);
  assert.match(guard, /process\.exit\(1\)/);
});

test("help exposes the blind-test runner subcommand", () => {
  const logs = [];
  const originalLog = console.log;
  try {
    console.log = (message) => logs.push(String(message));
    printHelp();
  } finally {
    console.log = originalLog;
  }

  assert.match(logs.join("\n"), /neo-cast runner blind-test \[--run-id/);
});

test("help exposes the reflection design flag", () => {
  const logs = [];
  const originalLog = console.log;
  try {
    console.log = (message) => logs.push(String(message));
    printHelp();
  } finally {
    console.log = originalLog;
  }

  assert.match(logs.join("\n"), /--use-reflection/);
});

test("help exposes autonomous design flags", () => {
  const logs = [];
  const originalLog = console.log;
  try {
    console.log = (message) => logs.push(String(message));
    printHelp();
  } finally {
    console.log = originalLog;
  }

  const help = logs.join("\n");
  assert.match(help, /--autonomous/);
  assert.match(help, /--time-budget/);
  assert.match(help, /--max-no-improve/);
});

test("python runner processes receive the user project root in environment", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-project-root-"));
  const resolvedProjectRoot = fs.realpathSync(projectRoot);
  const outputPath = path.join(projectRoot, "env.json");
  const scriptPath = path.join(projectRoot, "write-env.js");
  fs.writeFileSync(
    scriptPath,
    [
      '"use strict";',
      'const fs = require("node:fs");',
      "fs.writeFileSync(process.argv[2], JSON.stringify({",
      "  cwd: process.cwd(),",
      "  projectRoot: process.env.NEO_CAST_PROJECT_ROOT,",
      "  packageRoot: process.env.NEO_CAST_PACKAGE_ROOT || null,",
      "}));",
    ].join("\n"),
    "utf8",
  );

  const exitCode = await runPythonScript([scriptPath, outputPath], {
    projectRoot,
    pythonCommand: process.execPath,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), {
    cwd: resolvedProjectRoot,
    projectRoot: resolvedProjectRoot,
    packageRoot: REPO_ROOT,
  });
});

test("project runtime installs Python dependencies from the Neo-Cast package root", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-runtime-install-root-"));
  const installRoot = getRuntimeInstallRoot(projectRoot);

  assert.equal(installRoot, REPO_ROOT);
  assert.ok(fs.existsSync(path.join(installRoot, "pyproject.toml")));
  assert.ok(!fs.existsSync(path.join(projectRoot, "pyproject.toml")));
});
