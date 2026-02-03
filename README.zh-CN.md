# snapstash

[English](README.md) | 简体中文

一个轻量 CLI：将 Git index（已暂存变更）或目录快照为 `.snapstash/.backup`，可选 AES-256-GCM 加密。

支持复制粘贴：备份文件为纯文本，可复制到新项目后恢复。

## 安装

```
npm i -g snapstash
```

或者无需全局安装：

```
npx snapstash
```

## 快速开始

1) 初始化配置（语种 + 密码 + gitignore）：
```
snapstash init
```

2) 备份当前 Git index（已暂存变更）：
```
snapstash
```

3) 恢复到当前目录：
```
snapstash r
```

## 命令与参数

### `snapstash` / `snapstash b`（备份）

```
snapstash b [options]
```

参数：

- `--output, -o <file>` 输出文件（默认 `.snapstash/.backup`）
- `--pw <password>` 加密密码（为空则仅压缩）
- `--pw-env <ENV>` 密码环境变量名（默认 `SNAPSTASH_PW`）
- `--clipboard, --c` 复制到剪贴板
- `--no-progress` 关闭进度日志
- `--root, --dir <path>` 备份目录（文件系统模式）
- `--from <stash|fs>` 指定来源（默认 `stash`）

### `snapstash r`（恢复）

```
snapstash r [options]
```

参数：

- `--input, -i <file>` 输入文件（默认 `.snapstash/.backup`）
- `--root, --dir <path>` 恢复目录（默认当前目录）
- `--pw <password>` 解密密码
- `--pw-env <ENV>` 密码环境变量名（默认 `SNAPSTASH_PW`）
- `--no-progress` 关闭进度日志

### `snapstash i`（信息）

```
snapstash i [options]
```

参数：

- `--input, -i <file>` 输入文件（默认 `.snapstash/.backup`）
- `--root, --dir <path>` 备份所属目录（默认当前目录）
- `--pw <password>` 解密密码
- `--pw-env <ENV>` 密码环境变量名（默认 `SNAPSTASH_PW`）

### `snapstash init`（初始化）

```
snapstash init
```

交互步骤：

1) 选择语种（en/zh）
2) 输入密码（可为空）

## 配置（.snapstash/config.json）

在项目根目录放置 `.snapstash/config.json`：

```
{
  "version": 1,
  "lang": "en",
  "password": "",
  "passwordEnv": "SNAPSTASH_PW",
  "excludes": [".snapstash/", "node_modules/", "dist/", "*.log"]
}
```

- `password`/`passwordEnv` 会在未传 `--pw` 时生效
- `excludes` 为相对路径匹配，`dir/` 表示目录，`*.log` 为简单通配
- `lang`/`language` 支持 `en`（默认）或 `zh`，用于 help 与日志
  - 词条文件位于 `i18n/en.json` 和 `i18n/zh.json`

## 说明

- 默认备份来源为 Git index（已暂存变更）。使用 `--root` 或 `--from fs` 备份目录。
- 密码可通过 `--pw` 或环境变量 `SNAPSTASH_PW` 提供；未提供时只压缩（base64 + brotli）。
- 加密使用 AES-256-GCM + scrypt（开销小、速度快）。
- `snapstash i` 可查看加密备份的元信息（version、createdAt、repoRoot、head、payloadEncoding）。
- `snapstash init` 会创建 `.snapstash` 模板并在 Git 仓库中加入 `.gitignore`。
- `--clipboard`/`--c` 复制备份文本到剪贴板。
- 默认输出进度日志，可用 `--no-progress` 关闭。

## Link

- [Nano Banana 2](https://ricebowl.ai/m/nano-banana-2)
- [Sora 2](https://ricebowl.ai/m/sora/sora-2)
- [Grok Video](https://ricebowl.ai/m/grok-video)
- [Ricebowl AI](https://ricebowl.ai)
