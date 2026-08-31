// Experimental responsive Herdr data plane for Handoff.
//
// The worker remains authoritative for the persistent desk and PTYs. A pinned
// Herdr mirror build replicates raw PTY output + resize events to a local Herdr
// terminal emulator, so the controller owns terminal interpretation, scrollback,
// search and selection. The stable official v0.8.2 runtime is left untouched.

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { copyToWorker, runPowerShell } from "./ssh.js";
import { ensureCachedRelease, sha256File } from "./runtime-assets.js";
import { remotePathExpression } from "./worker.js";
import { quotePowerShell } from "./util.js";
import {
  forwardFailureReason,
  thinClientSocketPath,
  thinForwardArgs,
  thinWindowsSshShellCompatible,
  windowsPipeBridgeArgs,
  windowsPipeBridgeScript,
} from "./herdr-thin.js";

export const RESPONSIVE_HERDR_REF = "20a0cd5294fb15ef17209612d80d5a2704169990";
export const RESPONSIVE_HERDR_VERSION = "0.7.4";
export const RESPONSIVE_HERDR_PROTOCOL = 17;
export const RESPONSIVE_HERDR_TAG = `herdr-mirror-${RESPONSIVE_HERDR_REF}`;
export const RESPONSIVE_HERDR_STABLE_BUNDLE_VERSION = "0.8.2";

const ASSETS = {
  "darwin:arm64": {
    file: "herdr-mirror-macos-aarch64",
    sha256: "cb7f5495cf50555a83813cc1f16e280517978b0e4771178c2513d3d3d5805b4f",
  },
  "darwin:x64": {
    file: "herdr-mirror-macos-x86_64",
    sha256: "ae255d36f935b66ac7585e7e4157bb7bd02a8598136f5465ef143b7cced64c2f",
  },
  "windows:x64": {
    file: "herdr-mirror-windows-x86_64.exe",
    sha256: "3e6fd237375940724c2085adb477f76b5f6d1d42f204913055dda025bd4863a9",
  },
};

const FORWARD_READY_TIMEOUT_MS = 30000;
const BRIDGE_ACCEPT_MS = 20000;
const PORT_ATTEMPTS = 5;
const REMOTE_CONFIG_RELATIVE = `.hn/herdr-mirror/${RESPONSIVE_HERDR_REF}/config.toml`;

const LOCAL_CONFIG = `# Written by Handoff for the pinned responsive Herdr mirror client.
onboarding = false

[update]
version_check = false
manifest_check = false

[ui]
sidebar_width = 28
sidebar_min_width = 20
sidebar_max_width = 36
mouse_capture = true
copy_on_select = true
confirm_close = true
hide_tab_bar_when_single_tab = true
show_agent_labels_on_pane_borders = true
agent_panel_sort = "priority"

[ui.sidebar.spaces]
row_gap = 0
rows = [["state_icon", "workspace"]]

[ui.sidebar.agents]
row_gap = 0
rows = [["state_icon", "workspace"], ["agent", "state_text"]]
`;

function normalizedPlatform(value) {
  return value === "win32" ? "windows" : value;
}

function normalizedArch(value) {
  if (["x64", "amd64", "x86_64"].includes(value)) return "x64";
  if (["arm64", "aarch64"].includes(value)) return "arm64";
  return value;
}

export function responsiveAsset(platform = process.platform, arch = process.arch) {
  return ASSETS[`${normalizedPlatform(platform)}:${normalizedArch(arch)}`] ?? null;
}

export function responsiveHerdrRequested(env = process.env) {
  return String(env.HN_HERDR_TRANSPORT ?? "auto").trim().toLowerCase() === "mirror";
}

export function responsiveTransportSupported(
  worker,
  platform = process.platform,
  arch = process.arch,
) {
  const local = responsiveAsset(platform, arch);
  const remote = responsiveAsset(worker?.platform, worker?.arch);
  return normalizedPlatform(platform) === "darwin"
    && Boolean(local?.sha256)
    && worker?.platform === "windows"
    && worker?.arch === "x64"
    && Boolean(remote?.sha256);
}

export function responsiveInstallDir() {
  return `.hn/bin/herdr-mirror/${RESPONSIVE_HERDR_REF}`;
}

