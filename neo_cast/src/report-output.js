"use strict";

const fs = require("fs");
const path = require("path");

function datasetRootFor(projectRoot = process.cwd(), env = process.env) {
  return path.resolve(env.NEO_TSF_DATA_ROOT || path.join(projectRoot, ".neo-cast", "dataset"));
}

function releaseReportDir(projectRoot, versionId, options = {}) {
  return path.join(datasetRootFor(projectRoot, options.env), "reports", versionId);
}

function publishReleaseReport(projectRoot, options = {}) {
  const versionId = options.versionId;
  if (!versionId || typeof versionId !== "string") {
    throw new Error("versionId must be a non-empty string");
  }
  const reportDir = releaseReportDir(projectRoot, versionId, options);
  const reportPath = path.join(reportDir, "eval_report.md");
  const manifestPath = path.join(reportDir, "release_manifest.json");
  const sourceReportPath = options.sourceReportPath ? path.resolve(options.sourceReportPath) : null;

  fs.mkdirSync(reportDir, { recursive: true });
  const copied = Boolean(sourceReportPath && fs.existsSync(sourceReportPath));
  if (copied) {
    fs.copyFileSync(sourceReportPath, reportPath);
  }
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schema_version: "release_report_manifest.v1",
      release_version: versionId,
      report_path: reportPath,
      source_report_path: sourceReportPath,
      copied,
      ...(options.manifest || {}),
    }, null, 2)}\n`,
    "utf8"
  );

  return {
    copied,
    reportDir,
    reportPath,
    manifestPath,
  };
}

module.exports = {
  datasetRootFor,
  publishReleaseReport,
  releaseReportDir,
};
