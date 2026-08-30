# `hn` CLI contract

This document defines the intended command surface and UX semantics for Handoff.

The daily CLI is intentionally small. `hn` should disappear after it coordinates synchronization, path mapping, and a real interactive SSH PTY.

## 1. Core commands

```bash
hn
hn status
hn pc
hn home
hn aws
hn use pc

hn claude
hn codex
hn shell
hn npm run dev
hn pc claude
hn exec npm test

hn port 5173
hn port 3000 3001

hn pc -p
hn -p

hn doctor

hn access
hn profile enable claude
```

## 2. `hn` / `hn status`

Default command:

```bash
hn
```

Equivalent to:

```bash
hn status
```

Current compact shape:

```text
target     pc ✓  windows/x64
workspace  main
project    Handoff
sync       ✓  GitHub
```

Desired status evolution:

- remain fast;
- show selected target and reachability;
- show current workspace/project;
- show each root's synchronization state;
- show exact problem/conflict paths when unhealthy or link to `hn conflicts`;
- do not perform expensive bootstrap merely to display status.

## 3. Target aliases

```bash
hn pc
hn home
hn aws
```

Semantics:

- ensure/flush synchronization for the workspace containing the local cwd;
- allocate a real interactive SSH PTY;
- map the local cwd to the corresponding worker path;
- enter the worker's native shell there.

Selection without connecting is explicit:

```bash
hn use pc
hn worker default pc
```

Direct interactive target command:

```bash
hn aws claude
```

This enters the mapped cwd and runs Claude directly with the PTY. It does not change the selected target or start a persistent desk.

Target aliases are arbitrary configured names. `pc`, `home`, and `aws` are ergonomic examples/hints, not special backend types.

### Persistent mode

```bash
hn pc -p
hn pc --p
hn pc --persist
hn pc -p claude
hn -p
```

Same target, same synchronization, same mapped project. The difference is that the work survives closing the terminal, and `hn pc -p` returns to it.

`--persist` is the clearest spelling, `-p` is the fastest, and `--p` is accepted. All three mean the same thing.

Handoff reads these flags only while they sit in front of the remote command:

```bash
hn pc npm run dev -- --persist   # --persist goes to npm
hn pc -p -- foo --persist        # one flag consumed, the rest is the command
```

Persistent mode is the only thing that installs a persistence runtime on a worker. A plain `hn pc` never does.

What you get is a desk, not a session name:

```text
PROJECTS / AGENTS
! Handoff
  ! claude   BLOCKED
* Palmier
  * codex    WORKING
o drawer
```

One desk per controller + workspace on that target. Each synchronized Git project is one entry in it. Click a project or an agent to switch; close the terminal whenever; `hn pc -p` comes back to the same panes and the same running processes.

Persistent mode is project-scoped, not directory-scoped. Running it from deep inside a project opens that project's desk, and an existing desk keeps the directory it already has. Plain `hn pc` still lands in the exact subdirectory you were in.

`hn pc -p claude` returns to the Claude already running in that project instead of starting a second one. Any other command runs in the project's focused pane.

## 4. Direct interactive commands

Any non-reserved command uses the selected target and runs directly with an interactive PTY:

```bash
hn claude
hn codex
hn npm run dev
hn python train.py
```

Pipeline:

```text
resolve local context
→ prepare worker
→ ensure/flush full workspace synchronization
→ refuse conflicts/unhealthy sync
→ map cwd to remote cwd
→ augment supported agent command
→ open SSH PTY
→ run command directly
```

The command lifetime is the SSH connection lifetime unless the user asks for persistence with `-p`.

## 6. `hn shell`

Opens the selected target's transparent remote shell in the current mapped project directory. This is equivalent to a target alias except that it uses the current selected target.

Worker shell choice today:

```text
Windows: PowerShell
POSIX:   sh
```

Future shell preference/configuration is possible but not required for core v1.

## 7. `hn exec`

```bash
hn exec npm test
hn exec node -e "console.log(process.platform, process.arch)"
```

One-shot remote execution.

It still passes through synchronization safety but does not allocate an interactive PTY.

This command is both a user feature and an important diagnostic primitive because it isolates remote execution from session-manager failures.

