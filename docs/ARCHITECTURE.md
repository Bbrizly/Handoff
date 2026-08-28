# Handoff architecture

This document describes the accepted architecture and the current implementation shape. See `DECISIONS.md` for why each major choice was made.

## 1. System overview

```text
CONTROLLER                                      WORKER
(local daily machine)                           (compute machine)

Editor / IDE                                    Claude / Codex
Local files                                     Node / Python / compilers
Canonical .git                                  Docker / CUDA / local AI
Browser                                          dev servers
      │                                              │
      │ local paths                                  │ remote paths
      ▼                                              ▼
     hn ─────────────── SSH control ───────────────► worker
      │                                              │
      ├──── Mutagen two-way-resolved sync ─────────┤
      │                                              │
      └────── Mutagen TCP forwarding ◄──────────────┘
```

The core interactive path is a real SSH PTY into the mapped remote directory. Zellij is an optional layer behind `SessionBackend`, not a prerequisite for entering or using the worker.

Handoff is deliberately a coordinator. It does not replace the editor, Git, network overlay, shell, sync engine, or session multiplexer.

## 2. Controller responsibilities

The controller owns:

- `hn` CLI and configuration;
- active target selection;
- local workspace roots;
- canonical source checkout and `.git`;
- Mutagen binary/daemon/session control;
- SSH command/control transport;
- interactive PTY handoff into mapped remote directories;
- mapping local paths to remote workspace paths;
- command augmentation for supported coding agents;
- local endpoints for forwarded remote ports.

Current configuration path:

```text
~/.hn/config.json
```

Legacy configuration:

```text
~/.handoff/config.json
```

is migrated to config version 4.

Config is written with restrictive file permissions where supported.

## 3. Worker responsibilities

A worker provides:

- SSH access;
- platform-native shell/command environment;
- Handoff-managed Zellij binary;
- project/workspace mirror under the remote user's home;
- the actual workload tools the user wants to run.

Handoff does not require a worker-side Handoff daemon.

Typical remote paths:

```text
~/hn/main/GitHub
~/hn/main/Obsidian
~/hn/main/Downloads
```

On Windows these are interpreted relative to `$HOME` and materialized with Windows path semantics.

## 4. Configuration model

Canonical config shape:

```json
{
  "version": 4,
  "activeTarget": "pc",
  "workers": {
    "pc": {
      "target": "Lenovo@100.68.238.25",
      "host": "100.68.238.25",
      "user": "Lenovo",
      "port": 22,
      "platform": "windows",
      "arch": "x64"
    }
  },
  "workspaces": {
    "main": {
      "roots": [
        {
          "local": "/Users/example/Documents/GitHub",
          "remote": "hn/main/GitHub",
          "kind": "directory"
        },
        {
          "local": "/Users/example/.claude/skills",
          "remote": ".claude/skills",
          "kind": "directory",
          "purpose": "claude-profile",
          "policy": "agent-profile",
          "scope": "trusted"
        }
      ]
    }
  }
}
```

A root records:

- `kind`: `directory` or `file`. A file root synchronizes exactly one file, creates only its remote parent directory, and never becomes a project or terminal cwd.
- `scope`: absent for normal roots, `trusted` for roots that must never reach a target marked `remote`.
- `policy`: absent for normal roots, `agent-profile` for roots that use the agent-profile ignore set.
- `purpose`: what created the root, so `hn profile` can list and remove its own roots.

Older configs migrate on read. A root with no `kind` becomes a directory.

### 4.1 Active target is global

The active target is a global local selection, not stored per workspace. This keeps switching simple:

```bash
hn pc
hn home
hn aws
```

### 4.2 One endpoint, one alias

Two target aliases may not point to the same `(user, host, port)` endpoint. Re-adding the same alias/end-point is safe; silently repointing an existing alias to a different live machine is rejected.

### 4.3 Workspace roots cannot overlap

Handoff rejects local or remote root overlap across configured workspaces. Overlapping independent Mutagen sessions would create ambiguous ownership and unsafe concurrent synchronization.

