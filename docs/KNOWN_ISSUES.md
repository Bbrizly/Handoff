# Known issues and live-hardware findings

This file records issues that have been observed or are known from the current implementation. It is intentionally concrete so future debugging does not rediscover the same failures.

Severity terminology:

- **Blocker** — prevents the golden path.
- **High** — unsafe or materially bad UX.
- **Medium** — important production gap, workaround exists.
- **Low** — polish/coverage gap.

## 1. Optional managed native-Windows Zellij persistence is not proven

**Severity:** Medium experimental feature gap; no longer a core-path blocker

**Status:** Root cause isolated; transparent terminal proven independently

The daily native-Windows path is proven: `hn pc` enters the mapped PowerShell PTY, Node reports `win32 x64`, Claude and Codex open interactively, and remote dev servers work through `hn port`.

Only the explicit `hn session` backend remains unproven.

### Observed history

Initial creation appeared to succeed, but immediate inspection failed:

```text
Zellij session '...' was created but could not be inspected
There is no active session!
```

Improved diagnostics then showed:

```text
list-sessions: No active zellij sessions found.
```

A Windows process-lifetime workaround was introduced to detach session creation from the short-lived OpenSSH exec tree. Live forensics established that the broad process-lifetime hypothesis was wrong:

- a WMI-created Session 0 sleeper executed and survived the originating SSH connection;
- the exact Zellij anchor executed;
- its non-interactive/closed input caused the initial `cmd.exe` pane to exit;
- Zellij printed `Bye from Zellij!` and exited with code 0 about 260 ms after startup;
- no server therefore remained for the next SSH connection to inspect.

An earlier launcher transport also hit:

```text
The command line is too long.
```

The PowerShell transport was updated so oversized scripts can stream over SSH stdin instead of being placed in a giant `-EncodedCommand` argument.

The remaining solution should use a supported headless layout or a tiny deterministic session host if Zellij still requires a durable console. It stays isolated behind `SessionBackend`; do not reintroduce it into `hn pc`.

### Required proof

After synchronization is healthy:

```text
1. hn session claude
2. Claude opens on Windows
3. close controller terminal
4. open a new controller terminal
5. run hn session claude from the same project
6. same live Claude session reattaches
```

Only after this passes should native Windows persistence be marked solved.

Session cleanup force-deletes the server, terminates an exact-match orphan only when it is Handoff's pinned Zellij binary, waits for asynchronous native-Windows shutdown, then removes the final resurrection record. Without that fallback and delay, a Session 0 server can rewrite the exited record after deletion. This prevents `hn sessions kill` from leaving an exited entry or hidden server process.

---

## 2. Generated output conflicts exposed incomplete defaults

**Severity:** Resolved high-risk sync issue

**Status:** Fixed in sync policy v2

Current ignores:

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

A real two-way conflict occurred on generated .NET build output:

```text
Quadstick-Config-Manager/src/QuadStick.App/obj/Release/net8.0/QuadStickConfigManager.dll
```

The file changed independently on both endpoints and Mutagen correctly stopped.

### Resolution

Policy v2 adds these as leaf-name patterns so they apply inside every nested project, not only at the workspace root. `.env` secrets are local by default while `.env.example` and `.env.sample` remain portable.

### Why this matters

Generated artifacts:

- create meaningless conflicts;
- inflate first-time sync size;
- can be platform-specific or incompatible;
- can sync remote build output back to the controller when it should be rebuilt locally if needed.

---

## 3. Project-local Claude/gstack absolute symlinks fail portable sync

**Severity:** Resolved high issue for known paths

**Status:** Fixed with targeted preflight/ignores; richer diagnostics remain

A real workspace scan reported at least 25 problems. Examples:

```text
.claude/.agents/skills/gstack/ETHOS.md: invalid symbolic link: target is absolute
.claude/.agents/skills/gstack/bin: invalid symbolic link: target is absolute
.claude/.agents/skills/gstack/browse: invalid symbolic link: target is absolute
.claude/.agents/skills/gstack/qa: invalid symbolic link: target is absolute
.claude/.agents/skills/gstack/review: invalid symbolic link: target is absolute
```

Additional failures occurred inside generated `.claude/worktrees/...` trees.

### Product constraint

Mutagen is currently using portable symbolic-link behavior. Absolute symlinks cannot necessarily be represented safely/portably across macOS and Windows.

### Do not apply this bad fix

Do **not** globally ignore `.claude/`.