## 8. `hn sync`

From within a workspace:

```bash
hn sync
```

Explicit workspace:

```bash
hn sync main
```

Accepted semantics: synchronize all roots in the workspace to the active target.

This is **not** a project-only sync command.

### Progress

For a large initial transfer the user should see meaningful live feedback, approximately:

```text
main → pc
GitHub
████████████████░░░░░░░░ 67%
41,230 / 61,625 files
4.7 GB / 7.0 GB
build-1781560291334.tar.gz
```

Exact rendering can differ based on what Mutagen exposes.

For an already healthy small diff:

```text
✓ main synced
```

or similarly compact output.

### Failure

A conflict should be explicit:

```text
hn: sync blocked by 1 conflict
Quadstick-Config-Manager/.../obj/Release/.../QuadStickConfigManager.dll
```

A cross-platform path problem should also include the exact path and reason.

## 9. `hn port`

```bash
hn port 5173
```

Maps:

```text
worker 127.0.0.1:5173 → controller 127.0.0.1:5173
```

Optional local port:

```bash
hn port 3000 3001
```

Maps remote 3000 to local 3001.

Port forwarding is explicit in v1. Automatic server detection is deferred.

## 10. Worker management

### Pair a new Windows worker

```bash
hn worker pair pc Lenovo@100.68.238.25
```

Expected output:

- indicate whether an SSH key was reused/created;
- print exactly one Windows administrator PowerShell command;
- tell the user to return and run `hn worker finish pc`.

### Finish pairing

```bash
hn worker finish pc
```

Verifies SSH, detects platform/architecture, installs the persistent desk runtime, stores metadata.

### Add an already reachable worker

```bash
hn worker add home user@host
```

Requires key-based SSH to already work.

### Explicit bootstrap

```bash
hn worker bootstrap pc
```

Ensures Handoff-managed worker infrastructure is installed.

### Worker doctor

```bash
hn worker doctor pc
```

### List workers

```bash
hn worker list
```

The active target should be visually marked.

## 11. Workspace management

Create empty workspace:

```bash
hn workspace create main
```

Add root (workspace is auto-created if needed):

```bash
hn workspace add main ~/Documents/GitHub
```

Custom remote path:

```bash
hn workspace add main ~/Documents/GitHub hn/main/code
```

Add a single file:

```bash
hn workspace add main ~/notes.md hn/main/files/notes.md
```

A root is a directory or one regular file. A file root shares exactly that file. It never becomes a project or terminal directory, and only its remote parent directory is created on the worker.

List:

```bash
hn workspace list
```

Future required management:

```bash
hn workspace remove <workspace> <root>
hn workspace delete <workspace>
```

These commands must safely account for existing Mutagen sessions; they are not just config deletion operations.

## 12. Personal agent profile

```bash
hn profile enable claude
hn profile enable claude main
hn profile list
hn profile disable claude
```

`enable` adds the portable parts of the local Claude setup to the workspace: canonical skill trees, Claude skills, subagents, commands, rules, hooks, output styles, and `~/.claude/CLAUDE.md`. They map to the same paths under the worker's home, so remote Claude starts with the same portable abilities as local Claude. Cross-root skill links become safe worker-native links after synchronization; an existing destination is backed up first.

Controller credentials, `settings.json`, MCP auth, plugins, history, sessions, and caches are never included. A worker continues using its own copies.

On native Windows, plain `claude` and `codex` inside `hn pc` are shell-local wrappers around the real applications. They automatically receive the other shared workspace roots through `--add-dir`. Management commands are passed through untouched, and nothing is installed into the user's PowerShell profile.

Profile roots carry `scope: trusted`. A target marked `remote` never receives them, with or without a workspace grant.

`disable` terminates the matching sync sessions first, then removes the roots. Files already copied to a worker stay on that worker; `hn` says so instead of implying a remote wipe.

## 13. `hn access`

```bash
hn access
hn access ~/GitHub/app/.env
```

Answers whether one path reaches the worker:

```text
shared ✓    /Users/me/GitHub/app/src/index.js
remote      ~/hn/main/GitHub/app/src/index.js
workspace   main  directory
```

