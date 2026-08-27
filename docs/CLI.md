# `hn` CLI contract

This document defines the intended command surface and UX semantics for Handoff.

The daily CLI is intentionally small. `hn` should feel like a local command even when it coordinates synchronization, SSH, persistent sessions, and forwarding underneath.

## 1. Core commands

```bash
hn
hn status
hn pc
hn home
hn aws

hn claude
hn codex
hn shell
hn npm run dev
hn new claude
hn exec npm test

hn port 5173
hn port 3000 3001

hn sessions
hn attach <session>
hn doctor
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

- update `activeTarget` locally;
- do not SSH/bootstrap/sync just to select it;
- output can be minimal, e.g. `pc`.

Combined target selection + command:

```bash
hn aws claude
```

Semantics:

1. set `aws` active;
2. run the remaining command exactly as if invoked separately.

Target aliases are arbitrary configured names. `pc`, `home`, and `aws` are ergonomic examples/hints, not special backend types.

## 4. Persistent commands

Any non-reserved command is interpreted as a persistent remote command:

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
→ derive stable session identity
→ create/repair persistent Zellij session
→ attach local terminal
```

The same project + target + command should reconnect to the same session.

## 5. `hn new`

```bash
hn new claude
hn new codex
```

Creates a new independent persistent session by adding a unique token to session identity.

It must not replace or kill the stable default session.

## 6. `hn shell`

Starts or reconnects a persistent remote shell in the current mapped project directory.

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

It still passes through synchronization safety before execution but bypasses Zellij persistence.

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

Verifies SSH, detects platform/architecture, bootstraps Zellij, stores metadata.

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

## 12. Sessions

List:

```bash
hn sessions
```

Attach explicitly:

```bash
hn attach main-pc-handoff-claude-...
```

Stable session names should remain deterministic enough for Handoff to reconnect, but users should not be required to manually construct them.

## 13. Doctor

```bash
hn doctor
hn doctor pc
```

Current checks:

```text
pc  windows/x64
  ✓ ssh
  ✓ zellij
  ✓ claude
  ✓ codex
  ✓ node
  ✓ mutagen (controller)
```

Future useful checks:

- native persistent-session create/reattach test;
- workspace Windows-path compatibility preflight;
- scan/transition problems;
- Handoff-managed binary checksum/version;
- remote disk space;
- optional workload-specific checks.

## 14. Future conflict UX

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

## 15. Output principles

1. **Conclusion first.** Tell the user what is happening.
2. **Progress for slow work.** Never look hung when data is moving.
3. **Quiet when healthy.** Do not dump full Mutagen session metadata before every command once the sync is idle.
4. **Exact path on file problems.** Counts alone are insufficient.
5. **Underlying error preserved.** Include useful stderr/stdout from SSH/Mutagen/Zellij.
6. **No infrastructure jargon unless needed.** Prefer `local`/`remote`, workspace/target/project over `alpha`/`beta`.
7. **Safe action hints.** Error messages should provide the next command when Handoff can identify it.

## 16. Reserved commands

Current reserved top-level command family includes:

```text
help
status
doctor
worker
workspace
sync
sessions
attach
port
exec
shell
new
```

A target alias cannot use a reserved command name.

## 17. CLI invariants

- Product stays Handoff; binary stays `hn`.
- `hn` with no args stays useful and cheap.
- target selection stays local-only.
- ordinary commands are persistent by default.
- `hn exec` remains explicitly one-shot.
- `hn new` creates another session rather than mutating the default one.
- `hn sync` means the whole configured workspace, not only the current project.
- conflicts stop execution.
- daily use should not expose manual SSH/cd/tunnel/multiplexer ceremony.
