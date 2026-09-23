"use strict";

const fs = require("fs");
const { randomUUID } = require("crypto");
const path = require("path");
const { spawn } = require("child_process");
const { getRuntimePaths, runtimeReady } = require("./runtime");
const PY_DIR = "py";
const PACKAGE_ROOT = path.resolve(__dirname, "..");

function scriptPath(scriptName) {
  return path.join(PACKAGE_ROOT, PY_DIR, scriptName);
}

function pythonEnv(projectRoot) {
  return {
    ...process.env,
    NEO_CAST_PROJECT_ROOT: projectRoot,
    NEO_CAST_PACKAGE_ROOT: PACKAGE_ROOT,
  };
}

function pythonCommandFor(projectRoot, options = {}) {
  return options.pythonCommand || (runtimeReady(projectRoot) ? getRuntimePaths(projectRoot).pythonPath : "python3");
}

function normalizeProjectRoot(projectRoot = process.cwd()) {
  return fs.realpathSync(projectRoot);
}

function getProjectPaths(projectRoot = process.cwd()) {
  const stateDir = path.join(projectRoot, ".neo-cast");
  return {
    projectRoot,
    stateDir,
    currentCandidatePath: path.join(stateDir, "current_candidate.json"),
    resolvedCandidatePath: path.join(stateDir, "resolved_candidate.json"),
    artifactsDir: path.join(stateDir, "artifacts"),
    runnerStatePath: path.join(stateDir, "runner_state.json"),
    resultsPath: path.join(stateDir, "results.tsv"),
  };
}

function ensureProjectState(projectRoot = process.cwd()) {
  const paths = getProjectPaths(projectRoot);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.artifactsDir, { recursive: true });
  return paths;
}

