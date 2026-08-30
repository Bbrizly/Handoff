# Handoff decision ledger

This is the canonical record of product and architecture decisions made for Handoff.

Statuses:

- **Accepted** — part of the intended product contract.
- **Accepted / needs polish** — correct architecture; implementation/UX still needs work.
- **Provisional** — selected direction but not fully proven on real hardware.
- **Deferred** — intentionally not v1; do not implement accidentally while solving another problem.
- **Rejected** — considered and intentionally not the direction.

If a future change reverses an accepted decision, update this file with a superseding decision rather than silently editing history.

---

## HN-001 — Product name is Handoff

**Status:** Accepted

The product is named **Handoff**.

Rationale: the product hands development execution from the daily machine to other compute while preserving the local workflow.

---

## HN-002 — Daily CLI is `hn`, not `handoff`

**Status:** Accepted

The product name and CLI do not need to match character-for-character.

The command is intentionally very short because it is used constantly:

```bash
hn
hn pc
hn claude
```

Longer CLI spellings such as `handoff` were rejected for daily ergonomics.

---

## HN-003 — Handoff is local-first remote execution, not a remote IDE

**Status:** Accepted

The user's editor, primary files, Git repository, terminal entry point, and browser stay on the controller.

The worker supplies compute.

Remote-IDE models where the repository/editor effectively move to the worker were rejected because they make the local machine stop feeling like the real development environment.

---

## HN-004 — Local files and local Git remain canonical

**Status:** Accepted

The controller's checkout is authoritative.

`.git` does not synchronize to workers.

Remote agents edit the synchronized working tree and those changes return to the controller as normal Git modifications.

Rejected alternative: maintain a second independent Git clone on every worker and use push/pull as the transport for in-progress changes.

---

## HN-005 — Do not implement a remote Git bridge in v1

**Status:** Deferred

A future bridge may expose local Git status/diff/history to remote agents without synchronizing `.git`.

For v1, remote Git awareness is intentionally limited. Codex exec uses `--skip-git-repo-check` where required.

Rationale: a correct Git bridge is a separate product problem and should not complicate proving core execution/sync/session persistence.

---

## HN-006 — Workers are ordinary SSH-reachable machines

**Status:** Accepted

The core target abstraction is not “Tailscale machine,” “AWS machine,” or “LAN machine.” It is an SSH endpoint with a local alias.

Examples:

```text
pc
home
aws
```

This allows later AWS/provider integrations without changing the core execution model.

---

## HN-007 — Handoff does not build its own VPN/network overlay

**Status:** Accepted

Tailscale is useful and a strong personal-machine default, but optional.

LAN, VPN, cloud networking, MagicDNS, SSH config aliases, and public/private SSH endpoints are all valid.

Rejected direction: making Handoff responsible for network identity/routing.

---

## HN-008 — Native Windows is a first-class worker

**Status:** Accepted

Windows must work without WSL.

The product cannot claim cross-platform worker support while making Windows users install Linux purely for Handoff infrastructure.

This decision heavily influenced the session-manager choice and Windows command transport.

---

## HN-009 — Do not require WSL

**Status:** Accepted

WSL may exist on a user's machine and their workload may use it, but Handoff's core worker bootstrap/persistence must not require it.

Rejected workaround: solve Windows session persistence by routing all Windows users through WSL/tmux.

---

## HN-010 — Zellij is the persistent-session backend

**Status:** Superseded by HN-076; Zellij was removed in 0.2.0

Zellij was selected over tmux because:

- it is cross-platform;
- it has native Windows support;
- it has programmatic CLI control;
- it avoids making WSL part of Handoff's core requirements.

Pinned version: `0.45.0`.

Rejected: tmux as the universal backend.

---

## HN-011 — Persistent sessions are keyed by project + target + command context

**Status:** Superseded by HN-068 and HN-076; the desk keys a project by label first, token second for explicit persistent sessions; not a requirement of the transparent terminal

A normal persistent command should reconnect to the same logical session.

Identity includes:

- workspace;
- target;
- local project path;
- command arguments;
- workspace-root mapping salt.

`hn session new ...` adds a unique token to intentionally create another session.

---

## HN-012 — Closing the controller terminal must not kill remote interactive work

**Status:** Accepted for explicit persistent sessions; not a requirement of the transparent terminal

This remains the contract for the persistent desk (`-p`), but it no longer gates the core `hn pc` transparent terminal. A direct SSH PTY naturally ends when its controller terminal disconnects.

Success test:

```text
hn pc -p claude
→ close local terminal
→ open another terminal
→ hn pc -p claude
→ same remote Claude session returns
```

