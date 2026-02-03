#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { resolvePassword, DEFAULT_PW_ENV } = require("./crypto");
const { parseBackupText } = require("./backup-format");
const { getMessages, formatMessage } = require("./i18n");
const { createProgressRenderer } = require("./progress");
const { COLORS, colorize } = require("./colorize");
const {
  SUMMARY_LABEL_WIDTH,
  STATUS_LABEL_WIDTH,
  PATH_LABEL_WIDTH,
  FIELD_GAP,
} = require("./constants");
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

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    if (!code) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0xa0)) continue;
    width += code <= 0x7f ? 1 : 2;
  }
  return width;
}

function truncateDisplay(text, maxWidth) {
  const str = String(text ?? "");
  if (maxWidth <= 0) return "";
  let width = 0;
  let out = "";
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (!code) continue;
    const chWidth = code <= 0x7f ? 1 : 2;
    if (width + chWidth > maxWidth) break;
    out += ch;
    width += chWidth;
  }
  if (out.length < str.length && maxWidth >= 3) {
    let trimWidth = maxWidth - 3;
    let trimmed = "";
    let acc = 0;
    for (const ch of out) {
      const code = ch.codePointAt(0);
      if (!code) continue;
      const chWidth = code <= 0x7f ? 1 : 2;
      if (acc + chWidth > trimWidth) break;
      trimmed += ch;
      acc += chWidth;
    }
    return `${trimmed}...`;
  }
  return out;
}

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    if (!code) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0xa0)) continue;
    width += code <= 0x7f ? 1 : 2;
  }
  return width;
}

function padDisplay(text, targetWidth) {
  const str = String(text ?? "");
  const width = displayWidth(str);
  if (width >= targetWidth) return str;
  return str + " ".repeat(targetWidth - width);
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
  const progressLabel = lang === "zh" ? "进度" : "progress";
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
  const renderer = createProgressRenderer({ label: progressLabel, force: true });
  let rendererStarted = false;
  let pendingItems = null;
  let itemPaths = null;
  let itemRawBytes = null;
  let completedCount = 0;
  const ensurePendingState = (count) => {
    if (!count) return;
    if (!pendingItems || pendingItems.length !== count) {
      pendingItems = Array(count).fill(true);
      itemPaths = Array(count).fill("");
      itemRawBytes = Array(count).fill(0);
    }
  };
  const pickNeighbor = (index, count) => {
    if (!pendingItems) return null;
    const hasInfo = (i) => pendingItems[i] && itemPaths[i];
    for (let i = index - 1; i >= 0; i -= 1) {
      if (hasInfo(i)) return i;
    }
    for (let i = index + 1; i < count; i += 1) {
      if (hasInfo(i)) return i;
    }
    for (let i = index - 1; i >= 0; i -= 1) {
      if (pendingItems[i]) return i;
    }
    for (let i = index + 1; i < count; i += 1) {
      if (pendingItems[i]) return i;
    }
    return null;
  };
  const emitProgress = (status, index, rawBytes, brBytes, durationMs, relPath) => {
    if (!options.progress) return;
    const statusKey = status || "done";
    const buildLine = (lineStatus, lineIndex, lineRawBytes, lineBrBytes, lineDur, linePath) => {
      const statusLabel = lineStatus.padEnd(STATUS_LABEL_WIDTH, " ");
      const statusColor = lineStatus === "processing" ? COLORS.dim : COLORS.cyan;
      let countLabel = "";
      if (total) {
        if (lineStatus === "processing") {
          const remaining = Math.max(total - completedCount, 0);
          const left = colorize(` [${remaining}/`, COLORS.dim);
          const right = colorize(String(completedCount), COLORS.cyan);
          const end = colorize("]", COLORS.dim);
          countLabel = `${left}${right}${end}`;
        } else {
          const count = ` [${lineIndex}/${total}]`;
          countLabel = colorize(count, COLORS.dim);
        }
      }
      const rawLabel = formatSize(lineRawBytes || 0).padStart(10, " ");
      const brLabel = (lineBrBytes ? formatSize(lineBrBytes) : "0.00 KB").padStart(10, " ");
      const pathLabel = truncateDisplay(String(linePath || "(pending)"), PATH_LABEL_WIDTH).padEnd(PATH_LABEL_WIDTH, " ");
      const timeLabel = formatDuration(lineDur || 0).padStart(7, " ");
      return `${colorize(statusLabel, statusColor)}${countLabel} ${colorize(pathLabel, COLORS.bold)} ` +
        `${colorize(restoreMessages.progress.size, COLORS.dim)}: ${rawLabel}${FIELD_GAP}${colorize(restoreMessages.progress.br, COLORS.dim)}: ${brLabel}${FIELD_GAP}` +
        `${colorize(restoreMessages.progress.time, COLORS.dim)}: ${colorize(timeLabel, COLORS.green)}`;
    };
    const line = buildLine(statusKey, index, rawBytes, brBytes, durationMs, relPath);
    if (renderer) {
      ensurePendingState(total);
      const idx = Math.max(0, index - 1);
      if (!rendererStarted) {
        renderer.start(total);
        rendererStarted = true;
      }
      if (relPath) itemPaths[idx] = relPath;
      if (Number.isFinite(rawBytes)) itemRawBytes[idx] = rawBytes;
      if (statusKey === "processing") {
        renderer.update(index, line, statusKey);
        return;
      }
      if (statusKey === "done") {
        pendingItems[idx] = false;
        completedCount = Math.min(completedCount + 1, total || completedCount + 1);
        renderer.write(line);
        renderer.update(index, line, statusKey);
        const neighbor = pickNeighbor(idx, total);
        if (neighbor !== null) {
          const nextLine = buildLine(
            "processing",
            neighbor + 1,
            itemRawBytes[neighbor],
            0,
            0,
            itemPaths[neighbor]
          );
          renderer.setProcessing(nextLine);
        } else {
          renderer.setProcessing("");
        }
        return;
      }
      renderer.update(index, line, statusKey);
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
  const summaryLabelWidth = SUMMARY_LABEL_WIDTH;
  const doneLabel = padDisplay(summary.done || "Done", summaryLabelWidth);
  const sep = ", ";
  console.log(
    lang === "zh"
      ? `${colorize(doneLabel, COLORS.green)}: ` +
        `${colorize(summary.add, COLORS.dim)} ${restored}${sep}` +
        `${colorize(summary.del, COLORS.dim)} ${removed}${sep}` +
        `${colorize(summary.skip, COLORS.dim)} ${skipped}${sep}` +
        `${colorize(summary.total, COLORS.dim)} ${items.length || 0}${sep}` +
        `${colorize("Dur", COLORS.dim)} ${colorize(durationLabel, COLORS.green)} ` +
        `(${colorize(summary.path, COLORS.dim)}: ${repoRoot})`
      : `${colorize(doneLabel, COLORS.green)}: ` +
        `${colorize(summary.add, COLORS.dim)} ${restored}${sep}` +
        `${colorize(summary.del, COLORS.dim)} ${removed}${sep}` +
        `${colorize(summary.skip, COLORS.dim)} ${skipped}${sep}` +
        `${colorize(summary.total, COLORS.dim)} ${items.length || 0}${sep}` +
        `${colorize("Dur", COLORS.dim)} ${colorize(durationLabel, COLORS.green)} ` +
        `(${colorize(summary.path, COLORS.dim)}: ${repoRoot})`,
  );
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
