import { runPosix, runPowerShell, testSsh } from "./ssh.js";
import { fail, quotePosix, quotePowerShell } from "./util.js";

function normalizeArch(value) {
  const arch = String(value ?? "").trim().toLowerCase();
  if (["x86_64", "amd64", "x64"].includes(arch)) return "x64";
  if (["aarch64", "arm64"].includes(arch)) return "arm64";
  return arch || "unknown";
}

export function detectWorker(worker) {
  const posix = runPosix(
    worker,
    'printf "%s|%s" "$(uname -s)" "$(uname -m)"',
    { capture: true, allowFailure: true, timeoutMs: 8000 },
  );
  if (posix.code === 0) {
    const [system, arch] = posix.stdout.trim().split("|");
    const normalizedSystem = String(system ?? "").toLowerCase();
    if (normalizedSystem === "linux" || normalizedSystem === "darwin") {
      return { platform: normalizedSystem, arch: normalizeArch(arch) };
    }
  }

  const windows = runPowerShell(
    worker,
    '[Console]::Out.Write("windows|" + $env:PROCESSOR_ARCHITECTURE)',
    { capture: true, allowFailure: true, timeoutMs: 8000 },
  );
  if (windows.code === 0 && windows.stdout.toLowerCase().startsWith("windows|")) {
    const [, arch] = windows.stdout.trim().split("|");
    return { platform: "windows", arch: normalizeArch(arch) };
  }

  fail(`Could not detect the operating system on ${worker.target}.`);
}

export function remotePathExpression(remotePath) {
  if (/^[a-zA-Z]:[\\/]/.test(remotePath)) return quotePowerShell(remotePath);
  return `(Join-Path $HOME ${quotePowerShell(remotePath.replaceAll("/", "\\"))})`;
}

export function ensureRemoteDirectories(worker, remotePaths) {
  const paths = [...new Set(remotePaths.filter(Boolean))];
  if (!paths.length) return;

  if (worker.platform === "windows") {
    const lines = paths.map((path) => `New-Item -ItemType Directory -Force -Path ${remotePathExpression(path)} | Out-Null`);
    runPowerShell(worker, `$ErrorActionPreference = 'Stop'\n${lines.join("\n")}`);
    return;
  }

  const values = paths.map(quotePosix).join(" ");
  const script = `
for hn_path in ${values}; do
  case "$hn_path" in
    /*) hn_abs="$hn_path" ;;
    *) hn_abs="$HOME/$hn_path" ;;
  esac
  mkdir -p -- "$hn_abs"
done
`;
  runPosix(worker, script);
}

export function ensureRemoteDirectory(worker, remotePath) {
  ensureRemoteDirectories(worker, [remotePath]);
}

// Reaching a worker must never install a persistence runtime. A plain
// 'hn pc' pays for SSH and platform detection, nothing else.
export function prepareWorkerCore(worker, { quiet = false } = {}) {
  const ssh = testSsh(worker);
  if (ssh.code !== 0) fail(`Cannot SSH to ${worker.target}. ${(ssh.stderr || ssh.stdout).trim()}`);

  const metadata = worker.platform && worker.arch ? worker : { ...worker, ...detectWorker(worker) };
  if (!quiet) console.log(`ready  ${metadata.platform}/${metadata.arch}`);
  return metadata;
}

export function windowsDoctorScript() {
  return `
$claude = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$codex = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$claudeAuth = $false
if ($claude) {
  & $claude.Source auth status *> $null
  $claudeAuth = $LASTEXITCODE -eq 0
}
$statuslineScript = Join-Path $HOME '.hn\\claude-statusline.cjs'
$statuslineSettings = Join-Path $HOME '.hn\\claude-settings.json'
$statusline = (Test-Path -LiteralPath $statuslineScript -PathType Leaf) -and (Test-Path -LiteralPath $statuslineSettings -PathType Leaf)
if ($statusline) {
  try { $statusline = [bool]((Get-Content -LiteralPath $statuslineSettings -Raw | ConvertFrom-Json).statusLine.command) } catch { $statusline = $false }
}
$chrome = [bool](Get-Command chrome -CommandType Application -ErrorAction SilentlyContinue)
if (-not $chrome) {
  $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $chrome = (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'Google\\Chrome\\Application\\chrome.exe')) -or
    ($programFilesX86 -and (Test-Path -LiteralPath (Join-Path $programFilesX86 'Google\\Chrome\\Application\\chrome.exe'))) -or
    (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'Google\\Chrome\\Application\\chrome.exe'))
}
@{
  claude = [bool]$claude
  claudeAuth = $claudeAuth
  codex = [bool]$codex
  node = [bool]$node
  statusline = $statusline
  chrome = $chrome
} | ConvertTo-Json -Compress
`;
}

