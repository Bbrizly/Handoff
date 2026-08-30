import { fileURLToPath } from "node:url";
import { copyToWorker, runPosix, runPowerShell } from "./ssh.js";
import { quotePosix, quotePowerShell } from "./util.js";
import { ensureRemoteDirectory } from "./worker.js";

export const HANDOFF_STATUSLINE_VERSION = 5;
export const HANDOFF_STATUSLINE_REMOTE = ".hn/claude-statusline.cjs";
export const HANDOFF_CLAUDE_SETTINGS_REMOTE = ".hn/claude-settings.json";
export const HANDOFF_CLAUDE_SETTINGS_TOKEN = "__HN_CLAUDE_SETTINGS__";

const STATUSLINE_LOCAL = fileURLToPath(new URL("../assets/claude-statusline.cjs", import.meta.url));
const SETTINGS_POSIX_LOCAL = fileURLToPath(new URL("../assets/claude-settings-posix.json", import.meta.url));

export function claudeStatuslineCommand(worker) {
  if (worker.platform === "windows") {
    return 'node "%USERPROFILE%\\.hn\\claude-statusline.cjs"';
  }
  return 'node "$HOME/.hn/claude-statusline.cjs" 2>/dev/null';
}

export function claudeStatuslineSettings(worker) {
  return JSON.stringify({
    statusLine: {
      type: "command",
      command: claudeStatuslineCommand(worker),
      refreshInterval: 30,
    },
  });
}

export function handoffClaudeSettingsArgument() {
  return HANDOFF_CLAUDE_SETTINGS_TOKEN;
}

export function windowsStatuslineSettingsScript() {
  return `$ErrorActionPreference = 'Stop'
$hnStatusline = (Join-Path $HOME '.hn\\claude-statusline.cjs').Replace('\\', '/')
$hnSettings = @{
  statusLine = @{
    type = 'command'
    command = ('node "' + $hnStatusline + '"')
    refreshInterval = 30
  }
}
$hnSettings | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $HOME '.hn\\claude-settings.json') -Encoding utf8
`;
}

// What a launch expects to still be there: the two managed files, plus every
// projected profile link, checked by exact path and exact target. A count lets
// a stray junction stand in for a missing one, and never sees a wrong target.
export function managedExpectation(links = []) {
  return { links: links.map(({ link, target }) => ({ link, target })) };
}

export const MANAGED_REPAIR_MARKER = "hn-repair";

// Prints the marker when one of Handoff's managed files is gone. It never
// exits non-zero: 'ssh -tt' to a Windows worker does not return the remote exit
// code, so a marker on stdout is the only signal that survives the trip.
export function managedAssetGuardScript(worker, expectation = { links: [] }) {
  const links = expectation.links ?? [];
  if (worker.platform === "windows") {
    const list = links
      .map(({ link, target }) => quotePowerShell(
        `${link.replaceAll("/", "\\")}|${target.replaceAll("/", "\\")}`,
      ))
      .join(", ");
    return `$hnOk = (Test-Path -LiteralPath (Join-Path $HOME '.hn\\claude-statusline.cjs') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $HOME '.hn\\claude-settings.json') -PathType Leaf)
foreach ($hnPair in @(${list})) {
  if (-not $hnOk) { break }
  $hnParts = $hnPair -split '\\|', 2
  $hnItem = Get-Item -LiteralPath (Join-Path $HOME $hnParts[0]) -Force -ErrorAction SilentlyContinue
  if (-not ($hnItem -and $hnItem.LinkType -eq 'Junction' -and ($hnItem.Target -contains (Join-Path $HOME $hnParts[1])))) { $hnOk = $false }
}
if (-not $hnOk) { Write-Output '${MANAGED_REPAIR_MARKER}' }
`;
  }

  const checks = links
    .map(({ link, target }) => `[ "$(readlink "$HOME"/${quotePosix(link)} 2>/dev/null)" = "$HOME"/${quotePosix(target)} ] || hn_ok=0`)
    .join("\n");
  return `hn_ok=1
[ -f "$HOME/.hn/claude-statusline.cjs" ] || hn_ok=0
[ -f "$HOME/.hn/claude-settings.json" ] || hn_ok=0
${checks}
[ "$hn_ok" = 1 ] || echo ${MANAGED_REPAIR_MARKER}
`;
}

// One cheap round trip before a launch, in place of trusting the cache blindly.
// The persistent desk gets the same answer for free from its own probe.
export function managedAssetsNeedRepair(worker, expectation) {
  const script = managedAssetGuardScript(worker, expectation);
  const options = { capture: true, allowFailure: true, timeoutMs: 15000 };
  const result = worker.platform === "windows"
    ? runPowerShell(worker, script, options)
    : runPosix(worker, script, options);
  return result.stdout.includes(MANAGED_REPAIR_MARKER);
}

export function ensureHandoffStatusline(worker, { force = false } = {}) {
  if (!force && worker.handoffStatuslineVersion === HANDOFF_STATUSLINE_VERSION) return worker;
  ensureRemoteDirectory(worker, ".hn");
  copyToWorker(worker, STATUSLINE_LOCAL, HANDOFF_STATUSLINE_REMOTE);
  if (worker.platform === "windows") {
    runPowerShell(worker, windowsStatuslineSettingsScript());
  } else {
    copyToWorker(worker, SETTINGS_POSIX_LOCAL, HANDOFF_CLAUDE_SETTINGS_REMOTE);
  }
  return { ...worker, handoffStatuslineVersion: HANDOFF_STATUSLINE_VERSION };
}
