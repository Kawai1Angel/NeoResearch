"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PACKAGE_ROOT = path.resolve(__dirname, "..");

function getRuntimePaths(projectRoot = process.cwd()) {
  const stateDir = path.join(projectRoot, ".neo-cast");
  const runtimeDir = path.join(stateDir, "runtime");
  const venvDir = path.join(runtimeDir, ".venv");
  const pythonPath = path.join(venvDir, "bin", "python");
  const uvCacheDir = path.join(runtimeDir, ".uv-cache");
  return {
    projectRoot,
    stateDir,
    runtimeDir,
    venvDir,
    pythonPath,
    uvCacheDir,
  };
}

function ensureRuntimeDirs(projectRoot = process.cwd()) {
  const paths = getRuntimePaths(projectRoot);
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  fs.mkdirSync(paths.uvCacheDir, { recursive: true });
  return paths;
}

function runtimeReady(projectRoot = process.cwd()) {
  const paths = getRuntimePaths(projectRoot);
  return fs.existsSync(paths.pythonPath) && _pythonVersionSupported(paths.pythonPath);
}

function getRuntimeInstallRoot(_projectRoot = process.cwd()) {
  return PACKAGE_ROOT;
}

function _run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (typeof result.status === "number") {
    return result.status;
  }
  throw new Error(`Failed to launch ${command}: ${result.error ? result.error.message : "unknown error"}`);
}

function _pythonVersionSupported(pythonPath) {
  const result = spawnSync(pythonPath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const text = `${result.stdout || ""}${result.stderr || ""}`;
  const match = /Python\s+(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 10);
}

function initRuntime(projectRoot = process.cwd(), options = {}) {
  const paths = ensureRuntimeDirs(projectRoot);
  const runtimeEnv = {
    UV_CACHE_DIR: paths.uvCacheDir,
  };
  let exitCode = _run("uv", ["venv", "--python", ">=3.10", "--allow-existing", paths.venvDir], projectRoot, runtimeEnv);
  if (exitCode !== 0) {
    return exitCode;
  }
  if (!_pythonVersionSupported(paths.pythonPath)) {
    console.error(`Runtime python at ${paths.pythonPath} does not satisfy Python >= 3.10.`);
    return 1;
  }

  if (options.skipInstall) {
    return 0;
  }

  const installRoot = getRuntimeInstallRoot(projectRoot);
  exitCode = _run("uv", ["pip", "install", "--python", paths.pythonPath, "-e", installRoot], installRoot, runtimeEnv);
  return exitCode;
}

module.exports = {
  ensureRuntimeDirs,
  getRuntimeInstallRoot,
  getRuntimePaths,
  initRuntime,
  runtimeReady,
};
