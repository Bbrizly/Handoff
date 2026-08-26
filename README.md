# Handoff

Local-first remote execution: edit locally, execute remotely.

```text
Mac                                Windows worker
---                                --------------
Zed + local files                  Tailscale
local .git                    SSH  OpenSSH
Handoff CLI  --------------------> Zellij
Mutagen      <-------------------> Claude / Codex / builds
localhost    <-------------------- dev servers
```

## Prototype setup

Requirements on the Mac: Node 20+, SSH, and Homebrew. The CLI installs Mutagen through Homebrew on first use if Mutagen is missing.

The Windows machine only needs Tailscale and a working OpenSSH server to start. Handoff bootstraps its own pinned Zellij binary into the remote user's home directory automatically.

```bash
npm link

handoff worker add lenovo YOUR_WINDOWS_USER@YOUR_TAILSCALE_IP
handoff workspace create main lenovo
handoff workspace add main ~/GitHub

cd ~/GitHub/your-project
handoff claude
```

The first remote command will:

1. verify SSH,
2. install Handoff's private Zellij binary on Windows if needed,
3. create/resume a Mutagen two-way-safe sync with VCS metadata excluded,
4. create or reattach a persistent Zellij session,
5. run the command from the matching remote path.

Any unrecognized Handoff command is treated as a persistent remote command, so these work from inside a configured root:

```bash
handoff claude
handoff codex
handoff npm run dev
handoff npm test
```

For a one-shot command:

```bash
handoff exec npm test
```

Forward a remote dev server to the same local port:

```bash
handoff port 5173
```

Or map ports explicitly:

```bash
handoff port 3000 3001
```

## Git model

`.git` is intentionally **not synchronized**. Git remains authoritative on the local machine. Remote tools edit the synchronized working tree; those edits appear locally as ordinary Git changes.

## Current scope

- macOS controller
- native Windows worker over SSH
- multi-root workspaces
- Mutagen two-way-safe synchronization
- `.git` excluded
- persistent Zellij sessions
- arbitrary remote commands
- manual localhost forwarding

Automatic port discovery, menu-bar UI, arbitrary outside-file sharing, native macOS/Linux worker adapters, and a packaged installer are later milestones.

## Third-party software

Handoff does not vendor Mutagen or Zellij in this repository. See `THIRD_PARTY_NOTICES.md` for details.