---

## HN-013 — Use Mutagen for workspace synchronization

**Status:** Accepted

Mutagen was selected because it provides:

- persistent bidirectional synchronization;
- safe conflict semantics;
- SSH transport;
- watch/reconciliation behavior;
- cross-platform support;
- forwarding support that can also cover dev ports.

This avoids inventing a filesystem sync protocol inside Handoff.

---

## HN-014 — Synchronization mode is `two-way-safe`

**Status:** Superseded by HN-060

Both the controller and worker are allowed to produce legitimate file changes.

Therefore Handoff must not use a one-way mirror as the normal model.

When both sides modify the same path incompatibly, the correct behavior is conflict + stop, not silent overwrite.

---

## HN-015 — `.git` is excluded through Mutagen VCS ignore mode

**Status:** Accepted

Handoff creates Mutagen sessions with `--ignore-vcs`.

The worker mirrors source/worktree state, not Git internals.

---

## HN-016 — Workspace is the synchronized/access universe

**Status:** Accepted

A workspace describes everything intentionally available to remote work.

Example:

```text
main
  GitHub
  Obsidian
  Downloads
```

Important clarification: this decision was revisited after a large first seed. The accepted answer is still **whole configured workspace-root synchronization**, not implicit project-only synchronization.

---

## HN-017 — Do not replace workspace sync with automatic lazy project-only sync

**Status:** Rejected

A proposed optimization was:

```text
cd Handoff
hn session claude
→ synchronize Handoff only
```

This was rejected because it changes the original workspace mental model. The user intentionally wants an initialized set of directories available to Claude without repeatedly deciding what to materialize.

The correct response to a large first seed is:

- improve ignores;
- show excellent progress;
- keep persistent sessions;
- transfer diffs after initialization.

Not silently shrink the synchronization boundary.

---

## HN-018 — Large initial workspace seed is acceptable once

**Status:** Accepted / needs polish

A first synchronization can be gigabytes and tens of thousands of files.

That is acceptable if:

- it is clearly presented as initialization;
- progress is visible;
- generated junk is ignored;
- later operation is incremental.

A large initial seed must not happen on every Claude/session invocation.

---

## HN-019 — Sync progress must be visible

**Status:** Accepted / needs polish

The original `syncing main -> pc...` with no progress made a healthy 7 GB transfer look frozen.

The product should expose Mutagen phases/files/bytes/percentage when meaningful.

Idle healthy synchronization should eventually become quiet instead of printing full session metadata before every command.

---

## HN-020 — Conflicts block remote work

**Status:** Accepted

If Mutagen reports conflicts, Handoff refuses to launch remote work.

This is intentional safety behavior.

Rejected: silently choosing local or remote as the winner.

---

## HN-021 — Handoff needs first-class conflict UX

**Status:** Deferred but required for product quality

Current status only shows conflict counts.

Desired future commands:

```bash
hn conflicts
hn resolve <path> --local
hn resolve <path> --remote
```

The CLI should surface exact paths, why they conflict, and whether a path appears generated.

---

## HN-022 — Generated outputs should be excluded from workspace sync

**Status:** Accepted / ignore list incomplete

The initial ignore list covers common JS/Rust/Gradle outputs but real testing proved it is insufficient.

At minimum the product should consider common generated/cache roots such as:

```text
bin/
obj/
.venv/
venv/
.pytest_cache/
.mypy_cache/
.ruff_cache/
.turbo/
```

The exact default list should remain conservative enough not to hide legitimate source/assets.

Reason: a real conflict occurred on a generated `.dll` under `obj/Release`.

---

## HN-023 — Do not blanket-ignore project `.claude` directories

**Status:** Accepted

Project-local Claude instructions/skills/configuration may be needed by remote Claude.

Real Mutagen scan errors occurred in `.claude` trees due to absolute generated symlinks, but the solution must be targeted.

Rejected quick fix: ignore every `.claude/` directory globally.

Preferred directions:

- relative symlinks where possible;
- targeted ignore of generated worktrees/symlink farms;
- explicit diagnostics for non-portable symlinks.

---

## HN-024 — Windows-incompatible filenames are a real product boundary

**Status:** Accepted limitation / needs UX

macOS/Linux can contain names Windows cannot materialize, including `:`.

Handoff cannot faithfully synchronize those paths to NTFS.

The product should surface incompatible paths clearly and eventually offer preflight validation for Windows targets.

Rejected: silently rename user files during sync.

---

## HN-025 — Mutagen portable symlink semantics are currently accepted

