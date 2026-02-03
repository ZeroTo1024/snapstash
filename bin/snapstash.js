#!/usr/bin/env node
/* eslint-disable no-console */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const { runBackup, DEFAULT_BACKUP_FILE: BACKUP_DEFAULT } = require("../backup");
const {
  runRestore,
  getBackupInfo,
  DEFAULT_BACKUP_FILE: RESTORE_DEFAULT,
} = require("../restore");
const { DEFAULT_PW_ENV } = require("../crypto");
const { loadConfig, resolveConfigLang } = require("../config");
const { getMessages, formatMessage, formatList } = require("../i18n");

function resolveHelpLang() {
  try {
    const gitRoot = tryGitRoot(process.cwd());
    const rootAbs = gitRoot || process.cwd();
    const { config } = loadConfig(rootAbs);
    return resolveConfigLang(config) || "en";
  } catch {
    return "en";
  }
}

function printHelp() {
  const messages = getMessages(resolveHelpLang());
  const snapMessages = messages.snapstash || {};
  const help = snapMessages.help || {};
  const vars = {
    defaultBackupFile: BACKUP_DEFAULT,
    defaultPwEnv: DEFAULT_PW_ENV,
  };
  console.log(
    [
      formatMessage(help.title, vars),
      "",
      formatMessage(help.usage, vars),
      formatMessage(help.cmdBackup, vars),
      formatMessage(help.cmdRestore, vars),
      formatMessage(help.cmdInfo, vars),
      formatMessage(help.cmdInit, vars),
      "",
      formatMessage(help.aliasTitle, vars),
      formatMessage(help.aliasBackup, vars),
      formatMessage(help.aliasRestore, vars),
      formatMessage(help.aliasInfo, vars),
      "",
      formatMessage(help.backupTitle, vars),
      ...formatList(help.backupOptions, vars),
      "",
      formatMessage(help.restoreTitle, vars),
      ...formatList(help.restoreOptions, vars),
      "",
      formatMessage(help.infoTitle, vars),
      ...formatList(help.infoOptions, vars),
      "",
      formatMessage(help.examplesTitle, vars),
      ...formatList(help.examples, vars),
      "",
      formatMessage(help.configTitle, vars),
      formatMessage(help.configDesc, vars),
    ].join("\n"),
  );
}

function parseBackupArgs(argv) {
  const out = {
    output: BACKUP_DEFAULT,
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
    if (arg === "--clipboard" || arg === "--c") {
      out.copy = true;
      continue;
    }
    if (arg === "--no-progress") {
      out.progress = false;
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
    configPath: null,
    help: false,
    progress: true,
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

function parseInfoArgs(argv) {
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
  if (["i", "info"].includes(value)) return "info";
  if (["init"].includes(value)) return "init";
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
  const entry = ".snapstash/";
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

function promptInput(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function runInit() {
  const gitRoot = tryGitRoot(process.cwd());
  const rootAbs = gitRoot || process.cwd();
  const { config } = loadConfig(rootAbs);
  const lang = resolveConfigLang(config) || "en";
  const messages = getMessages(lang);
  const snapMessages = messages.snapstash || {};
  const initMessages = snapMessages.init || {};
  const configDir = path.join(rootAbs, ".snapstash");
  const configPath = path.join(configDir, "config.json");

  if (fs.existsSync(configDir) && !fs.statSync(configDir).isDirectory()) {
    throw new Error(`${configDir} 已存在但不是目录，请手动处理`);
  }

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  if (!fs.existsSync(configPath)) {
    const selectedLang = await promptInput(initMessages.promptLang || "Select language (en/zh) [en]: ");
    const langValue = (selectedLang || "en").trim().toLowerCase();
    const normalizedLang = langValue === "zh" ? "zh" : "en";
    const passwordInput = await promptInput(initMessages.promptPassword || "Password (empty for none): ");
    const template = {
      version: 1,
      lang: normalizedLang,
      password: passwordInput || "",
      passwordEnv: DEFAULT_PW_ENV,
      concurrency: {
        enabled: true,
        threads: 4,
        bigFileMB: 1,
        fileCountThreshold: 80
      },
      excludes: [
        ".snapstash/",
        "node_modules/",
        ".next/",
        ".opennext/",
        "dist/",
        "build/",
        ".turbo/",
        ".cache/",
        "__pycache__/",
        ".venv/",
        "venv/",
        "*.pyc",
        "*.log",
      ],
    };
    fs.writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`);
    console.log(formatMessage(initMessages.created, { path: configPath }));
  } else {
    console.log(formatMessage(initMessages.exists, { path: configPath }));
  }

  if (gitRoot) {
    const added = ensureGitignore(rootAbs);
    if (added) {
      console.log(initMessages.gitignoreAdded);
    } else {
      console.log(initMessages.gitignoreExists);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const [cmdRaw, ...rest] = args;
  if (!cmdRaw) {
    const options = parseBackupArgs([]);
    return runBackup(options);
  }
  if (cmdRaw === "--help" || cmdRaw === "-h") {
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
    return runBackup(options);
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

  if (cmd === "info") {
    const options = parseInfoArgs(rest);
    if (options.help) {
      printHelp();
      return;
    }
    const info = getBackupInfo(options);
    const { config } = loadConfig(path.resolve(options.root || process.cwd()));
    const lang = resolveConfigLang(config) || "en";
    const messages = getMessages(lang);
    const snapMessages = messages.snapstash || {};
    const infoMessages = snapMessages.info || {};
    const labelWidth = require("../constants").INFO_LABEL_WIDTH;
    const displayWidth = (text) => {
      let width = 0;
      for (const ch of String(text ?? "")) {
        const code = ch.codePointAt(0);
        if (!code) continue;
        if (code <= 0x1f || (code >= 0x7f && code <= 0xa0)) continue;
        width += code <= 0x7f ? 1 : 2;
      }
      return width;
    };
    const padLabel = (value) => {
      const str = String(value ?? "");
      const width = displayWidth(str);
      if (width >= labelWidth) return str;
      return str + " ".repeat(labelWidth - width);
    };
    const dim = (text) => `\x1b[2m${text}\x1b[0m`;
    const label = (text) => dim(padLabel(text));
    console.log(
      [
        `${label(infoMessages.version)}: ${info.version ?? ""}`,
        `${label(infoMessages.createdAt)}: ${info.createdAt ?? ""}`,
        `${label(infoMessages.repoRoot)}: ${info.repoRoot ?? ""}`,
        `${label(infoMessages.head)}: ${info.head ?? ""}`,
        `${label(infoMessages.payloadEncoding)}: ${info.payloadEncoding ?? ""}`,
        `${label(infoMessages.encrypted)}: ${info.encrypted ? "true" : "false"}`,
        `${label(infoMessages.source)}: ${info.source?.mode ?? ""}${info.source?.root ? ` (${info.source.root})` : ""}`,
        `${label(infoMessages.items)}: ${info.items ?? 0}`,
      ].join("\n"),
    );
    return;
  }

  if (cmd === "init") {
    return runInit();
  }
}

try {
  Promise.resolve(main()).catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  });
} catch (err) {
  console.error(err?.message || err);
  process.exitCode = 1;
}
