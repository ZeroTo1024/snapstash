#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { resolvePassword, DEFAULT_PW_ENV } = require("./crypto");
const { parseBackupText } = require("./backup-format");
const { getMessages, formatMessage } = require("./i18n");
const {
  loadConfig,
  loadConfigAt,
  resolveConfigPassword,
  resolveConfigPwEnv,
  resolveConfigLang,
  DEFAULT_CONFIG_DIR,
  DEFAULT_BACKUP_NAME,
  getDefaultBackupPath,
} = require("./config");

const DEFAULT_BACKUP_FILE = `${DEFAULT_CONFIG_DIR}/${DEFAULT_BACKUP_NAME}`;
const COLOR_ENABLED = process.stdout.isTTY;

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
};

function colorize(text, color) {
  if (!COLOR_ENABLED) return text;
  return `${color}${text}${COLORS.reset}`;
}

function createProgressRenderer() {
  if (!process.stdout.isTTY) return null;
  try {
    const logUpdateModule = require("log-update");
    const logUpdate = logUpdateModule?.default || logUpdateModule;
    const ansiEscapes = require("ansi-escapes");
    const hideCursor = ansiEscapes?.cursorHide || "";
    const showCursor = ansiEscapes?.cursorShow || "";
    let rows = [];
    let active = true;

    const start = (total) => {
      rows = Array.from({ length: total }, () => "");
      if (hideCursor) process.stdout.write(hideCursor);
    };

    const update = (index, line) => {
      if (!active) return;
      const i = Math.max(1, index) - 1;
      rows[i] = line;
      logUpdate(rows.join("\n"));
    };

    const stop = () => {
      if (!active) return;
      active = false;
      logUpdate.done();
      if (showCursor) process.stdout.write(showCursor);
    };

    return { start, update, stop };
  } catch {
    return null;
  }
}

function resolveHelpLang() {
  try {
    const { config } = loadConfig(process.cwd());
    return resolveConfigLang(config) || "en";
  } catch {
    return "en";
  }
}