// Claude's own inventory is the only thing that describes its effective MCP
// configuration; a scan of whichever JSON files Handoff guesses at does not.
// Only names and connection status leave the worker. The command column can
// carry tokens in a URL or an env value, so it is never read or printed.
export function parseMcpList(output) {
  const servers = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s*([^:\s][^:]*?)\s*:.*?-\s*\S*\s*(Connected|Failed to connect|Needs authentication|Disconnected)/i);
    if (match) servers.push({ name: match[1].trim(), ok: /^connected$/i.test(match[2]) });
  }
  return servers;
}

// Its own round trip with its own budget: 'claude mcp list' dials every server,
// so a slow one must not slow the rest of doctor down or hide it.
export function doctorMcp(worker) {
  const options = { capture: true, allowFailure: true, timeoutMs: 30000 };
  const result = worker.platform === "windows"
    ? runPowerShell(worker, `
$claude = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $claude) { exit 3 }
& $claude.Source mcp list 2>&1
`, options)
    : runPosix(worker, 'command -v claude >/dev/null 2>&1 || exit 3; claude mcp list 2>&1', options);

  if (result.code === 3) return { available: false, reason: "claude not on the worker", servers: [] };
  if (result.code === 124) return { available: false, reason: "claude mcp list timed out", servers: [] };
  if (result.code !== 0) return { available: false, reason: "claude mcp list failed", servers: [] };
  return { available: true, reason: "", servers: parseMcpList(result.stdout) };
}

export function doctorWorker(worker) {
  const ssh = testSsh(worker);
  const checks = {
    ssh: ssh.code === 0,
    platform: worker.platform ?? "unknown",
    arch: worker.arch ?? "unknown",
    claude: false,
    claudeAuth: false,
    codex: false,
    node: false,
    statusline: false,
    chrome: false,
    mcp: { available: false, reason: "not checked", servers: [] },
  };
  if (!checks.ssh) return checks;

  const metadata = worker.platform && worker.arch ? worker : { ...worker, ...detectWorker(worker) };
  checks.platform = metadata.platform;
  checks.arch = metadata.arch;
  if (metadata.platform === "windows") {
    const script = windowsDoctorScript();
    const result = runPowerShell(metadata, script, { capture: true, allowFailure: true, timeoutMs: 20000 });
    if (result.code === 0) {
      try { Object.assign(checks, JSON.parse(result.stdout.trim())); } catch {
        checks.diagnostic = result.stdout.trim().slice(0, 300);
      }
    } else {
      checks.diagnostic = (result.stderr || result.stdout).trim().slice(0, 300);
    }
    if (checks.claude) checks.mcp = doctorMcp(metadata);
    else checks.mcp = { available: false, reason: "claude not on the worker", servers: [] };
    return checks;
  }

  const result = runPosix(
    metadata,
    `for c in claude codex node; do if command -v "$c" >/dev/null 2>&1; then printf "%s=1\\n" "$c"; else printf "%s=0\\n" "$c"; fi; done
if command -v claude >/dev/null 2>&1 && claude auth status >/dev/null 2>&1; then printf 'claudeAuth=1\\n'; else printf 'claudeAuth=0\\n'; fi
if [ -f "$HOME/.hn/claude-statusline.cjs" ] && [ -f "$HOME/.hn/claude-settings.json" ]; then printf 'statusline=1\\n'; else printf 'statusline=0\\n'; fi
if command -v google-chrome >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 || [ -d '/Applications/Google Chrome.app' ]; then printf 'chrome=1\\n'; else printf 'chrome=0\\n'; fi`,
    { capture: true, allowFailure: true, timeoutMs: 20000 },
  );
  if (result.code === 0) {
    for (const line of result.stdout.trim().split(/\r?\n/)) {
      const [name, value] = line.split("=");
      if (name in checks) checks[name] = value === "1";
    }
  }
  checks.mcp = checks.claude
    ? doctorMcp(metadata)
    : { available: false, reason: "claude not on the worker", servers: [] };
  return checks;
}
