#!/usr/bin/env node
/* eslint-disable no-console */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { resolvePassword, DEFAULT_PW_ENV } = require("./crypto");
const { encodeEncryptedToText, encodePlainToText } = require("./backup-format");
const { getMessages, formatMessage } = require("./i18n");
const {
  buildExcludeMatcher,
  loadConfig,
  normalizeExcludes,
  resolveConfigPassword,
  resolveConfigPwEnv,
  resolveConfigLang,
  loadConfigAt,
  DEFAULT_CONFIG_DIR,
  DEFAULT_BACKUP_NAME,
  getDefaultBackupPath,
} = require("./config");

const DEFAULT_BACKUP_FILE = `${DEFAULT_CONFIG_DIR}/${DEFAULT_BACKUP_NAME}`;
const DEFAULT_PAYLOAD_ENCODING = "br";
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const COLOR_ENABLED = process.stdout.isTTY;

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
};

function colorize(text, color) {
  if (!COLOR_ENABLED) return text;
  return `${color}${text}${COLORS.reset}`;
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
  const help = messages.backup?.help || {};
  console.log(
    [
      formatMessage(help.usage, vars),
      "",
      formatMessage(help.options, vars),
      formatMessage(help.output, vars),
      formatMessage(help.encrypt, vars),
      formatMessage(help.noEncrypt, vars),
      formatMessage(help.pw, vars),
      formatMessage(help.pwEnv, vars),
      formatMessage(help.config, vars),
      formatMessage(help.clipboard, vars),
      formatMessage(help.noProgress, vars),
      formatMessage(help.root, vars),
      formatMessage(help.from, vars),
      formatMessage(help.help, vars),
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const out = {
    output: DEFAULT_BACKUP_FILE,
    pretty: false,
    encrypt: false,
    pw: null,
    pwProvided: false,
    pwEnv: null,
    noEncrypt: false,
    configPath: null,
    root: null,
    from: null,
    help: false,
    copy: false,
    progress: true,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") {
      out.output = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--pretty") {
      out.pretty = true;
      continue;
    }
    if (arg === "--compact") {
      out.pretty = false;
      continue;
    }
    if (arg === "--encrypt") {
      out.encrypt = true;
      continue;
    }
    if (arg === "--no-encrypt" || arg === "--plain") {
      out.noEncrypt = true;
      continue;
    }
    if (arg === "--pw") {
      out.pwProvided = true;
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        out.pw = next;
        i += 1;
      }
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
    if (arg === "--root" || arg === "--dir") {
      out.root = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--from") {
      out.from = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--clipboard" || arg === "--c") {
      out.copy = true;
      continue;
    }
    if (arg === "--no-progress") {
      out.progress = false;
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }

  return out;
}

function runGit(cwd, args, { text = true } = {}) {
  const res = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: text ? "utf8" : null,
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (res.status !== 0) {
    const stderr = text ? res.stderr : res.stderr?.toString("utf8");
    const msg = (stderr || "").trim() || `git ${args.join(" ")} 失败`;
    const err = new Error(msg);
    err.code = res.status;
    throw err;
  }
  return res.stdout;
}

function tryGitText(cwd, args) {
  const res = spawnSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

function parseNameStatusZ(buffer) {
  const tokens = buffer
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

  const items = [];
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i];
    if (token.includes("\t")) {
      const [status, firstPath] = token.split("\t");
      const kind = status[0];
      if ((kind === "R" || kind === "C") && i + 1 < tokens.length) {
        const secondPath = tokens[i + 1];
        items.push({
          status,
          kind,
          oldPath: firstPath,
          path: secondPath,
        });
        i += 2;
      } else {
        items.push({
          status,
          kind,
          path: firstPath,
        });
        i += 1;
      }
      continue;
    }

    const status = token;
    const kind = status[0];
    if (kind !== "R" && kind !== "C") {
      const filePath = tokens[i + 1];
      if (!filePath) {
        throw new Error("解析 git name-status(-z) 失败：缺少路径");
      }
      items.push({ status, kind, path: filePath });
      i += 2;
      continue;
    }

    if (kind === "R" || kind === "C") {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (!oldPath || !newPath) {
        throw new Error("解析 git name-status(-z) 失败：rename/copy 缺少路径");
      }
      items.push({ status, kind, oldPath, path: newPath });
      i += 3;
      continue;
    }

    throw new Error(`解析 git name-status(-z) 失败：未知 token: ${status}`);
  }
  return items;
}

function getIndexEntryMeta(cwd, filePath) {
  const out = tryGitText(cwd, ["ls-files", "-s", "--", filePath]);
  if (!out) return null;
  const [left] = out.split("\t");
  const parts = left.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [mode, blob] = parts;
  return { mode, blob };
}

function brotliCompress(buffer) {
  return zlib.brotliCompressSync(buffer);
}

function ensureParentDir(fileAbsPath) {
  fs.mkdirSync(path.dirname(fileAbsPath), { recursive: true });
}

function packItem(record) {
  const payload = Buffer.from(JSON.stringify(record), "utf8");
  const packed = brotliCompress(payload);
  return packed.toString("base64");
}

function normalizeMode(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (["stash", "index", "staged"].includes(v)) return "stash";
  if (["fs", "dir", "directory", "filesystem"].includes(v)) return "fs";
  throw new Error(`未知模式: ${value}`);
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "0.00 KB";
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function maskSecret(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length === 1) return `${text}***${text}`;
  return `${text[0]}***${text[text.length - 1]}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "0ms";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function collectFromGitIndex(repoRoot, excludeMatcher, onProgress, stats) {
  const nameStatusRaw = runGit(repoRoot, ["diff", "--cached", "--name-status", "-z"], {
    text: false,
  });
  const staged = parseNameStatusZ(nameStatusRaw);

  const filtered = excludeMatcher
    ? staged.filter((item) => {
        if (excludeMatcher(item.path)) return false;
        if (item.oldPath && excludeMatcher(item.oldPath)) return false;
        return true;
      })
    : staged;

  return filtered.map((item, idx) => {
    const startedAt = process.hrtime.bigint();
    const record = {
      k: item.kind,
      p: item.path,
    };
    if (item.oldPath) record.o = item.oldPath;

    if (item.kind === "D") {
      if (onProgress) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        onProgress(item, idx + 1, filtered.length, 0, 0, durationMs);
      }
      return packItem(record);
    }

    const meta = getIndexEntryMeta(repoRoot, item.path);
    if (meta) {
      record.m = meta.mode;
    }

    if (record.m === "160000") {
      record.sm = 1;
      if (onProgress) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        onProgress(item, idx + 1, filtered.length, 0, 0, durationMs);
      }
      return packItem(record);
    }

    const content = runGit(repoRoot, ["show", `:${item.path}`], { text: false });

    if (record.m === "120000") {
      record.t = content.toString("utf8");
      if (stats) {
        stats.rawBytes += content.length;
      }
      if (onProgress) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        onProgress(item, idx + 1, filtered.length, content.length, 0, durationMs);
      }
      return packItem(record);
    }

    const compressed = brotliCompress(content);
    record.ce = "br";
    record.c = compressed.toString("base64");
    if (stats) {
      stats.rawBytes += content.length;
      stats.compressedBytes += compressed.length;
    }
    if (onProgress) {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      onProgress(item, idx + 1, filtered.length, content.length, compressed.length, durationMs);
    }

    return packItem(record);
  });
}

function collectFromFs(rootAbs, outputAbs, excludeMatcher, onProgress, stats) {
  const items = [];
  const outputResolved = outputAbs ? path.resolve(outputAbs) : null;
  let fileIndex = 0;
  let fileTotal = 0;

  function walk(relDir) {
    const absDir = relDir ? path.join(rootAbs, relDir) : rootAbs;
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const absPath = path.join(absDir, entry.name);
      if (outputResolved && path.resolve(absPath) === outputResolved) continue;
      const relPath = relDir ? path.posix.join(relDir, entry.name) : entry.name;
      if (excludeMatcher && excludeMatcher(relPath)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(relPath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const startedAt = process.hrtime.bigint();
        const target = fs.readlinkSync(absPath, "utf8");
        const record = {
          k: "A",
          p: relPath,
          m: "120000",
          t: target,
        };
        if (stats) {
          stats.rawBytes += Buffer.byteLength(target, "utf8");
        }
        if (onProgress) {
          fileIndex += 1;
          const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          onProgress({ kind: "A", path: relPath }, fileIndex, fileTotal, Buffer.byteLength(target, "utf8"), 0, durationMs);
        }
        items.push(packItem(record));
        continue;
      }

      if (entry.isFile()) {
        const startedAt = process.hrtime.bigint();
        const stat = fs.statSync(absPath);
        const content = fs.readFileSync(absPath);
        const record = {
          k: "A",
          p: relPath,
          m: stat.mode.toString(8),
        };
        const compressed = brotliCompress(content);
        record.ce = "br";
        record.c = compressed.toString("base64");
        if (stats) {
          stats.rawBytes += content.length;
          stats.compressedBytes += compressed.length;
        }
        if (onProgress) {
          fileIndex += 1;
          const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          onProgress({ kind: "A", path: relPath }, fileIndex, fileTotal, content.length, compressed.length, durationMs);
        }
        items.push(packItem(record));
      }
    }
  }

  if (onProgress) {
    const countFiles = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        const absPath = path.join(dir, entry.name);
        const relPath = path.relative(rootAbs, absPath).split(path.sep).join("/");
        if (excludeMatcher && excludeMatcher(relPath)) continue;
        if (outputResolved && path.resolve(absPath) === outputResolved) continue;
        if (entry.isDirectory()) {
          count += countFiles(absPath);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          count += 1;
        }
      }
      return count;
    };
    fileTotal = countFiles(rootAbs);
  }

  walk("");
  return items;
}

function buildBackup({ mode, root, outputAbs, repoRoot, excludeMatcher, excludes, onProgress, stats }) {
  if (mode === "fs") {
    const rootAbs = path.resolve(root || process.cwd());
    const files = collectFromFs(rootAbs, outputAbs, excludeMatcher, onProgress, stats);
    return {
      version: 2,
      createdAt: new Date().toISOString(),
      repoRoot: rootAbs,
      head: null,
      payloadEncoding: DEFAULT_PAYLOAD_ENCODING,
      source: {
        mode: "fs",
        root: rootAbs,
        excludes: excludes && excludes.length ? excludes : undefined,
      },
      data: files,
    };
  }

  const gitCwd = root ? path.resolve(root) : process.cwd();
  const resolvedRepoRoot = repoRoot || runGit(gitCwd, ["rev-parse", "--show-toplevel"]).trim();
  const files = collectFromGitIndex(resolvedRepoRoot, excludeMatcher, onProgress, stats);
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    repoRoot: resolvedRepoRoot,
    head: tryGitText(resolvedRepoRoot, ["rev-parse", "--verify", "HEAD"]),
    payloadEncoding: DEFAULT_PAYLOAD_ENCODING,
    source: {
      mode: "stash",
      root: resolvedRepoRoot,
      excludes: excludes && excludes.length ? excludes : undefined,
    },
    data: files,
  };
}

function writeBackupFile({ outputPath, backup, password }) {
  const encoded = password
    ? encodeEncryptedToText(backup, password)
    : encodePlainToText(backup);
  ensureParentDir(outputPath);
  fs.writeFileSync(outputPath, `${encoded}\n`);
  const bytes = fs.statSync(outputPath).size;
  const kb = (bytes / 1024).toFixed(2);
  return { bytes, kb, encoded };
}

function tryCopyToClipboard(text) {
  if (!text) return false;
  const platform = process.platform;
  const candidates = [];
  if (platform === "darwin") {
    candidates.push(["pbcopy", []]);
  } else if (platform === "win32") {
    candidates.push(["clip", []]);
  } else {
    candidates.push(["wl-copy", []]);
    candidates.push(["xclip", ["-selection", "clipboard"]]);
  }

  for (const [cmd, args] of candidates) {
    const res = spawnSync(cmd, args, { input: text, encoding: "utf8" });
    if (res.status === 0) return true;
  }
  return false;
}

function runBackup(options) {
  const mode = normalizeMode(options.from) || (options.root ? "fs" : "stash");
  let repoRoot = null;
  let rootForConfig = null;
  const stats = { rawBytes: 0, compressedBytes: 0 };

  if (mode === "stash") {
    const gitCwd = options.root ? path.resolve(options.root) : process.cwd();
    repoRoot = runGit(gitCwd, ["rev-parse", "--show-toplevel"]).trim();
    rootForConfig = repoRoot;
  } else {
    rootForConfig = path.resolve(options.root || process.cwd());
  }

  const defaultOutput = getDefaultBackupPath(rootForConfig);
  if (!options.output) {
    const configDir = path.dirname(defaultOutput);
    if (fs.existsSync(configDir) && !fs.statSync(configDir).isDirectory()) {
      throw new Error(`${configDir} 已存在但不是目录，请手动处理`);
    }
    fs.mkdirSync(configDir, { recursive: true });
  }

  const outputPath = options.output
    ? path.resolve(process.cwd(), options.output)
    : defaultOutput;

  const configEntry = options.configPath
    ? loadConfigAt(path.resolve(process.cwd(), options.configPath))
    : loadConfig(rootForConfig);
  const { config, path: configPath } = configEntry;
  const excludes = normalizeExcludes(config?.excludes);
  const excludeMatcher = buildExcludeMatcher(excludes);
  const pwEnv = options.pwEnv || resolveConfigPwEnv(config) || DEFAULT_PW_ENV;
  const configPassword = resolveConfigPassword(config);
  const lang = resolveConfigLang(config) || "en";
  const messages = getMessages(lang);
  const backupMessages = messages.backup || {};

  const password = resolvePassword(options.pw || configPassword, pwEnv);
  const encryptPassword = options.noEncrypt ? null : password;
  let pwSource = null;
  if (options.pw) {
    pwSource = "arg";
  } else if (configPassword) {
    pwSource = "config";
  } else if (pwEnv && process.env[pwEnv]) {
    pwSource = "env";
  }

  const onProgress = options.progress
    ? (item, index, total, rawBytes, brBytes, durationMs) => {
        const progress = backupMessages.progress || {};
        const labelText = item.kind === "D" ? progress.delete : progress.backup;
        const label = item.kind === "D"
          ? colorize(labelText, COLORS.yellow)
          : colorize(labelText, COLORS.cyan);
        const count = total ? ` [${index}/${total}]` : "";
        const countLabel = colorize(count, COLORS.dim);
        const rawLabel = formatSize(rawBytes || 0).padStart(10, " ");
        const brLabel = (brBytes ? formatSize(brBytes) : "0.00 KB").padStart(10, " ");
        const pathLabel = String(item.path || "").padEnd(64, " ");
        const timeLabel = formatDuration(durationMs || 0).padStart(7, " ");
        console.log(
          `${label}${countLabel} ${colorize(pathLabel, COLORS.bold)} ` +
            `${colorize(progress.size, COLORS.dim)}: ${rawLabel}   ${colorize(progress.br, COLORS.dim)}: ${brLabel}   ` +
            `${colorize(progress.time, COLORS.dim)}: ${colorize(timeLabel, COLORS.green)}`,
        );
      }
    : null;

  const startAt = process.hrtime.bigint();
  const backup = buildBackup({
    mode,
    root: options.root,
    outputAbs: mode === "fs" ? outputPath : null,
    repoRoot,
    excludeMatcher,
    excludes,
    onProgress,
    stats,
  });

  const { kb, encoded } = writeBackupFile({
    outputPath,
    backup,
    password: encryptPassword,
  });
  const backupFileBytes = Number(kb) * 1024;

  const outputLabel = path.relative(process.cwd(), outputPath);
  const summary = backupMessages.summary || {};
  console.log(`${colorize(summary.file, COLORS.magenta)}：${outputLabel}`);
  if (stats.rawBytes > 0) {
    const rawKb = (stats.rawBytes / 1024).toFixed(2);
    const compKb = (stats.compressedBytes / 1024).toFixed(2);
    const ratio = ((stats.compressedBytes / stats.rawBytes) * 100).toFixed(2);
    const reduced = (100 - Number(ratio)).toFixed(2);
    const savedKb = ((stats.rawBytes - stats.compressedBytes) / 1024).toFixed(2);
    const savedLabel = `[${savedKb}kb ↓]`;
    const reducedLabel = `[${reduced}% ↓]`;
    console.log(
      `${colorize(summary.raw, COLORS.dim)}：${rawKb} KB，` +
        `${colorize(summary.compressed, COLORS.dim)}：${compKb} KB ` +
        `${colorize(savedLabel, COLORS.green)}，` +
        `${colorize(summary.ratio, COLORS.dim)}：${ratio}% ` +
        `${colorize(reducedLabel, COLORS.green)}`,
    );
    if (Number.isFinite(backupFileBytes) && stats.compressedBytes > 0) {
      const fileKb = (backupFileBytes / 1024).toFixed(2);
      const overheadBytes = Math.max(backupFileBytes - stats.compressedBytes, 0);
      const overheadKb = (overheadBytes / 1024).toFixed(2);
      const overheadRatio = ((overheadBytes / stats.compressedBytes) * 100).toFixed(2);
      console.log(
        `${colorize(summary.fileSize, COLORS.dim)}：${fileKb} KB，` +
          `${colorize(summary.overhead, COLORS.dim)}：${colorize(`${overheadKb}kb (${overheadRatio}%)`, COLORS.green)}`,
      );
    }
  }
  const durationLabel = formatDuration(Number(process.hrtime.bigint() - startAt) / 1e6);
  console.log(
    `${colorize(summary.success, COLORS.green)}：${outputLabel}（${backup.data.length} ${summary.entries}，${kb} KB）`,
    `${colorize("Time", COLORS.dim)}: ${colorize(durationLabel, COLORS.green)}`
  );
  if (!options.noEncrypt && encryptPassword && (pwSource === "config" || pwSource === "arg")) {
    const label = summary.pwMasked || "Encryption key";
    const masked = maskSecret(password);
    const suffix = pwSource === "config"
      ? ` ${formatMessage(summary.pwFromConfig || "(from {path})", { path: configPath || "config.json" })}`
      : "";
    console.log(`${colorize(label, COLORS.yellow)}: ${colorize(masked, COLORS.bold)}${suffix}`);
  }

  if (options.copy) {
    const copied = tryCopyToClipboard(encoded);
    if (copied) {
      console.log(colorize(backupMessages.clipboard, COLORS.green));
    }
  }
}

module.exports = {
  DEFAULT_BACKUP_FILE,
  runBackup,
};

if (require.main === module) {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      printHelp();
    } else {
      runBackup(options);
    }
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 1;
  }
}
