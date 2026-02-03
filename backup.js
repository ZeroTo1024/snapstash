#!/usr/bin/env node
/* eslint-disable no-console */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { Worker } = require("node:worker_threads");

const { resolvePassword, DEFAULT_PW_ENV } = require("./crypto");
const { encodeEncryptedToText, encodePlainToText } = require("./backup-format");
const { getMessages, formatMessage } = require("./i18n");
const { createProgressRenderer } = require("./progress");
const {
  SUMMARY_LABEL_WIDTH,
  STATUS_LABEL_WIDTH,
  PATH_LABEL_WIDTH,
  FIELD_GAP,
} = require("./constants");
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
const DEFAULT_THREADS = Math.max(2, Math.min(4, os.cpus().length || 2));
const DEFAULT_BIGFILE_MB = 1;
const DEFAULT_FILECOUNT_THRESHOLD = 80;
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
      formatMessage(help.noConcurrency, vars),
      formatMessage(help.threads, vars),
      formatMessage(help.bigFileMB, vars),
      formatMessage(help.fileCountThreshold, vars),
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
    noConcurrency: false,
    threads: null,
    bigFileMB: null,
    fileCountThreshold: null,
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
    if (arg === "--no-concurrency") {
      out.noConcurrency = true;
      continue;
    }
    if (arg === "--threads") {
      out.threads = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--bigfile-mb") {
      out.bigFileMB = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--file-count-threshold") {
      out.fileCountThreshold = argv[i + 1];
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

function resolveConcurrencyConfig(config) {
  const concurrency = config && typeof config === "object" ? config.concurrency : null;
  return {
    enabled: concurrency?.enabled !== false,
    threads: Number.isFinite(concurrency?.threads) ? Number(concurrency.threads) : DEFAULT_THREADS,
    bigFileMB: Number.isFinite(concurrency?.bigFileMB) ? Number(concurrency.bigFileMB) : DEFAULT_BIGFILE_MB,
    fileCountThreshold: Number.isFinite(concurrency?.fileCountThreshold)
      ? Number(concurrency.fileCountThreshold)
      : DEFAULT_FILECOUNT_THRESHOLD,
  };
}

class WorkerPool {
  constructor(size, workerPath) {
    this.size = Math.max(1, size);
    this.workerPath = workerPath;
    this.workers = [];
    this.queue = [];
    this.idle = [];
    this.taskId = 0;
    this.pending = new Map();
    for (let i = 0; i < this.size; i += 1) {
      this.spawnWorker();
    }
  }

  spawnWorker() {
    const worker = new Worker(this.workerPath);
    worker.on("message", (msg) => {
      const task = this.pending.get(msg.id);
      if (task) {
        this.pending.delete(msg.id);
        task.resolve(msg);
      }
      this.idle.push(worker);
      this.runNext();
    });
    worker.on("error", (err) => {
      for (const [id, task] of this.pending.entries()) {
        task.reject(err);
        this.pending.delete(id);
      }
    });
    this.idle.push(worker);
    this.workers.push(worker);
  }

  runTask(payload) {
    return new Promise((resolve, reject) => {
      const id = ++this.taskId;
      this.queue.push({ id, payload, resolve, reject });
      this.runNext();
    });
  }

  runNext() {
    if (!this.idle.length || !this.queue.length) return;
    const worker = this.idle.shift();
    const task = this.queue.shift();
    this.pending.set(task.id, task);
    worker.postMessage({ id: task.id, ...task.payload });
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
async function collectFromGitIndex(repoRoot, excludeMatcher, onProgress, stats, concurrency) {
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

  const workerPath = path.join(__dirname, "workers", "compress-worker.js");
  let pool = null;
  const bigFileBytes = concurrency.bigFileMB * 1024 * 1024;
  const usePoolByCount = concurrency.enabled && filtered.length >= concurrency.fileCountThreshold;
  const getPool = () => {
    if (!pool) {
      pool = new WorkerPool(concurrency.threads, workerPath);
    }
    return pool;
  };

  const results = await Promise.all(filtered.map(async (item, idx) => {
    const startedAt = process.hrtime.bigint();
    const record = {
      k: item.kind,
      p: item.path,
    };
    if (item.oldPath) record.o = item.oldPath;

    if (item.kind === "D") {
      if (onProgress) {
        onProgress(item, idx + 1, filtered.length, 0, 0, 0, "processing");
      }
      const packed = packItem(record);
      if (onProgress) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        onProgress(item, idx + 1, filtered.length, 0, 0, durationMs, "done");
      }
      return packed;
    }

    const meta = getIndexEntryMeta(repoRoot, item.path);
    if (meta) {
      record.m = meta.mode;
    }

    if (record.m === "160000") {
      record.sm = 1;
      if (onProgress) {
        onProgress(item, idx + 1, filtered.length, 0, 0, 0, "processing");
      }
      const packed = packItem(record);
      if (onProgress) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        onProgress(item, idx + 1, filtered.length, 0, 0, durationMs, "done");
      }
      return packed;
    }

    const content = runGit(repoRoot, ["show", `:${item.path}`], { text: false });

    if (record.m === "120000") {
      record.t = content.toString("utf8");
      if (stats) {
        stats.rawBytes += content.length;
      }
      if (onProgress) {
        onProgress(item, idx + 1, filtered.length, content.length, 0, 0, "processing");
      }
      const packed = packItem(record);
      if (onProgress) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        onProgress(item, idx + 1, filtered.length, content.length, 0, durationMs, "done");
      }
      return packed;
    }

    if (onProgress) {
      onProgress(item, idx + 1, filtered.length, content.length, 0, 0, "processing");
    }
    let compressed;
    if (concurrency.enabled && (usePoolByCount || content.length >= bigFileBytes)) {
      const { buffer } = await getPool().runTask({ buffer: content });
      compressed = Buffer.from(buffer);
    } else {
      compressed = brotliCompress(content);
    }
    record.ce = "br";
    record.c = compressed.toString("base64");
    if (stats) {
      stats.rawBytes += content.length;
      stats.compressedBytes += compressed.length;
    }
    if (onProgress) {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      onProgress(item, idx + 1, filtered.length, content.length, compressed.length, durationMs, "done");
    }

    return packItem(record);
  }));

  if (pool) {
    await pool.close();
  }
  return results;
}

