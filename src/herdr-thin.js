import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { copyToWorker, runPowerShell } from "./ssh.js";
import { ensureCachedRelease, sha256File } from "./runtime-assets.js";
import { remotePathExpression } from "./worker.js";
import { quotePosix, quotePowerShell } from "./util.js";

export const THIN_HERDR_RELEASE = "2026.08.27.5";
export const THIN_HERDR_UPSTREAM_VERSION = "0.8.2";
export const THIN_HERDR_PROTOCOL = 20;

const RELEASE_TAG = `v${THIN_HERDR_RELEASE}`;
const RELEASE_BASE = `https://github.com/hdosys/herdr-win/releases/download/${RELEASE_TAG}`;
const REMOTE_WINDOWS_ZIP = {
  file: `herdr-win_v${THIN_HERDR_RELEASE}_windows_amd64.zip`,
  sha256: "77bed06f9e7d0ac57be99b5c8be3a5d153bd11cbb26781a8cf8c4d33207c8da1",
};

const CLIENT_ASSETS = {
  "darwin:arm64": {
    file: `herdr-win_v${THIN_HERDR_RELEASE}_macos_arm64`,
    sha256: "d39a3a6f0c00ef42392533c7ba547933e7480836556c10e054faf747a37733ca",
  },
  "darwin:x64": {
    file: `herdr-win_v${THIN_HERDR_RELEASE}_macos_amd64`,
    sha256: "232e164fe2fffe021a2458107332aa35e78810db7e078a2aa3667c1d0727b64e",
  },
  "linux:x64": {
    file: `herdr-win_v${THIN_HERDR_RELEASE}_linux_amd64`,
    sha256: "daabf90ef6443c4e82cb2cfa2b34ed72d35cfa85692ca25af55be8d0cae5f8fb",
  },
  "linux:arm64": {
    file: `herdr-win_v${THIN_HERDR_RELEASE}_linux_arm64`,
    sha256: "e6dd517b384a2c5ef2f82a73f82382b741ece225b3bdef4f9d0d2a8d1d7f80fa",
  },
};

const LOCAL_CONFIG = `# Written by Handoff. This config is only for the local Herdr thin client.
onboarding = false

[update]
version_check = false
manifest_check = false

[remote]
manage_ssh_config = true
`;

function normalizedArch(value) {
  if (["x64", "amd64", "x86_64"].includes(value)) return "x64";
  if (["arm64", "aarch64"].includes(value)) return "arm64";
  return value;
}

export function thinTransportMode(env = process.env) {
  const value = String(env.HN_HERDR_TRANSPORT ?? "auto").trim().toLowerCase();
  if (["auto", "thin", "legacy"].includes(value)) return value;
  return "auto";
}

export function thinClientAsset(platform = process.platform, arch = process.arch) {
  return CLIENT_ASSETS[`${platform}:${normalizedArch(arch)}`] ?? null;
}

export function thinTransportSupported(worker, platform = process.platform, arch = process.arch) {
  return Boolean(thinClientAsset(platform, arch)) && worker?.platform === "windows" && worker?.arch === "x64";
}

export function thinServerCompatible(server) {
  return Boolean(
    server?.running
    && String(server.version ?? "") === THIN_HERDR_UPSTREAM_VERSION
    && Number(server.protocol) === THIN_HERDR_PROTOCOL
    && server?.capabilities?.detached_server_daemon === true,
  );
}

export function thinBridgeCompatible(bridge) {
  const version = String(bridge?.version ?? "");
  return bridge?.state === "ok"
    && Number(bridge.protocol) === THIN_HERDR_PROTOCOL
    && version.includes(THIN_HERDR_RELEASE)
    && version.includes(THIN_HERDR_UPSTREAM_VERSION);
}

function releaseUrl(file) {
  return `${RELEASE_BASE}/${file}`;
}

function localInstallPath() {
  return join(homedir(), ".hn", "bin", "herdr-thin", RELEASE_TAG, "herdr");
}

function localConfigPath() {
  return join(homedir(), ".hn", "herdr", "thin-client.toml");
}

function ensureLocalConfig() {
  const path = localConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path) || readFileSync(path, "utf8") !== LOCAL_CONFIG) {
    writeFileSync(path, LOCAL_CONFIG, { encoding: "utf8", mode: 0o600 });
  }
  return path;
}

