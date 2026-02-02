# snapstash

A tiny CLI to snapshot Git index (staged changes) or a directory into `backup.json`, with optional AES-256-GCM encryption.

## Usage

```
# default: snapshot Git index (staged)
snapstash backup

# encrypt with password
snapstash backup --encrypt --pw 123

# snapshot a directory instead of Git index
snapstash backup --root ./my-folder

# restore to current directory (use --root to target another dir)
snapstash restore --pw 123

# create .snapstash template and add to .gitignore (if git repo)
snapstash init
```

## Commands

- `backup` (aliases: `b`, `save`)
- `restore` (aliases: `r`, `apply`)
- `init` (alias: `i`)

## Config (.snapstash)

You can place a `.snapstash` JSON file in the project root:

```
{
  "version": 1,
  "password": "",
  "passwordEnv": "SNAPSTASH_PW",
  "excludes": ["node_modules/", "dist/", "*.log"]
}
```

- `password`/`passwordEnv` are used when `--pw` is not provided.
- `excludes` are matched against relative paths. `dir/` excludes the directory, `*.log` matches simple globs.

## Notes

- Default backup source is Git index (staged changes). Use `--root` or `--from fs` to snapshot a directory.
- Password can be provided with `--pw` or `SNAPSTASH_PW` env var.
- Encryption uses AES-256-GCM with scrypt key derivation (fast, small overhead).
- `snapstash init` creates a `.snapstash` template and adds it to `.gitignore` when inside a Git repo.