async function collectFromFs(rootAbs, outputAbs, excludeMatcher, onProgress, stats, concurrency) {
  const items = [];
  const outputResolved = outputAbs ? path.resolve(outputAbs) : null;
  let fileIndex = 0;
  let fileTotal = 0;
  const workerPath = path.join(__dirname, "workers", "compress-worker.js");
  const bigFileBytes = concurrency.bigFileMB * 1024 * 1024;
  let pool = null;
  let usePoolByCount = false;
  const getPool = () => {
    if (!pool) pool = new WorkerPool(concurrency.threads, workerPath);
    return pool;
  };

  async function walk(relDir) {
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
        await walk(relPath);
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
          onProgress({ kind: "A", path: relPath }, fileIndex, fileTotal, Buffer.byteLength(target, "utf8"), 0, 0, "processing");
        }
        items.push(packItem(record));
        if (onProgress) {
          const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          onProgress({ kind: "A", path: relPath }, fileIndex, fileTotal, Buffer.byteLength(target, "utf8"), 0, durationMs, "done");
        }
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
        let compressed;
        if (concurrency.enabled && (usePoolByCount || content.length >= bigFileBytes)) {
          const { buffer } = await getPool().runTask({ buffer: content });
          compressed = Buffer.from(buffer);
        } else {
          compressed = brotliCompress(content);
        }
        record.ce = "br";
        record.c = compressed.toString("base64");
        if (stats) {
          stats.rawBytes += content.length;
          stats.compressedBytes += compressed.length;
        }
        if (onProgress) {
          fileIndex += 1;
          onProgress({ kind: "A", path: relPath }, fileIndex, fileTotal, content.length, 0, 0, "processing");
        }
        if (onProgress) {
          const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          onProgress({ kind: "A", path: relPath }, fileIndex, fileTotal, content.length, compressed.length, durationMs, "done");
        }
        items.push(packItem(record));
      }
    }
  }

  if (onProgress || (concurrency.enabled && concurrency.fileCountThreshold > 0)) {
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
    usePoolByCount = concurrency.enabled && fileTotal >= concurrency.fileCountThreshold;
  }

  await walk("");
  if (pool) {
    await pool.close();
  }
  return items;
}