**Status:** Accepted limitation / needs UX

Portable symlink mode is safer cross-platform but rejects absolute links that cannot be represented portably.

The product should diagnose these paths rather than globally changing symlink behavior without understanding security/portability consequences.

---

## HN-026 — Handoff manages its infrastructure binaries

**Status:** Accepted

Handoff should not require users to manually install/configure its internal plumbing when it can do so safely.

Current managed dependencies:

- Mutagen controller binary + agent bundle;
- Zellij worker binary.

Both are pinned and checksum verified.

---

## HN-027 — Mutagen bootstrap must not depend on Homebrew

**Status:** Accepted

An early implementation attempted Homebrew and hit tap trust restrictions.

The correct architecture is self-contained download of the official pinned Mutagen archive plus checksum verification.

Homebrew may exist on the machine but is not the Handoff dependency path.

---

## HN-028 — Keep `mutagen-agents.tar.gz` beside the managed Mutagen executable

**Status:** Accepted implementation requirement

Mutagen expects its agent bundle to be discoverable relative to its executable/install layout.

The managed install therefore keeps both under the same versioned Handoff directory.

---

## HN-029 — Worker toolchains are not magically managed in core v1

**Status:** Deferred

A worker still needs the workload tools it will execute: Claude, Codex, Node, Python, Docker, CUDA, etc.

Future UX may provide:

```bash
hn worker setup pc
hn tools setup pc
```

but Handoff should not silently own third-party account authentication or rewrite a user's development environment.

---

## HN-030 — Windows onboarding should be one elevated bootstrap, then normal unprivileged use

**Status:** Accepted

`hn worker pair` generates one administrator PowerShell command to establish OpenSSH/key access.

After pairing, daily Handoff commands should not require administrator elevation.

---

## HN-031 — Native Windows worker uses Microsoft OpenSSH first

**Status:** Accepted / monitored

The design prefers the built-in/common Windows OpenSSH path for minimal setup.

Mutagen documents historical Windows OpenSSH caveats, but real hardware testing proved the synchronization transport can work.

Rejected as an automatic first response: force Bitvise or WSL before observing a real problem.

A different SSH server remains a fallback if a proven transport issue cannot be solved.

---

## HN-032 — Prefer Windows application shims over PowerShell script shims

**Status:** Accepted

When launching tools on Windows, Handoff resolves `Get-Command -CommandType Application` first.

Reason: npm can expose both `.cmd` and `.ps1` wrappers; restrictive PowerShell execution policy may block the `.ps1` even though the application shim works.

Rejected: weaken the user's execution policy globally.

---

## HN-033 — PowerShell orchestration uses encoded scripts, with a large-payload fallback

**Status:** Accepted

UTF-16LE `-EncodedCommand` avoids quoting problems for normal scripts.

Real testing hit `The command line is too long.` when a large detached Zellij-launch script was embedded in argv.

Accepted fix direction: stream oversized scripts over SSH stdin instead of expanding argv indefinitely.

---

## HN-034 — Pin one stable Zellij socket/runtime directory on Windows

**Status:** Obsolete; removed with Zellij in 0.2.0 (HN-076)

Windows Zellij invocations use a stable Handoff-owned runtime path under `~/.hn` so create/inspect/control/attach calls made through separate SSH invocations can discover the same session.

This is part of the current native-Windows persistence work and remains subject to final real-hardware proof.

---

## HN-035 — Native Windows Zellij creation may need to escape the OpenSSH process lifetime

**Status:** Obsolete; removed with Zellij in 0.2.0 (HN-076). The detached-launch primitive it produced survives as HN-069 and is used by the desk.

Live testing showed:

```text
zellij attach --create-background
→ exit 0
→ SSH command returns
→ list-sessions says no sessions
```

The working hypothesis is Windows OpenSSH process/job lifetime teardown.

Current implementation direction uses detached Win32 process creation semantics to keep the Zellij server outside the short-lived SSH-owned tree.

Do not mark this accepted/proven until the close-terminal/reattach smoke test succeeds on the real Windows worker.

---

## HN-036 — `hn pc` / target selection is local-only

**Status:** Superseded by HN-058

Selecting a target must not perform SSH/bootstrap just to update local state.

This keeps target switching instant and predictable.

Validation happens when a target is actually used or through explicit diagnostics.

---

## HN-037 — Active target is global, not workspace-specific

**Status:** Accepted

The user thinks “use pc now” rather than “main workspace's target is pc while another workspace's target is home.”

Config v2 therefore stores one `activeTarget`.

---

