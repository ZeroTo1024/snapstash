const fs = require("node:fs");
const path = require("node:path");

function normalizePattern(value) {
  if (typeof value !== "string") return null;
  let p = value.trim();
  if (!p) return null;
  p = p.replaceAll("\\", "/");
  if (p.startsWith("./")) p = p.slice(2);
  return p;
}

function normalizeRelPath(value) {
  if (typeof value !== "string") return "";
  let p = value.replaceAll("\\", "/");
  p = path.posix.normalize(p);
  if (p.startsWith("./")) p = p.slice(2);
  if (p === ".") return "";
  return p;
}

function normalizeExcludes(excludes) {
  if (!Array.isArray(excludes)) return [];
  return excludes.map(normalizePattern).filter(Boolean);
}

function globToRegExp(pattern) {
  let escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  escaped = escaped.replace(/\\\*\\\*/g, ".*");
  escaped = escaped.replace(/\\\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function buildExcludeMatcher(excludes) {
  const list = normalizeExcludes(excludes);
  if (!list.length) return null;

  const rules = list.map((pattern) => {
    if (pattern.endsWith("/")) {
      const prefix = pattern.slice(0, -1);
      return (p) => p === prefix || p.startsWith(`${prefix}/`);
    }
    if (pattern.includes("*")) {
      const regex = globToRegExp(pattern);
      return (p) => regex.test(p);
    }
    return (p) => p === pattern;
  });

  return (relPath) => {
    const normalized = normalizeRelPath(relPath);
    return rules.some((rule) => rule(normalized));
  };
}

function loadConfig(rootAbs) {
  const configPath = path.join(rootAbs, ".snapstash");
  if (!fs.existsSync(configPath)) {
    return { path: configPath, config: null };
  }

  const raw = fs.readFileSync(configPath, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`无法解析 ${configPath}: ${err?.message || err}`);
  }

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`配置格式不正确: ${configPath}`);
  }

  return { path: configPath, config };
}

function resolveConfigPassword(config) {
  if (!config) return null;
  if (typeof config.password === "string" && config.password) return config.password;
  if (typeof config.pw === "string" && config.pw) return config.pw;
  return null;
}

function resolveConfigPwEnv(config) {
  if (!config) return null;
  if (typeof config.passwordEnv === "string" && config.passwordEnv) return config.passwordEnv;
  if (typeof config.pwEnv === "string" && config.pwEnv) return config.pwEnv;
  return null;
}

module.exports = {
  normalizeExcludes,
  buildExcludeMatcher,
  loadConfig,
  resolveConfigPassword,
  resolveConfigPwEnv,
};
