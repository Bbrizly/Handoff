# Handoff Product Requirements Document

Status: Canonical product contract  
Product: **Handoff**  
CLI: **`hn`**  
Current implementation series at time of writing: **0.1.x**

## 1. Product summary

Handoff makes another computer feel like invisible development horsepower attached to the computer the developer already uses.

The developer keeps their normal editor, local files, local Git repository, local terminal entry point, and local browser. Handoff synchronizes an explicitly chosen workspace to an SSH-reachable worker and runs expensive or long-lived work there: AI coding agents, compilers, tests, Docker, local models, CUDA/ML workloads, video processing, development servers, and arbitrary commands.

The intended feeling is:

> Open the project locally, type `hn pc`, and continue in the corresponding directory on the worker as if the compute were local.

Handoff is not a remote IDE. It is not a VPN. It is not a cloud filesystem. It is not a replacement for Git. It is the execution layer between a developer's local environment and their compute.

## 2. Problem

Developers increasingly have more compute than fits on one machine:

- a lightweight laptop used for daily work;
- a powerful desktop at home;
- a gaming/ML laptop with a GPU;
- a workstation on a LAN;
- a cloud VM or GPU instance;
- future provider-managed machines such as AWS resources.

Existing workflows force the developer to think about infrastructure:

- manually SSH into the machine;
- remember remote paths;
- keep repositories cloned in two places;
- push/pull just to move unfinished changes;
- deal with remote `.git` state;
- manually establish tunnels;
- restart commands after disconnects;
- keep terminal multiplexers configured on every OS;
- use a remote IDE that moves the editor and repository away from the local machine;
- treat Windows as a second-class worker or install WSL purely for infrastructure tooling.

The result is that remote compute feels like another computer to manage instead of an extension of the computer already in front of the developer.

## 3. Core user

The primary user is a developer who:

- wants to edit locally in their preferred editor;
- owns or can reach one or more other machines;
- wants those machines to run AI agents and heavy development workloads;
- wants local Git to remain authoritative;
- does not want a cloud-hosted development environment to become mandatory;
- wants Windows, Linux, macOS, LAN, Tailscale, VPN, and cloud SSH targets to fit the same mental model.

The first real reference setup is:

```text
Controller
macOS laptop
- local editor
- local source tree
- canonical .git
- hn
- Mutagen

Worker
native Windows laptop
- OpenSSH Server
- Zellij
- Claude / Codex
- Node / build tools
- optional GPU workloads
```

The product must generalize beyond this setup without compromising it.

## 4. Product principles

### 4.1 Local-first

The user's normal machine remains home base. Source files and Git history are not moved into a proprietary cloud environment.

### 4.2 Compute is replaceable

A workspace is independent of a specific worker. Switching from `pc` to `home` or `aws` should not change how the project is opened or edited locally.

### 4.3 Infrastructure should disappear

A routine command should not require a manual SSH login, remote `cd`, Git push/pull, tunnel setup, or session-manager ceremony.

### 4.4 Safe by default

Handoff must refuse ambiguous/destructive synchronization rather than silently choose a side. Conflicts are product state, not an edge case to hide.

### 4.5 Native Windows is first-class

Windows workers must not require WSL merely to make Handoff function. A Windows user should be able to use OpenSSH + native tools.

### 4.6 Existing tools over reinvention

Handoff coordinates proven primitives instead of rebuilding them:

- SSH for reachability and command transport;
- Mutagen for synchronized workspaces and forwarding;
- the worker's native shell for the daily interactive experience;
- Zellij as an optional persistence layer;
- Git remains Git;
- Tailscale/LAN/VPN/cloud networking remains outside Handoff.

### 4.7 Short daily UX

The product may do substantial work underneath, but the daily interface should remain tiny:

```bash
hn
hn pc
claude
codex
npm run dev
hn port 5173
```

## 5. Naming

Accepted:

- Product name: **Handoff**
- CLI binary: **`hn`**

The CLI is intentionally shorter than the product name because it is typed constantly. `handoff` is too long for the daily command surface. Do not change the CLI back to the product name.

## 6. Mental model

Handoff has four primary concepts.

### 6.1 Controller

The machine where the developer is sitting.

The controller owns:

- local source files;
- the canonical `.git` repository;
- workspace configuration;
- active worker selection;
- Mutagen controller state;
- the `hn` CLI;
- the local browser/editor experience.

### 6.2 Worker / target

An SSH-reachable compute machine with an alias such as:

```text
pc
home
aws
```

The target may be Windows, Linux, or macOS. The alias is a local ergonomic name, not a special provider type.