## HN-038 — Workspace roots must not overlap

**Status:** Accepted

Overlapping local or remote roots could create overlapping Mutagen ownership and unsafe propagation.

Handoff rejects them globally.

---

## HN-039 — One SSH endpoint should have one target alias

**Status:** Accepted

Duplicate aliases for the same `(user, host, port)` add ambiguity to session/config identity and are rejected.

---

## HN-040 — Remote workspace namespace is `hn/...`

**Status:** Accepted

Legacy `handoff/...` remote paths are migrated to `hn/...`.

The CLI/remote namespace follows the short command name.

---

## HN-041 — Multi-root workspaces are first-class

**Status:** Accepted

A remote agent may need source code plus notes/assets from other configured roots.

Claude/Codex are augmented with the other synchronized workspace roots through their supported add-directory flags.

---

## HN-042 — Agent management commands must not receive automatic workspace flags

**Status:** Accepted

Commands such as auth/update/plugin/mcp management have different CLI grammars.

Handoff only augments actual agent work invocations, not every command that happens to start with `claude` or `codex`.

---

## HN-043 — Manual explicit port forwarding is v1

**Status:** Accepted

```bash
hn port 5173
```

is sufficient for the core workflow.

Automatic dev-server/port discovery is deferred until after execution and persistence are reliable.

---

## HN-044 — Use Mutagen forwarding for `hn port`

**Status:** Accepted

Handoff already depends on Mutagen and can let it own forwarding lifecycle instead of building another SSH-tunnel manager.

Default endpoints are loopback-to-loopback.

---

## HN-045 — Automatic port discovery is deferred

**Status:** Deferred

Potential future behavior may detect dev servers and offer/open ports automatically, but this is not necessary to prove core v1.

---

## HN-046 — AWS/cloud integrations are layered on top of the worker model

**Status:** Deferred

The core does not need an AWS-specific execution path. Provisioning, credentials, instance lifecycle, and discovery can later create/manage ordinary SSH-reachable workers.

This keeps cloud integration optional rather than foundational.

---

## HN-047 — No Handoff-hosted backend is required for core operation

**Status:** Accepted

The local-first product must work between machines the user controls without a Handoff SaaS control plane.

A future optional service may exist for convenience, but the core architecture cannot depend on it.

---

## HN-048 — MCP/browser-local integrations need an explicit bridge, not broad config sync

**Status:** Deferred

Remote Claude cannot automatically see controller-local MCP servers or browser integrations just because the workspace syncs.

Future work should bridge those capabilities intentionally.

Rejected: synchronize all of `~/.claude` or other global auth/cache state to workers.

---

## HN-049 — Project-local AI instructions/configuration may sync

**Status:** Accepted

Files such as project `CLAUDE.md`, `.mcp.json`, project-local skills, or similar source-controlled/project-scoped instructions are part of the project/workspace when explicitly located there.

Global AI credentials/cache remain outside the model.

---

## HN-050 — `hn exec` is the one-shot escape hatch

**Status:** Accepted

Not every remote command needs persistence.

```bash
hn exec npm test
```

runs directly on the worker after the same synchronization safety gate.

This also provides a valuable diagnostic path independent of Zellij.

---

## HN-051 — Remote execution was proven before persistent sessions

**Status:** Historical proof, retained as architecture evidence

Real hardware returned:

```text
win32 x64
```

from:

```bash
hn exec node -e "console.log(process.platform, process.arch)"
```

This proves the controller → sync → Windows worker → command path independently of remaining Zellij persistence bugs.

---

## HN-052 — Status and doctor should answer different questions

**Status:** Accepted

`hn status` is a lightweight view of selected target/workspace/project/sync state.

`hn doctor` explicitly probes machine/tool readiness.

Do not make normal status unnecessarily expensive by turning it into a full bootstrap/probe every time.

---

## HN-053 — Error messages must include underlying diagnostics

**Status:** Accepted

Real debugging improved only after errors exposed Zellij stdout/stderr such as:

```text
There is no active session!
No active zellij sessions found.
The command line is too long.
```

Generic wrapper failures are not acceptable when the underlying tool provides actionable detail.

---

## HN-054 — Workspace root removal/management is needed but not yet core-complete

**Status:** Deferred

Current workspace UX supports create/add/list. A production product also needs safe root removal/migration that understands and terminates the matching synchronization sessions.

Do not implement removal as “delete config entry only” without session cleanup semantics.

---

## HN-055 — Reconfigure overlapping sync sessions safely

**Status:** Accepted invariant

Handoff must never create project/root sessions that overlap an existing whole-root synchronization tree.

