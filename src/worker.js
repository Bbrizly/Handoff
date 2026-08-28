import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyToWorker, runPosix, runPowerShell, testSsh } from "./ssh.js";
import { ensureCachedRelease, runLocal } from "./runtime-assets.js";
import { fail, quotePosix, quotePowerShell } from "./util.js";

export const ZELLIJ_VERSION = "0.45.0";

const ZELLIJ_ASSETS = {
  "windows:x64": {
    file: "zellij-no-web-x86_64-pc-windows-msvc.zip",
    sha256: "2c76164fd082ffa1ca815b5f4515b7a2eb45600b2e1d562650a31e9b69bd61f6",
    binary: "zellij.exe",
    archive: "zip",
  },
  "linux:x64": {
    file: "zellij-no-web-x86_64-unknown-linux-musl.tar.gz",
    sha256: "2d793377c788300256f18fa17ab251e444ba28db07b0959aca5902834c0f7efd",
    binary: "zellij",
    archive: "tar.gz",
  },
  "linux:arm64": {
    file: "zellij-no-web-aarch64-unknown-linux-musl.tar.gz",
    sha256: "73e815f6b6b37e45102488733e2afece21044219a661a88a6d6709dd0bbfe35b",
    binary: "zellij",
    archive: "tar.gz",
  },
  "darwin:x64": {
    file: "zellij-no-web-x86_64-apple-darwin.tar.gz",
    sha256: "7c51dc5c834886f54004ad4b9566f0dbd3e8f2b2f4b4c76e9c723c41c159fdbb",
    binary: "zellij",
    archive: "tar.gz",
  },
  "darwin:arm64": {
    file: "zellij-no-web-aarch64-apple-darwin.tar.gz",
    sha256: "059e5bf12e870606e88d465767a535afd517bd0d519bb0fa04d60c23110f469f",
    binary: "zellij",
    archive: "tar.gz",
  },
};

function normalizeArch(value) {
  const arch = String(value ?? "").trim().toLowerCase();
  if (["x86_64", "amd64", "x64"].includes(arch)) return "x64";
  if (["aarch64", "arm64"].includes(arch)) return "arm64";
  return arch || "unknown";
}

export function zellijAssetFor(platform, arch) {
  const normalizedPlatform = platform === "win32" ? "windows" : platform;
  return ZELLIJ_ASSETS[`${normalizedPlatform}:${normalizeArch(arch)}`] ?? null;
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

export function zellijRelativePath(worker) {
  return worker.platform === "windows" ? ".hn/bin/zellij.exe" : ".hn/bin/zellij";
}

function zellijVersion(worker) {
  if (worker.platform === "windows") {
    const script = `
$z = Join-Path $HOME '.hn\\bin\\zellij.exe'
if (-not (Test-Path $z)) { exit 1 }
& $z --version
exit $LASTEXITCODE
`;
    return runPowerShell(worker, script, { capture: true, allowFailure: true, timeoutMs: 8000 });
  }

  return runPosix(
    worker,
    'z="$HOME/.hn/bin/zellij"; [ -x "$z" ] || exit 1; "$z" --version',
    { capture: true, allowFailure: true, timeoutMs: 8000 },
  );
}

function assetFor(worker) {
  const asset = zellijAssetFor(worker.platform, worker.arch);
  if (!asset) fail(`Zellij ${ZELLIJ_VERSION} has no supported build for ${worker.platform}/${worker.arch}.`);
  return asset;
}

function ensureCachedArchive(asset) {
  return ensureCachedRelease({
    name: "zellij",
    version: ZELLIJ_VERSION,
    file: asset.file,
    url: `https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/${asset.file}`,
    sha256: asset.sha256,
  });
}

function extractZellij(asset, archivePath) {
  const dir = mkdtempSync(join(tmpdir(), "hn-zellij-"));
  if (asset.archive === "zip") {
    runLocal("unzip", ["-oq", archivePath, "-d", dir]);
  } else {
    runLocal("tar", ["-xzf", archivePath, "-C", dir]);
  }
  const binary = join(dir, asset.binary);
  if (!existsSync(binary)) {
    rmSync(dir, { recursive: true, force: true });
    fail(`Zellij archive did not contain ${asset.binary}.`);
  }
  if (asset.binary === "zellij") chmodSync(binary, 0o755);
  return { dir, binary };
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

export function ensurePersistenceRuntime(metadata, { quiet = false } = {}) {
  const current = zellijVersion(metadata);
  if (current.code === 0 && current.stdout.includes(ZELLIJ_VERSION)) {
    if (!quiet) console.log(`ready  ${metadata.platform}/${metadata.arch} · Zellij ${ZELLIJ_VERSION}`);
    return metadata;
  }

  const asset = assetFor(metadata);
  const archivePath = ensureCachedArchive(asset);
  const extracted = extractZellij(asset, archivePath);
  try {
    ensureRemoteDirectory(metadata, ".hn/bin");
    copyToWorker(metadata, extracted.binary, zellijRelativePath(metadata));
    if (metadata.platform !== "windows") {
      runPosix(metadata, 'chmod 755 "$HOME/.hn/bin/zellij"');
    }
  } finally {
    rmSync(extracted.dir, { recursive: true, force: true });
  }

  const verified = zellijVersion(metadata);
  if (verified.code !== 0 || !verified.stdout.includes(ZELLIJ_VERSION)) {
    fail(`Zellij bootstrap failed on ${metadata.target}. ${(verified.stderr || verified.stdout).trim()}`);
  }
  if (!quiet) console.log(`ready  ${metadata.platform}/${metadata.arch} · Zellij ${ZELLIJ_VERSION}`);
  return metadata;
}

export function bootstrapWorker(worker, { quiet = false } = {}) {
  return ensurePersistenceRuntime(prepareWorkerCore(worker, { quiet: true }), { quiet });
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