async function buildBackup({ mode, root, outputAbs, repoRoot, excludeMatcher, excludes, onProgress, stats, concurrency }) {
  if (mode === "fs") {
    const rootAbs = path.resolve(root || process.cwd());
    const files = await collectFromFs(rootAbs, outputAbs, excludeMatcher, stats ? onProgress : null, stats, concurrency);
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
  const files = await collectFromGitIndex(resolvedRepoRoot, excludeMatcher, stats ? onProgress : null, stats, concurrency);
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

async function runBackup(options) {
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
  const concurrency = resolveConcurrencyConfig(config);
  if (options.noConcurrency) {
    concurrency.enabled = false;
  }
  if (options.threads) concurrency.threads = Number(options.threads);
  if (options.bigFileMB) concurrency.bigFileMB = Number(options.bigFileMB);
  if (options.fileCountThreshold) concurrency.fileCountThreshold = Number(options.fileCountThreshold);
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

  const renderer = createProgressRenderer();
  let rendererStarted = false;
  const logProgress = options.progress
    ? (item, index, total, rawBytes, brBytes, durationMs, status) => {
        const progress = backupMessages.progress || {};
        const statusText = status || "done";
        const statusLabel = statusText.padEnd(STATUS_LABEL_WIDTH, " ");
        const statusColor = statusText === "processing" ? COLORS.dim : COLORS.cyan;
        const count = total ? ` [${index}/${total}]` : "";
        const countLabel = colorize(count, COLORS.dim);
        const rawLabel = formatSize(rawBytes || 0).padStart(10, " ");
        const brLabel = (brBytes ? formatSize(brBytes) : "0.00 KB").padStart(10, " ");
        const pathLabel = String(item.path || "").padEnd(PATH_LABEL_WIDTH, " ");
        const timeLabel = formatDuration(durationMs || 0).padStart(7, " ");
        const line = `${colorize(statusLabel, statusColor)}${countLabel} ${colorize(pathLabel, COLORS.bold)} ` +
          `${colorize(progress.size, COLORS.dim)}: ${rawLabel}${FIELD_GAP}${colorize(progress.br, COLORS.dim)}: ${brLabel}${FIELD_GAP}` +
          `${colorize(progress.time, COLORS.dim)}: ${colorize(timeLabel, COLORS.green)}`;
        if (renderer && total) {
          if (!rendererStarted) {
            renderer.start(total);
            rendererStarted = true;
          }
          renderer.update(index, line);
        } else {
          console.log(line);
        }
      }
    : null;
  const onProgress = logProgress
    ? (item, index, total, rawBytes, brBytes, durationMs, status) => {
        logProgress(item, index, total, rawBytes, brBytes, durationMs, status);
      }
    : null;

  const startAt = process.hrtime.bigint();
  const backup = await buildBackup({
    mode,
    root: options.root,
    outputAbs: mode === "fs" ? outputPath : null,
    repoRoot,
    excludeMatcher,
    excludes,
    onProgress,
    stats,
    concurrency,
  });

  const { kb, encoded } = writeBackupFile({
    outputPath,
    backup,
    password: encryptPassword,
  });
  const backupFileBytes = Number(kb) * 1024;

  const outputLabel = path.relative(process.cwd(), outputPath);
  const summary = backupMessages.summary || {};
  const summaryLabelWidth = SUMMARY_LABEL_WIDTH;
  const formatSummaryLine = (label, value, color) => {
    const text = padDisplay(label, summaryLabelWidth);
    return `${colorize(text, color || COLORS.magenta)}：${value}`;
  };
  if (rendererStarted && renderer) {
    renderer.stop();
  }
  console.log(formatSummaryLine(summary.file, outputLabel, COLORS.dim));
  if (stats.rawBytes > 0) {
    const rawKb = (stats.rawBytes / 1024).toFixed(2);
    const compKb = (stats.compressedBytes / 1024).toFixed(2);
    const ratio = ((stats.compressedBytes / stats.rawBytes) * 100).toFixed(2);
    const reduced = (100 - Number(ratio)).toFixed(2);
    const savedKb = ((stats.rawBytes - stats.compressedBytes) / 1024).toFixed(2);
    const savedLabel = `(${savedKb}kb ↓)`;
    const reducedLabel = `(${reduced}% ↓)`;
    console.log(
      `${colorize(padDisplay(summary.raw, summaryLabelWidth), COLORS.dim)}：${rawKb} KB，` +
        `${colorize(summary.compressed, COLORS.dim)}：${compKb} KB ` +
        `${colorize(savedLabel, COLORS.green)}， ` +
        `${colorize(summary.ratio, COLORS.dim)}：${ratio}% ` +
        `${colorize(reducedLabel, COLORS.green)}`,
    );
    console.log(formatSummaryLine(summary.encoding, DEFAULT_PAYLOAD_ENCODING, COLORS.dim));
    if (Number.isFinite(backupFileBytes) && stats.compressedBytes > 0) {
      const fileKb = (backupFileBytes / 1024).toFixed(2);
      const overheadBytes = Math.max(backupFileBytes - stats.compressedBytes, 0);
      const overheadKb = (overheadBytes / 1024).toFixed(2);
      const overheadRatio = ((overheadBytes / stats.compressedBytes) * 100).toFixed(2);
      console.log(
        `${colorize(padDisplay(summary.fileSize, summaryLabelWidth), COLORS.dim)}：${fileKb} KB，` +
          ` ${colorize(summary.overhead, COLORS.dim)}：${colorize(`${overheadKb}kb (${overheadRatio}%)`, COLORS.green)}`,
      );
    }
  }
  const durationLabel = formatDuration(Number(process.hrtime.bigint() - startAt) / 1e6);
  console.log(
    `${colorize(padDisplay(summary.success, summaryLabelWidth), COLORS.green)}：` +
      `${colorize("File: ", COLORS.dim)} ${outputLabel}（${backup.data.length} ${summary.entries}，${kb} KB）`,
    `${colorize("Dur: ", COLORS.dim)} ${colorize(durationLabel, COLORS.green)}`
  );
  // console.log(
  //   `${colorize("Time".padEnd(summaryLabelWidth, " "), COLORS.dim)}：${colorize(durationLabel, COLORS.green)}`,
  // );
  if (!options.noEncrypt && encryptPassword && (pwSource === "config" || pwSource === "arg")) {
    const label = summary.pwMasked || "Encryption key";
    const masked = maskSecret(password);
    const suffix = pwSource === "config"
      ? ` ${formatMessage(summary.pwFromConfig || "(from {path})", { path: configPath || "config.json" })}`
      : "";
    console.log(
      `${colorize(padDisplay(label, summaryLabelWidth), COLORS.yellow)}：` +
        `${colorize(masked, COLORS.bold)}${suffix}`,
    );
    console.log(
      `${colorize(padDisplay(summary.encAlg, summaryLabelWidth), COLORS.dim)}：` +
        `${colorize("AES-256-GCM", COLORS.green)}`,
    );
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
      Promise.resolve(runBackup(options)).catch((err) => {
        console.error(err?.message || err);
        process.exitCode = 1;
      });
    }
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 1;
  }
}
