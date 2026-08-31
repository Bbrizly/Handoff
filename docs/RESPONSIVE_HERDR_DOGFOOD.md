# Responsive Herdr mirror dogfood

This validates the experimental local-terminal data plane without changing the proven official Herdr v0.8.2 desk.

## What is isolated

`HN_HERDR_TRANSPORT=mirror` uses a separate pinned Herdr runtime built from `rrnewton/herdr@20a0cd5294fb15ef17209612d80d5a2704169990` (0.7.4 / protocol 17). It has a distinct binary directory, config directory, local client state, and session name. The normal `auto`, `thin`, and `legacy` paths stay on official Herdr v0.8.2.

```text
Mac / Zed terminal
  -> pinned responsive Herdr --mirror client
  -> private herdr.sock + herdr-client.sock Unix forwards
  -> Handoff SSH policy / ControlMaster
  -> two loopback-only, same-user Windows pipe bridges
  -> pinned responsive Herdr server on Windows
  -> persistent Windows panes / Claude / Codex / builds
```

The Windows server remains authoritative for process/session ownership. The Mac mirror owns terminal interpretation, scrollback, selection, search, keyboard handling, mouse handling, and resize rendering.

## Prepare the stacked dogfood checkout

The responsive branch is stacked on `feat/local-herdr-thin-client`; do not replace your normal checkout.

```bash
cd "$HOME/Documents/GitHub/Handoff"
git fetch origin

DOGFOOD="$HOME/.hn/dogfood/Handoff-mirror"
if [ -d "$DOGFOOD" ]; then
  git -C "$DOGFOOD" fetch origin
  git -C "$DOGFOOD" checkout --detach origin/feat/herdr-responsive-data-plane
else
  git worktree add --detach "$DOGFOOD" origin/feat/herdr-responsive-data-plane
fi

cd "$DOGFOOD"
npm test
npm run check
export HN="$DOGFOOD/src/index.js"
```

## Prove the normal worker first

From the real Handoff project on the Mac:

```bash
cd "$HOME/Documents/GitHub/Handoff"
node "$HN" worker list
node "$HN" doctor pc
node "$HN" sync
```

The normal official desk must still work:

```bash
HN_HERDR_TRANSPORT=thin node "$HN" pc -p
```

Detach with `Ctrl+B`, then `q`.

## Capture the official and responsive server processes

On Windows before mirror mode:

```powershell
Get-Process herdr -ErrorAction SilentlyContinue |
  Select-Object Id,StartTime,Path |
  Sort-Object Id
```

Then on the Mac run the explicit mirror path:

```bash
HN_HERDR_TRANSPORT=mirror node "$HN" pc -p
```

First use downloads checksum-pinned controller/worker binaries and starts a **separate** `-mirror-20a0cd5` desk. It must not stop or replace the official v0.8.2 server.

While the mirror is open, in a second Mac terminal:

```bash
pgrep -fl 'herdr-mirror|herdr-responsive|ssh'
ls -ld /tmp/hn-herdr-mirror-* 2>/dev/null || true
```

On Windows, run the process listing again. The original official Herdr PID/start time must still be present; one separate responsive Herdr server is expected.

## Human interaction gate

Inside the responsive desk test all of these in an ordinary PowerShell pane and then in Claude:

- type continuously: characters must appear without the old server-rendering drag;
- Option+Backspace deletes one word, not the whole line;
- arrows, Ctrl+C, paste;
- rapid Zed terminal resize;
- mouse/sidebar/project switching;
- scrollback, selection, and search should be local-feeling;
- run `claude`; Handoff statusline/workspace roots must still be present;
- detach and reattach with the same mirror command; the responsive Windows desk/processes must survive;
- close the Mac terminal entirely, open a new one, and reattach; the responsive Windows server and Claude PIDs must be unchanged.

For an A/B comparison use the same project and network:

```bash
HN_HERDR_TRANSPORT=legacy node "$HN" pc -p
HN_HERDR_TRANSPORT=thin   node "$HN" pc -p
HN_HERDR_TRANSPORT=mirror node "$HN" pc -p
```

## Failure interpretation

- `thin` good + `mirror` faster: the replicated local terminal data plane is the right latency architecture.
- `thin` good + `mirror` same: remaining delay is network/input acknowledgment, not server terminal rendering.
- `mirror` fails before opening: install/protocol/socket/SSH-forward preflight; the official desk is untouched.
- `mirror` disconnects while the Windows responsive server PID survives: transport failure, not persistence failure.
- official v0.8.2 server PID changes during mirror attach: stop; that violates the isolation boundary.

## Rollback

No uninstall is required. Stop using the explicit environment variable:

```bash
node "$HN" pc -p
```

That returns to the normal official v0.8.2 `auto` path. The responsive runtime lives only under Handoff-owned `~/.hn/bin/herdr-mirror/`, `~/.hn/herdr-mirror/`, and `~/.hn/herdr/local-mirror/` paths.

## Completion gate

```text
[ ] normal thin desk still works
[ ] mirror opens a separate responsive desk
[ ] official v0.8.2 server PID/start time unchanged
[ ] local responsive Herdr process is visible on Mac
[ ] Option+Backspace correct in shell
[ ] Option+Backspace correct in Claude
[ ] typing materially more local-feeling than thin/legacy
[ ] resize/mouse/sidebar correct
[ ] local scrollback/search/selection correct
[ ] Claude Handoff statusline/workspace parity correct
[ ] detach/reattach preserves responsive desk
[ ] controller terminal close preserves responsive desk
[ ] no runtime-only Herdr override fields persisted into worker config
```