### 6.3 Workspace

A workspace is the **synchronized universe the developer intentionally wants available to remote agents and commands**.

A workspace can contain multiple non-overlapping roots:

```text
main
  ~/Documents/GitHub  <-> ~/hn/main/GitHub
  ~/Obsidian          <-> ~/hn/main/Obsidian
  ~/Downloads         <-> ~/hn/main/Downloads
```

Important: the accepted design is **not** lazy project-only synchronization. The initial root seed may be large, but after the persistent Mutagen session is established, normal operation transfers differences rather than re-copying the entire workspace for each command.

A root is a directory or one regular file. A file root shares exactly that file, so a single document can be available remotely without exposing its folder.

A root can also be marked trusted-only. Those roots never synchronize to a target marked `remote`, which is how personal agent capability files stay off shared or rented machines.

### 6.4 Project

The project is the current local Git/project directory inside one workspace root. It determines command working directory and persistent session identity, but it does not redefine the workspace synchronization boundary.

This distinction is deliberate:

```text
workspace = what the remote agent may need access to
project   = where this command/session starts
```

## 7. Golden-path user experience

### 7.1 First-time install

```bash
git clone https://github.com/Bbrizly/Handoff.git
cd Handoff
npm link
```

Handoff should minimize prerequisite installation. Today it self-manages pinned Mutagen and Zellij components where implemented.

### 7.2 Pair a native Windows worker

On controller:

```bash
hn worker pair pc Lenovo@100.x.x.x
```

Handoff produces one administrator PowerShell command.

On Windows, the user pastes that command once. It installs/enables OpenSSH Server if required and installs the controller's SSH public key with Windows-correct ACLs.

Back on controller:

```bash
hn worker finish pc
hn doctor pc
```

The setup must not require WSL.

If SSH key authentication already works:

```bash
hn worker add pc user@host
```

### 7.3 Define workspace

```bash
hn workspace add main ~/Documents/GitHub
```

Optional additional roots:

```bash
hn workspace add main ~/Obsidian
hn workspace add main ~/Downloads
```

### 7.4 Seed synchronization

```bash
hn sync main
```

The first sync may copy gigabytes. This is an initialization cost for that workspace-root/target pair, not an expected cost for every agent session.

Handoff must expose meaningful progress during this operation:

- current file when available;
- files transferred / total;
- bytes transferred / total;
- percent when available;
- current Mutagen phase;
- clear success/failure state.

A bare `syncing main -> pc...` with no feedback for a long initial seed is unacceptable UX.

### 7.5 Daily handoff

```bash
hn pc
hn home
hn aws
```

From a local project, a target alias means "take me there":

1. ensure and flush the configured workspace synchronization;
2. open a real interactive SSH PTY to that worker;
3. map the current local directory to its corresponding remote directory;
4. enter the worker's normal native shell there.

Changing the selected target without connecting is explicit:

```bash
hn use pc
hn worker default pc
```

Direct interactive execution is allowed:

```bash
hn aws claude
```

This connects to `aws`, enters the mapped directory, and runs Claude directly with the SSH PTY. It does not implicitly create a Zellij session or change the selected target.

### 7.6 Transparent remote terminal

From a local project:

```bash
cd ~/Documents/GitHub/Handoff
hn pc
```

Expected behavior:

1. resolve workspace/project/explicit target;
2. ensure worker is usable;
3. ensure every workspace root's persistent synchronization session exists/resumes;
4. flush synchronization and refuse unsafe state;
5. map local working directory to remote path;
6. allocate a real interactive SSH PTY;
7. enter native PowerShell on Windows or the user's login shell on POSIX;
8. let the user run Claude, Codex, npm, Docker, Zellij, or any other worker tool normally.

### 7.7 Optional managed persistence

```bash
hn pc -p
hn pc -p claude
```

`-p` opens the persistent desk. It runs on Herdr, installs on first use, and is not required for the transparent terminal or direct command paths. Closing an attachment leaves the desk and its processes running; `hn pc -p` returns to them.

```bash
hn session
hn session claude
hn session new claude
```

These are the older Zellij surface. They are legacy, scheduled for removal, and are not the persistence Handoff offers today. Users may also run a multiplexer themselves inside `hn pc`.

### 7.7a Claude's appearance on a worker

Handoff starts Claude with its own settings file and never writes the worker's `~/.claude/settings.json`. That settings file gives the worker's Claude the controller's own statusline: same segments, order, colours, context and usage percentages, model and directory formatting. The branch and dirty-state segments degrade to dim placeholders because `.git` stays on the controller.