export function ensureLocalThinClient(platform = process.platform, arch = process.arch) {
  const asset = thinClientAsset(platform, arch);
  if (!asset) throw new Error(`local Herdr thin client is not pinned for ${platform}/${arch}`);
  const cached = ensureCachedRelease({
    name: "herdr-thin",
    version: THIN_HERDR_RELEASE,
    file: asset.file,
    url: releaseUrl(asset.file),
    sha256: asset.sha256,
  });
  const target = localInstallPath();
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target) || sha256File(target) !== asset.sha256) copyFileSync(cached, target);
  chmodSync(target, 0o700);
  return { binary: target, config: ensureLocalConfig() };
}

function parseJson(output) {
  const text = String(output ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function readinessScript(runtime) {
  return `$ErrorActionPreference = 'Stop'
$serverExe = ${remotePathExpression(`.hn/bin/herdr/${THIN_HERDR_UPSTREAM_VERSION}/herdr.exe`)}
$server = $null
if (Test-Path -LiteralPath $serverExe -PathType Leaf) {
  try {
    $env:HERDR_CONFIG_PATH = ${remotePathExpression(".hn/herdr/config.toml")}
    $serverRaw = (& $serverExe --session ${quotePowerShell(runtime)} status server --json 2>$null | Out-String).Trim()
    if ($serverRaw) { $server = $serverRaw | ConvertFrom-Json }
  } catch { $server = $null }
}
$bridgeRoot = Join-Path $HOME '.herdr\\remote'
$bridgeExe = Join-Path $bridgeRoot 'herdr.exe'
$bridge = @{ state = 'missing'; version = ''; protocol = 0 }
if (Test-Path -LiteralPath $bridgeExe -PathType Leaf) {
  try {
    $env:HERDR_REMOTE_SIDECAR_V1 = '1'
    Remove-Item Env:HERDR_ENV -ErrorAction SilentlyContinue
    & $bridgeExe '--herdr-private-validate-remote-sidecar-v1' *> $null
    if ($LASTEXITCODE -ne 0) { throw 'remote sidecar validation failed' }
    $version = (& $bridgeExe --version 2>&1 | Out-String).Trim()
    $clientRaw = (& $bridgeExe status client --json 2>$null | Out-String).Trim()
    $client = if ($clientRaw) { $clientRaw | ConvertFrom-Json } else { $null }
    $bridge = @{ state = 'ok'; version = $version; protocol = if ($client) { [int]$client.protocol } else { 0 } }
  } catch {
    $bridge = @{ state = 'broken'; version = ''; protocol = 0 }
  } finally {
    Remove-Item Env:HERDR_REMOTE_SIDECAR_V1 -ErrorAction SilentlyContinue
  }
}
@{ server = $server; bridge = $bridge } | ConvertTo-Json -Depth 8 -Compress
`;
}

export function probeThinReadiness(worker, runtime) {
  const result = runPowerShell(worker, readinessScript(runtime), {
    capture: true,
    allowFailure: true,
    timeoutMs: 15000,
  });
  if (result.code !== 0) return { server: null, bridge: { state: "error", version: "", protocol: 0 } };
  return parseJson(result.stdout) ?? { server: null, bridge: { state: "error", version: "", protocol: 0 } };
}

function installThinBridgeScript(remoteZip) {
  return `$ErrorActionPreference = 'Stop'
$archive = ${remotePathExpression(remoteZip)}
$parent = Join-Path $HOME '.herdr'
$target = Join-Path $parent 'remote'
New-Item -ItemType Directory -Force -Path $parent | Out-Null
if (Test-Path -LiteralPath $target) {
  $items = @(Get-ChildItem -LiteralPath $target -Force -ErrorAction SilentlyContinue)
  if ($items.Count -gt 0) { throw 'A different Herdr remote runtime already owns ~/.herdr/remote; Handoff will not overwrite it.' }
  Remove-Item -LiteralPath $target -Recurse -Force
}
$stage = Join-Path $parent ('remote.hn-stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
try {
  Expand-Archive -LiteralPath $archive -DestinationPath $stage -Force
  $exe = Join-Path $stage 'herdr.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Pinned herdr-win archive has no top-level herdr.exe.' }
  [IO.File]::WriteAllBytes((Join-Path $stage '.lease'), [byte[]]@())
  $env:HERDR_REMOTE_SIDECAR_V1 = '1'
  Remove-Item Env:HERDR_ENV -ErrorAction SilentlyContinue
  & $exe '--herdr-private-validate-remote-sidecar-v1' *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Pinned herdr-win archive failed its sidecar payload validation.' }
  $version = (& $exe --version 2>&1 | Out-String).Trim()
  $clientRaw = (& $exe status client --json 2>$null | Out-String).Trim()
  $client = $clientRaw | ConvertFrom-Json
  if ($version -notlike '*${THIN_HERDR_RELEASE}*' -or $version -notlike '*${THIN_HERDR_UPSTREAM_VERSION}*' -or [int]$client.protocol -ne ${THIN_HERDR_PROTOCOL}) {
    throw 'Pinned herdr-win archive did not report the expected release/protocol.'
  }
  Remove-Item Env:HERDR_REMOTE_SIDECAR_V1 -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $stage -Destination $target
} finally {
  Remove-Item Env:HERDR_REMOTE_SIDECAR_V1 -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
}
`;
}

export function ensureThinRemoteBridge(worker, currentBridge = null) {
  if (thinBridgeCompatible(currentBridge)) return currentBridge;
  if (currentBridge?.state && currentBridge.state !== "missing") {
    throw new Error("a different or broken Herdr remote runtime already exists at ~/.herdr/remote; refusing to replace it while work may be active");
  }

  const cached = ensureCachedRelease({
    name: "herdr-thin",
    version: THIN_HERDR_RELEASE,
    file: REMOTE_WINDOWS_ZIP.file,
    url: releaseUrl(REMOTE_WINDOWS_ZIP.file),
    sha256: REMOTE_WINDOWS_ZIP.sha256,
  });
  const remoteZip = `.hn/cache/${REMOTE_WINDOWS_ZIP.file}`;
  runPowerShell(worker, `New-Item -ItemType Directory -Force -Path ${remotePathExpression(".hn/cache")} | Out-Null\n`);
  copyToWorker(worker, cached, remoteZip);
  const installed = runPowerShell(worker, installThinBridgeScript(remoteZip), {
    capture: true,
    allowFailure: true,
    timeoutMs: 60000,
  });
  if (installed.code !== 0) {
    throw new Error((installed.stderr || installed.stdout || "thin bridge install failed").trim().slice(0, 500));
  }
  return null;
}

function resolveExecutable(name) {
  for (const entry of String(process.env.PATH ?? "").split(":")) {
    if (!entry) continue;
    const candidate = join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function sshShim(port) {
  if (!port || port === 22) return null;
  const ssh = resolveExecutable("ssh");
  if (!ssh) throw new Error("ssh is not available on the controller");
  const dir = mkdtempSync(join(tmpdir(), "hn-herdr-ssh-"));
  const path = join(dir, "ssh");
  writeFileSync(path, `#!/bin/sh\nexec ${quotePosix(ssh)} -p ${Number(port)} \"$@\"\n`, { mode: 0o700 });
  return { dir, path };
}

export function attachThinHerdr(worker, runtime, { readiness = null } = {}) {
  if (!thinTransportSupported(worker)) {
    return { available: false, reason: `thin client unsupported for ${process.platform}/${process.arch} -> ${worker?.platform}/${worker?.arch}` };
  }

  const observed = readiness ?? probeThinReadiness(worker, runtime);
  if (!thinServerCompatible(observed.server)) {
    return { available: false, reason: "the running Handoff Herdr server is not a compatible detached v0.8.2/protocol-20 server" };
  }

  try {
    ensureThinRemoteBridge(worker, observed.bridge);
  } catch (error) {
    return { available: false, reason: error.message };
  }

  const verified = thinBridgeCompatible(observed.bridge) ? observed : probeThinReadiness(worker, runtime);
  if (!thinBridgeCompatible(verified.bridge)) {
    return { available: false, reason: "the pinned Windows Herdr bridge did not verify after installation" };
  }

  let local;
  try { local = ensureLocalThinClient(); } catch (error) {
    return { available: false, reason: error.message };
  }

  let shim = null;
  try {
    shim = sshShim(worker.port);
    const env = {
      ...process.env,
      HERDR_CONFIG_PATH: local.config,
      HERDR_REMOTE_BINARY: ensureCachedRelease({
        name: "herdr-thin",
        version: THIN_HERDR_RELEASE,
        file: REMOTE_WINDOWS_ZIP.file,
        url: releaseUrl(REMOTE_WINDOWS_ZIP.file),
        sha256: REMOTE_WINDOWS_ZIP.sha256,
      }),
    };
    if (shim) env.PATH = `${shim.dir}:${env.PATH ?? ""}`;
    const result = spawnSync(local.binary, [
      "--remote", worker.target,
      "--remote-keybindings", "local",
      "--session", runtime,
    ], { stdio: "inherit", env });
    if (result.error) return { available: false, reason: `local Herdr client failed to start: ${result.error.message}` };
    return { available: true, code: result.status ?? 1 };
  } finally {
    if (shim) rmSync(shim.dir, { recursive: true, force: true });
  }
}
