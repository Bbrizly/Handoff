# hn

Local files. Compute anywhere.

```text
Mac                                  pc / home / aws
---                                  ---------------
Zed + local files                    SSH reachable
local .git                      SSH  Zellij
hn + Mutagen  ---------------------> Claude / Codex / builds
localhost       <------------------- dev servers
```

## Product docs

The canonical product and engineering specification lives in [`docs/`](./docs/README.md):

- [`docs/PRD.md`](./docs/PRD.md) — what Handoff is, requirements, scope, non-goals, and success criteria.
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — controller/worker, sync, Git, sessions, Windows, networking, and security architecture.
- [`docs/DECISIONS.md`](./docs/DECISIONS.md) — accepted, rejected, deferred, and still-unproven design decisions.
- [`docs/CLI.md`](./docs/CLI.md) — `hn` command and UX contract.
- [`docs/KNOWN_ISSUES.md`](./docs/KNOWN_ISSUES.md) — real hardware findings and current blockers.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — ordered path to v1 and later capabilities.

When changing the product architecture, update the decision ledger instead of relying on chat/history as the source of truth.

## Setup

The controller needs Node 20+ and SSH/SCP. On first sync, `hn` downloads the pinned official Mutagen v0.18.1 release directly from GitHub, verifies it against the release's SHA256SUMS, and keeps the binary plus its agent bundle under `~/.hn/bin`. Homebrew is not required for Mutagen.

A worker needs the tools you actually want to run there (Claude, Codex, Node, Python, etc.). `hn` manages SSH pairing and injects a pinned, checksum-verified Zellij binary. Windows does not need WSL or a manual Zellij install.

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

## Daily use

```bash
hn          # status
hn pc       # switch locally to pc (instant)
hn home     # use home
hn aws      # use aws
```

From a local project:

```bash
cd ~/GitHub/Palmier
hn claude
hn codex
hn npm run dev
```

Before starting a remote command, `hn` synchronizes every workspace root and waits for a Mutagen sync cycle to finish. It refuses to start remote work when conflicts or an unhealthy sync are detected. Claude and Codex automatically receive the other workspace roots through `--add-dir`.

On Windows, `hn` prefers real application shims (`.exe`, `.cmd`, `.bat`) over PowerShell `.ps1` wrappers. This avoids common execution-policy failures from npm-installed tools such as Codex, Claude, and npm without weakening the machine's PowerShell policy.

A normal command reattaches its persistent project/target session. Start another independent session with:

```bash
hn new claude
```

Other useful commands:

```bash
hn shell
hn exec npm test
hn sessions
hn attach <session>
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
- x64 and arm64 where an official Zellij build exists

Windows does **not** require WSL.

## Current caveat

Mutagen documents historical performance/stalling issues with Microsoft's Windows OpenSSH server. The architecture avoids extra Windows setup, but real performance still depends on the actual Windows SSH endpoint. `hn doctor` checks connectivity and required worker tools.

Native-Windows persistent Zellij sessions are still under live-hardware validation; see [`docs/KNOWN_ISSUES.md`](./docs/KNOWN_ISSUES.md) for the exact current state rather than assuming the persistence path is already proven.

## Third-party software

See `THIRD_PARTY_NOTICES.md`.
