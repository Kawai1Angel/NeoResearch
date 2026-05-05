"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("registerVersion writes sequential lineage records with parent references", () => {
  const {
    getLatestVersionRef,
    registerVersion,
  } = require("../src/versioning");

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-versioning-"));
  const stateDir = path.join(projectDir, ".neo-cast");
  fs.mkdirSync(stateDir, { recursive: true });

  const taskPath = path.join(stateDir, "task_spec.json");
  fs.writeFileSync(taskPath, '{"schema_version":"task_spec.v1","task_id":"energy"}\n', "utf8");

  const taskRecord = registerVersion(projectDir, {
    kind: "task",
    logicalId: "energy",
    artifactPath: taskPath,
    metadata: { schema_version: "task_spec.v1" },
  });
  const dataRecord = registerVersion(projectDir, {
    kind: "data",
    logicalId: "energy",
    artifactPath: taskPath,
    parentRefs: [taskRecord],
    metadata: { split_policy: "fixed_rows" },
  });

  assert.equal(taskRecord.version_id, "task_energy_v1");
  assert.equal(dataRecord.version_id, "data_energy_v1");
  assert.equal(dataRecord.parent_versions[0].version_id, "task_energy_v1");
  assert.match(taskRecord.artifact_hash, /^sha256:/);

  const index = JSON.parse(fs.readFileSync(path.join(stateDir, "lineage", "index.json"), "utf8"));
  assert.equal(index.latest.task, "task_energy_v1");
  assert.equal(index.latest.data, "data_energy_v1");
  assert.equal(index.records.data_energy_v1.parent_versions[0].version_id, "task_energy_v1");
  assert.ok(fs.existsSync(path.join(stateDir, "lineage", "data", "data_energy_v1.json")));

  const latestTask = getLatestVersionRef(projectDir, "task", "energy");
  assert.equal(latestTask.version_id, "task_energy_v1");
  assert.equal(latestTask.artifact_path, ".neo-cast/task_spec.json");
});