### 7.8 Arbitrary remote work

Interactive on the selected target:

```bash
hn npm run dev
hn python train.py
hn shell
```

Explicit target:

```bash
hn pc npm run dev
```

One-shot:

```bash
hn exec npm test
```

### 7.9 Port access

Explicit forwarding:

```bash
hn port 5173
hn port 3000 3001
```

Meaning:

```text
remote 127.0.0.1:5173 -> controller 127.0.0.1:5173
remote 127.0.0.1:3000 -> controller 127.0.0.1:3001
```

Automatic port discovery is deferred; explicit forwarding is the v1 contract.

## 8. Functional requirements

### FR-1: SSH-reachable workers

Handoff must support a worker anywhere SSH works. The network route may be Tailscale, LAN, VPN, public internet, or a cloud network.

Handoff must not require or implement its own VPN.

### FR-2: Worker aliases

Workers are addressed by local aliases. Aliases must map deterministically to a single SSH endpoint.

Duplicate aliases pointing to the same endpoint should be rejected because one machine should have one canonical target name in config.

### FR-3: Cross-platform workers

Worker support target:

- Windows x64, native;
- Linux x64/arm64;
- macOS x64/arm64 where supported by the pinned runtime dependencies.

### FR-4: Workspace mapping

A workspace contains one or more local-to-remote root mappings. Local roots and remote roots must not overlap with any other configured workspace root.

Default remote roots live beneath `hn/<workspace>/...` in the remote user's home directory.

### FR-5: Persistent bidirectional sync

Each workspace-root/target tuple uses a persistent Mutagen `two-way-resolved` session with the controller/alpha side authoritative only for simultaneous collisions.

Requirements:

- `.git` is excluded;
- the first seed is allowed to be large;
- subsequent synchronization should be incremental;
- sessions should survive/recover across normal controller restarts/reconnections;
- duplicate named sessions should be repaired deterministically;
- Handoff must not start remote work while a conflict or materially unhealthy state exists.

### FR-6: Synchronization feedback

Long synchronization cannot appear hung. Handoff should render Mutagen progress during meaningful transfer/scanning/staging work and become quiet once healthy and idle.

### FR-7: Conflict visibility

Status must eventually expose the actual conflicting/problem paths, not only a count.

Desired UX:

```text
sync  ⚠ 1 conflict · GitHub
      Quadstick-Config-Manager/.../QuadStickConfigManager.dll
      generated artifact; both endpoints changed
```

Future explicit resolution UX:

```bash
hn conflicts
hn resolve <path> --local
hn resolve <path> --remote
```

Remote-only changes still return to the controller. If both sides independently change the same path before reconciliation, the controller/alpha version wins automatically by the accepted sync policy.

### FR-8: Git ownership

The controller's `.git` is canonical and never synchronizes to workers.

Remote tools operate on the synchronized working tree. Their edits return to the controller and appear as ordinary local Git modifications.

A worker is not required to maintain its own repository clone.

### FR-9: Agent workspace access

When a workspace has multiple roots, Handoff should make those synchronized roots available to supported coding agents.

Current strategy:

- Claude receives additional roots via `--add-dir`;
- Codex receives repeated `--add-dir` arguments;
- management/admin subcommands must not be polluted with workspace directory arguments;
- `codex exec` receives `--skip-git-repo-check` because the worker intentionally lacks `.git`.

Personal profile roots are deliberately excluded from `--add-dir`. They belong at the worker's home paths where the agent already looks for them, not in the project directory list.

### FR-10: Interactive terminal and optional persistent sessions

The core terminal must be a real interactive SSH PTY in the mapped remote directory and must not depend on Zellij.

Zellij remains the selected optional session backend behind `SessionBackend`. Managed persistence should survive terminal disconnects when invoked explicitly with `hn session`, but failure of that optional backend must not block `hn pc`, direct interactive commands, or `hn exec`.

Session identity must be stable for the same:

- workspace;
- target;
- project;
- command arguments;
- workspace root mapping set.

`hn session new ...` adds a unique token.

Exited/stale sessions should be repaired rather than endlessly reattached.

### FR-11: Native Windows command handling

On Windows, Handoff must prefer application shims (`.exe`, `.cmd`, `.bat`) over PowerShell `.ps1` shims where possible so restrictive PowerShell execution policies do not break normal npm-installed CLIs.

PowerShell transport must not require weakening the machine's execution policy.

### FR-12: Worker bootstrap

Handoff should own infrastructure dependencies required by Handoff itself.

Current examples:

- pinned checksum-verified Zellij on workers;
- pinned checksum-verified Mutagen on the controller;
- Windows OpenSSH onboarding.

