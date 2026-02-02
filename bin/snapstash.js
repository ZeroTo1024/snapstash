#!/usr/bin/env node
/* eslint-disable no-console */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { runBackup, DEFAULT_BACKUP_FILE: BACKUP_DEFAULT } = require("../backup");
const { runRestore, DEFAULT_BACKUP_FILE: RESTORE_DEFAULT } = require("../restore");
const { DEFAULT_PW_ENV } = require("../crypto");

function printHelp() {
  console.log(
    [
      "snapstash - snapshot git index or directory to JSON (optional encryption)",
      "",
      "用法:",
      "  snapstash backup [options]",
      "  snapstash restore [options]",
      "  snapstash init",
      "",
      "命令别名:",
      "  backup: b, save",
      "  restore: r, apply",
      "  init: i",
      "",
      "backup 选项:",
      `  --output, -o <file>   输出文件 (默认 ${BACKUP_DEFAULT})`,
      "  --pretty              JSON 美化 (仅未加密时)",
      "  --compact             JSON 紧凑",
      "  --encrypt             启用加密 (AES-256-GCM)",
      "  --pw <password>        加密密码",
      `  --pw-env <ENV>         密码环境变量名 (默认 ${DEFAULT_PW_ENV})`,
      "  --root, --dir <path>   备份目录 (使用文件系统模式)",
      "  --from <stash|fs>      指定来源 (默认：stash)",
      "",
      "restore 选项:",
      `  --input, -i <file>    输入文件 (默认 ${RESTORE_DEFAULT})`,
      "  --root, --dir <path>   恢复目录 (默认当前目录)",
      "  --pw <password>        解密密码",
      `  --pw-env <ENV>         密码环境变量名 (默认 ${DEFAULT_PW_ENV})`,
      "",
      "示例:",
      "  snapstash b",
      "  snapstash b --encrypt --pw 123",
      "  snapstash b --root ./my-folder",
      "  snapstash r --pw 123",
      "  snapstash init",
      "",
      "配置文件:",
      "  支持在项目根目录放置 .snapstash (JSON)，可配置 password/passwordEnv 与 excludes。",
    ].join("\n"),
  );
}

function parseBackupArgs(argv) {
  const out = {
    output: BACKUP_DEFAULT,
    pretty: false,
    encrypt: false,
    pw: null,
    pwEnv: null,
    root: null,
    from: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
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

function parseRestoreArgs(argv) {
  const out = {
    input: RESTORE_DEFAULT,
    root: null,
    pw: null,
    pwEnv: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
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

function normalizeCommand(cmd) {
  if (!cmd) return null;
  const value = cmd.toLowerCase();
  if (["backup", "b", "save"].includes(value)) return "backup";
  if (["restore", "r", "apply"].includes(value)) return "restore";
  if (["init", "i"].includes(value)) return "init";
  return null;
}

function tryGitRoot(cwd) {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  return (res.stdout || "").trim() || null;
}

function ensureGitignore(rootAbs) {
  const gitignorePath = path.join(rootAbs, ".gitignore");
  const entry = ".snapstash";
  let content = "";

  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf8");
    const hasEntry = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .includes(entry);
    if (hasEntry) return false;
    const needsNewline = content.length > 0 && !content.endsWith("\n");
    fs.appendFileSync(gitignorePath, `${needsNewline ? "\n" : ""}${entry}\n`);
    return true;
  }

  fs.writeFileSync(gitignorePath, `${entry}\n`);
  return true;
}

function runInit() {
  const gitRoot = tryGitRoot(process.cwd());
  const rootAbs = gitRoot || process.cwd();
  const configPath = path.join(rootAbs, ".snapstash");

  if (!fs.existsSync(configPath)) {
    const template = {
      version: 1,
      password: "",
      passwordEnv: DEFAULT_PW_ENV,
      excludes: [
        "node_modules/",
        "dist/",
        "*.log",
      ],
    };
    fs.writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`);
    console.log(`已创建：${configPath}`);
  } else {
    console.log(`已存在：${configPath}`);
  }

  if (gitRoot) {
    const added = ensureGitignore(rootAbs);
    if (added) {
      console.log("已写入 .gitignore: .snapstash");
    } else {
      console.log(".gitignore 已包含 .snapstash");
    }
  }
}

function main() {
  const [cmdRaw, ...rest] = process.argv.slice(2);
  if (!cmdRaw || cmdRaw === "--help" || cmdRaw === "-h") {
    printHelp();
    return;
  }

  const cmd = normalizeCommand(cmdRaw);
  if (!cmd) {
    printHelp();
    throw new Error(`未知命令: ${cmdRaw}`);
  }

  if (cmd === "backup") {
    const options = parseBackupArgs(rest);
    if (options.help) {
      printHelp();
      return;
    }
    runBackup(options);
    return;
  }

  if (cmd === "restore") {
    const options = parseRestoreArgs(rest);
    if (options.help) {
      printHelp();
      return;
    }
    runRestore(options);
    return;
  }

  if (cmd === "init") {
    runInit();
    return;
  }
}

try {
  main();
} catch (err) {
  console.error(err?.message || err);
  process.exitCode = 1;
}