Project-local Claude files may contain legitimate instructions, skills, `CLAUDE.md`-adjacent content, or configuration needed by the remote agent.

### Preferred resolution order

1. Ignore generated `.claude/worktrees/` where appropriate.
2. Prefer relative symlinks in project-managed skill trees where possible.
3. Add targeted ignores for generated/non-portable symlink farms only if they are recreatable.
4. Surface exact symlink paths and remediation in `hn status`/future `hn conflicts`.
5. Reconsider Mutagen symlink mode only with a deliberate portability/security decision.

---

## 4. macOS-valid filenames can be invalid on Windows

**Severity:** Resolved high issue for known paths

**Status:** Fixed with exact local-only ignores and warning; richer diagnostics remain

A real Windows transition failure occurred on a PDF whose filename included a colon:

```text
Adaptiv's Playbook: 100+ Near-Guaranteed Wins to Build Unstoppable Momentum.pdf
```

Mutagen reported that Windows could not create the file because the filename/directory syntax was invalid.

### Constraint

NTFS/Windows filename rules are stricter than macOS/Linux. Handoff cannot faithfully materialize every valid POSIX/macOS filename on Windows.

### Required UX

Before or during synchronization to a Windows target, Handoff should eventually surface incompatible paths explicitly, e.g.:

```text
PATH INCOMPATIBLE WITH WINDOWS
.../Adaptiv's Playbook: 100+ Near-Guaranteed Wins....pdf
':' cannot be represented in a Windows filename
```

### Rejected behavior

Do not silently rename the user's files. That would break references and make the local and remote trees semantically different.

The safe remedies are user rename, targeted exclusion, or selecting a compatible worker/filesystem.

---

## 5. First workspace seed can be very large

**Severity:** Medium UX/performance  
**Status:** Expected architecture, poor initial UX discovered

A real initial workspace sync showed roughly:

```text
61,625 files
7.0 GB total transfer set during the first seed
```

and later the synchronized set was approximately:

```text
9,042 directories
37,317 files
4.1 GB synchronizable content
```

The difference illustrates how scanning/filtering/session state can change what is actually synchronizable.

### Decision

The large first seed is not itself a design bug. The workspace is intentionally the reusable synchronized universe.

### UX requirements

Handoff must:

- show transfer progress;
- show current phase/file when useful;
- explain that first seed is one-time per workspace-root/target;
- improve ignore defaults to avoid generated content;
- avoid making later incremental checks look like another full transfer.

---

## 6. Mutagen monitor output was too noisy for normal healthy commands

**Severity:** Resolved medium UX issue

**Status:** Fixed; monitoring is explicit-sync only

Current command startup can print full Mutagen metadata:

```text
Name: ...
Identifier: ...
Alpha:
  URL: ...
Beta:
  URL: ...
[!] Watching for changes
```

This was useful while debugging the first seed, but it was too verbose for every `hn exec`/`hn pc` once healthy. Routine handoff and execution now flush quietly; explicit `hn sync` retains monitor output.

### Desired behavior

- Initial/large work: rich progress UI.
- Small meaningful diff: concise transfer summary.
- Already healthy/idle: no Mutagen dump; continue immediately.
- Conflict/problem: exact actionable paths.

---

## 7. `hn status` shows counts, not problem paths

**Severity:** Medium  
**Status:** Known product gap

Current status can show:

```text
sync  ⚠ 1 conflict  GitHub
```

but not the actual conflict, scan problem, or transition problem.

This forced use of raw Mutagen commands during live testing.

### Required product behavior

First-class diagnostics should distinguish:

- conflicts;
- local scan problems;
- remote scan problems;
- transition/write problems;
- disconnected/halted sessions;
- cross-platform path incompatibility;
- symlink portability failures.

Future command:

```bash
hn conflicts
```

or a broader:

```bash
hn sync doctor
```

may be appropriate.

---

## 8. No first-class conflict resolution command

**Severity:** Medium  
**Status:** Deferred

Today conflict resolution requires understanding Mutagen directly.

Desired UX:

```bash
hn resolve path/to/file --local
hn resolve path/to/file --remote
```

Resolution must be explicit. Handoff must not automatically choose a side for genuine source changes.

For generated artifacts, Handoff should preferably fix the ignore policy and remove the generated conflict from synchronization rather than teach users to resolve the same junk repeatedly.

---

## 9. Workspace root removal is missing

**Severity:** Medium  
**Status:** Known CLI gap