This is another reason the lazy project-sync redesign was rejected after the workspace model was reaffirmed.

---

## HN-056 — Keep the product narrow: execution layer, not everything-devops

**Status:** Accepted

When evaluating new features, prefer those that make:

```text
local environment + remote compute
```

feel seamless.

Do not let Handoff become a remote desktop, Git host, container platform, VPN, cloud IDE, secret manager, or general infrastructure dashboard unless a future product decision explicitly expands the scope.

---

## HN-057 — The core primitive is a transparent mapped remote terminal

**Status:** Accepted

The daily Handoff path is:

```text
target
→ workspace synchronization
→ interactive SSH PTY
→ mapped remote cwd
→ normal native worker shell
```

Once connected, the user should run Claude, Codex, Cursor CLI, npm, Docker, Python, Zellij, and other tools normally. Core entry and direct interactive commands must not depend on hidden managed sessions.

This is physically proven on the reference native-Windows worker: `hn pc` entered `C:\Users\Lenovo\hn\main\GitHub\Handoff`; Node reported `win32 x64`; Claude and Codex opened; and a remote Vite server was reachable through `hn port`.

---

## HN-058 — A target alias means "take me there"

**Status:** Accepted; supersedes HN-036

```bash
hn pc
```

now synchronizes and opens the mapped interactive terminal. It does not merely mutate local target state.

Selection is explicit:

```bash
hn use pc
hn worker default pc
```

Direct forms such as `hn pc claude` use that target for one interactive command without changing the selection.

---

## HN-059 — Managed Zellij persistence is optional

**Status:** Superseded by HN-076; the optional Zellij backend was removed in 0.2.0

Zellij remains installed, available to users inside the transparent terminal, and implemented behind `SessionBackend` for explicit commands:

```bash
hn session
hn session claude
hn session new claude
```

Native-Windows managed persistence remains experimental. Live forensics showed that WMI detachment works, but a Session 0 attached Zellij anchor receives closed/non-interactive input; its default `cmd.exe` pane and server exit cleanly within roughly 260 ms. This optional issue must not block `hn pc`, `hn pc <command>`, or `hn exec`.

---

## HN-060 — Synchronization mode is `two-way-resolved`

**Status:** Accepted; supersedes HN-014

The controller/Mac is the alpha endpoint. Local-only and remote-only edits both propagate. Only simultaneous divergence on the same path resolves automatically in favor of alpha.

This preserves remote-to-Mac edits while matching the local-canonical product model and removes routine manual conflict handling. Generated artifacts and secrets remain excluded so conflict precedence is reserved for actual synchronized content.

---

## HN-061 — Personal agent capability files may sync to trusted targets

**Status:** Accepted; narrows HN-048

Remote Claude was capable but not *yours*: home-level skills, subagents, commands, rules, hooks, output styles, and `~/.claude/CLAUDE.md` stayed on the controller.

`hn profile enable claude` adds those paths to a workspace as ordinary roots with `scope: "trusted"`, so they never reach a target marked `remote`.

Canonical skill trees outside `~/.claude` are included when Claude skill entries link to them. Links that cross profile roots are reconstructed on the worker after synchronization. Native Windows uses junctions and moves any replaced destination under `~/.hn/backups` first.

The allowlist is deliberate. These stay local:

```text
.credentials.json  settings.json  .claude.json  mcp auth
plugins  history  sessions  shell-snapshots  todos  caches  projects
```

HN-048 still holds for auth, cache, and MCP state. What changed is that portable capability files are not auth state, and copying them is what makes a worker feel like the user's own machine.

Rejected: synchronize all of `~/.claude`.

---

## HN-062 — A workspace root may be a single file

**Status:** Accepted

Roots used to be directories only, so sharing one file meant sharing its whole parent.

A root now records `kind: "file" | "directory"`. A file root:

- creates only its remote parent directory;
- never becomes a terminal or project cwd, so `hn pc` still lands in a real directory;
- passes its parent directory, not itself, to agent `--add-dir`;
- fails early when the remote filename cannot exist on a Windows worker.

This is what makes `~/.claude/CLAUDE.md` shareable without dragging `~/.claude` along with it.

---

## HN-063 — `hn access` answers "is this shared?"

**Status:** Accepted

Ignore policy is invisible. A user could not tell whether a path reached the worker without reading the sync configuration.

```bash
hn access
hn access ~/GitHub/app/.env
```

reports one of three states: shared with its remote path, local only with the reason, or outside every workspace. Privacy rules the user cannot inspect are not privacy rules.

---

