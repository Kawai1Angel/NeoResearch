"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const testDir = path.join(repoRoot, "test");
const testFiles = fs
  .readdirSync(testDir)
  .filter((file) => file.endsWith(".test.js") && file !== "python-unit.test.js")
  .sort()
  .map((file) => path.join("test", file));

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
