"use strict";

const { execFileSync } = require("child_process");
const { resolveConfig } = require("./config");
const { getRuntimePaths, runtimeReady } = require("./runtime");

function runCommand(command, args) {
  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return {
      ok: true,
      stdout,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      error,
    };
  }
}

function parsePythonVersion(raw) {
  const match = /Python\s+(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw,
  };
}

function isPythonSupported(versionInfo) {
  if (!versionInfo) {
    return false;
  }
  return versionInfo.major > 3 || (versionInfo.major === 3 && versionInfo.minor >= 10);
}

function checkPython(projectRoot = process.cwd()) {
  // Prefer the runtime venv python — it's what actually runs training.
  // Fall back to system python3 only when the venv doesn't exist yet.
  const runtimePaths = getRuntimePaths(projectRoot);
  const venvReady = runtimeReady(projectRoot);

  const pythonBin = venvReady ? runtimePaths.pythonPath : "python3";
  const source = venvReady ? "runtime venv" : "system python3";

  const result = runCommand(pythonBin, ["--version"]);
  if (!result.ok) {
    return {
      name: "python3",
      ok: false,
      message: `${source}: not available at ${pythonBin}`,
      details: venvReady
        ? "Runtime venv exists but python binary is missing — run `neo-cast init-runtime`."
        : "python3 is not installed. Install Python >= 3.10 first.",
    };
  }

  const versionInfo = parsePythonVersion(result.stdout);
  const supported = isPythonSupported(versionInfo);
  return {
    name: "python3",
    ok: supported,
    message: versionInfo
      ? `${versionInfo.raw} [${source}]`
      : `Unrecognized version output: ${result.stdout} [${source}]`,
    details: supported ? "" : "neo-cast requires python3 >= 3.10. Run `neo-cast init-runtime` to create the project venv.",
  };
}

function checkUv() {
  const result = runCommand("uv", ["--version"]);
  return {
    name: "uv",
    ok: result.ok,
    message: result.ok ? `Detected ${result.stdout}` : "uv is not available.",
    details: result.ok ? "" : "Install uv before running `neo-cast init-runtime`.",
  };
}

function checkAnthropicApiKey(env = process.env) {
  const hasKey = Boolean(env.ANTHROPIC_API_KEY);
  return {
    name: "anthropic_api_key",
    ok: true,
    level: hasKey ? "ok" : "warn",
    message: hasKey ? "ANTHROPIC_API_KEY is set." : "ANTHROPIC_API_KEY is not set.",
    details: hasKey ? "" : "Set ANTHROPIC_API_KEY for live LLM calls, or run design with `--mock-llm` / `NEO_CAST_USE_MOCK=1` for offline alpha demos.",
  };
}

function checkOpenAICompatibleApiKey(env = process.env) {
  const hasKey = Boolean(env.NEO_CAST_LLM_API_KEY || env.OPENAI_API_KEY || env.AIGCBEST_API_KEY);
  return {
    name: "openai_compatible_api_key",
    ok: true,
    level: hasKey ? "ok" : "warn",
    message: hasKey
      ? "OPENAI-compatible API key is set."
      : "OPENAI-compatible API key is not set.",
    details: hasKey
      ? ""
      : "Set NEO_CAST_LLM_API_KEY, OPENAI_API_KEY, or AIGCBEST_API_KEY for live LLM calls, or run design with `--mock-llm` / `NEO_CAST_USE_MOCK=1` for offline alpha demos.",
  };
}

function checkConfig(options = {}) {
  const configResult = resolveConfig(options);
  const ok = configResult.validationErrors.length === 0;

  return {
    name: "config",
    ok,
    message: ok ? "Resolved config is valid." : "Resolved config has validation errors.",
    details: ok ? "" : configResult.validationErrors.join(" "),
    resolvedConfig: configResult.resolved,
    paths: configResult.paths,
  };
}

function checkRuntime(projectRoot = process.cwd()) {
  const paths = getRuntimePaths(projectRoot);
  const ok = runtimeReady(projectRoot);
  return {
    name: "runtime",
    ok,
    message: ok
      ? `Project runtime is ready at ${paths.pythonPath}`
      : "Project runtime is not initialized.",
    details: ok ? "" : "Run `neo-cast init-runtime` inside the project directory.",
  };
}

function runDoctor(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const configResult = resolveConfig(options);
  const provider = configResult.resolved?.llm?.provider || "anthropic";
  const checks = [
    checkPython(projectRoot),
    checkUv(),
    provider === "openai-compatible"
      ? checkOpenAICompatibleApiKey(options.env || process.env)
      : checkAnthropicApiKey(options.env || process.env),
    checkConfig(options),
    checkRuntime(projectRoot),
  ];

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function formatDoctorReport(report) {
  const lines = [];

  lines.push(report.ok ? "neo-cast doctor: OK" : "neo-cast doctor: issues found");
  for (const check of report.checks) {
    const status = check.level === "warn" ? "WARN" : check.ok ? "OK" : "FAIL";
    lines.push(`[${status}] ${check.name}: ${check.message}`);
    if (check.details) {
      lines.push(`  ${check.details}`);
    }
  }

  const configCheck = report.checks.find((check) => check.name === "config");
  if (configCheck && configCheck.paths) {
    lines.push(`user config: ${configCheck.paths.userConfigPath}`);
    lines.push(`project config: ${configCheck.paths.projectConfigPath}`);
  }

  return lines.join("\n");
}

module.exports = {
  checkAnthropicApiKey,
  checkConfig,
  checkOpenAICompatibleApiKey,
  checkPython,
  checkRuntime,
  checkUv,
  formatDoctorReport,
  isPythonSupported,
  parsePythonVersion,
  runDoctor,
  runCommand,
};