## HN-064 — Transparent Windows shells expose every shared root to agents

**Status:** Accepted

Direct commands such as `hn pc claude` already augmented Claude and Codex with the other workspace roots. Typing plain `claude` after entering `hn pc` did not, which made the transparent shell less capable than the direct form.

The Windows shell bootstrap now defines process-local wrappers around the resolved native Claude and Codex applications. They add every non-profile workspace root with the applications' supported `--add-dir` arguments and pass management commands through unchanged. The wrappers do not modify the PowerShell profile or replace installed tools.

The reference Lenovo proved both wrappers resolve as functions over the real applications, Claude opens in the mapped project, and the synchronized skills are discoverable. Equivalent transparent wrapping on POSIX interactive shells remains later portability work; direct POSIX agent forms already receive the additional roots.

---

## HN-065 — Persistence is optional and installs nothing until it is asked for

**Status:** Accepted

`prepareTarget()` called `bootstrapWorker()`, which verified or installed Zellij on every ordinary command. A plain `hn pc` paid for a multiplexer it never used, and pairing a worker downloaded one before the user had asked for a session.

The bootstrap is now two steps:

- `prepareWorkerCore()` proves SSH, detects platform/architecture, and stops there. Every ordinary command uses it.
- the desk runtime installs on demand. Only `-p` and the explicit `hn worker bootstrap` reach it. (0.2.0 removed `ensurePersistenceRuntime()` along with Zellij; see HN-076.)

`hn doctor` reports a missing runtime as `— persistence`, not `✗`. An optional capability that was never requested is not an unhealthy system.

The transparent terminal must never depend on the persistence layer. If the persistence runtime is completely broken, `hn pc` still has to work.

---

## HN-066 — `-p`, `--p`, and `--persist` are one flag, and only before the remote command

**Status:** Accepted

Target aliases forwarded everything after the target as the remote command, so `hn pc --persist` meant "run a program called `--persist`".

`parseTargetInvocation()` now reads Handoff flags only while they sit in front of the remote command. All three spellings resolve to the same mode; `--persist` is the documented form, `-p` is the fast one, and `--p` is accepted because refusing it helps nobody.

```bash
hn pc -p                        # persistent
hn pc -p claude                 # persistent, running Claude
hn pc npm run dev -- --persist  # --persist belongs to npm
hn pc -p -- foo --persist       # one flag consumed, the rest is the command
```

A bare `hn -p` uses the selected target.

---

## HN-067 — Herdr is the persistent desk, Handoff does not build a multiplexer

**Status:** Accepted

`hn pc -p` needs terminals that outlive the SSH connection, real panes on native Windows, projects a user can click between, and per-agent state so the agent that is waiting can be seen. Writing that means writing a terminal multiplexer: PTY renderer, ANSI parser, mouse layout, sidebar, scrollback.

Handoff pins Herdr v0.8.2 (Apache-2.0) instead. Verified against the upstream release rather than taken on trust: five published assets, all five SHA-256 sums matching the pins in `src/herdr.js`, native Windows support via ConPTY, a headless `herdr server`, a JSON socket API, and its own project/agent sidebar with `blocked`, `working`, `done`, `idle`, and `unknown` states.

The boundary holds: everything Herdr-specific lives in `src/herdr.js`, one Herdr runtime maps to one Handoff target plus workspace, and one Herdr workspace maps to one Git project. Handoff is not Herdr, and the transparent `hn pc` path does not know Herdr exists.

Rejected: building a Handoff TUI, and Herdr's own `--remote` thin client, which does not support Windows remote hosts. Handoff already owns SSH, so attaching runs a Herdr client on the worker through Handoff's own PTY.

---

## HN-068 — A desk project is keyed by label first, token second

**Status:** Accepted

Herdr can hold a metadata token per workspace, which is the natural place for the mapped remote root. Measured against the reference worker: workspaces, labels, tabs, panes, and cwd survive a server restart. **Metadata tokens do not.**

So the durable key is the label, which Handoff owns and makes unique itself (`app`, `app 2`) instead of trusting a folder basename to be distinct. The token `hn_root` is the exact match while the server is up and is re-applied on every attach.

Matching is token first, then label. Proven on the Lenovo: stop the server, restart it, ask for the same project, and Handoff reconnects to the existing workspace and re-tags it rather than creating a duplicate.

---

## HN-069 — One detached-launch primitive for native Windows

**Status:** Accepted

Windows OpenSSH tears down descendants when the exec channel closes, so a background server started the obvious way dies with the SSH command that started it. Zellij already had a working answer buried in its module: spawn through WMI with `CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_CONSOLE`, hidden window, and an owner check.

