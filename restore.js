#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { decryptBuffer, resolvePassword, DEFAULT_PW_ENV } = require("./crypto");
const {
  loadConfig,
  resolveConfigPassword,
  resolveConfigPwEnv,
} = require("./config");

const DEFAULT_BACKUP_FILE = "backup.json";

function printHelp() {
  console.log(
    [
      "用法：node restore.js [options]",
      "",
      "选项：",
      `  --input, -i <file>    输入文件 (默认 ${DEFAULT_BACKUP_FILE})`,
      "  --root, --dir <path>   恢复目录 (默认当前目录)",
      "  --pw <password>        解密密码",
      `  --pw-env <ENV>         密码环境变量名 (默认 ${DEFAULT_PW_ENV})`,
      "  --help, -h             显示帮助",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const out = {
    input: DEFAULT_BACKUP_FILE,
    root: null,
    pw: null,
    pwEnv: null,
    help: false,
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

function loadBackup(inputPath, options) {
  const raw = fs.readFileSync(inputPath, "utf8");
  let backup = JSON.parse(raw);

  if (backup && (backup.encrypted || backup.version === 3)) {
    const rootForConfig = path.resolve(options.root || process.cwd());
    const { config } = loadConfig(rootForConfig);
    const configPassword = resolveConfigPassword(config);
    const pwEnv = options.pwEnv || resolveConfigPwEnv(config) || DEFAULT_PW_ENV;
    const password = resolvePassword(options.pw || configPassword, pwEnv);
    if (!password) {
      throw new Error(`该备份已加密：请使用 --pw 或设置 ${pwEnv}`);
    }
    if (!backup.payload || !backup.enc) {
      throw new Error("加密备份格式不正确");
    }
    let decrypted;
    try {
      decrypted = decryptBuffer(backup.payload, backup.enc, password);
    } catch (err) {
      throw new Error("解密失败：密码错误或文件损坏");
    }
    const payloadEncoding = backup.payloadEncoding || "utf8";
    const json = payloadEncoding === "utf8"
      ? decrypted.toString("utf8")
      : decrypted.toString("utf8");
    backup = JSON.parse(json);
  }

  if (!backup || !Array.isArray(backup.data)) {
    throw new Error(`${DEFAULT_BACKUP_FILE} 格式不正确（缺少 data 数组）`);
  }

  if (backup.version !== 1 && backup.version !== 2) {
    throw new Error(`${DEFAULT_BACKUP_FILE} 版本不支持：${backup.version}`);
  }

  return backup;
}

function runRestore(options) {
  const inputPath = path.resolve(process.cwd(), options.input || DEFAULT_BACKUP_FILE);
  const backup = loadBackup(inputPath, options);
  const repoRoot = path.resolve(options.root || process.cwd());

  let restored = 0;
  let removed = 0;
  let skipped = 0;

  const items = backup.version === 2
    ? backup.data.map((value) => decodePayload(value, backup.payloadEncoding || "br"))
    : backup.data;

  for (const item of items) {
    const relPath = assertSafeRepoRelativePath(item.p ?? item.path);
    const absPath = path.resolve(repoRoot, relPath);

    const kind = item.k ?? item.kind;
    if (kind === "D") {
      removeIfExists(absPath);
      removed += 1;
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
      writeSymlink(absPath, target);
      restored += 1;
      continue;
    }

    const contentBase64 = item.c ?? item.contentBase64;
    if (typeof contentBase64 !== "string") {
      throw new Error(`缺少内容：${relPath}`);
    }

    const content = item.c ? decodeContent(item) : Buffer.from(contentBase64, "base64");
    ensureParentDir(absPath);
    fs.writeFileSync(absPath, content);
    tryChmod(absPath, mode);
    restored += 1;
  }

  console.log(
    `执行成功：add ${restored}，del ${removed}，skip ${skipped}， total ${items.length || 0}（path：${repoRoot}）`,
  );
}

module.exports = {
  DEFAULT_BACKUP_FILE,
  runRestore,
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
