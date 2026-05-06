"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const LINEAGE_INDEX_SCHEMA_VERSION = "neo_cast_lineage_index.v1";
const VERSION_RECORD_SCHEMA_VERSION = "neo_cast_version.v1";
const VERSION_KINDS = new Set(["task", "data", "recipe", "experiment", "release"]);

function nowIso() {
  return new Date().toISOString();
}

function getLineageDir(projectRoot = process.cwd()) {
  return path.join(projectRoot, ".neo-cast", "lineage");
}

function indexPath(projectRoot = process.cwd()) {
  return path.join(getLineageDir(projectRoot), "index.json");
}

function emptyIndex() {
  return {
    schema_version: LINEAGE_INDEX_SCHEMA_VERSION,
    latest: {},
    latest_by_logical_id: {},
    records: {},
    updated_at: null,
  };
}

function readIndex(projectRoot = process.cwd()) {
  const resolvedPath = indexPath(projectRoot);
  if (!fs.existsSync(resolvedPath)) {
    return emptyIndex();
  }
  const payload = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  return {
    ...emptyIndex(),
    ...payload,
    latest: payload.latest || {},
    latest_by_logical_id: payload.latest_by_logical_id || {},
    records: payload.records || {},
  };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeIndex(projectRoot, index) {
  writeJson(indexPath(projectRoot), {
    ...index,
    updated_at: nowIso(),
  });
}

function assertKind(kind) {
  if (!VERSION_KINDS.has(kind)) {
    throw new Error(`version kind must be one of: ${Array.from(VERSION_KINDS).join(", ")}`);
  }
}

function safeLogicalId(value) {
  const normalized = String(value || "default")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80);
  return normalized || "default";
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bufferOrText) {
  return `sha256:${crypto.createHash("sha256").update(bufferOrText).digest("hex")}`;
}

function relativeArtifactPath(projectRoot, artifactPath) {
  if (!artifactPath) {
    return null;
  }
  const absolute = path.resolve(artifactPath);
  const root = fs.existsSync(projectRoot) ? fs.realpathSync(projectRoot) : path.resolve(projectRoot);
  const comparable = fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
  const relative = path.relative(root, comparable);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return absolute;
}

function artifactHash(_projectRoot, options) {
  if (options.artifactPath && fs.existsSync(options.artifactPath)) {
    const stat = fs.statSync(options.artifactPath);
    if (stat.isFile()) {
      return sha256(fs.readFileSync(options.artifactPath));
    }
  }
  if (options.payload !== undefined) {
    return sha256(stableStringify(options.payload));
  }
  return sha256(stableStringify(options.metadata || {}));
}

function versionRef(record) {
  if (!record) {
    return null;
  }
  return {
    kind: record.kind,
    logical_id: record.logical_id,
    version: record.version,
    version_id: record.version_id,
    artifact_path: record.artifact_path,
    artifact_hash: record.artifact_hash,
  };
}

function normalizeParentRef(ref) {
  if (!ref) {
    return null;
  }
  if (typeof ref === "string") {
    return { version_id: ref };
  }
  return {
    kind: ref.kind,
    logical_id: ref.logical_id,
    version: ref.version,
    version_id: ref.version_id,
    artifact_path: ref.artifact_path,
    artifact_hash: ref.artifact_hash,
  };
}

function nextVersionNumber(index, kind, logicalId) {
  return Object.values(index.records)
    .filter((record) => record.kind === kind && record.logical_id === logicalId)
    .reduce((maxVersion, record) => Math.max(maxVersion, Number(record.version) || 0), 0) + 1;
}

function getNextVersionId(projectRoot, kind, logicalId) {
  assertKind(kind);
  const safeId = safeLogicalId(logicalId);
  const index = readIndex(projectRoot);
  const version = nextVersionNumber(index, kind, safeId);
  return `${kind}_${safeId}_v${version}`;
}

function registerVersion(projectRoot, options = {}) {
  const kind = options.kind;
  assertKind(kind);
  const logicalId = safeLogicalId(options.logicalId);
  const index = readIndex(projectRoot);
  const version = nextVersionNumber(index, kind, logicalId);
  const versionId = `${kind}_${logicalId}_v${version}`;
  const recordPath = path.join(getLineageDir(projectRoot), kind, `${versionId}.json`);
  const createdAt = options.createdAt || nowIso();
  const artifactPath = relativeArtifactPath(projectRoot, options.artifactPath);
  const parentVersions = (options.parentRefs || [])
    .map(normalizeParentRef)
    .filter(Boolean);

  const record = {
    schema_version: VERSION_RECORD_SCHEMA_VERSION,
    kind,
    logical_id: logicalId,
    version,
    version_id: versionId,
    artifact_path: artifactPath,
    artifact_hash: artifactHash(projectRoot, options),
    parent_versions: parentVersions,
    metadata: options.metadata || {},
    created_by: options.createdBy || "neo-cast",
    created_at: createdAt,
  };

  writeJson(recordPath, record);

  const recordSummary = {
    ...versionRef(record),
    parent_versions: parentVersions,
    metadata: record.metadata,
    record_path: relativeArtifactPath(projectRoot, recordPath),
    created_by: record.created_by,
    created_at: createdAt,
  };
  index.records[versionId] = recordSummary;
  index.latest[kind] = versionId;
  index.latest_by_logical_id[kind] = index.latest_by_logical_id[kind] || {};
  index.latest_by_logical_id[kind][logicalId] = versionId;
  writeIndex(projectRoot, index);

  return record;
}

function getLatestVersionRef(projectRoot, kind, logicalId) {
  assertKind(kind);
  const index = readIndex(projectRoot);
  const safeId = logicalId ? safeLogicalId(logicalId) : null;
  const versionId = safeId
    ? index.latest_by_logical_id[kind]?.[safeId]
    : index.latest[kind];
  return versionRef(index.records[versionId]);
}

function getVersionRecord(projectRoot, versionId) {
  const index = readIndex(projectRoot);
  const summary = index.records[versionId];
  if (!summary || !summary.record_path) {
    return null;
  }
  const recordPath = path.resolve(projectRoot, summary.record_path);
  if (!fs.existsSync(recordPath)) {
    return summary;
  }
  return JSON.parse(fs.readFileSync(recordPath, "utf8"));
}

module.exports = {
  LINEAGE_INDEX_SCHEMA_VERSION,
  VERSION_RECORD_SCHEMA_VERSION,
  getLatestVersionRef,
  getLineageDir,
  getNextVersionId,
  getVersionRecord,
  readIndex,
  registerVersion,
};
