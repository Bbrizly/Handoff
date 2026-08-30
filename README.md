# Handoff

[![CI](https://github.com/Bbrizly/Handoff/actions/workflows/ci.yml/badge.svg)](https://github.com/Bbrizly/Handoff/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Your files and your Git stay on your laptop. Your compute happens somewhere else.

Handoff (`hn`) synchronizes a workspace you choose to any SSH-reachable machine and drops you into a real shell in the matching directory. Agents, builds, tests, dev servers, and GPU work run there. Your editor, your working tree, and your `.git` never move.

```text
Mac                                  pc / home / aws
---                                  ---------------
Zed + local files                    SSH reachable
local .git                      SSH  native shell + normal tools
hn + Mutagen  ---------------------> Claude / Codex / builds
localhost       <------------------- dev servers
```

Day to day:

```bash
cd ~/GitHub/Palmier
hn pc
```

You are now in `~/hn/main/GitHub/Palmier` on the other machine, in a native shell, with the files already there.

## What it does

Handoff wires together SSH, path mapping, bidirectional sync, and port forwarding so you stop running them by hand. The controller keeps the canonical working tree and the only `.git`, so remote edits arrive locally as ordinary Git changes. A Windows worker needs OpenSSH Server and nothing else.

The scope stops there. Handoff moves commands, not your editor, your repository, or your environment. There is no Handoff server, no account, and no hosted backend, and it will not provision machines for you.

## Product docs

The canonical product and engineering specification lives in [`docs/`](./docs/README.md):

- [`docs/PRD.md`](./docs/PRD.md): what Handoff is, requirements, scope, non-goals, and success criteria.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md): controller/worker, sync, Git, sessions, Windows, networking, and security architecture.
- [`docs/DECISIONS.md`](./docs/DECISIONS.md): accepted, rejected, deferred, and still-unproven design decisions.
- [`docs/CLI.md`](./docs/CLI.md): `hn` command and UX contract.
- [`docs/KNOWN_ISSUES.md`](./docs/KNOWN_ISSUES.md): real hardware findings and current blockers.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md): ordered path to v1 and later capabilities.
- [`docs/THIN_HERDR_DOGFOOD.md`](./docs/THIN_HERDR_DOGFOOD.md): exact Mac -> Windows physical validation for the local-renderer persistent desk path.

When changing the product architecture, update the decision ledger instead of relying on chat/history as the source of truth.

## Setup

The controller needs Node 20+ and SSH/SCP. On first sync, `hn` downloads the pinned official Mutagen v0.18.1 release directly from GitHub, verifies it against the release's SHA256SUMS, and keeps the binary plus its agent bundle under `~/.hn/bin`. Homebrew is not required for Mutagen.

A worker needs the tools you actually want to run there (Claude, Codex, Node, Python, etc.). `hn` manages SSH pairing and nothing else until you ask for more. The pinned, checksum-verified persistence runtime is only installed the first time you use `-p`. Windows does not need WSL or a manual install.

```bash
git clone https://github.com/Bbrizly/Handoff.git
cd Handoff
npm link
```

### New Windows worker

On the Mac:

```bash
hn worker pair pc YOUR_WINDOWS_USER@YOUR_TAILSCALE_IP
```

`hn` reuses a normal default SSH key or creates `~/.ssh/id_ed25519` if you do not have one. It prints one PowerShell command.

On Windows, open **PowerShell as Administrator** and paste that one command. It installs/enables OpenSSH Server if needed and adds the controller key with the Windows-required ACLs.

Back on the Mac:

```bash
hn worker finish pc
hn doctor pc
```

If key-based SSH is already working, you can skip pairing:

```bash
hn worker add pc user@host
```

Target names are aliases. Add any SSH-reachable machine:

```bash
hn worker add home user@home-machine
hn worker add aws ubuntu@server.example.com
```

Tailscale is optional; LAN, VPN, or any other working SSH route is fine. For literal IPv6 targets, use an SSH hostname/alias because Mutagen's SCP-style endpoint parser cannot encode a literal IPv6 address directly.

### Workspace

Start with one root:

```bash
hn workspace add main ~/GitHub
hn sync main
```

Add more later:

```bash
hn workspace add main ~/Obsidian
hn workspace add main ~/Downloads
```

A root can also be one file, so you can share a single document without its folder:

```bash
hn workspace add main ~/notes.md hn/main/files/notes.md
```

### Your own Claude on every worker

```bash
hn profile enable claude
```

This shares the portable half of your local Claude setup: canonical skill trees, Claude skills, subagents, commands, rules, hooks, output styles, and `~/.claude/CLAUDE.md`. Remote Claude then starts with the same portable abilities as local Claude. Skill links are recreated safely on Windows, with replaced worker paths backed up under `~/.hn/backups`.

The Mac copies of credentials, `settings.json`, MCP auth, plugin state, history, sessions, and caches are never sent. The worker keeps its own account, settings, plugins, and history. Profile roots only go to targets you marked trusted, so a rented box never gets them.

```bash
hn profile list
hn profile disable claude
```

`disable` stops the sync sessions and removes the roots. Files already copied to a worker stay on that worker until you delete them there.

### What is actually shared

```bash
hn access
hn access ~/GitHub/app/.env
```

It answers with the remote path, or with the reason a path stays local, or that the path is outside every workspace.

## Daily use

