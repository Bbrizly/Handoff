# Known issues and live-hardware findings

This file records issues that have been observed or are known from the current implementation. It is intentionally concrete so future debugging does not rediscover the same failures.

Severity terminology:

- **Blocker** — prevents the golden path.
- **High** — unsafe or materially bad UX.
- **Medium** — important production gap, workaround exists.
- **Low** — polish/coverage gap.

## 1. Zellij persistence was never proven, and is gone

**Severity:** Closed in 0.2.0

Managed native-Windows Zellij persistence never passed its close-terminal/reattach proof. Live forensics found the cause: WMI detachment worked, but a Session 0 attached Zellij anchor received closed input, its `cmd.exe` pane exited, and the server printed `Bye from Zellij!` about 260 ms after startup, so the next connection found nothing.

Herdr replaced it as the `-p` persistent desk (HN-067). The legacy `hn session`, `hn new`, `hn attach`, and `hn sessions` commands and all Zellij code were removed in 0.2.0. See HN-076.

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

---

## 18. The persistent desk still has no human hours in it

Every mechanical step is proven on the reference Lenovo: install, detached server, four projects, no duplicates, long-running processes surviving closed SSH sessions, Claude detected with a state, and the TUI rendering over Handoff's PTY with mouse tracking on.

Measured on 2026-08-28 across repeated `hn pc -p` and `hn pc -p claude` runs with a forced disconnect between each:

```text
claude processes   33740, 29692   unchanged across 4 attach/detach cycles
herdr server       37628          unchanged
herdr clients      exactly 1 at any time, the previous one is evicted
projects           4, same ids, same focus
agents             2, same pane ids, one per project
```

`hn pc -p claude` focused the Claude already running in the project rather than starting a second one, every time.

What has not happened is a person living in it: clicking through the sidebar for an afternoon, answering a blocked agent, closing the Mac for an hour and coming back. Until that happens the feature is proven, not lived in.

Also open:

- **worker reboot is untested.** Nobody has rebooted the Lenovo and run `hn pc -p` afterwards. Herdr restores projects, tabs, panes, and cwd; arbitrary processes do not come back, and agent conversation resume needs Herdr's optional integrations, which Handoff does not install. Do not record this as solved;
- terminal history across a server restart is deliberately left off. Saved screen contents can hold tokens and prompts;
- moving a running `herdr.exe` aside leaves the old file locked by the running server until the desk restarts. Testing on 2026-08-28 left one such file behind; it clears on the next desk restart.

Closed by testing on 2026-08-28:

- **executable paths with spaces.** `pane run` was documented as not handling them. It does. Proven with `C:\Users\Lenovo\AppData\Local\Temp\hn space test\my node.exe` plus arguments containing spaces, which returned `arg with spaces|second arg`. A separate limitation is real and belongs to Windows PowerShell 5.1, not Handoff: an argument containing double quotes is mangled when PowerShell passes it to a native executable;
- **`hn: SSH command failed (255)` on every detach.** See HN-071. Closing an attachment now checks the desk and reports it as a detach.

---

## 19. Persistent mode inspects terminal output on the worker

The desk recognizes agents and their states by looking at what panes are printing on that machine. That is how `blocked`, `working`, `done`, and `idle` are known at all.

That state stays on the worker. Handoff does not collect it, and nothing is uploaded anywhere. Anyone who does not want terminal inspection should not use `-p`; plain `hn pc` does none of it.

---

## 20. Handoff's managed files can be deleted on the worker, and are put back

Handoff caches per worker that its managed Claude files and profile links are in place. That cache is a speed hint, not a fact about the worker, and it was possible for the worker to drift from it silently.

The launch now verifies and repairs once. Live-tested on 2026-08-28 by deleting each asset on the Lenovo and launching:

```text
~/.hn/claude-statusline.cjs   deleted -> restored, sha256 matches the controller copy
~/.hn/claude-settings.json    deleted -> restored, absolute path intact
one projected junction        deleted -> re-projected, 73 back to 74
~/.hn/bin/herdr/0.8.2/herdr.exe  removed -> reinstalled under a running desk
```

Both `hn pc claude` and `hn pc -p claude` recover. See HN-072 and HN-073.

Not covered by this mechanism, on purpose: anything Mutagen owns. A missing synchronized file is a sync problem and `hn sync doctor` is the tool for it.

---

## 21. Skill file validity is not Handoff's claim

Codex on the controller reported thirteen gstack `SKILL.md` files missing required YAML frontmatter. Those files synchronize correctly and are byte-identical on both machines. They are invalid upstream.

Handoff reports `7 roots synchronized` and stops there. It does not edit third-party or personal skill content to make its own diagnostics green. See HN-075.

---

## 22. No NUL artifact from the managed Windows statusline

An earlier Windows statusline command carried a `2>NUL` redirect. PowerShell does not treat `NUL` as a device, so that creates a file called `NUL` in whatever directory Claude was started from.

The current command has no redirect at all:

```text
node "C:/Users/Lenovo/.hn/claude-statusline.cjs"
```