## 5. Context resolution

For commands run from a local directory, Handoff resolves:

```text
current working directory
      ↓
workspace root containing it
      ↓
project root/context
      ↓
relative path inside workspace root
      ↓
remote working directory
```

Example:

```text
Local workspace root:
/Users/me/Documents/GitHub

Local cwd:
/Users/me/Documents/GitHub/Handoff

Remote root:
hn/main/GitHub

Remote cwd:
hn/main/GitHub/Handoff
```

The project determines command/session identity. The workspace remains the full synchronized/access boundary.

## 6. Synchronization architecture

### 6.1 Engine

Handoff uses Mutagen v0.18.1.

The controller manages a pinned official Mutagen release and keeps the binary plus `mutagen-agents.tar.gz` together under:

```text
~/.hn/bin/mutagen-v0.18.1/
```

The release archive is verified against Mutagen's official SHA256SUMS before use.

Homebrew is not part of the required setup.

### 6.2 Session granularity

There is one synchronization session per:

```text
workspace + target + SSH endpoint + local root + remote root
```

Session names are deterministic hashes, for example:

```text
hn-sync-b631d292
```

Handoff repairs accidental duplicate named Mutagen sessions by preserving the oldest session and terminating duplicates.

### 6.3 Mode

Accepted mode:

```text
two-way-resolved
```

Git metadata is excluded with:

```text
--ignore-vcs
```

This means local and remote working-tree changes propagate both ways. Remote-only changes return to the controller; only a simultaneous collision on the same path resolves in favor of the controller/alpha endpoint.

### 6.4 Initial seed vs normal operation

The first synchronization of a large workspace may copy many files/gigabytes. That is expected once for each workspace-root/target tuple.

After the baseline exists, Mutagen's persistent session watches/reconciles changes. Opening another remote terminal does not intentionally resend the entire workspace.

A restart/reconnect may trigger scanning/reconciliation; scanning is not equivalent to retransferring every byte.

### 6.5 Current ignore set

Current code ignores generated/cache roots at any workspace depth, including:

```text
node_modules/
dist/
build/
bin/
obj/
.next/
.nuxt/
.output/
.turbo/
target/
.gradle/
DerivedData/
.venv/
venv/
.tox/
.pytest_cache/
.mypy_cache/
.ruff_cache/
__pycache__/
*.pyc
.DS_Store
.env
.env.*
```

Roots with `policy: agent-profile` use a smaller set. Dependencies, caches, and secrets are still excluded, but built output such as `dist/` and `bin/` synchronizes, because a compiled skill or hook is the thing being shared rather than a rebuildable artifact of a project.

Project `.claude` content is not ignored wholesale. Generated `.claude/worktrees/`, non-portable absolute symlinks, and exact Windows-incompatible paths are handled narrowly.

### 6.6 Safety gate before remote work

Before an interactive terminal or remote command starts, Handoff:

1. creates remote workspace directories;
2. ensures/resumes Mutagen sessions for all workspace roots;
3. flushes the sessions;
4. waits for synchronization work;
5. checks status;
6. refuses remote work if conflicts or materially unhealthy states exist.

Conflict refusal is a core invariant.

### 6.7 Progress UX

Explicit `hn sync` can invoke Mutagen's monitor output while the flush runs. Routine `hn pc`, direct commands, and `hn exec` flush quietly when healthy rather than dumping raw session metadata.

Idle healthy sync should become quiet; meaningful initial/large sync should be richly observable.

## 7. Git architecture

```text
CONTROLLER                          WORKER

.git         canonical             no .git
worktree   ◄──────── sync ───────► worktree
```

The worker is intentionally not a second Git clone.

Benefits:

- no branch divergence between machines;
- no push/pull just to move in-progress changes;
- editor Git integration remains local;
- remote agent edits appear as normal uncommitted local changes;
- secrets/history stored in `.git` do not need synchronization.

Tradeoff:

