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

test("release reports are published under dataset root using the release version folder", () => {
  const {
    getNextVersionId,
    registerVersion,
  } = require("../src/versioning");
  const { publishReleaseReport } = require("../src/report-output");

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "neo-cast-report-version-"));
  const artifactDir = path.join(projectDir, ".neo-cast", "artifacts", "run_run_001");
  const datasetRoot = path.join(projectDir, ".neo-cast", "dataset");
  fs.mkdirSync(artifactDir, { recursive: true });
  const sourceReportPath = path.join(artifactDir, "eval_report.md");
  fs.writeFileSync(sourceReportPath, "# Evaluation\n\nversioned report\n", "utf8");

  const releaseVersionId = getNextVersionId(projectDir, "release", "run_001");
  const published = publishReleaseReport(projectDir, {
    versionId: releaseVersionId,
    sourceReportPath,
    env: { NEO_TSF_DATA_ROOT: datasetRoot },
    manifest: {
      run_id: "run_001",
      release_version: releaseVersionId,
    },
  });
  const releaseRecord = registerVersion(projectDir, {
    kind: "release",
    logicalId: "run_001",
    artifactPath: published.reportPath,
    metadata: { report_path: published.reportPath },
  });

  const expectedReportPath = path.join(datasetRoot, "reports", "release_run_001_v1", "eval_report.md");
  assert.equal(releaseVersionId, "release_run_001_v1");
  assert.equal(published.reportPath, expectedReportPath);
  assert.equal(fs.readFileSync(expectedReportPath, "utf8"), "# Evaluation\n\nversioned report\n");
  assert.ok(fs.existsSync(path.join(datasetRoot, "reports", "release_run_001_v1", "release_manifest.json")));
  assert.equal(releaseRecord.version_id, "release_run_001_v1");
  assert.equal(releaseRecord.artifact_path, ".neo-cast/dataset/reports/release_run_001_v1/eval_report.md");
});