That is now `src/windows-detach.js`, shared by both backends. Two failures were measured on the way there and are worth keeping written down:

- `Start-Process` alone is not enough. The server starts, answers while the SSH session is open, and is gone once it closes.
- `Start-Process -RedirectStandardOutput` kills Herdr silently. It needs real console handles; redirecting its stdio to a file leaves a zero-byte log and no server. Herdr writes its own log under its session directory, so Handoff redirects nothing.

---

## HN-070 — The worker's Claude wears the controller's statusline, minus the Git it cannot see

**Status:** Accepted; live-proven on the reference Lenovo

A remote Claude that looks different from the local one reads as a lesser Claude, and that was the stated adoption blocker. Handoff ships `assets/claude-statusline.cjs` to `~/.hn/claude-statusline.cjs` and points its own settings file at it with `--settings`. The worker's `~/.claude/settings.json` is never written.

The script reproduces the controller's `~/.claude/statusline.sh` exactly: segment order, labels, colours, separators, context percentage, the 5h and weekly countdowns with their `5h`/`7d` fallbacks, the reserved Fable segment, model shortening (`Opus 4.8 (1M context)` becomes `Opus4.8_1M`), and home-relative directory display.

One segment is allowed to differ. `.git` stays on the controller, so the worker has no repository. Branch degrades to the dim `⎇ —` the local script already prints when it finds none. Dirty state degrades to a dim `—` rather than the local script's `clean`, because Handoff will not assert a Git state it cannot read. Nothing else is invented.

A test feeds identical payloads to both renderers and asserts every segment before the last is byte-identical, and that the last is exactly this one difference.

Rejected: a `hn` badge and a `local Git` label. Both were text invented to fill space the Git segments used to hold.

---

## HN-071 — Closing an attachment is not a failure

**Status:** Accepted; live-proven

`hn pc -p` ended with `hn: SSH command failed (255)` every time the user closed the desk. The desk was fine. 255 is ssh's own code for a connection that ended without a remote exit status, and closing a window produces exactly that.

Suppressing 255 was rejected: a real network fault produces the same code.

Instead, a non-zero attach asks the desk itself. `herdr --session <runtime> status server` is one cheap round trip. If the server answers `status: running`, the attachment ended and Handoff says so:

```text
desk still running on pc. 'hn pc -p' comes back to it
```

If it does not answer, that is a genuine failure and keeps a real error. Proven over four attach/detach cycles on the Lenovo: exit 0 each time, the same desk, the same two Claude processes, no duplicates.

---

## HN-072 — A cached fact about the worker is a hint, and the launch checks it

**Status:** Accepted; live-proven

Handoff caches `handoffStatuslineVersion`, `herdrVersion`, `claudeProfileProjection`, and `profileSyncPolicyFingerprint` per worker so a normal launch does no unconditional install work. A cache like that quietly becomes a wrong permanent assertion the moment someone deletes a file on the worker.

So the launch verifies, and repairs once, instead of trusting the cache blindly:

- `hn pc claude` runs one guard script before starting Claude. It reports a marker on stdout when either managed file or any projected profile link is missing. Handoff then re-ships the files, re-projects the links, and launches.
- `hn pc -p` gets the same answer for free. The guard rides the desk probe that already had to run, which also reports whether the Herdr binary is still there.

The signal is a stdout marker, never an exit code. Measured on Windows: `ssh -tt` returns 0 no matter what the remote program exits with, because OpenSSH drops the remote status once a pty is allocated. An earlier exit-code protocol was written, measured, and deleted for that reason.

Measured cost on the reference Lenovo: `hn pc claude` median 2.45s without the guard, 2.79s with it. `hn pc -p` pays nothing.

Live-proven by deleting each asset on the worker and launching: the statusline script, the settings file, a projected junction, and the Herdr binary. Each one was detected and put back.

---

## HN-073 — Install Herdr beside its locked files, not over them

**Status:** Accepted; fixed after a live failure

Restoring a deleted `herdr.exe` while a desk is running failed:

```text
Remove-Item : Cannot remove item ...\0.8.2\conpty\conpty.dll: Access to the path is denied.
```

`Expand-Archive -Force` deletes each entry before writing it, and the running server holds its ConPTY DLLs open.

The install now unpacks to a staging directory under `%TEMP%` and copies into place with `-ErrorAction SilentlyContinue`. A locked file is already the correct file, so failing to overwrite it is not an error. The `herdr --version` check that follows is what decides whether the install worked.