Remote agents cannot directly use normal Git repository introspection unless Handoff provides a future Git bridge. Current Codex exec handling uses `--skip-git-repo-check` when needed.

## 8. Agent integration architecture

Handoff treats Claude and Codex as special only where necessary to preserve the workspace model.

### 8.1 Additional workspace roots

The command starts in the project's mapped remote cwd, but other workspace roots are supplied to supported agents.

Claude:

```text
--add-dir <root> <root> ...
```

Codex:

```text
--add-dir <root> --add-dir <root> ...
```

Profile roots are excluded from `--add-dir`. They live at the worker's home paths where the agent already loads them.

### 8.2 Management commands

Agent management commands such as auth/update/mcp/plugin commands are not augmented with workspace directories, because doing so can corrupt their CLI semantics.

### 8.3 Gitless Codex

For `codex exec`, Handoff adds:

```text
--skip-git-repo-check
```

unless already present.

## 9. SSH architecture

SSH is the control plane.

Default connection behavior includes:

```text
BatchMode=yes
ConnectTimeout=5
ConnectionAttempts=1
StrictHostKeyChecking=accept-new
ServerAliveInterval=5
ServerAliveCountMax=3
```

Supported address forms include:

```text
user@host
user@host:port
user@[ipv6]:port
```

Literal IPv6 is accepted by Handoff's SSH parser, but Mutagen's SCP-like endpoint syntax cannot directly encode the same literal IPv6 target. For sync, use an SSH hostname/alias or MagicDNS-style name.

## 10. Windows command transport

Windows uses PowerShell as Handoff's orchestration shell.

### 10.1 Encoded commands

Normal PowerShell payloads use UTF-16LE `-EncodedCommand` to avoid quoting corruption.

### 10.2 Oversized commands

Live testing exposed Windows/OpenSSH command-line limits. Large PowerShell scripts therefore need a transport that does not place the entire payload into argv. Current 0.1.x work added a fallback that streams oversized scripts over SSH stdin using PowerShell's stdin command mode.

### 10.3 Application shim resolution

For workload commands Handoff checks `Get-Command -CommandType Application` first. This prefers `.exe`, `.cmd`, and `.bat` shims over a `.ps1` wrapper that may be blocked by local execution policy.

This is especially relevant for npm-installed tools such as Claude, Codex, and npm-related commands.

## 11. Windows pairing architecture

`hn worker pair` is designed to reduce Windows setup to one elevated action.

The generated PowerShell bootstrap:

- installs Windows OpenSSH Server if absent;
- configures `sshd` to start automatically;
- starts `sshd`;
- writes the controller public key to the administrators authorized-keys path;
- applies ACLs required by Windows OpenSSH;
- restarts SSH as needed.

`hn worker finish` then:

- verifies key-based SSH;
- detects platform and architecture;
- removes pending-pair state;
- saves worker metadata.

Pairing does not install the persistence runtime. That happens the first time the user runs `-p`, `hn session`, or the explicit `hn worker bootstrap`.

Current limitation: the bootstrap assumes the paired Windows account is an administrator.

## 12. Interactive transport and optional sessions

### 12.1 Core interactive PTY

Target aliases are executable destinations:

```text
local cwd
  -> resolve workspace root
  -> flush synchronization
  -> map relative cwd to remote root
  -> SSH with a real PTY
  -> native worker shell or direct command
```

On Windows, Handoff starts profile-aware PowerShell with `-NoExit` for the shell form. It does not weaken execution policy. If PowerShell would choose a blocked `.ps1` wrapper for a supported interactive agent while an application shim exists, the shell receives a process-scoped alias to that application shim.

On POSIX, Handoff enters the user's login shell. Direct forms such as `hn pc claude` execute the command with the same PTY and mapped cwd but do not create a session.

### 12.1a The managed Claude experience on a worker

When Handoff starts Claude it passes `--settings ~/.hn/claude-settings.json`. The worker's own `~/.claude/settings.json` is never written, so a worker the user also drives directly keeps its own configuration.

Handoff owns exactly three things for this:

