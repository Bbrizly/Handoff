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

The core no longer depends on Zellij. The mapped interactive PTY is proven with native PowerShell, Node, Claude, Codex, npm, Vite, and port forwarding.

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

### Optional managed persistence follow-up

`hn session` remains experimental. The root cause is now isolated to Zellij's Session 0 closed-input lifecycle, not generic WMI/OpenSSH descendant teardown. Continue with supported headless layouts or a minimal session host; keep it behind `SessionBackend`.

- Zellij creation log;
- `list-sessions`;
- process ownership/lifetime;
- stable socket directory;
- OpenSSH job/process behavior.

Do not switch the architecture to WSL/tmux as an unexamined workaround.

---

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

- server runs directly in the remote PTY (users may opt into Zellij themselves);
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

Keep Handoff-managed infrastructure (SSH/Zellij) separate from user workload/toolchain ownership.

---

## Phase 8 — Agent capability bridge

**Status:** Portable capability files done; Git and MCP bridges remain

`hn profile enable claude` shares home-level skills, subagents, commands, rules, hooks, output styles, and `~/.claude/CLAUDE.md` with trusted targets. Auth, MCP state, and caches were not part of that step and still need real bridges.

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
- reproducible Handoff-managed Mutagen bootstrap and optional Zellij installation;
- no remote `.git`;
- no Handoff-hosted backend required.
