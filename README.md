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

## Setup

The controller needs Node 20+, SSH/SCP, and Homebrew on macOS. `hn` installs Mutagen with Homebrew on first use if needed.

A worker needs SSH access plus the tools you actually want to run there (Claude, Codex, Node, Python, etc.). `hn` downloads a pinned Zellij build on the controller, verifies its SHA-256, and injects the binary over SCP. No WSL or manual Zellij install is required.

```bash
git clone https://github.com/Bbrizly/Handoff.git
cd Handoff
npm link

hn worker add pc YOUR_WINDOWS_USER@YOUR_TAILSCALE_IP
hn workspace add main ~/GitHub
hn workspace add main ~/Obsidian
hn workspace add main ~/Downloads
```

Target names are just aliases. Add any SSH-reachable machine:

```bash
hn worker add home user@home-machine
hn worker add aws ubuntu@server.example.com
```

Tailscale is optional; LAN, VPN, or any other working SSH route is fine.

## Daily use

```bash
hn          # status
hn pc       # use pc
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

`hn` synchronizes every root in the workspace. Claude and Codex automatically receive the other workspace roots through `--add-dir`.

A normal command reattaches its persistent project session. Start another independent session with:

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

## Worker support

- native Windows over OpenSSH / PowerShell
- Linux over SSH
- macOS over SSH
- x64 and arm64 where an official Zellij build exists

Windows does **not** require WSL.

## Current caveat

Mutagen documents historical performance/stalling issues with Microsoft's Windows OpenSSH server. The architecture avoids extra Windows setup, but real performance still depends on the actual Windows SSH endpoint. `hn doctor` checks connectivity and required worker tools.

## Third-party software

See `THIRD_PARTY_NOTICES.md`.