```text
~/.hn/claude-statusline.cjs    the statusline renderer
~/.hn/claude-settings.json     points Claude's statusLine at it, absolute path, no redirect
~/.claude/... junctions        the projected profile links
```

The renderer reproduces the controller's own statusline segment for segment. The two Git segments degrade, because `.git` stays on the controller. See HN-070.

Freshness is cached per worker (`handoffStatuslineVersion`, `claudeProfileProjection`) so a normal launch does no install work. The cache is a hint, not an assertion about the worker: one guard script runs before the launch and reports on stdout when a managed file or a projected link is gone, and Handoff repairs once and continues. On Windows the signal must be stdout, because `ssh -tt` returns 0 whatever the remote program exits with. See HN-072.

### 12.2 Why Zellij remains available

The persistent desk (`hn <target> -p`) runs on Herdr, pinned at v0.8.2 and Apache-2.0. Everything Handoff knows about Herdr lives in `src/herdr.js`; nothing outside that module builds a Herdr command line.

```text
Handoff target + workspace     ->  one Herdr session (the desk)
one synchronized Git project   ->  one Herdr workspace inside it
```

The desk is named `hn-<controller-id-short>-<workspace>`, so two controllers sharing a worker never attach to each other's desk. The controller id is generated once and stored in `~/.hn/config.json` (version 5).

Herdr runs under a Handoff-owned config at `~/.hn/herdr/config.toml`, selected with `HERDR_CONFIG_PATH`. The user's own `~/.config/herdr/config.toml` is never touched. Handoff turns off onboarding and update checks, sorts the sidebar by attention, and drops the branch/git rows because the synchronized tree has no `.git`.

Attaching does not use Herdr's own `--remote` client, which does not support Windows remote hosts. Handoff already owns SSH, so it runs a Herdr client on the worker through its own PTY.

Ending an attachment is not a failure. A non-zero attach asks the desk directly (`herdr status server`); a running server means the user detached, and a silent one means a real fault. See HN-071.

One probe covers the whole `-p` preflight: whether the desk is up, whether the Herdr binary is still installed, and whether Handoff's managed Claude files and profile links are still on the worker. It is the round trip the launch had to make anyway. Measured on the reference Lenovo: 265 to 305 ms for the probe, 910 to 930 ms for everything before the TUI appears.

Zellij remains only behind the legacy `hn session`, `hn new`, and `hn attach` commands. It is history, not the persistence Handoff offers; managed Zellij on native Windows was never proven. tmux and mandatory WSL remain rejected. Core Handoff does not depend on either backend.

The dependency is enforced by the bootstrap split rather than by convention. `prepareWorkerCore()` proves SSH and detects the platform; the persistence runtime installs only when a persistent command asks for it. `hn doctor` reports a missing runtime as `— persistence`, not a failure.

Pinned version:

```text
0.45.0
```

Handoff downloads official release artifacts, verifies pinned SHA256 hashes, and copies the binary to:

```text
Windows: $HOME\.hn\bin\zellij.exe
POSIX:   $HOME/.hn/bin/zellij
```

### 12.3 Session identity

A stable persistent command session is keyed from:

```text
workspace
+ target
+ project local path
+ command arguments
+ workspace-root mapping salt
+ optional unique token
```

This gives:

```bash
hn session claude
```

one stable project/target session, while:

```bash
hn session new claude
```

creates another.

### 12.4 Pane lifecycle

The intended lifecycle is:

1. inspect existing named Zellij session;
2. if the expected command pane is healthy, reuse it;
3. if stale/wrong, recreate the session;
4. replace the initial shell pane with the desired command in the mapped cwd;
5. attach interactively over SSH TTY.

### 12.5 Native Windows persistence boundary

Real native-Windows testing proved a narrow optional-backend issue. WMI successfully creates a detached Session 0 process that survives the originating SSH connection, but an attached Zellij anchor in that environment receives closed/non-interactive input. Its default `cmd.exe` pane exits, Zellij prints `Bye from Zellij!`, and the anchor exits cleanly roughly 260 ms after startup. A later connection therefore finds no active session.

