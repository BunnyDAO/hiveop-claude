# Plugin key: where it lives and what guards it (hcp-13)

## Decision: keep the user-only file

The key stays in `~/.hiveop/claude-plugin.json` (folder 700, file 600). Evidence:

- **The mod API has no write path to secure storage.** The only secure store in
  `types/claude-code/index.d.ts` is a `userConfig` field marked sensitive, filled
  by the person in `/config`. `$.config.set` changes such a field, but this
  plugin's manifest declares none, and a hook-written value would be a settings
  entry the user never typed. Nothing in `$` stores a secret by handle for the
  plugin to read back (`$.session.authorize` is for the Anthropic credential only).
- **The git helper could not use it anyway.** `bin/hiveop-git-credential` is run
  by git, a separate process, and cannot reach Claude Code's secure storage.
- **The macOS keychain is no safer here.** Any process running as the user can run
  `security find-generic-password -w` for an item the `security` tool created
  (or approve a prompt), exactly as it can read a 600 file. It would add a second
  copy and a platform split (none on Linux or Windows).

Not moved: neither option is clearly better, so the keychain is not used and the
guard has no keychain rule.

## Key guard

`hooks/keyguard.ts`, wired as an `on('tool.call')` hook, refuses with one line,
"HiveOp blocks reading its sign-in key.", when:

- a file tool (Read, Edit, Write, NotebookEdit, Grep, Glob, any tool with
  `file_path`, `path`, `notebook_path`, `glob` or `pattern`) names `~/.hiveop` or
  anything under it, or `claude-plugin.json` anywhere. `~`, `$HOME`, `${HOME}`,
  absolute paths, `//`, `/./`, `..` and globs like `.hive*` are resolved.
- Bash text touches `claude-plugin.json` or `~/.hiveop` (same spellings, quotes
  and backslashes stripped), runs `hiveop-git-credential`, or runs
  `git credential fill|approve|reject`.

Ordinary `git push` and `git pull` pass: git calls the helper itself, so the
helper never appears in the command text. A project's own `.hiveop/` folder
passes.

## Known gaps (best effort, not a wall)

A command can build the path at run time (`$(echo ...)`, variables, base64 of
the name), `cd ~ && cat .hiveop/*`, run a script file that reads the key, or use
a tool the guard does not see (an MCP server, a Bash call from a subagent that
does not pass this hook). The file is also readable by any process of the user.
The real limits on a leaked key are server-side: it is a limited Plugin key
(ADR-0019), revocable from HiveOp.