```text
local only  /Users/me/GitHub/app/.env
reason      environment secrets stay local
```

```text
not shared  /Users/me/Desktop/scratch.txt
```

Sharing rules the user cannot inspect are not trustworthy, so this command exists to make ignore policy and trust scope visible.

## 15. Doctor

```bash
hn doctor
hn doctor pc
```

Current checks:

```text
pc  windows/x64  trusted

core
  ✓ ssh
  ✓ workspace  main (9 roots)
  ✓ sync
  ✓ sync engine  controller
  ✓ persistence  Herdr 0.8.2

ai
  ✓ claude
  ✓ claude auth  plausibility check
  ✓ codex
  ✓ node
  ✓ profile  7 roots synchronized
  ✓ statusline  Handoff launches only

optional
  ✓ chrome  installed
  — chrome extension  worker-local; verify with claude --chrome
  ✓ mcp  claude mcp list: 2/2 connected
```

A worker that has never been used with `-p` reports `— persistence` instead. An optional capability nobody asked for is not a failure.

Each line says exactly what it proved:

- `profile` says **synchronized**. Whether a skill or agent file is valid is the agent runtime's own check, not Handoff's. See HN-075;
- `statusline` says **Handoff launches only**, because the worker's own `~/.claude/settings.json` is untouched;
- `mcp` reports what `claude mcp list` said. Only names and connection status are read; the command column can hold an API key and is never printed. Without Claude on the worker, or when the command fails or times out, the line says that instead of guessing. See HN-074.

Future useful checks:

- native persistent-session create/reattach test;
- workspace Windows-path compatibility preflight;
- scan/transition problems;
- Handoff-managed binary checksum/version;
- remote disk space;
- optional workload-specific checks.

## 16. Future conflict UX

Desired:

```bash
hn conflicts
```

Example:

```text
main → pc

CONFLICT
Quadstick-Config-Manager/src/QuadStick.App/obj/Release/net8.0/QuadStickConfigManager.dll
local:  changed
remote: changed
hint: generated output under obj/; add/fix ignore policy

PATH ERROR
Adptiv/adaptiv-business/pitch/Adaptiv's Playbook: 100+ Near-Guaranteed Wins to Build Unstoppable Momentum.pdf
remote Windows cannot create ':' in a filename
```

Explicit resolution:

```bash
hn resolve <path> --local
hn resolve <path> --remote
```

Naming of `--local`/`--remote` is preferred over Mutagen's `alpha`/`beta` user-facing terminology.

## 17. Output principles

1. **Conclusion first.** Tell the user what is happening.
2. **Progress for slow work.** Never look hung when data is moving.
3. **Quiet when healthy.** Do not dump full Mutagen session metadata before every command once the sync is idle.
4. **Exact path on file problems.** Counts alone are insufficient.
5. **Underlying error preserved.** Include useful stderr/stdout from SSH/Mutagen/Herdr.
6. **No infrastructure jargon unless needed.** Prefer `local`/`remote`, workspace/target/project over `alpha`/`beta`.
7. **Safe action hints.** Error messages should provide the next command when Handoff can identify it.

## 18. Reserved commands

Current reserved top-level command family includes:

```text
help
status
doctor
worker
workspace
sync
port
exec
shell
use
profile
access
```

A target alias cannot use a reserved command name.

## 19. CLI invariants

- Product stays Handoff; binary stays `hn`.
- `hn` with no args stays useful and cheap.
- target aliases open a synchronized mapped interactive PTY.
- target selection without connecting is explicit through `hn use` or `hn worker default`.
- ordinary commands run directly and interactively; persistence is explicit.
- `hn exec` remains explicitly one-shot.
- `-p` is the optional managed persistence surface.
- `-p`, `--p`, and `--persist` are the same flag, and Handoff reads them only before the remote command begins.
- ordinary commands never install a persistence runtime.
- `hn sync` means the whole configured workspace, not only the current project.
- conflicts stop execution.
- personal profile sharing is opt-in, trusted-target only, and reversible.
- the user can always ask what is shared with `hn access`.
- daily use should not expose manual SSH/cd/tunnel/multiplexer ceremony.