This disproved the earlier broad hypothesis that Windows OpenSSH simply kills every detached descendant. The remaining work is a supported headless Zellij layout/session-host strategy, isolated behind `SessionBackend`.

This optional path is **not yet considered fully proven** until a real Windows test demonstrates:

```text
hn session claude
→ Claude opens
→ local terminal closes
→ hn session claude
→ same live session reattaches
```

See `KNOWN_ISSUES.md`.

## 13. Port forwarding architecture

Handoff uses Mutagen forwarding rather than constructing custom SSH tunnel lifecycle management.

Explicit command:

```bash
hn port <remote-port> [local-port]
```

The forwarding is loopback-to-loopback by default:

```text
controller 127.0.0.1:<local>
            │
         Mutagen
            │
worker     127.0.0.1:<remote>
```

This is safer and more predictable than exposing services on a public worker interface.

## 14. Network architecture

Handoff assumes reachability; it does not create it.

Supported network paths include:

- Tailscale;
- LAN;
- conventional VPN;
- public/private SSH endpoints;
- provider networking.

Tailscale is a strong default for personal machines but is not a product dependency.

## 15. Target invocation and selection

Target aliases mean "take me there":

```bash
hn pc
```

This synchronizes the workspace and opens the mapped interactive PTY. Selection without connecting is explicit and local-only:

```bash
hn use pc
hn worker default pc
```

## 16. Managed dependency strategy

### Mutagen

- version: 0.18.1;
- controller-managed;
- official GitHub release;
- official SHA256SUMS verified;
- executable and agent bundle kept together.

### Zellij

- version: 0.45.0;
- worker-managed by Handoff;
- official platform-specific binaries;
- pinned SHA256 per artifact.

This reduces setup drift and makes Handoff's infrastructure behavior reproducible.

## 17. Security boundaries

### SSH

SSH keys and host verification are the primary machine trust mechanism.

### Sync

Only explicitly configured workspace roots synchronize.

### Git

`.git` remains local through VCS ignore mode.

### Ports

Forwarding defaults to loopback endpoints.

### AI configuration

Project-local files inside a workspace may sync. User-global AI auth/cache/config trees should not be copied wholesale by Handoff.

`hn profile enable claude` is the one exception, and it is an allowlist: canonical skill trees, Claude skills, subagents, commands, rules, hooks, output styles, and `~/.claude/CLAUDE.md`. Credentials, settings, MCP auth, plugins, history, sessions, and caches are never included, and these roots only reach trusted targets.

Profile roots use their own sync policy. Skill build output such as `dist/` and `bin/` remains available, while dependency trees, caches, and secrets remain excluded. Portable symlinks within a root synchronize normally. Links that cross profile-root boundaries are projected after synchronization; on Windows they become junctions, and any replaced worker path is moved under `~/.hn/backups` first.

For a transparent Windows shell, Handoff wraps the native Claude and Codex applications only for the lifetime of that PowerShell process. The wrappers supply every non-profile workspace root through the agents' supported `--add-dir` flags. They do not replace either executable, write a PowerShell profile, or alter the worker globally.

`hn access <path>` reports whether a path is shared, where it lands, or why it stays local.

## 18. Architecture invariants

The following should be treated as hard invariants unless an explicit ADR supersedes them:

1. The local machine remains the developer's primary environment.
2. Workers are addressed through ordinary SSH.
3. A workspace is not bound to one worker.
4. `.git` is controller-only.
5. Workspace synchronization is bidirectional and safe-by-default.
6. Project context determines mapped command location and optional session identity but not a narrower implicit sync boundary.
7. Native Windows is supported without WSL.
8. The core mapped interactive terminal must not depend on Zellij or another session manager.
9. Handoff does not require its own hosted backend.
10. Network overlay/provider concerns remain separable from core execution.
11. Personal agent capability files reach trusted targets only, by explicit allowlist, and never carry credentials or caches.
