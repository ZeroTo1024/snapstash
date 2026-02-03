const fs = require("node:fs");
const path = require("node:path");

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mergeDeep(target, source) {
  if (!source || typeof source !== "object") return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = mergeDeep(out[key] && typeof out[key] === "object" ? out[key] : {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function getLocalePath(locale) {
  return path.join(__dirname, "i18n", `${locale}.json`);
}

function getMessages(locale) {
  const base = readJson(getLocalePath("en")) || {};
  if (!locale || locale === "en") return base;
  const extra = readJson(getLocalePath(locale)) || {};
  return mergeDeep(base, extra);
}

function formatMessage(text, vars) {
  if (typeof text !== "string") return text;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key]);
    }
    return match;
  });
}

function formatList(list, vars) {
  if (!Array.isArray(list)) return [];
  return list.map((item) => formatMessage(item, vars));
}

module.exports = {
  getMessages,
  formatMessage,
  formatList,
};
