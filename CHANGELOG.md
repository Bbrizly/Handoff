# Changelog

Notable changes to Handoff (`hn`). Newest first.

The 0.1.x series was never released. 0.2.0 is the first public release, so its
notes describe the whole product rather than a diff.

## 0.2.0

First public release.

### Setup

- One elevated PowerShell command pairs a native Windows worker. It installs and
  enables OpenSSH Server if needed and writes the controller key with the ACLs
  Windows requires. No WSL, and no second elevated step.
- `hn worker add` for any machine where key-based SSH already works. Targets are
  aliases, so `pc`, `home`, and `aws` all fit one mental model.
- Handoff installs its own pinned Mutagen v0.18.1, verified against the upstream
  `SHA256SUMS`, and keeps the executable beside its agent bundle. Homebrew is not
  required.

### The mapped terminal

- A target alias synchronizes the workspace, maps the current directory, and
  opens a real interactive SSH PTY in the matching remote directory.
- `hn pc claude` and `hn pc npm run dev` run one interactive command through the
  same mapped PTY without creating a hidden session.
- Windows command resolution prefers real application shims (`.exe`, `.cmd`,
  `.bat`) over PowerShell `.ps1` wrappers, so npm-installed tools stop failing on
  execution policy without weakening the machine's policy.
- Oversized PowerShell payloads stream over SSH stdin instead of hitting the
  command-line length limit.

### Synchronization

- Persistent Mutagen sessions per workspace root, `two-way-resolved`, with `.git`
  excluded through VCS ignore mode.
- A safety gate refuses to start remote work while a workspace has conflicts or
  an unhealthy sync, instead of running an agent against a broken tree.
- Live progress during flushes, duplicate-session repair, and multi-root
  workspaces where a root may be a single file.
- `hn port` forwards a remote port to localhost.

### Persistence

- `-p` opens a persistent desk: every synchronized project on that machine in one
  sidebar, with each agent showing blocked, working, done, or idle. Close the
  terminal and `hn pc -p` returns to the same panes and processes.
- The desk runs on Herdr v0.8.2, pinned and SHA-256 verified. Nothing installs
  until the first `-p`.
- A desk project is keyed by label first and token second, so reattaching finds
  the existing agent instead of starting a second one.
- Detaching is reported as detaching. A non-zero attach asks the desk whether it
  is still running before calling anything a failure.

### Portability

- `hn profile enable claude` shares the portable half of a local Claude setup with
  trusted targets: skill trees, subagents, commands, rules, hooks, output styles,
  and `~/.claude/CLAUDE.md`.
- Claude on a worker renders the controller's own statusline, from a Handoff-owned
  settings file that never touches the worker's `~/.claude/settings.json`. Branch
  and dirty-state segments degrade to the same dim placeholders the local script
  already uses, because `.git` stays on the controller.
- Managed files and projected links are verified once before launch and repaired
  if the worker drifted. The freshness cache is treated as a hint, not a fact.

### Security and privacy

- Credentials, `settings.json`, MCP auth, plugin state, history, sessions, and
  caches are never sent to a worker.
- Profile roots only reach targets explicitly marked trusted.
- `hn access` answers whether and where a given path is shared, or why it stays
  local.
- `hn doctor` reports MCP health from `claude mcp list` on the worker and parses
  only server names and connection status, never the command column, which can
  hold a key.

### Removed

- The legacy Zellij surface: `hn session`, `hn new`, `hn attach`, and
  `hn sessions`, plus `src/zellij.js`, `src/session.js`, the pinned Zellij worker
  bootstrap and its five checksummed release assets, `bootstrapWorker()`,
  `ensurePersistenceRuntime()`, and the `persistence` flag on `prepareTarget()`.
  Managed Zellij persistence was never proven on native Windows, and Herdr had
  already replaced it. See HN-076.

### Known limits

- Worker reboot recovery is untested.
- The managed Mutagen bootstrap is controller-platform-limited.
- A literal IPv6 target must be reached through an SSH hostname or alias.
- macOS filenames that NTFS cannot represent are surfaced, not silently mangled.