Proven on the Lenovo: the binary was restored under a running desk, and the desk kept its server process, its four projects, and both Claude agents.

---

## HN-074 — MCP health comes from Claude, or it is not claimed

**Status:** Accepted

`hn doctor` used to scan `~/.claude.json` and `~/.claude/settings.json` for `mcpServers` and check that each command existed on PATH. That is not Claude's effective MCP configuration, and printing `✓ mcp` from it was a claim Handoff had not earned.

Doctor now runs `claude mcp list` on the worker and reports what it says:

```text
✓ mcp  claude mcp list: 2/2 connected
✗ mcp  claude mcp list: 1/3 not connected: broken-one
```

Only server names and connection status are parsed. The command column is never read or printed: it can hold an API key in a URL or an env value. When Claude is absent, or the command fails or times out, doctor says that instead of guessing.

---

## HN-075 — Synchronized is not the same as usable, and doctor says which one it means

**Status:** Accepted

Codex reported thirteen `SKILL.md` files under gstack missing required YAML frontmatter. Those files are byte-identical on both machines. Handoff synchronized them correctly; they are invalid upstream.

Handoff's diagnostics only claim what Handoff can know. The profile line reads `7 roots synchronized`. Whether a given skill, agent, or command file is valid is the agent runtime's own check, and Handoff does not edit third-party or personal skill content to make its own output green.

---

## HN-076 — Delete Zellij rather than ship a second persistence story

**Status:** Accepted; supersedes HN-010, HN-011, HN-034, HN-035, and HN-059

Herdr became the persistent desk in HN-067. That left two answers to the same question: `-p` on one side, and `hn session` / `hn new` / `hn attach` / `hn sessions` on the other. The second answer was never proven on native Windows, was already documented as scheduled for removal, and cost a pinned worker binary with five platform artifacts.

Removed in 0.2.0:

- `src/zellij.js` and `src/session.js`;
- the `session`, `new`, `attach`, and `sessions` commands and their reserved names;
- the Zellij worker bootstrap, its pinned version, and its five checksummed release assets;
- `bootstrapWorker()`, `ensurePersistenceRuntime()`, and the `persistence` flag on `prepareTarget()`.

`prepareWorkerCore()` is now the only worker preparation path. The desk runtime installs on first `-p` and nowhere else, so reaching a worker still pays for SSH and platform detection and nothing more.

`SessionBackend` stays as a boundary. Replacing Herdr must not require touching target or workspace logic.

Users who want a multiplexer can still run one themselves inside `hn pc`. Handoff does not install it, pin it, or claim it.

---

## HN-077 — Herdr protocol bytes ride an SSH forward, never an exec channel

**Status:** Accepted

The thin desk runs the official Herdr client on the Mac and needs its client socket
to reach the worker's already-running Herdr server. The first build carried those
bytes on `ssh worker powershell.exe`, pumping the exec channel's stdin and stdout
into the Windows named pipe. It rendered and could not be typed into. Windows
OpenSSH only keeps an exec channel's stdin alive when it allocates a ConPTY, so
the remote pump got the handshake that was buffered before it started and nothing
after. `-tt` is not a fix, because a ConPTY echoes, rewrites CR/LF and injects its
own escapes into what has to stay a raw byte stream. KNOWN_ISSUES 25 has the
timings.

The bytes now take a different channel entirely. `ssh -L <private socket>:127.0.0.1:<port>`
publishes the Unix socket the renderer wants and sshd forwards it over direct-tcpip.
A helper on the worker holds the other end: it binds one loopback-only ephemeral
port, takes exactly one connection, and copies bytes to the existing
`herdr-client.sock` named pipe. No Handoff process sits in the data path.

The helper is attachment-scoped, not a service. It knows no Herdr path and starts,
stops, restarts and updates nothing. It exits when the connection closes, when the
SSH channel dies, or after its accept window passes with nobody there. The forward
dies with the client, so detaching leaves the worker exactly as it was.

A loopback port is reachable by every account on the machine, which the named pipe
is not. The helper closes that gap itself: it looks up the connecting process and
refuses anything not running as the same Windows user, which is the pipe's own
boundary restated.

The attachment opens its own SSH connection rather than borrowing the shared
`ControlMaster`. A shared master owns the forward's lifetime, and a stale one
refuses new sessions outright, which is exactly what a long-lived desk must not
depend on.

Rejected: repairing exec stdin, a ConPTY for protocol bytes, a Node byte relay
between the renderer and ssh (`ssh -L` already publishes the socket, so the relay
was deleted), and any listener not bound to loopback.