function printHelp() {
  const messages = getMessages(resolveHelpLang());
  const vars = {
    defaultBackupFile: DEFAULT_BACKUP_FILE,
    defaultPwEnv: DEFAULT_PW_ENV,
  };
  const help = messages.restore?.help || {};
  console.log(
    [
      formatMessage(help.usage, vars),
      "",
      formatMessage(help.options, vars),
      formatMessage(help.input, vars),
      formatMessage(help.root, vars),
      formatMessage(help.pw, vars),
      formatMessage(help.pwEnv, vars),
      formatMessage(help.config, vars),
      formatMessage(help.noProgress, vars),
      formatMessage(help.help, vars),
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const out = {
    input: DEFAULT_BACKUP_FILE,
    root: null,
    pw: null,
    pwEnv: null,
    configPath: null,
    help: false,
    progress: true,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input" || arg === "-i") {
      out.input = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--root" || arg === "--dir") {
      out.root = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--pw") {
      out.pw = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--pw-env") {
      out.pwEnv = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--config") {
      out.configPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--no-progress") {
      out.progress = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  return out;
}

function assertSafeRepoRelativePath(p) {
  if (!p || typeof p !== "string") throw new Error("非法路径：空");
  if (path.isAbsolute(p)) throw new Error(`非法路径：不允许绝对路径: ${p}`);
  const normalized = path.posix.normalize(p.replaceAll("\\", "/"));
  if (normalized.startsWith("../") || normalized === "..") {
    throw new Error(`非法路径：不允许跳出仓库: ${p}`);
  }
  return normalized;
}

function ensureParentDir(fileAbsPath) {
  fs.mkdirSync(path.dirname(fileAbsPath), { recursive: true });
}

function removeIfExists(fileAbsPath) {
  try {
    fs.rmSync(fileAbsPath, { force: true });
  } catch {
    // ignore
  }
}

function tryChmod(fileAbsPath, modeStr) {
  if (!modeStr) return;
  const mode = Number.parseInt(modeStr, 8);
  if (!Number.isFinite(mode)) return;
  try {
    fs.chmodSync(fileAbsPath, mode & 0o777);
  } catch {
    // ignore (e.g. Windows)
  }
}

function writeSymlink(fileAbsPath, target) {
  removeIfExists(fileAbsPath);
  ensureParentDir(fileAbsPath);
  fs.symlinkSync(target, fileAbsPath);
}

function decodePayload(value, encoding) {
  const buf = Buffer.from(value, "base64");
  const json = encoding === "br"
    ? zlib.brotliDecompressSync(buf).toString("utf8")
    : zlib.gunzipSync(buf).toString("utf8");
  return JSON.parse(json);
}

function decodeContent(item) {
  const encoded = Buffer.from(item.c, "base64");
  if (item.ce === "br") return zlib.brotliDecompressSync(encoded);
  if (item.ce === "gz") return zlib.gunzipSync(encoded);
  return encoded;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "0.00 KB";
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "0ms";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function loadBackup(inputPath, options) {
  const raw = fs.readFileSync(inputPath, "utf8").trim();
  let backup;
  const rootForConfig = path.resolve(options.root || process.cwd());
  const configEntry = options.configPath
    ? loadConfigAt(path.resolve(process.cwd(), options.configPath))
    : loadConfig(rootForConfig);
  const { config } = configEntry;
  const lang = resolveConfigLang(config) || "en";
  const messages = getMessages(lang);
  const restoreMessages = messages.restore || {};
  const errors = restoreMessages.errors || {};
  const configPassword = resolveConfigPassword(config);
  const pwEnv = options.pwEnv || resolveConfigPwEnv(config) || DEFAULT_PW_ENV;
  const password = resolvePassword(options.pw || configPassword, pwEnv);

  if (raw.startsWith("{")) {
    backup = JSON.parse(raw);
  } else {
    try {
      backup = parseBackupText(raw, password);
    } catch (err) {
      if (String(err?.message || "").includes("已加密")) {
        throw new Error(formatMessage(errors.encrypted, { pwEnv }));
      }
      if (!password) {
        throw new Error(formatMessage(errors.encrypted, { pwEnv }));
      }
      throw new Error(errors.decryptFailed);
    }
  }

  if (!backup || !Array.isArray(backup.data)) {
    throw new Error(formatMessage(errors.missingData, { defaultBackupFile: DEFAULT_BACKUP_FILE }));
  }

  if (backup.version !== 1 && backup.version !== 2) {
    throw new Error(
      formatMessage(errors.version, { defaultBackupFile: DEFAULT_BACKUP_FILE, version: backup.version }),
    );
  }

  return backup;
}

function runRestore(options) {
  const rootForConfig = path.resolve(options.root || process.cwd());
  if (!options.input) {
    const configDir = path.join(rootForConfig, DEFAULT_CONFIG_DIR);
    if (fs.existsSync(configDir) && !fs.statSync(configDir).isDirectory()) {
      throw new Error(`${configDir} 已存在但不是目录，请手动处理`);
    }
  }
  const configEntry = options.configPath
    ? loadConfigAt(path.resolve(process.cwd(), options.configPath))
    : loadConfig(rootForConfig);
  const { config } = configEntry;
  const lang = resolveConfigLang(config) || "en";
  const messages = getMessages(lang);
  const restoreMessages = messages.restore || {};
  const inputPath = options.input
    ? path.resolve(process.cwd(), options.input)
    : getDefaultBackupPath(rootForConfig);
  const backup = loadBackup(inputPath, options);
  const repoRoot = rootForConfig;
  const startAt = process.hrtime.bigint();

  let restored = 0;
  let removed = 0;
  let skipped = 0;

  const items = backup.version === 2
    ? backup.data.map((value) => decodePayload(value, backup.payloadEncoding || "br"))
    : backup.data;
  const total = items.length;
  const renderer = createProgressRenderer();
  let rendererStarted = false;
  const emitProgress = (status, index, rawBytes, brBytes, durationMs, relPath) => {
    if (!options.progress) return;
    const statusText = status || "done";
    const statusLabel = statusText.padEnd(10, " ");
    const statusColor = statusText === "processing" ? COLORS.dim : COLORS.cyan;
    const count = total ? ` [${index}/${total}]` : "";
    const countLabel = colorize(count, COLORS.dim);
    const rawLabel = formatSize(rawBytes || 0).padStart(10, " ");
    const brLabel = (brBytes ? formatSize(brBytes) : "0.00 KB").padStart(10, " ");
    const pathLabel = String(relPath || "").padEnd(64, " ");
    const timeLabel = formatDuration(durationMs || 0).padStart(7, " ");
    const line = `${colorize(statusLabel, statusColor)}${countLabel} ${colorize(pathLabel, COLORS.bold)} ` +
      `${colorize(restoreMessages.progress.size, COLORS.dim)}: ${rawLabel}   ${colorize(restoreMessages.progress.br, COLORS.dim)}: ${brLabel}   ` +
      `${colorize(restoreMessages.progress.time, COLORS.dim)}: ${colorize(timeLabel, COLORS.green)}`;
    if (renderer) {
      if (!rendererStarted) {
        renderer.start(total);
        rendererStarted = true;
      }
      renderer.update(index, line);
    } else {
      console.log(line);
    }
  };

  for (let i = 0; i < items.length; i += 1) {
    const startedAt = process.hrtime.bigint();
    const item = items[i];
    const relPath = assertSafeRepoRelativePath(item.p ?? item.path);
    const absPath = path.resolve(repoRoot, relPath);

    const kind = item.k ?? item.kind;
    if (kind === "D") {
      emitProgress("processing", i + 1, 0, 0, 0, relPath);
      removeIfExists(absPath);
      removed += 1;
      emitProgress(
        "done",
        i + 1,
        0,
        0,
        Number(process.hrtime.bigint() - startedAt) / 1e6,
        relPath,
      );
      continue;
    }

    const oldPath = item.o ?? item.oldPath;
    if (kind === "R" && oldPath) {
      const oldRelPath = assertSafeRepoRelativePath(oldPath);
      const oldAbsPath = path.resolve(repoRoot, oldRelPath);
      removeIfExists(oldAbsPath);
    }

    if (item.sm || item.submodule) {
      console.warn(`跳过 submodule：${relPath}`);
      skipped += 1;
      continue;
    }

    const mode = item.m ?? item.mode;
    if (mode === "120000") {
      const target = item.t ?? item.symlinkTarget;
      if (typeof target !== "string") {
        throw new Error(`symlink 缺少目标：${relPath}`);
      }
      emitProgress("processing", i + 1, Buffer.byteLength(target, "utf8"), 0, 0, relPath);
      writeSymlink(absPath, target);
      restored += 1;
      emitProgress(
        "done",
        i + 1,
        Buffer.byteLength(target, "utf8"),
        0,
        Number(process.hrtime.bigint() - startedAt) / 1e6,
        relPath,
      );
      continue;
    }

    const contentBase64 = item.c ?? item.contentBase64;
    if (typeof contentBase64 !== "string") {
      throw new Error(`缺少内容：${relPath}`);
    }

    const content = item.c ? decodeContent(item) : Buffer.from(contentBase64, "base64");
    emitProgress("processing", i + 1, content.length, 0, 0, relPath);
    ensureParentDir(absPath);
    fs.writeFileSync(absPath, content);
    tryChmod(absPath, mode);
    restored += 1;
    emitProgress(
      "done",
      i + 1,
      content.length,
      item.c ? Buffer.from(item.c, "base64").length : 0,
      Number(process.hrtime.bigint() - startedAt) / 1e6,
      relPath,
    );
  }

  if (rendererStarted && renderer) {
    renderer.stop();
  }
  const summary = restoreMessages.summary || {};
  const durationLabel = formatDuration(Number(process.hrtime.bigint() - startAt) / 1e6);
  console.log(
    lang === "zh"
      ? `${colorize(summary.done, COLORS.green)}: ${summary.add} ${restored}，${summary.del} ${removed}，${summary.skip} ${skipped}， ${summary.total} ${items.length || 0}（${summary.path}：${repoRoot}）`
      : `${colorize(summary.done, COLORS.green)}: ${summary.add} ${restored}, ${summary.del} ${removed}, ${summary.skip} ${skipped}, ${summary.total} ${items.length || 0} (${summary.path}: ${repoRoot})`,
  );
  console.log(`${colorize("Time", COLORS.dim)}: ${colorize(durationLabel, COLORS.green)}`);
}

function getBackupInfo(options) {
  const rootForConfig = path.resolve(options.root || process.cwd());
  const inputPath = options.input
    ? path.resolve(process.cwd(), options.input)
    : getDefaultBackupPath(rootForConfig);
  const raw = fs.readFileSync(inputPath, "utf8").trim();
  const encrypted = !raw.startsWith("{") && !raw.startsWith("SSP1:");
  const backup = loadBackup(inputPath, options);
  return {
    version: backup.version,
    createdAt: backup.createdAt,
    repoRoot: backup.repoRoot,
    head: backup.head,
    payloadEncoding: backup.payloadEncoding,
    source: backup.source,
    items: Array.isArray(backup.data) ? backup.data.length : 0,
    encrypted,
  };
}

module.exports = {
  DEFAULT_BACKUP_FILE,
  runRestore,
  getBackupInfo,
};

if (require.main === module) {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      printHelp();
    } else {
      runRestore(options);
    }
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 1;
  }
}