Development tools such as Claude, Codex, Node, Python, CUDA, Docker, and model runtimes are user/workload tools. Automatic setup of them is a future product layer, not assumed today.

### FR-13: Diagnostics

`hn doctor` must show whether the active worker has:

- SSH;
- Zellij;
- Claude;
- Codex;
- Node;
- controller-side Mutagen.

Future diagnostics should include synchronization problems and persistent-session viability.

### FR-14: Portable agent profile

A worker should feel like the user's own machine, not a stock install.

```bash
hn profile enable claude
```

adds the portable parts of the local Claude setup to the workspace: canonical skill trees, Claude skills, subagents, commands, rules, hooks, output styles, and `~/.claude/CLAUDE.md`.

Requirements:

- the path list is an allowlist, never all of `~/.claude`;
- credentials, settings, MCP auth, plugins, history, sessions, and caches stay on the controller;
- profile roots are trusted-target only;
- built tool output inside a profile directory still synchronizes, because a skill's `dist/` is the skill;
- cross-root skill links are reconstructed on the worker without overwriting an existing path;
- plain Claude and Codex commands in the transparent Windows shell can access every shared workspace root;
- `hn profile disable claude` terminates the sync sessions and removes the roots.

### FR-15: Explain what is shared

The user must be able to ask about any path:

```bash
hn access ~/GitHub/app/.env
```

Handoff answers shared with the remote path, local only with the reason, or outside every workspace.

## 9. Non-functional requirements

### NFR-1: No silent data loss

Safety overrides convenience whenever source-of-truth is ambiguous.

### NFR-2: Low daily latency

After first-time workspace initialization, `hn pc` should feel close to opening a local shell when there are few/no pending changes.

### NFR-3: Minimal Windows ceremony

Native Windows setup should require at most a one-time elevated bootstrap, after which normal Handoff operation is unprivileged.

### NFR-4: Reproducible infrastructure

Managed third-party binaries must be version pinned and checksum verified.

### NFR-5: No hidden cloud dependency

Core Handoff must function entirely with machines the user controls plus their chosen SSH route. No Handoff-hosted backend is required for the core product.

### NFR-6: Observable failures

Errors must preserve the real underlying diagnostic. Generic messages such as “could not be inspected” are insufficient when the tool can expose stdout/stderr/state.

## 10. Security and privacy requirements

- SSH authentication is the trust boundary for remote execution.
- Handoff should reuse normal SSH key semantics rather than invent credentials.
- Private key material must remain on the controller.
- Config containing machine endpoints lives under `~/.hn` with restrictive permissions where applicable.
- `.git` remains controller-only.
- Handoff must not broadly synchronize user-global AI configuration/auth/cache directories such as `~/.claude`.
- An explicit allowlist of portable agent capability files may synchronize to trusted targets only, and never carries credentials, settings, MCP auth, or caches.
- Project-local agent instructions/configuration may synchronize when inside an explicit workspace root.
- The user must be able to inspect what is shared and why, without reading the sync configuration.
- Opening a port means forwarding only the requested loopback endpoint by default, not exposing the worker service publicly.

## 11. Current implementation snapshot

At the time this document was created, the code already implements:

- config v4 under `~/.hn/config.json` with migration from `~/.handoff/config.json`;
- global active target;
- worker add/pair/finish/bootstrap/doctor/list;
- Windows OpenSSH bootstrap;
- workspace create/add/list, with directory or single-file roots;
- non-overlapping root validation;
- persistent Mutagen root sessions using `two-way-resolved` and `--ignore-vcs`;
- managed Mutagen v0.18.1 bootstrap on supported controller platforms;
- live Mutagen monitor output during single-session flushes;
- duplicate Mutagen session repair;
- manual Mutagen forwarding;
- pinned Zellij 0.45.0 worker bootstrap;
- stable persistent session naming;
- transparent mapped SSH PTY handoff through target aliases;
- direct interactive commands without implicit Zellij;
- explicit optional persistence through `hn session`;
- Claude/Codex multi-root augmentation;
- Windows application-shim preference;
- oversized PowerShell transport fallback to SSH stdin;
- one-shot remote execution;
- opt-in trusted-only Claude profile roots through `hn profile`;
- `hn access` sharing explanation;
- status and doctor commands.

The transparent core path is physically proven on native Windows: `hn pc` entered `C:\Users\Lenovo\hn\main\GitHub\Handoff`, Node returned `win32 x64`, Claude and Codex opened interactively, a Vite dev server ran remotely, and `hn port` exposed it through Mac localhost.