Current workspace management supports create/add/list but not safe remove/delete.

A production removal operation must coordinate:

1. identify matching Mutagen sessions;
2. terminate them before changing/deleting endpoint files;
3. update config;
4. never propagate unintended deletions through a still-live sync session.

`hn profile disable claude` does it correctly for the roots it owns: it terminates the matching sync sessions for every configured target first, then removes the roots. `hn workspace remove-root` is still config editing alone and needs the same treatment.

Do not implement root removal as config editing alone.

---

## 10. Windows pairing currently assumes an administrator account

**Severity:** Medium  
**Status:** Known limitation

The bootstrap writes the administrators authorized-keys location and ACLs and expects an elevated PowerShell session.

A future version may support non-admin Windows accounts cleanly, but the current onboarding path is intentionally optimized for the first working native-Windows setup.

---

## 11. Worker workload tools are detected but not installed

**Severity:** Medium onboarding  
**Status:** Deferred

`hn doctor` can detect Claude, Codex, Node, etc., but Handoff does not currently install/authenticate all workload tools.

Future possibility:

```bash
hn worker setup pc
hn tools setup pc
```

This should remain explicit and should not take ownership of account credentials without user intent.

---

## 12. Literal IPv6 target cannot be encoded directly in Mutagen endpoint syntax

**Severity:** Low/Medium  
**Status:** Known transport limitation

Handoff's SSH target parser supports bracketed IPv6, but Mutagen's SCP-style endpoint representation is ambiguous for literal IPv6.

Current guidance: use an SSH hostname/alias, Tailscale MagicDNS, or `~/.ssh/config` name for synchronization targets.

---

## 13. Managed Mutagen automatic bootstrap is controller-platform-limited

**Severity:** Low for current reference setup  
**Status:** Known support gap

The current managed release selector automatically handles supported macOS/Linux controller platform/architecture combinations. A Windows controller path is not the current proven target.

Worker platform support and controller platform support should not be conflated in documentation.

---

## 14. Remote agent Git awareness is intentionally limited

**Severity:** Low/Medium depending workload  
**Status:** Accepted v1 tradeoff

Because `.git` remains local, remote agents cannot perform all native Git operations.

Do not “fix” this by syncing `.git`.

Future solution: a deliberate local Git bridge/API that exposes selected repository information/actions to the remote agent.

---

## 15. Controller-local MCP/browser capabilities are not automatically available remotely

**Severity:** Medium for advanced agent workflows  
**Status:** Deferred

A remote Claude process does not automatically inherit MCP servers or browser integrations running only on the controller.

Future work should bridge these intentionally.

Do not broadly sync global AI auth/config/cache directories as a workaround.

`hn profile enable claude` is not that workaround. It shares an allowlist of capability files with trusted targets and carries no auth, MCP state, or cache.

---

## 16. Portable agent profile is proven on the reference Windows worker

**Severity:** Resolved live-hardware gap
**Status:** Implemented and proven on the Lenovo

The August 27, 2026 Lenovo canary proved:

- one standalone file outside the workspace synchronized Mac to Windows and back without sharing its parent;
- all 249 canonical agent-skill names matched between Mac and Windows;
- all 261 portable Claude-skill names matched after excluding macOS `.DS_Store`;
- representative skill, subagent, and hook SHA-256 hashes matched byte-for-byte;
- links crossing profile roots were reconstructed as Windows junctions, including the absolute `superpowers` link;
- interactive Claude opened in the mapped Handoff directory and `/skills` reported 262 discovered skills;
- the worker retained its own Claude credentials and Windows statusline configuration.

The important boundary remains: machine settings, authentication, MCP state, plugin installation state, history, sessions, and caches are not portable profile data. Individual skills can still depend on programs that must be installed separately on the worker.

---

## 17. Current exact sync state from the real reference workspace

The real synchronization session that surfaced the above problems used:

```text
Synchronization mode: Two Way Resolved (alpha/controller authoritative on collisions)
Hashing: default SHA-1
Symbolic links: portable
Ignore VCS: enabled
Watch mode: portable
Scan mode: accelerated
Remote compression: DEFLATE
```

The historical v1 state included:

```text
local scan problems: 25
remote transition problems: 1
conflicts: 1
```

This is valuable product evidence: Handoff's safety gate correctly prevented starting remote Claude while the workspace was not clean.

The next step is not to disable the gate; it is to improve ignores and problem-resolution UX until a normal workspace stays healthy.