Verified on 2026-08-28 after many statusline refreshes. A recursive scan of `%USERPROFILE%`, `~/hn`, `~/.hn`, and `~/.claude` found zero files named `NUL`. A unit test asserts the generated settings script and command contain no `NUL` redirect.

---

## 23. A Herdr flag Handoff got wrong, and the check that now guards them

`hn pc -p` failed on the Lenovo on 2026-08-30:

```text
hn: Herdr command failed (pane process-info wF:p1): unknown option: wF:p1
```

`herdr pane process-info` takes `--pane <ID>`. Every neighbouring command takes the id positionally (`pane run <PANE_ID>`, `agent focus <target>`, `workspace focus <workspace_id>`), so the call site matched its neighbours instead of the help text. The path is Windows-only and runs during desk bootstrap, so no controller test could reach it.

All eleven other Herdr command lines were checked against the pinned 0.8.2 binary and are correct.

`test/integration/herdr.integration.test.js` now downloads pinned Herdr on the controller and runs `--help` for every command Handoff builds, asserting the positional count and each flag. It runs in CI on ubuntu and macos. Reverting the fix fails it.

---

## 24. Three faults, one symptom: the desk's Claude had no statusline

`hn pc -p` on the Lenovo opened Claude with no statusline and no `Alt+Backspace` at the shell prompt, while plain `hn pc` had both. Found on 2026-08-30. Three separate faults stacked up, and each one alone was enough to cause it.

**The oversized PowerShell transport did nothing and said it worked.** A script too big for `-EncodedCommand`, even gzip-compressed, used to travel on ssh stdin to `powershell.exe -Command -`. On the reference worker PowerShell read it, ran nothing, printed nothing, and exited 0. Proven by bisection: the same three `Set-Content` statements ran fine one or two at a time (encoded transport) and vanished as a set of three (stdin transport):

```text
toml            len 877   encode code 0 "ok-toml"
toml+cmd        len 1075  encode code 0 "ok-toml ok-cmd"
toml+cmd+shell  len 4511  stdin  code 0 ""
```

`ensureHerdrConfig` is the only script Handoff builds that is that big, which is why nothing else showed it. Oversized scripts now go over scp and run from a file. Calling the file with `&` or `-File` is blocked by the worker's execution policy, and blocked with an error record that leaves the exit code at 0, so the runner reads the file and runs it as a scriptblock instead, then deletes it.

**The desk never refreshed its own files.** `config.toml`, the pane shell shim `hn-powershell.cmd`, and `shell.ps1` ship with Handoff, not with the pinned Herdr binary. `runPersistentDesk` only reached `ensureHerdrConfig` through `ensureHerdrInstalled`, which is skipped when the binary is already there. Every worker that had ever run Herdr kept the older files. On the Lenovo, `~/.hn/shell.ps1` and `~/.hn/bin/hn-powershell.cmd` did not exist at all and `config.toml` had no `[terminal]` section.

**The pane process probe read the wrong field.** `herdr pane process-info` answers with `result.process_info.foreground_processes`. The code read `result.foreground_processes`, always got an empty list, and treated that as "this pane is busy". `bootstrapIdleWindowsPane` therefore returned false for every pane that ever existed.

Verified on the reference macOS controller and native Windows worker on 2026-08-30. After the fixes, a bootstrapped idle pane reports:

```text
Function|C:\Users\Lenovo\.hn\claude-settings.json|C:\Users\Lenovo\.agents\skills;C:\Users\Lenovo\.claude\skills
```

`claude` is Handoff's wrapper function rather than the bare executable, the managed settings path is set, and both skill directories are on `--add-dir`.

## 25. The thin Herdr client rendered but could not be typed into, and what fixed it

Found 2026-08-30 on the reference macOS controller and native Windows worker. The
thin transport opened a real desk on the Mac, drew the whole sidebar and pane, and
then ignored every key. Fixed the same day by changing which SSH channel carries
the bytes. Kept here because the failure looked like a dead link and was not one.

**Windows OpenSSH drops an exec channel's stdin once the command is running.** The
first bridge was `ssh worker powershell.exe -EncodedCommand <byte pump>` with no
tty. The remote side gets whatever stdin was buffered before it started and nothing
after. Proven with a bare echo command, one byte at a time:

```text
[+0ms]    sending IMMEDIATE-early (1B)
[+369ms]  handle=System.IO.__ConsoleStream canread=True
[+429ms]  GOT 1 at 17:12:43.982
[+1502ms] sending t1.5s (1B)        <- never arrives
[+3005ms] sending t3s (1B)          <- never arrives
[+4506ms] sending t4.5s-big (1537B) <- never arrives
```

Three host processes, same worker:

```text
powershell.exe, no tty   early yes  late no
cmd.exe /c findstr       early no   late no
powershell.exe with -tt  early yes  late yes
```

Only a ConPTY session keeps stdin alive, which is why the legacy `ssh -tt` desk
types fine. `-tt` cannot rescue a byte bridge: a ConPTY echoes, rewrites CR/LF and
injects its own escapes.