The `-p` persistent desk is proven on the same machine: project switching, agent reuse without duplicates, survival across repeated disconnects, and recovery when a managed file or the Herdr binary is deleted. Worker reboot recovery is not tested. Optional managed native-Windows Zellij creation was never proven and is legacy.

## 12. Proven real-world synchronization lessons

A real workspace seed exposed issues that must shape the product rather than be treated as random local failures.

### 12.1 Generated build outputs must not sync

A real conflict occurred on:

```text
Quadstick-Config-Manager/src/QuadStick.App/obj/Release/net8.0/QuadStickConfigManager.dll
```

This is generated build output and should never have been in the synchronization set. Default ignore policy must expand beyond the current list to include common generated roots such as `bin/` and `obj/` and environment caches such as `.venv/`/`venv/`.

### 12.2 Portable symlink mode rejects absolute symlinks

Real scan problems appeared inside project-local Claude/gstack skill trees because absolute symlinks are invalid under Mutagen's portable symlink mode.

The product should not blindly ignore all `.claude` content because project-local instructions and skills may be required by remote agents. Resolution should be targeted: relative symlinks where practical, or targeted ignores for generated agent/worktree structures that cannot be portable.

### 12.3 Windows filenames differ from macOS

A real file containing `:` in its filename could not be materialized on Windows:

```text
Adaptiv's Playbook: 100+ Near-Guaranteed Wins to Build Unstoppable Momentum.pdf
```

A workspace targeting Windows must surface cross-platform-incompatible paths clearly. Handoff cannot faithfully create an NTFS-invalid filename and must not pretend otherwise.

### 12.4 Workspace roots can be large

A first real seed involved tens of thousands of files and multiple gigabytes. This is acceptable as a one-time seed because the accepted product model is a reusable synchronized workspace, but the progress UX must make the transfer observable and the ignore policy must prevent obviously generated content from bloating it.

## 13. Success criteria

Handoff v1 is successful when the following workflow is boring and reliable:

```bash
cd ~/Documents/GitHub/Project
hn pc
```

And all of the following are true:

1. the controller's local editor remains the primary editor;
2. the terminal is a real native worker shell in the corresponding mapped directory;
3. the project and allowed workspace roots are already synchronized or incrementally reconciled;
4. Claude edits appear back on the controller quickly;
5. local edits appear on the worker quickly;
6. `.git` exists only on the controller;
7. Claude, Codex, npm, Docker, Python, and Zellij can be invoked normally inside that shell;
8. direct forms such as `hn pc claude` run interactively without implicit session management;
9. changing worker does not require changing projects or editor configuration;
10. a remote dev server is reachable with `hn port`;
11. conflicts and incompatible paths are visible and safe;
12. Windows workers require no WSL.

## 14. Explicit non-goals for v1

Handoff v1 is not:

- a remote IDE/editor;
- a hosted SaaS workspace filesystem;
- a custom VPN or overlay network;
- a Git hosting/repository replication system;
- an automatic Git bridge;
- a container orchestration platform;
- a cloud provider abstraction layer;
- an automatic dev-port scanner;
- a universal toolchain installer;
- a replacement for Claude/Codex configuration/authentication;
- a general consumer remote desktop product.

## 15. Deferred capabilities

These are compatible with the architecture but intentionally not part of the core v1 contract:

- automatic Git-awareness bridge for remote agents without copying `.git`;
- automatic port discovery;
- AWS/provider provisioning and lifecycle integrations;
- toolchain installation (`hn worker setup` / `hn tools setup`);
- MCP bridge from controller-local MCP servers/browser integrations to remote agents;
- first-class sync conflict inspection/resolution commands;
- first-class workspace root removal/migration;
- automatic cross-platform filename remediation;
- richer local daemon/background UX if needed for instant status and orchestration.
- production-ready managed native-Windows session persistence beyond the transparent PTY core.

## 16. Product guardrails

Future changes must preserve these invariants unless an explicit product decision supersedes them:

1. **Handoff stays local-first.**
2. **`hn` stays the daily CLI.**
3. **The controller owns `.git`.**
4. **Workers are ordinary SSH-reachable machines.**
5. **Tailscale is optional, not embedded into the product.**
6. **Native Windows does not require WSL.**
7. **Workspace roots represent the user's remote-access universe; project context does not silently shrink that universe.**
8. **Remote-only changes sync back; only simultaneous collisions prefer the controller/alpha side.**
9. **The transparent terminal never depends on a session manager; persistence is optional.**
10. **Core Handoff does not require a Handoff-hosted backend.**
