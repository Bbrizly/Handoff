# Thin Herdr hardware dogfood

This is the physical Mac -> native Windows proof for PR #20. It is intentionally conservative: do not merge, do not modify `main`, and do not treat a worker reboot as a process-persistence test.

## 1. Protect the repository first

Run this in the existing Handoff checkout on the Mac:

```bash
git status --short
git fetch origin
git rev-parse main
git rev-parse origin/main
git rev-parse origin/feat/local-herdr-thin-client
```

If the working tree has unrelated changes, stop before switching branches or resetting anything. Never discard or stash user work automatically.

For the cleanest dogfood environment, create a detached worktree from the feature branch **outside every synchronized workspace** so the normal checkout, `main`, and the shared project tree are untouched:

```bash
DOGFOOD="$HOME/.hn/dogfood/Handoff-thin"
mkdir -p "$(dirname "$DOGFOOD")"
git worktree add --detach "$DOGFOOD" origin/feat/local-herdr-thin-client
cd "$DOGFOOD"
node --version
npm test
npm run check
HN="$DOGFOOD/src/index.js"
```

Node must be 20 or newer. Do not place this worktree under `~/GitHub` (or another configured Handoff root), because that would synchronize the dogfood checkout back to the worker and create a useless extra project.

The runner can be invoked from any real synchronized project without installing/linking this checkout globally.

## 2. Confirm the existing Handoff worker before changing anything

Change back to the actual project you want to test inside the configured Handoff workspace, for example:

```bash
cd ~/GitHub/Handoff
```

Then:

```bash
node "$HN" worker list
node "$HN" doctor pc
node "$HN" sync
```

If `pc` is not the target alias, substitute the configured Windows target name everywhere below.

Do not re-pair or reinstall OpenSSH when key-based SSH and `doctor` are already healthy.

For a genuinely new Windows worker, follow the normal Handoff onboarding instead:

```bash
node "$HN" worker pair pc WINDOWS_USER@WINDOWS_HOST
# Paste the one printed command into elevated Windows PowerShell.
node "$HN" worker finish pc
node "$HN" doctor pc
```

## 3. Check the one thin-transport-specific Windows prerequisite

On Windows PowerShell, inspect the OpenSSH default shell without changing it:

```powershell
$old = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell
if ([string]::IsNullOrWhiteSpace([string]$old)) { '<unset: Windows OpenSSH uses cmd.exe>' } else { $old }
```

Thin mode currently accepts:

- unset/default `cmd.exe`;
- `cmd.exe`;
- PowerShell 7 `pwsh.exe`.

It intentionally rejects Windows PowerShell 5.1 `powershell.exe` as the OpenSSH `DefaultShell` for the raw byte path.

Only if the current value is `powershell.exe` and thin mode is needed, back it up first. Prefer PowerShell 7 when installed:

```powershell
$old = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell
$old | Set-Content "$HOME\hn-openssh-defaultshell-before-thin.txt"
$pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
$new = if ($pwsh) { $pwsh.Source } else { "$env:WINDIR\System32\cmd.exe" }
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $new -PropertyType String -Force | Out-Null
Restart-Service sshd
$new
```

Rollback, if this change was made:

```powershell
$old = Get-Content "$HOME\hn-openssh-defaultshell-before-thin.txt" -ErrorAction SilentlyContinue
if ([string]::IsNullOrWhiteSpace([string]$old)) {
  Remove-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue
} else {
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $old -PropertyType String -Force | Out-Null
}
Restart-Service sshd
```

After any intentional shell change, re-run `node "$HN" doctor pc` from the Mac before continuing.

## 4. Establish the proven legacy baseline first

From the project being tested on the Mac:

```bash
HN_HERDR_TRANSPORT=legacy node "$HN" pc -p
```

This proves the existing server/desk path before the renderer changes. If this is the first persistent run, Handoff may install the pinned official Herdr runtime on the worker.

Detach using Herdr's normal prefix (`Ctrl+B`, then `q`). The desk must remain alive.

Immediately record the Windows server process and the worker's normal Claude settings hash in Windows PowerShell:

```powershell
Get-Process herdr -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path
$p = "$HOME\.claude\settings.json"
if (Test-Path -LiteralPath $p) { Get-FileHash -LiteralPath $p -Algorithm SHA256 } else { 'CLAUDE_SETTINGS_MISSING' }
```

Keep this output. The thin attach must not replace the persistent server or mutate the worker's global Claude settings.

## 5. Force the new local renderer

From the same Mac project:

```bash
HN_HERDR_TRANSPORT=thin node "$HN" pc -p
```

Do not use `auto` for this proof. `thin` makes an unavailable/incompatible local renderer fail explicitly instead of falling back before launch.

While the TUI is open, use a second Mac terminal:

```bash
pgrep -fl 'herdr-client/0\.8\.2/herdr|herdr-relay\.js'
lsof -U | grep 'hn-herdr' || true
```

Expected on the Mac:

- official Herdr client under `~/.hn/bin/herdr-client/0.8.2/herdr`;
- `herdr-relay.js`;
- one private `hn-herdr` Unix socket.

On Windows, re-run:

```powershell
Get-Process herdr -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path
```

The persistent server PID and start time recorded after the legacy baseline must still be present. Thin mode should not create a second Windows Herdr client/runtime.

## 6. Input and rendering proof

In an ordinary Herdr PowerShell pane, test all of these before starting an agent:

```text
type: alpha beta
press Option+Backspace  -> beta disappears, alpha remains
arrow keys              -> normal cursor/history behavior
Ctrl+C                   -> normal shell interrupt
paste plain text         -> exact text arrives
resize the Zed terminal  -> Herdr redraws correctly
mouse/sidebar            -> project and pane selection works
```

The important regression is Option+Backspace. It must feel like the outer Zed terminal, because input is now interpreted by the local Herdr client rather than the Windows TUI path.

## 7. Manual Claude parity proof

From the Herdr shell, type manually:

```text
claude
```

Verify inside the real Claude UI:

- the Handoff statusline is present;
- Handoff's additional workspace roots are available;
- Option+Backspace works in Claude input;
- normal paste/arrow/Ctrl+C behavior is intact.

Exit Claude back to the same Herdr shell, then type `claude` again. The Handoff-managed behavior must still be present because the shell bootstrap is scoped to the persistent pane.

Now leave one Claude running, detach, and run from the Mac:

```bash
HN_HERDR_TRANSPORT=thin node "$HN" pc -p claude
```

It must focus/reuse the existing Claude in that project rather than start a duplicate.

On Windows, compare the Claude process list before and after if needed:

```powershell
Get-Process claude -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path
```

## 8. Persistence proof

With Claude still running:

1. detach with `Ctrl+B`, then `q`;
2. re-run `HN_HERDR_TRANSPORT=thin node "$HN" pc -p`;
3. verify the same project, pane, and Claude are still there;
4. close the Mac/Zed terminal without stopping the Windows worker;
5. open a new terminal and re-run the thin command;
6. verify the Windows Herdr server PID and Claude PID did not change.

For a stronger transport-drop test, interrupt only the controller attachment or briefly disconnect/reconnect the controller network/Tailscale, then reattach. Do not reboot the worker for this test: arbitrary processes are not expected to survive a Windows reboot.

## 9. Worker-state integrity proof

After all thin tests, re-run on Windows:

```powershell
Get-Process herdr -ErrorAction SilentlyContinue | Select-Object Id,StartTime,Path
$p = "$HOME\.claude\settings.json"
if (Test-Path -LiteralPath $p) { Get-FileHash -LiteralPath $p -Algorithm SHA256 } else { 'CLAUDE_SETTINGS_MISSING' }
```

Expected:

- original persistent Herdr server PID/start time unchanged across legacy -> thin attachment;
- worker `~/.claude/settings.json` hash exactly unchanged;
- no `~/.herdr/remote` was created by this implementation;
- no `herdr-win` process or binary is involved.

Optional Windows check:

```powershell
Test-Path "$HOME\.herdr\remote"
```

If that path predates this test, do not delete it automatically; only establish that Handoff did not create/modify it.

## 10. Compare thin against legacy

Use the same project and same network state for both:

```bash
HN_HERDR_TRANSPORT=legacy node "$HN" pc -p
HN_HERDR_TRANSPORT=thin   node "$HN" pc -p
```

Compare:

- time until usable UI;
- typing latency;
- Option+Backspace;
- resize responsiveness;
- mouse/sidebar responsiveness;
- Claude prompt latency.

The thin path is successful only if it preserves the persistence semantics while making local interaction materially closer to a native/local terminal.

## 11. Failure interpretation

`Local Herdr thin client is unavailable: ... DefaultShell ...` means the Windows OpenSSH shell gate failed before the local client launched. Do not blame Herdr persistence or restart the desk.

A protocol/session/version incompatibility means the preflight intentionally refused to attach to a server other than the exact Handoff-owned session.

A non-zero local Herdr client exit after launch is a real thin-transport error. It must not be hidden by retrying the legacy path.

If legacy works and thin fails, preserve the running Windows server and collect the exact Mac stderr plus the unchanged Windows server PID before changing anything.

## 12. Completion gate

Do not merge PR #20 until the physical proof records:

```text
[ ] legacy baseline works
[ ] thin local Herdr client is visibly running on Mac
[ ] Windows persistent Herdr server PID unchanged
[ ] Option+Backspace works in shell
[ ] Option+Backspace works in Claude
[ ] manual `claude` has Handoff statusline/workspace access
[ ] `pc -p claude` reuses existing Claude
[ ] detach/reattach preserves Claude and pane
[ ] closing controller terminal preserves Windows work
[ ] worker global Claude settings hash unchanged
[ ] no Handoff-created ~/.herdr/remote / herdr-win runtime
[ ] thin interaction is at least as correct and materially more local-feeling than legacy
```
