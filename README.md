# snapstash

English | [简体中文](https://github.com/ZeroTo1024/snapstash/blob/main/README.zh-CN.md)

A tiny CLI to snapshot Git index (staged changes) or a directory into `.snapstash/.backup`, with optional AES-256-GCM encryption.

Snapstash is clipboard-friendly: the backup file is plain text, so you can copy/paste it into a new project and restore.

## Install

```
npm i -g snapstash
```

Or run without global install:

```
npx snapstash
```

## Quick Start

1) Initialize config (language + password + gitignore).
```
snapstash init
```

2) Backup current Git index (staged changes):
```
snapstash
```

3) Restore to current directory:
```
snapstash r
```

## Usage

```
# default: snapshot Git index (staged) -> .snapstash/.backup
snapstash

# encrypt with password (optional)
snapstash b --pw 123

# snapshot a directory instead of Git index
snapstash b --root ./my-folder

# restore to current directory (use --root to target another dir)
snapstash r

# print backup info
snapstash i --pw 123

# copy backup text to clipboard
snapstash b --clipboard

# create .snapstash template and add to .gitignore (if git repo)
snapstash init
```

## Commands & Options

### `snapstash` / `snapstash b` (backup)

```
snapstash b [options]
```

Options:

- `--output, -o <file>` output file (default `.snapstash/.backup`)
- `--pw <password>` encryption password (if empty, only compress)
- `--pw-env <ENV>` password env name (default `SNAPSTASH_PW`)
- `--clipboard, --c` copy backup text to clipboard
- `--no-progress` disable progress logs
- `--root, --dir <path>` backup a directory (filesystem mode)
- `--from <stash|fs>` source (default: `stash`)

### `snapstash r` (restore)

```
snapstash r [options]
```

Options:

- `--input, -i <file>` input file (default `.snapstash/.backup`)
- `--root, --dir <path>` restore directory (default cwd)
- `--pw <password>` decryption password
- `--pw-env <ENV>` password env name (default `SNAPSTASH_PW`)
- `--no-progress` disable progress logs

### `snapstash i` (info)

```
snapstash i [options]
```

Options:

- `--input, -i <file>` input file (default `.snapstash/.backup`)
- `--root, --dir <path>` backup root directory (default cwd)
- `--pw <password>` decryption password
- `--pw-env <ENV>` password env name (default `SNAPSTASH_PW`)

### `snapstash init` (config)

```
snapstash init
```

Interactive steps:

1) Choose language (en/zh)
2) Enter password (empty is allowed)

## Config (.snapstash/config.json)

You can place a `.snapstash/config.json` file in the project root:

```
{
  "version": 1,
  "lang": "en",
  "password": "",
  "passwordEnv": "SNAPSTASH_PW",
  "excludes": [".snapstash/", "node_modules/", "dist/", "*.log"]
}
```

- `password`/`passwordEnv` are used when `--pw` is not provided.
- `excludes` are matched against relative paths. `dir/` excludes the directory, `*.log` matches simple globs.
- `lang`/`language` supports `en` (default) or `zh` for help and logs.
  - Locale strings are stored in `i18n/en.json` and `i18n/zh.json`.

## Notes

- Default backup source is Git index (staged changes). Use `--root` or `--from fs` to snapshot a directory.
- Password can be provided with `--pw` or `SNAPSTASH_PW` env var. Without it, output is only compressed (base64 + brotli).
- Encryption uses AES-256-GCM with scrypt key derivation (fast, small overhead).
- Use `snapstash i` to print encrypted metadata (version, createdAt, repoRoot, head, payloadEncoding).
- `snapstash init` creates a `.snapstash` template and adds it to `.gitignore` when inside a Git repo.
- Use `--clipboard` (or `--c`) to copy backup text to clipboard.
- Backup/restore will print progress by default; use `--no-progress` to disable.
