#!/usr/bin/env node
/* eslint-disable no-console */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { encryptBuffer, resolvePassword, DEFAULT_PW_ENV } = require("./crypto");
const {
  buildExcludeMatcher,
  loadConfig,
  normalizeExcludes,
  resolveConfigPassword,
  resolveConfigPwEnv,
} = require("./config");

const DEFAULT_BACKUP_FILE = "backup.json";
const DEFAULT_PAYLOAD_ENCODING = "br";
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

function printHelp() {
  console.log(
    [
      "用法：node backup.js [options]",
      "",
      "选项：",
      `  --output, -o <file>   输出文件 (默认 ${DEFAULT_BACKUP_FILE})`,
      "  --pretty              JSON 美化 (仅未加密时)",
      "  --compact             JSON 紧凑",
      "  --encrypt             启用加密 (AES-256-GCM)",
      "  --pw <password>       加密密码",
      `  --pw-env <ENV>         密码环境变量名 (默认 ${DEFAULT_PW_ENV})`,
      "  --root, --dir <path>  备份目录 (使用文件系统模式)",
      "  --from <stash|fs>     指定来源 (默认：stash)",
      "  --help, -h            显示帮助",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const out = {
    output: DEFAULT_BACKUP_FILE,
    pretty: false,
    encrypt: false,
    pw: null,
    pwEnv: null,
    root: null,
    from: null,
    help: false,
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

function collectFromGitIndex(repoRoot, excludeMatcher) {
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

  return filtered.map((item) => {
    const record = {
      k: item.kind,
      p: item.path,
    };
    if (item.oldPath) record.o = item.oldPath;

    if (item.kind === "D") return packItem(record);

    const meta = getIndexEntryMeta(repoRoot, item.path);
    if (meta) {
      record.m = meta.mode;
    }

    if (record.m === "160000") {
      record.sm = 1;
      return packItem(record);
    }

    const content = runGit(repoRoot, ["show", `:${item.path}`], { text: false });

    if (record.m === "120000") {
      record.t = content.toString("utf8");
      return packItem(record);
    }

    const compressed = brotliCompress(content);
    record.ce = "br";
    record.c = compressed.toString("base64");

    return packItem(record);
  });
}

function collectFromFs(rootAbs, outputAbs, excludeMatcher) {
  const items = [];
  const outputResolved = outputAbs ? path.resolve(outputAbs) : null;

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
        const target = fs.readlinkSync(absPath, "utf8");
        const record = {
          k: "A",
          p: relPath,
          m: "120000",
          t: target,
        };
        items.push(packItem(record));
        continue;
      }

      if (entry.isFile()) {
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
        items.push(packItem(record));
      }
    }
  }

  walk("");
  return items;
}

function buildBackup({ mode, root, outputAbs, repoRoot, excludeMatcher, excludes }) {
  if (mode === "fs") {
    const rootAbs = path.resolve(root || process.cwd());
    const files = collectFromFs(rootAbs, outputAbs, excludeMatcher);
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
  const files = collectFromGitIndex(resolvedRepoRoot, excludeMatcher);
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

function writeBackupFile({ outputPath, backup, pretty, encrypt, password }) {
  let json;
  if (encrypt) {
    const payload = Buffer.from(JSON.stringify(backup), "utf8");
    const encrypted = encryptBuffer(payload, password);
    const wrapper = {
      version: 3,
      encrypted: true,
      payloadEncoding: "utf8",
      enc: encrypted.enc,
      payload: encrypted.payload,
    };
    json = JSON.stringify(wrapper);
  } else {
    json = JSON.stringify(backup, null, pretty ? 2 : undefined);
  }

  fs.writeFileSync(outputPath, `${json}\n`);
  const bytes = fs.statSync(outputPath).size;
  const kb = (bytes / 1024).toFixed(2);
  return { bytes, kb };
}

function runBackup(options) {
  const outputPath = path.resolve(process.cwd(), options.output || DEFAULT_BACKUP_FILE);
  const mode = normalizeMode(options.from) || (options.root ? "fs" : "stash");
  let repoRoot = null;
  let rootForConfig = null;

  if (mode === "stash") {
    const gitCwd = options.root ? path.resolve(options.root) : process.cwd();
    repoRoot = runGit(gitCwd, ["rev-parse", "--show-toplevel"]).trim();
    rootForConfig = repoRoot;
  } else {
    rootForConfig = path.resolve(options.root || process.cwd());
  }

  const { config } = loadConfig(rootForConfig);
  const excludes = normalizeExcludes(config?.excludes);
  const excludeMatcher = buildExcludeMatcher(excludes);
  const pwEnv = options.pwEnv || resolveConfigPwEnv(config) || DEFAULT_PW_ENV;
  const configPassword = resolveConfigPassword(config);

  let password = null;
  if (options.encrypt) {
    password = resolvePassword(options.pw || configPassword, pwEnv);
    if (!password) {
      throw new Error(`缺少密码：请使用 --pw 或设置 ${pwEnv}`);
    }
  }

  const backup = buildBackup({
    mode,
    root: options.root,
    outputAbs: mode === "fs" ? outputPath : null,
    repoRoot,
    excludeMatcher,
    excludes,
  });

  const { kb } = writeBackupFile({
    outputPath,
    backup,
    pretty: options.pretty,
    encrypt: options.encrypt,
    password,
  });

  console.log(
    `执行成功：${path.relative(process.cwd(), outputPath)}（${backup.data.length} 个条目，${kb} KB）`,
  );
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