function writeCurrentCandidate(projectRoot, candidate) {
  const paths = ensureProjectState(projectRoot);
  fs.writeFileSync(paths.currentCandidatePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  return paths.currentCandidatePath;
}

function runPythonCommand(projectRoot, commandArgs, options = {}) {
  const resolvedProjectRoot = normalizeProjectRoot(projectRoot);
  const pythonCommand = pythonCommandFor(resolvedProjectRoot, options);
  const shouldMirrorOutput = options.capture !== true;
  const stdoutTarget = options.stdout || process.stdout;
  const stderrTarget = options.stderr || process.stderr;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let aborted = false;
  let timeout = null;
  let hardKillTimeout = null;
  let settled = false;
  const startedAt = Date.now();
  const logDir = path.join(resolvedProjectRoot, ".neo-cast", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${startedAt}-${randomUUID()}.jsonl`);
  const archive = (record) => fs.appendFileSync(logPath, `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`);
  archive({ event: "started", executable: pythonCommand, args: commandArgs });

  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, commandArgs, {
      cwd: resolvedProjectRoot,
      env: {
        ...pythonEnv(resolvedProjectRoot),
        ...(options.env || {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    function cleanup() {
      if (timeout) clearTimeout(timeout);
      if (hardKillTimeout) clearTimeout(hardKillTimeout);
      if (options.signal) options.signal.removeEventListener("abort", abortChild);
    }

    function stopChild(reason) {
      if (child.exitCode !== null || child.killed) return;
      if (reason === "timeout") {
        timedOut = true;
      }
      if (reason === "abort") {
        aborted = true;
      }
      child.kill("SIGTERM");
      hardKillTimeout = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, options.killAfterMs || 2000);
      if (typeof hardKillTimeout.unref === "function") hardKillTimeout.unref();
    }

    function abortChild() {
      stopChild("abort");
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      archive({ stream: "stdout", text });
      stdout += text;
      if (options.onStdout) options.onStdout(text, child);
      if (shouldMirrorOutput) stdoutTarget.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      archive({ stream: "stderr", text });
      stderr += text;
      if (options.onStderr) options.onStderr(text, child);
      if (shouldMirrorOutput) stderrTarget.write(text);
    });

    child.once("error", (error) => {
      cleanup();
      if (settled) return;
      settled = true;
      archive({ event: "failed", error: error.message, durationMs: Date.now() - startedAt });
      reject(error);
    });

    child.once("close", (code, signal) => {
      cleanup();
      if (settled) return;
      settled = true;
      archive({ event: aborted ? "canceled" : timedOut ? "timeout" : "finished", code, signal, durationMs: Date.now() - startedAt });
      resolve({
        logPath,
        status: typeof code === "number" ? code : null,
        signal,
        stdout,
        stderr,
        timedOut,
        aborted,
      });
    });

    if (options.signal) {
      if (options.signal.aborted) {
        abortChild();
      } else {
        options.signal.addEventListener("abort", abortChild, { once: true });
      }
    }

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeout = setTimeout(() => stopChild("timeout"), options.timeoutMs);
      if (typeof timeout.unref === "function") timeout.unref();
    }
  }).catch((error) => {
    throw new Error(`Failed to launch ${commandArgs[0] || pythonCommand}: ${error.message}`);
  });
}

async function runPython(projectRoot, scriptName, args = [], options = {}) {
  const result = await runPythonCommand(projectRoot, [scriptPath(scriptName), ...args], options);
  if (typeof result.status === "number") {
    return result.status;
  }
  if (result.timedOut) return 124;
  if (result.aborted) return 130;
  throw new Error(`Failed to run ${scriptName}: terminated by ${result.signal || "unknown signal"}`);
}

async function runPythonCapture(projectRoot, scriptName, args = [], options = {}) {
  const result = await runPythonCommand(projectRoot, [scriptPath(scriptName), ...args], {
    ...options,
    capture: true,
  });
  if (typeof result.status !== "number" && !result.timedOut && !result.aborted) {
    throw new Error(`Failed to run ${scriptName}: terminated by ${result.signal || "unknown signal"}`);
  }
  return result;
}

async function ensureRunnerInitialized(projectRoot = process.cwd()) {
  const paths = ensureProjectState(projectRoot);
  if (!fs.existsSync(paths.runnerStatePath)) {
    const exitCode = await runPython(projectRoot, "runner.py", ["init"]);
    if (exitCode !== 0) {
      throw new Error(`runner.py init failed with exit code ${exitCode}`);
    }
  }
  return paths;
}

function runRunner(projectRoot, description, options = {}) {
  const args = ["run", "--description", description];
  if (options.skipSmoke) {
    args.push("--skip-smoke");
  }
  return runPython(projectRoot, "runner.py", args, options);
}

function loadResults(projectRoot = process.cwd()) {
  const paths = getProjectPaths(projectRoot);
  if (!fs.existsSync(paths.resultsPath)) {
    return [];
  }
  const raw = fs.readFileSync(paths.resultsPath, "utf8").trim();
  if (!raw) {
    return [];
  }
  const lines = raw.split(/\r?\n/);
  const header = lines[0].split("\t");
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = line.split("\t");
    const row = {};
    header.forEach((key, index) => {
      row[key] = cells[index] || "";
    });
    return row;
  });
}

function readRunnerState(projectRoot = process.cwd()) {
  const paths = getProjectPaths(projectRoot);
  if (!fs.existsSync(paths.runnerStatePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(paths.runnerStatePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function loadArtifactData(projectRoot, runId) {
  const artifactDir = path.join(projectRoot, ".neo-cast", "artifacts", `run_${runId}`);
  const result = {};
  const curvesPath = path.join(artifactDir, "training_curves.json");
  const summaryPath = path.join(artifactDir, "training_summary.json");

  if (fs.existsSync(curvesPath)) {
    try {
      result.training_curves = JSON.parse(fs.readFileSync(curvesPath, "utf8"));
    } catch (error) {
      result.training_curves_error = error.message;
    }
  }

  if (fs.existsSync(summaryPath)) {
    try {
      result.training_summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    } catch (error) {
      result.training_summary_error = error.message;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

async function mutateCandidate(projectRoot, options = {}) {
  const paths = ensureProjectState(projectRoot);
  const recipePath = options.recipePath || paths.currentCandidatePath;
  const outputPath = options.outputPath || paths.currentCandidatePath;
  const metricsPath = options.metricsPath;
  const args = [
    "--recipe",
    recipePath,
    "--output",
    outputPath,
    "--index",
    String(options.index || 1),
  ];
  if (metricsPath) {
    args.push("--metrics", metricsPath);
  }
  if (options.statePath) {
    args.push("--state-path", options.statePath);
  }
  const result = await runPythonCapture(projectRoot, path.join("search", "mutate.py"), args, options);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`mutate.py failed with exit code ${result.status}`);
  }
  return JSON.parse(fs.readFileSync(outputPath, "utf8"));
}

module.exports = {
  ensureProjectState,
  ensureRunnerInitialized,
  getProjectPaths,
  loadArtifactData,
  loadResults,
  mutateCandidate,
  readRunnerState,
  runPython,
  runPythonCapture,
  runPythonCommand,
  runRunner,
  writeCurrentCandidate,
};