export function responsiveBinaryRelative() {
  return `${responsiveInstallDir()}/herdr.exe`;
}

export function responsiveConfigRelative() {
  return REMOTE_CONFIG_RELATIVE;
}

export function responsiveHerdrWorker(worker) {
  return {
    ...worker,
    __hnHerdrBinaryRelative: responsiveBinaryRelative(),
    __hnHerdrConfigRelative: responsiveConfigRelative(),
  };
}

export function responsiveRuntimeName(baseRuntime) {
  return `${baseRuntime}-mirror-${RESPONSIVE_HERDR_REF.slice(0, 7)}`;
}

function releaseUrl(asset) {
  return `https://github.com/Bbrizly/Handoff/releases/download/${RESPONSIVE_HERDR_TAG}/${asset.file}`;
}

function localInstallPath() {
  return join(homedir(), ".hn", "bin", "herdr-mirror", RESPONSIVE_HERDR_REF, "herdr");
}

function localClientRoot() {
  return join(homedir(), ".hn", "herdr", "local-mirror", RESPONSIVE_HERDR_REF);
}

function ensureLocalConfig() {
  const root = localClientRoot();
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  const cacheHome = join(root, "cache");
  const configPath = join(configHome, "herdr", "config.toml");
  for (const path of [configHome, stateHome, cacheHome, dirname(configPath)]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  if (!existsSync(configPath) || readFileSync(configPath, "utf8") !== LOCAL_CONFIG) {
    writeFileSync(configPath, LOCAL_CONFIG, { encoding: "utf8", mode: 0o600 });
  }
  return { configHome, stateHome, cacheHome, configPath };
}

export function ensureLocalResponsiveHerdr(platform = process.platform, arch = process.arch) {
  const asset = responsiveAsset(platform, arch);
  if (!asset?.sha256) {
    throw new Error(`responsive Herdr has no verified local build for ${platform}/${arch}`);
  }
  const cached = ensureCachedRelease({
    name: "herdr-mirror",
    version: RESPONSIVE_HERDR_REF,
    file: asset.file,
    url: releaseUrl(asset),
    sha256: asset.sha256,
  });
  const target = localInstallPath();
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (!existsSync(target) || sha256File(target) !== asset.sha256) copyFileSync(cached, target);
  chmodSync(target, 0o700);
  return { binary: target, ...ensureLocalConfig() };
}

function remoteShaScript(path) {
  return `$p = ${remotePathExpression(path)}
if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { exit 1 }
(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
`;
}

export function responsiveRemoteHash(worker) {
  const result = runPowerShell(worker, remoteShaScript(responsiveBinaryRelative()), {
    capture: true,
    allowFailure: true,
    timeoutMs: 15000,
  });
  return result.code === 0 ? result.stdout.trim().toLowerCase() : "";
}

export function ensureResponsiveHerdrInstalled(worker, { quiet = true } = {}) {
  if (worker?.platform !== "windows" || worker?.arch !== "x64") {
    throw new Error(`responsive Herdr worker runtime is unsupported for ${worker?.platform}/${worker?.arch}`);
  }
  const asset = responsiveAsset("windows", "x64");
  if (!asset?.sha256) {
    throw new Error("responsive Herdr Windows artifact is not checksum-pinned yet");
  }
  if (responsiveRemoteHash(worker) === asset.sha256) return;

  const cached = ensureCachedRelease({
    name: "herdr-mirror",
    version: RESPONSIVE_HERDR_REF,
    file: asset.file,
    url: releaseUrl(asset),
    sha256: asset.sha256,
  });
  if (!quiet) console.log(`installing responsive Herdr ${RESPONSIVE_HERDR_REF.slice(0, 7)} on ${worker.target}...`);

  const stableDir = `.hn/bin/herdr/${RESPONSIVE_HERDR_STABLE_BUNDLE_VERSION}`;
  const targetDir = responsiveInstallDir();
  runPowerShell(worker, `$ErrorActionPreference = 'Stop'
$stable = ${remotePathExpression(stableDir)}
$stableExe = Join-Path $stable 'herdr.exe'
if (-not (Test-Path -LiteralPath $stableExe -PathType Leaf)) {
  throw 'official Herdr 0.8.2 bundle must be installed before the responsive runtime'
}
$target = ${remotePathExpression(targetDir)}
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -Path (Join-Path $stable '*') -Destination $target -Recurse -Force -ErrorAction Stop
`);
  copyToWorker(worker, cached, responsiveBinaryRelative());

  const actual = responsiveRemoteHash(worker);
  if (actual !== asset.sha256) {
    throw new Error(`responsive Herdr install checksum mismatch on ${worker.target}: expected ${asset.sha256}, got ${actual || "missing"}`);
  }
  const version = runPowerShell(worker, `$h = ${remotePathExpression(responsiveBinaryRelative())}
& $h --version
exit $LASTEXITCODE
`, { capture: true, allowFailure: true, timeoutMs: 15000 });
  if (version.code !== 0 || !version.stdout.includes(RESPONSIVE_HERDR_VERSION)) {
    throw new Error(`responsive Herdr install failed on ${worker.target}: ${(version.stderr || version.stdout || "no version").trim()}`);
  }
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
$sshShell = 'cmd.exe'
try {
  $configuredShell = (Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue).DefaultShell
  if (-not [string]::IsNullOrWhiteSpace([string]$configuredShell)) { $sshShell = [string]$configuredShell }
} catch { }
$serverExe = ${remotePathExpression(responsiveBinaryRelative())}
$server = $null
if (Test-Path -LiteralPath $serverExe -PathType Leaf) {
  try {
    $env:HERDR_CONFIG_PATH = ${remotePathExpression(responsiveConfigRelative())}
    $serverRaw = (& $serverExe --session ${quotePowerShell(runtime)} status server --json 2>$null | Out-String).Trim()
    if ($serverRaw) { $server = $serverRaw | ConvertFrom-Json }
  } catch { $server = $null }
}
@{ server = $server; sshShell = $sshShell } | ConvertTo-Json -Depth 8 -Compress
`;
}

export function probeResponsiveReadiness(worker, runtime) {
  const result = runPowerShell(worker, readinessScript(runtime), {
    capture: true,
    allowFailure: true,
    timeoutMs: 15000,
  });
  if (result.code !== 0) return { server: null, sshShell: "" };
  return parseJson(result.stdout) ?? { server: null, sshShell: "" };
}

export function responsiveServerCompatible(server, runtime = null) {
  return Boolean(
    server?.running
    && server?.status === "running"
    && String(server.version ?? "") === RESPONSIVE_HERDR_VERSION
    && Number(server.protocol) === RESPONSIVE_HERDR_PROTOCOL
    && server?.compatible === true
    && server?.restart_needed !== true
    && (!runtime || String(server.session ?? "") === runtime),
  );
}

export function responsiveApiSocketPath(server) {
  const apiSocket = String(server?.socket ?? "").trim();
  if (!apiSocket || win32.basename(apiSocket).toLowerCase() !== "herdr.sock") {
    throw new Error(`responsive Herdr returned an unexpected API socket '${apiSocket || "missing"}'`);
  }
  return apiSocket;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ephemeralLoopbackPort() {
  return 20000 + (randomBytes(2).readUInt16BE(0) % 40000);
}

function stageBridgeScript(worker, pipePath, port) {
  const remote = `.hn-herdr-mirror-${randomBytes(8).toString("hex")}.ps1`;
  const stage = mkdtempSync(join(tmpdir(), "hn-herdr-mirror-ps-"));
  const local = join(stage, "bridge.ps1");
  writeFileSync(local, `\uFEFF${windowsPipeBridgeScript(pipePath, port, BRIDGE_ACCEPT_MS)}`, "utf8");
  try {
    copyToWorker(worker, local, remote);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return remote;
}

function startPipeForward(worker, pipePath, socketPath, dir, label) {
  let last = `the ${label} forward never became ready`;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const port = ephemeralLoopbackPort();
    const remoteScript = stageBridgeScript(worker, pipePath, port);
    const logPath = join(dir, `forward-${label}-${attempt}.log`);
    const log = openSync(logPath, "w+");
    let child;
    try {
      child = spawn("ssh", thinForwardArgs(worker, socketPath, port, windowsPipeBridgeArgs(remoteScript)), {
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
    } finally {
      closeSync(log);
    }

    const deadline = Date.now() + FORWARD_READY_TIMEOUT_MS;
    let text = "";
    while (Date.now() < deadline) {
      text = readFileSync(logPath, "utf8");
      if (/HN-READY/.test(text) || /HN-PORTBUSY/.test(text) || child.exitCode !== null) break;
      sleepMs(50);
    }
    if (/HN-READY/.test(text) && existsSync(socketPath)) {
      return { ready: true, child, socketPath, logPath, port };
    }

    try { child.kill("SIGTERM"); } catch {}
    if (/HN-PORTBUSY/.test(text)) {
      last = `loopback port ${port} on the worker was busy`;
      continue;
    }
    const detail = text.trim().split("\n").filter((line) => !line.startsWith("HN-")).slice(-3).join("; ");
    return { ready: false, reason: `${label}: ${forwardFailureReason(detail)}` };
  }
  return { ready: false, reason: `${last} after ${PORT_ATTEMPTS} tries` };
}

export function responsiveLocalEnvironment(local, apiSocket, base = process.env) {
  const env = {
    ...base,
    HERDR_CONFIG_PATH: local.configPath,
    HERDR_SOCKET_PATH: apiSocket,
    XDG_CONFIG_HOME: local.configHome,
    XDG_STATE_HOME: local.stateHome,
    XDG_CACHE_HOME: local.cacheHome,
  };
  delete env.HERDR_CLIENT_SOCKET_PATH;
  delete env.HERDR_SESSION;
  delete env.HERDR_ENV;
  delete env.HERDR_REMOTE_BINARY;
  delete env.HERDR_RENDER_ENCODING;
  delete env.HERDR_REMOTE_KEYBINDINGS;
  return env;
}

export function attachResponsiveHerdr(worker, runtime, { readiness = null } = {}) {
  if (!responsiveTransportSupported(worker)) {
    return { available: false, reason: `responsive mirror unsupported for ${process.platform}/${process.arch} -> ${worker?.platform}/${worker?.arch}` };
  }
  const observed = readiness ?? probeResponsiveReadiness(worker, runtime);
  if (!thinWindowsSshShellCompatible(observed.sshShell)) {
    return { available: false, reason: `Windows OpenSSH DefaultShell '${observed.sshShell || "unknown"}' is not validated for the responsive bridge; use cmd.exe or pwsh.exe` };
  }
  if (!responsiveServerCompatible(observed.server, runtime)) {
    return { available: false, reason: `responsive Herdr server is not the expected ${RESPONSIVE_HERDR_VERSION}/protocol-${RESPONSIVE_HERDR_PROTOCOL} session '${runtime}'` };
  }

  let apiPipe;
  let clientPipe;
  try {
    apiPipe = responsiveApiSocketPath(observed.server);
    clientPipe = thinClientSocketPath(observed.server);
  } catch (error) {
    return { available: false, reason: error.message };
  }

  let local;
  try { local = ensureLocalResponsiveHerdr(); } catch (error) {
    return { available: false, reason: error.message };
  }

  const dir = mkdtempSync(join(tmpdir(), "hn-herdr-mirror-"));
  chmodSync(dir, 0o700);
  const localApi = join(dir, "herdr.sock");
  const localClient = join(dir, "herdr-client.sock");
  const forwards = [];
  try {
    const control = startPipeForward(worker, apiPipe, localApi, dir, "control");
    if (!control.ready) return { available: false, reason: control.reason };
    forwards.push(control);

    const data = startPipeForward(worker, clientPipe, localClient, dir, "data");
    if (!data.ready) return { available: false, reason: data.reason };
    forwards.push(data);

    const result = spawnSync(local.binary, ["--mirror"], {
      stdio: "inherit",
      env: responsiveLocalEnvironment(local, localApi),
    });
    if (result.error) throw new Error(`responsive local Herdr failed to start: ${result.error.message}`);
    const code = result.status ?? 1;
    if (code !== 0) {
      throw new Error(`responsive local Herdr exited unexpectedly (${code}); the Windows desk remains authoritative and was not restarted`);
    }
    return { available: true, code: 0 };
  } finally {
    for (const forward of forwards) {
      try { forward.child.kill("SIGTERM"); } catch {}
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
