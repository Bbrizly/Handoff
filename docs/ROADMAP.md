# Handoff roadmap

This roadmap is ordered by product risk, not by feature excitement. The core promise is not complete until the boring daily path works reliably on a real native-Windows worker.

## Phase 0 — Preserve the product contract

**Status:** Done with this documentation set

- canonical PRD;
- architecture specification;
- decision ledger;
- CLI contract;
- known-issues record;
- roadmap;
- README links.

Goal: no future engineer/agent should need chat history to know what Handoff is or which alternatives were already rejected.

---

## Phase 1 — Make the real workspace healthy

**Status:** Core policy v2 complete; richer path-level status remains

Generated roots, secrets, Claude worktrees, absolute symlinks, and exact Windows-incompatible paths now have targeted policy. The reference sync is healthy; path-level problem output remains product polish.

### 1.1 Fix default generated-output ignores

At minimum evaluate/add:

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

Acceptance:

- generated .NET `obj/...dll` no longer participates in sync;
- common machine-specific virtual environments/caches do not cross platforms;
- legitimate source/assets remain synchronized.

### 1.2 Handle generated Claude worktrees/symlink trees

Investigate the real `.claude/.agents/skills/gstack` and `.claude/worktrees` layout.

Acceptance:

- project instructions/skills needed by remote Claude still synchronize;
- generated absolute symlink failures are removed or explicitly diagnosed;
- no blanket `.claude/` ignore.

### 1.3 Surface Windows-incompatible paths

Add a preflight/diagnostic path for Windows target filenames that cannot materialize.

Acceptance:

- exact file shown;
- exact invalid character/reason shown;
- safe remedy described;
- no silent rename.

### 1.4 Improve status/problem output

Acceptance:

```text
hn status
```

can show actual problem paths or direct the user to a first-class command that does.

---

## Phase 2 — Prove the transparent native-Windows terminal

**Status:** Complete on reference hardware

The core depends on no session manager. The mapped interactive PTY is proven with native PowerShell, Node, Claude, Codex, npm, Vite, and port forwarding.

### Smoke test

```bash
cd <project>
hn pc
```

Acceptance:

1. PowerShell opens on Windows in the corresponding mapped project path.
2. Node reports `win32 x64`.
3. Plain `claude` and `codex` open interactively.
4. Direct forms such as `hn pc claude` work without managed sessions.

## Phase 3 — Prove round-trip editing

**Status:** Bidirectional live canary complete

### Worker → controller

Have Claude/remote command create/edit a source file.

Acceptance:

- edit appears locally quickly;
- local Git sees it as a normal modification;
- no remote `.git` exists.

### Controller → worker

Edit locally in the normal editor while Claude/session is alive.

Acceptance:

- change reaches worker quickly;
- remote command observes it without restart;
- no manual push/pull/sync ceremony.

### Disconnect/reconnect

Acceptance:

- temporary SSH/network loss does not corrupt the workspace;
- Mutagen resumes/reconciles safely;
- Handoff reports unhealthy state rather than starting work blindly.

---

## Phase 4 — Make synchronization UX production-quality

### 4.1 Quiet healthy path

If no meaningful sync work is required:

```text
hn pc
```

`hn pc` should not dump full Mutagen session metadata. This quiet routine path is implemented; explicit `hn sync` retains monitoring.

### 4.2 Rich slow path

For large transfer/reconciliation show:

- workspace/target;
- root;
- files and bytes;
- percentage if available;
- current phase/file;
- conflicts/problems immediately.

### 4.3 First-class problem commands

Candidate surface:

```bash
hn conflicts
hn sync doctor
hn resolve <path> --local
hn resolve <path> --remote
```

Use local/remote terminology in user-facing UX, not Mutagen alpha/beta.

---

## Phase 5 — Dev server flow

**Status:** Explicit flow proven on reference hardware

Prove:

```bash
hn pc npm run dev
hn port 5173
```

Acceptance:

- server runs directly in the remote PTY (users may opt into a multiplexer themselves);
- controller browser reaches localhost;
- forwarding resumes/reuses deterministic Mutagen forwarding session;
- user does not manually run SSH tunnel commands.

Automatic port discovery remains deferred until this explicit path is solid.

---

## Phase 6 — Workspace lifecycle completeness

Add safe management for:

```bash
hn workspace remove ...
hn workspace delete ...
```

Acceptance:

- matching Mutagen sessions are identified;
- sessions are terminated before endpoint cleanup/reconfiguration;
- no deletion propagates accidentally through a live old session;
- root overlap invariants remain enforced.

Also add explicit session cleanup/repair commands if necessary.

---

## Phase 7 — Worker setup polish

Potential command:

```bash
hn worker setup pc
```

Responsibilities may include:

- infrastructure diagnostics;
- optional install guidance/automation for Node/Claude/Codex;
- tool version visibility;
- account/auth launch flows without taking ownership of credentials;
- disk/GPU/runtime diagnostics where relevant.