```bash
hn          # status
hn pc       # synchronize, map this cwd, and open the native remote shell
hn home     # take this project context to home
hn aws      # take this project context to aws
hn use pc   # select pc without connecting
```

From a local project:

```bash
cd ~/GitHub/Palmier
hn pc
```

Or run one direct interactive command:

```bash
hn pc claude
hn pc npm run dev
```

Before starting a remote command, `hn` synchronizes every workspace root and waits for a Mutagen sync cycle to finish. It refuses to start remote work when conflicts or an unhealthy sync are detected. Claude and Codex automatically receive the other workspace roots through `--add-dir`.

On Windows, `hn` prefers real application shims (`.exe`, `.cmd`, `.bat`) over PowerShell `.ps1` wrappers. This avoids common execution-policy failures from npm-installed tools such as Codex, Claude, and npm without weakening the machine's PowerShell policy.

A target alias opens a real interactive SSH PTY in the corresponding remote directory. From there, Handoff is out of the way. In the Windows shell, plain `claude` and `codex` also receive every shared workspace directory through their native `--add-dir` options:

```bash
claude
codex
npm run dev
python script.py
docker compose up
```

Direct local forms such as `hn pc claude` use the same mapped PTY without creating a hidden session. That terminal is disposable: close it and the remote command goes with it.

Add `-p` when you want the work to stay:

```bash
hn pc -p          # same compute, persistent
hn pc -p claude
hn -p             # selected target
```

`--p` and `--persist` mean the same thing. Handoff reads the flag only before the remote command, so `hn pc npm run dev -- --persist` still passes `--persist` to npm.

That opens a desk: every synchronized project on that machine in one sidebar, with the agent in each one showing whether it is blocked, working, done, or idle. Click a project or an agent to switch. Close the terminal whenever you want; `hn pc -p` comes back to the same panes and the same running processes.

The desk runs on [Herdr](https://herdr.dev), pinned and checksum-verified like everything else Handoff installs. Nothing installs it until your first `-p`.

Closing an attachment is not an error. Handoff asks the desk whether it is still running and says so:

```text
desk still running on pc. 'hn pc -p' comes back to it
```

If the desk really is gone, it says that instead.

Persistent mode reads what panes are printing on the worker. That is how it knows an agent is blocked or working. That state stays on the worker and nothing is uploaded anywhere. Plain `hn pc` does none of it.

## Claude on a worker looks like Claude at home

When Handoff starts Claude on a worker it passes its own settings file, so the worker's own `~/.claude/settings.json` is never touched. That file gives Claude the same statusline you have locally: same segments, same order, same colours, same context and usage percentages, same model and directory formatting.

One part is honestly different. `.git` stays on the controller, so the worker has no repository to read. The branch and dirty-file segments fall back to the same dim placeholders the local script already uses when it finds no repository. Nothing is invented to fill the space.

Handoff owns two files for this, `~/.hn/claude-statusline.cjs` and `~/.hn/claude-settings.json`, plus the profile links it projects. It caches the fact that they are in place so a normal launch is fast. Before starting Claude it still asks the worker whether they are actually there, and puts back anything that went missing:

```text
worker is missing Handoff's managed Claude files; restoring...
```

Other useful commands:

```bash
hn shell
hn exec npm test
hn port 5173
hn doctor
hn sync
```

You can select and run in one command:

```bash
hn aws claude
```

## Git model

`.git` never synchronizes. Your local checkout is the authoritative Git repository. Remote tools edit the synchronized working tree; those edits appear locally as ordinary Git changes.

Because remote Codex has no `.git`, `hn` automatically supplies Codex's `--skip-git-repo-check` for `codex exec`. Full remote Git-aware agent operations are intentionally deferred to a future local Git bridge instead of maintaining a second repository.

## Worker support

- native Windows over OpenSSH / PowerShell
- Linux over SSH
- macOS over SSH
- x64 and arm64 where an official Herdr build exists

Windows does **not** require WSL.

## What is proven, and what is not

Proven on the reference setup, a macOS controller and a native Windows worker:

- the mapped interactive terminal, with Node reporting `win32 x64`, Claude and Codex opening interactively, a Vite dev server running remotely, and `hn port` exposing it through Mac localhost;
- bidirectional sync with the safety gate refusing to start remote work on an unhealthy workspace;
- the `-p` desk: project switching, agent reuse without duplicates, survival across repeated disconnects, and recovery after a managed file or the Herdr binary is deleted.

Not proven, and not claimed:

- **worker reboot.** Nobody has rebooted the worker and run `hn pc -p` afterwards. Herdr restores projects, tabs, panes, and cwd. Arbitrary processes do not come back.
- **a person living in the desk.** Every mechanical step passes. An afternoon of real use has not happened yet.
- **controllers other than macOS.** The managed Mutagen bootstrap is controller-platform-limited today.

Mutagen documents historical performance and stalling issues with Microsoft's Windows OpenSSH server. The architecture avoids extra Windows setup, but real performance still depends on the actual Windows SSH endpoint. `hn doctor` checks connectivity and required worker tools.

Deferred, and not in progress: a remote Git bridge, automatic port discovery, toolchain installation, an MCP bridge, and first-class conflict resolution commands. See [`docs/KNOWN_ISSUES.md`](./docs/KNOWN_ISSUES.md) and [`docs/ROADMAP.md`](./docs/ROADMAP.md).

## Third-party software

See `THIRD_PARTY_NOTICES.md`.

## License

MIT. See [`LICENSE`](./LICENSE).
