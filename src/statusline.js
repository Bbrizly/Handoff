import { fileURLToPath } from "node:url";
import { copyToWorker, runPosix, runPowerShell } from "./ssh.js";
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

// What a launch expects to still be there: the two managed files, plus the
// profile junctions Handoff projected. Directories are one level deep, so the
// count is one cheap listing per directory.
export function managedExpectation(links = []) {
  const directories = [...new Set(links.map((link) => link.link.split("/").slice(0, -1).join("/")))];
  return { directories, links: links.length };
}

export const MANAGED_REPAIR_MARKER = "hn-repair";

// Prints the marker when one of Handoff's managed files is gone. It never
// exits non-zero: 'ssh -tt' to a Windows worker does not return the remote exit
// code, so a marker on stdout is the only signal that survives the trip.
export function managedAssetGuardScript(worker, expectation = { directories: [], links: 0 }) {
  const { directories = [], links = 0 } = expectation;
  if (worker.platform === "windows") {
    const list = directories.map((dir) => `'${dir.replaceAll("/", "\\")}'`).join(", ");
    return `$hnOk = (Test-Path -LiteralPath (Join-Path $HOME '.hn\\claude-statusline.cjs') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $HOME '.hn\\claude-settings.json') -PathType Leaf)
if ($hnOk -and ${links} -gt 0) {
  $hnLinks = 0
  foreach ($hnDir in @(${list})) {
    $hnPath = Join-Path $HOME $hnDir
    if (Test-Path -LiteralPath $hnPath -PathType Container) {
      $hnLinks += @(Get-ChildItem -LiteralPath $hnPath -Force -ErrorAction SilentlyContinue | Where-Object { $_.LinkType -eq 'Junction' }).Count
    }
  }
  if ($hnLinks -lt ${links}) { $hnOk = $false }
}
if (-not $hnOk) { Write-Output '${MANAGED_REPAIR_MARKER}' }
`;
  }

  const list = directories.map((dir) => `"$HOME/${dir}"`).join(" ");
  return `hn_ok=1
[ -f "$HOME/.hn/claude-statusline.cjs" ] || hn_ok=0
[ -f "$HOME/.hn/claude-settings.json" ] || hn_ok=0
if [ "$hn_ok" = 1 ] && [ ${links} -gt 0 ]; then
  hn_links=0
  for hn_dir in ${list || '""'}; do
    [ -d "$hn_dir" ] || continue
    for hn_entry in "$hn_dir"/*; do
      [ -L "$hn_entry" ] && hn_links=$((hn_links + 1))
    done
  done
  [ "$hn_links" -ge ${links} ] || hn_ok=0
fi
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