Keep Handoff-managed infrastructure (SSH/Mutagen/Herdr) separate from user workload/toolchain ownership.

---

## Phase 8 — Agent capability bridge

**Status:** Portable capability files live-proven; Git and MCP bridges remain

`hn profile enable claude` shares canonical skill trees, Claude skills, subagents, commands, rules, hooks, output styles, and `~/.claude/CLAUDE.md` with trusted targets. Cross-root links are projected safely on Windows. The Lenovo canary matched 249 canonical agent skills and 261 portable Claude skills, then confirmed that interactive Claude discovered the complete set. Auth, MCP state, plugin installation state, and caches were not part of that step and still need real bridges.

### Local Git bridge

Expose selected controller Git capabilities to remote agents without synchronizing `.git`.

Potential capabilities:

- status;
- diff;
- branch name;
- history/log;
- explicitly approved Git operations.

Must preserve controller Git as canonical.

### MCP/browser bridge

Allow remote Claude/Codex to access explicitly selected controller-local MCP/browser capabilities.

Do not copy global auth/cache directories as a shortcut.

---

## Phase 9 — Cloud/provider integrations

Add optional provisioning/discovery for AWS or other providers.

Core rule:

> provider integration should ultimately produce/manage an ordinary Handoff SSH worker.

Potential features:

- create/start/stop instance;
- discover IP/hostname;
- add target automatically;
- cost/status display;
- GPU instance templates.

Do not fork execution/sync/session semantics per provider unless absolutely necessary.

---

## Phase 10 — Advanced convenience

Only after the core path is boring:

- automatic port discovery;
- smarter project/session dashboards;
- optional tray/menu UI;
- richer worker health/performance metrics;
- project presets/tool profiles;
- optional encrypted secret handoff where explicitly needed;
- team/shared-worker workflows if product direction expands.

---

## Phase 11 — Persistent multi-project desk

**Status:** Live on the reference Windows worker; interactive polish and cleanup remain

`hn pc` is a disposable transparent terminal. `hn pc -p` should be the same compute inside a persistent desk: one runtime per target/workspace, one workspace per project, a sidebar listing projects and agents, and a state per agent so the one that needs the user is visible.

Done, measured on the Lenovo:

- ordinary commands no longer install a persistence runtime;
- `-p` / `--p` / `--persist` parse ahead of the remote command;
- Herdr 0.8.2 installs in under a second and starts a detached desk in under two;
- one desk per controller id + workspace, one desk project per Git project;
- asking for the same project twice reconnects instead of duplicating, before and after a server restart;
- a long-running Node process started from the Mac stayed alive across many closed SSH sessions;
- Claude launched into a project was detected as an agent with an `idle` state, and asking again focused it instead of starting a second one;
- the official local thin client now renders the Windows desk on the controller through Handoff's SSH direct-tcpip bridge; the legacy worker-side SSH PTY remains an explicit fallback.

Added 2026-08-28, measured on the Lenovo:

- closing an attachment reports a detach, not `SSH command failed (255)`. Four attach/detach cycles, exit 0 each time;
- four cycles left the same server process, the same two Claude processes, the same four projects, and exactly one Herdr client at any moment;
- a deleted Herdr binary is detected by the desk probe and reinstalled, under a running desk, without losing the desk or its agents;
- executable paths and arguments containing spaces round-trip through `pane run`.

Remaining:

- **responsive mirror A/B gate (HN-078):** explicit `HN_HERDR_TRANSPORT=mirror` is mechanically green and isolated, but it must prove materially more local-feeling typing/resize/mouse/scrollback on the reference Mac → Lenovo path before it can replace the official thin default;
- a human in the loop: click through the sidebar, close the terminal for an hour, come back;
- **reboot recovery is untested.** Nobody has rebooted the worker and run `hn pc -p`. Do not record this as solved until someone does;
- `hn attention` for the agents that are waiting;
- done in 0.2.0: retired `hn new`, `hn attach`, `hn session`, `hn sessions`, and deleted Zellij.

Terminal history must not persist across a worker restart by default. Saved screen contents can hold tokens and prompts.

The merge gate is the reference Lenovo, not CI: two projects live at once, an agent in each, close the Mac terminal, come back, and find the same processes.

---

## Definition of v1

Handoff v1 is ready when this feels normal:

```bash
cd ~/Documents/GitHub/Handoff
hn pc
```

and the user can forget the Lenovo exists as a separate interactive machine.

Required v1 proof:

- native Windows without WSL;
- healthy persistent full-workspace sync;
- incremental diffs after first seed;
- alpha-authoritative simultaneous collision handling with remote-only edits preserved;
- mapped native interactive terminal;
- Claude/Codex/npm work naturally inside the remote shell;
- round-trip edits;
- one-shot `hn exec`;
- manual `hn port`;
- clear doctor/status/errors;
- reproducible Handoff-managed Mutagen bootstrap and on-demand Herdr installation;
- Claude on a worker rendering the controller's own statusline;
- no remote `.git`;
- no Handoff-hosted backend required.
