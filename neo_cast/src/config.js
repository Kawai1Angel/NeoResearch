"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_CONFIG = {
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    base_url: null,
    max_tokens: 4000,
    temperature: 0.2,
    timeout_seconds: 120,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const current = result[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return result;
}

function getUserConfigPath() {
  return path.join(os.homedir(), ".config", "neo-cast", "config.json");
}

function getProjectConfigPath(projectRoot = process.cwd()) {
  return path.join(projectRoot, ".neo-cast", "config.json");
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const wrapped = new Error(`Failed to parse JSON config: ${filePath}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function loadEnvConfig(env = process.env) {
  const llm = {};

  if (env.NEO_CAST_LLM_PROVIDER) {
    llm.provider = env.NEO_CAST_LLM_PROVIDER;
  }
  if (env.NEO_CAST_LLM_MODEL) {
    llm.model = env.NEO_CAST_LLM_MODEL;
  }
  if (env.NEO_CAST_LLM_BASE_URL) {
    llm.base_url = env.NEO_CAST_LLM_BASE_URL;
  }
  if (env.ANTHROPIC_BASE_URL) {
    llm.base_url = env.ANTHROPIC_BASE_URL;
  }
  if (env.OPENAI_BASE_URL) {
    llm.base_url = env.OPENAI_BASE_URL;
  }
  if (env.NEO_CAST_LLM_MAX_TOKENS) {
    llm.max_tokens = Number(env.NEO_CAST_LLM_MAX_TOKENS);
  }
  if (env.NEO_CAST_LLM_TEMPERATURE) {
    llm.temperature = Number(env.NEO_CAST_LLM_TEMPERATURE);
  }
  if (env.NEO_CAST_LLM_TIMEOUT_SECONDS) {
    llm.timeout_seconds = Number(env.NEO_CAST_LLM_TIMEOUT_SECONDS);
  }

  return Object.keys(llm).length > 0 ? { llm } : {};
}

function loadFlagConfig(flags = {}) {
  const llm = {};

  if (flags.provider) {
    llm.provider = flags.provider;
  }
  if (flags.model) {
    llm.model = flags.model;
  }
  if (flags.baseUrl) {
    llm.base_url = flags.baseUrl;
  }
  if (flags.maxTokens !== undefined) {
    llm.max_tokens = Number(flags.maxTokens);
  }
  if (flags.temperature !== undefined) {
    llm.temperature = Number(flags.temperature);
  }
  if (flags.timeoutSeconds !== undefined) {
    llm.timeout_seconds = Number(flags.timeoutSeconds);
  }

  return Object.keys(llm).length > 0 ? { llm } : {};
}

function validateResolvedConfig(config) {
  const errors = [];

  if (!isPlainObject(config)) {
    errors.push("Config must be an object.");
    return errors;
  }

  if (!isPlainObject(config.llm)) {
    errors.push("Config must include an 'llm' object.");
    return errors;
  }

  const { llm } = config;
  if (!llm.provider) {
    errors.push("llm.provider is required.");
  }
  const supportedProviders = new Set(["anthropic", "openai-compatible"]);
  if (llm.provider && !supportedProviders.has(llm.provider)) {
    errors.push(`Unsupported llm.provider: ${llm.provider}`);
  }
  if (llm.provider === "openai-compatible" && !llm.base_url) {
    errors.push("llm.base_url is required for openai-compatible provider.");
  }
  if (!llm.model) {
    errors.push("llm.model is required.");
  }
  if (!Number.isFinite(llm.max_tokens) || llm.max_tokens <= 0) {
    errors.push("llm.max_tokens must be a positive number.");
  }
  if (!Number.isFinite(llm.temperature) || llm.temperature < 0 || llm.temperature > 1) {
    errors.push("llm.temperature must be a number between 0 and 1.");
  }
  if (!Number.isFinite(llm.timeout_seconds) || llm.timeout_seconds <= 0) {
    errors.push("llm.timeout_seconds must be a positive number.");
  }

  return errors;
}

function resolveConfig(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const env = options.env || process.env;
  const flags = options.flags || {};

  const userConfigPath = options.userConfigPath || getUserConfigPath();
  const projectConfigPath = options.projectConfigPath || getProjectConfigPath(projectRoot);

  const sources = {
    defaults: DEFAULT_CONFIG,
    env: loadEnvConfig(env),
    user: readJsonFile(userConfigPath) || {},
    project: readJsonFile(projectConfigPath) || {},
    flags: loadFlagConfig(flags),
  };

  const resolved = deepMerge(
    deepMerge(
      deepMerge(deepMerge(sources.defaults, sources.env), sources.user),
      sources.project
    ),
    sources.flags
  );

  const validationErrors = validateResolvedConfig(resolved);

  return {
    resolved,
    sources,
    paths: {
      userConfigPath,
      projectConfigPath,
      projectRoot,
    },
    validationErrors,
  };
}

function redactConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

function maskSecret(secret) {
  if (!secret) {
    return null;
  }
  if (secret.length <= 8) {
    return "********";
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function buildPublicConfigView(resolvedConfig, env = process.env) {
  return {
    config: redactConfig(resolvedConfig),
    secrets: {
      anthropic_api_key: maskSecret(env.ANTHROPIC_API_KEY || ""),
      openai_compatible_api_key: maskSecret(
        env.NEO_CAST_LLM_API_KEY || env.OPENAI_API_KEY || env.AIGCBEST_API_KEY || ""
      ),
    },
  };
}

function ensureUserConfigFile(filePath = getUserConfigPath()) {
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  }

  return filePath;
}

module.exports = {
  DEFAULT_CONFIG,
  buildPublicConfigView,
  ensureUserConfigFile,
  getProjectConfigPath,
  getUserConfigPath,
  loadEnvConfig,
  loadFlagConfig,
  readJsonFile,
  resolveConfig,
  validateResolvedConfig,
};