**The symptom read as a dead connection but the link was healthy.** Relay byte
counts show the handshake landing in the pre-start buffer, the server answering
with a full frame, then keystrokes going up forever with nothing coming back:

```text
576ms   UP 1537     client handshake
996ms   DOWN 16139  full first frame
8722ms  UP 13       these are real keys: the client log parses
10760ms UP 9        Down and Ctrl+B correctly before sending them
12799ms UP 7
15292ms DOWN 5387   'herdr workspace focus' run over ssh, not typed
19819ms DOWN 9802   'herdr workspace focus' run over ssh, not typed
```

**Two smaller faults were found on the way, neither of them the cause.**
`thinServerCompatible` required `capabilities.detached_server_daemon`, which Herdr
0.8.2 reports false on every platform, so thin mode could never engage at all. And
the bridge copied the pipe into a redirected console stdout with `CopyToAsync`,
which holds small writes.

**The fix is a different channel, not a better pump.** See HN-077. `ssh -L` publishes
the renderer's Unix socket and sshd forwards it to a loopback-only helper on the
worker, which copies bytes to the existing named pipe. A bare echo helper carried
the exact traffic pattern that killed the old bridge:

```text
immediate 64B                  exact echo in 63ms
after 1.5s 64B                 exact echo in 21ms
after another 1.5s 64B         exact echo in 21ms
after another 2s 4096B         exact echo in 21ms
after another 6s 2048B         exact echo in 21ms
```

Then the real desk, through `hn pc -p` with `HN_HERDR_TRANSPORT=thin`. Every key
produced a screen update, including after a five second pause:

```text
typing "alpha beta"      10 keys, 86 to 114 bytes back each
ctrl-w word delete       114 bytes, "beta" gone from the line
left / right arrow       43 bytes each
up arrow, history        930 bytes
ctrl-c                   181 bytes
25 character burst       227 bytes
enter                    141 bytes
resize 40x120 -> 50x150  19896 bytes, full reflow
ctrl-b prefix            556 bytes, prefix bar drawn
```

Worker state across four attaches and one hard `SIGKILL` of the whole controller
process group: Herdr server still PID 27548 started 08/29 22:50:37, firewall rules
890 before and after, no `~/.herdr/remote`, no staged helper script left in the home
directory, no leftover loopback listener, and the Claude settings hash unchanged at
`1B57348504C1BB52A29E32EF192C3F75762FF030B0C79BA8E2D6D0EBAA72CA23`.

**Still not proven.** Option+Backspace. The pinned 0.8.2 client maps `ESC BS`
(`\x1b\x08`) to a word delete and drops `ESC DEL` (`\x1b\x7f`), which is what
Terminal.app and iTerm2 send by default. Legacy passes the bytes straight through to
PSReadLine instead, so the two transports differ here. A headless pty cannot settle
it: the client negotiates the Kitty keyboard protocol with a real terminal and never
did with the harness, so the encoding a real user sends was never tested. Needs a
human at a real terminal.

**Unrelated but in the way.** The shared `ControlMaster` socket for the worker went
stale and answered `mux_client_request_session: session request failed: Session open
refused by peer` while still reporting `Master running`. Every command over it, and
every `-L` through it, failed until it was removed. The thin attach now opens its own
connection, so it is immune, but ordinary `hn` commands are not.

---

## 26. The correct thin transport still leaves server-rendering latency

**Severity:** High UX if perceptible in daily use
**Status:** Provisional mitigation implemented; human A/B gate open

HN-077 fixed the Windows input boundary. The official v0.8.2 client now types correctly over SSH direct-tcpip, survives controller disconnects without killing the worker desk, and keeps the same server PID. That does not mean the terminal feels local: the official server still owns terminal state/rendering and sends screen updates across the network.

PR #21 adds an explicit `HN_HERDR_TRANSPORT=mirror` experiment using the separately pinned `rrnewton/herdr@20a0cd5294fb15ef17209612d80d5a2704169990` mirror runtime. Its local client keeps a terminal emulator and scrollback on the Mac while the separate Windows server continues owning PTYs/processes. Control and raw terminal data use two forwarded sockets. The official v0.8.2 desk is not replaced.

Mechanical evidence is green: exact checksums, macOS arm64/x64 and Windows builds, Corresponding Source publication, repository tests, Runtime Integration, and a Windows CI smoke that starts the custom server from Handoff's Windows runtime layout, creates a ConPTY pane, runs a command, and reads the output back.

Still unproven and therefore not claimable:

- materially lower perceived typing latency than stable thin/legacy;
- Option+Backspace in a real Zed terminal and inside Claude;
- mouse/sidebar and rapid resize feel;
- local scrollback/search/selection feel;
- Claude statusline/workspace parity;
- detach/reattach and controller-terminal-close persistence on the reference Lenovo;
- the official v0.8.2 server PID remaining unchanged through mirror dogfood.

The exact A/B procedure and rollback are in `RESPONSIVE_HERDR_DOGFOOD.md`. Do not make mirror the default until those checks pass.
