import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePowerShell, runPowerShell } from "./ssh.js";
import { ensureCachedRelease, sha256File } from "./runtime-assets.js";
import { remotePathExpression } from "./worker.js";
import { quotePowerShell } from "./util.js";

export const THIN_HERDR_VERSION = "0.8.2";
export const THIN_HERDR_PROTOCOL = 20;

// These are the exact official Herdr v0.8.2 controller assets already pinned by
// src/herdr.js. Tests deliberately compare the duplicated boundary so drift is
// caught immediately. Thin mode does not use herdr-win or any other fork.
const CLIENT_ASSETS = {
  "darwin:x64": {
    file: "herdr-macos-x86_64",
    sha256: "ab50262c8190cd7aa9056d249d255c08c328c3e8716de9cfa29db4f131b8e2c1",
  },
  "darwin:arm64": {
    file: "herdr-macos-aarch64",
    sha256: "a5d4f4d504d8b309c91f811050559300faba31258425f53c50852fc96f6ae574",
  },
  "linux:x64": {
    file: "herdr-linux-x86_64",
    sha256: "976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4",
  },
  "linux:arm64": {
    file: "herdr-linux-aarch64",
    sha256: "f55610658e1c2e0d2aaef730b4b2ab885f7f8ba00285ab372bfb14f2e3d5b40d",
  },
};

const LOCAL_CONFIG = `# Written by Handoff. This config is only for the local Herdr renderer.
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
status_indicators = "symbols"
window_title = "hn: {workspace} on {hostname}"

[ui.sidebar.spaces]
row_gap = 0
rows = [["state_icon", "workspace"]]

[ui.sidebar.agents]
row_gap = 0
rows = [["state_icon", "workspace"], ["agent", "state_text"]]
`;

const RELAY_SCRIPT = fileURLToPath(new URL("./herdr-relay.js", import.meta.url));
const RELAY_START_TIMEOUT_MS = 5000;

function normalizedArch(value) {
  if (["x64", "amd64", "x86_64"].includes(value)) return "x64";
  if (["arm64", "aarch64"].includes(value)) return "arm64";
  return value;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  return Boolean(thinClientAsset(platform, arch))
    && worker?.platform === "windows"
    && worker?.arch === "x64";
}

export function thinWindowsSshShellCompatible(value) {
  const name = basename(String(value ?? "").trim().replaceAll("\\", "/")).toLowerCase();
  return ["cmd", "cmd.exe", "pwsh", "pwsh.exe"].includes(name);
}

export function thinServerCompatible(server, runtime = null) {
  return Boolean(
    server?.running
    && server?.status === "running"
    && String(server.version ?? "") === THIN_HERDR_VERSION
    && Number(server.protocol) === THIN_HERDR_PROTOCOL
    && server?.capabilities?.detached_server_daemon === true
    && (!runtime || String(server.session ?? "") === runtime),
  );
}

function releaseUrl(asset) {
  return `https://github.com/herdrdev/herdr/releases/download/v${THIN_HERDR_VERSION}/${asset.file}`;
}

function localInstallPath() {
  return join(homedir(), ".hn", "bin", "herdr-client", THIN_HERDR_VERSION, "herdr");
}

function localClientRoot() {
  return join(homedir(), ".hn", "herdr", "local-client");
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

export function ensureLocalThinClient(platform = process.platform, arch = process.arch) {
  const asset = thinClientAsset(platform, arch);
  if (!asset) throw new Error(`official Herdr ${THIN_HERDR_VERSION} has no local thin-client build for ${platform}/${arch}`);
  const cached = ensureCachedRelease({
    name: "herdr",
    version: THIN_HERDR_VERSION,
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
$serverExe = ${remotePathExpression(`.hn/bin/herdr/${THIN_HERDR_VERSION}/herdr.exe`)}
$server = $null
if (Test-Path -LiteralPath $serverExe -PathType Leaf) {
  try {
    $env:HERDR_CONFIG_PATH = ${remotePathExpression(".hn/herdr/config.toml")}
    $serverRaw = (& $serverExe --session ${quotePowerShell(runtime)} status server --json 2>$null | Out-String).Trim()
    if ($serverRaw) { $server = $serverRaw | ConvertFrom-Json }
  } catch { $server = $null }
}
@{ server = $server; sshShell = $sshShell } | ConvertTo-Json -Depth 8 -Compress
`;
}

export function probeThinReadiness(worker, runtime) {
  const fallback = { server: null, sshShell: "" };
  const result = runPowerShell(worker, readinessScript(runtime), {
    capture: true,
    allowFailure: true,
    timeoutMs: 15000,
  });
  if (result.code !== 0) return fallback;
  return parseJson(result.stdout) ?? fallback;
}

export function thinClientSocketPath(server) {
  const apiSocket = String(server?.socket ?? "").trim();
  if (!apiSocket || win32.basename(apiSocket).toLowerCase() !== "herdr.sock") {
    throw new Error(`Herdr returned an unexpected Windows server socket path '${apiSocket || "missing"}'`);
  }
  return win32.join(win32.dirname(apiSocket), "herdr-client.sock");
}

// Windows Herdr uses interprocess::GenericNamespaced for local sockets. On
// Windows that is a named pipe whose logical name is the socket path string.
// This bridge connects to that exact already-running pipe and copies bytes. It
// contains deliberately no Herdr executable path and no start/restart logic.
export function windowsClientBridgeScript(clientSocketPath) {
  return `$ErrorActionPreference = 'Stop'
$pipeName = ${quotePowerShell(clientSocketPath)}
$pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
try {
  $pipe.Connect(5000)
  $stdin = [Console]::OpenStandardInput()
  $stdout = [Console]::OpenStandardOutput()
  $toPipe = $stdin.CopyToAsync($pipe)
  $toStdout = $pipe.CopyToAsync($stdout)
  $tasks = [Threading.Tasks.Task[]]@($toPipe, $toStdout)
  $completed = [Threading.Tasks.Task]::WaitAny($tasks)
  if ($tasks[$completed].IsFaulted) {
    throw $tasks[$completed].Exception.GetBaseException()
  }
  try { $stdout.Flush() } catch { }
} finally {
  $pipe.Dispose()
}
`;
}

export function windowsClientBridgeArgs(clientSocketPath) {
  const encoded = encodePowerShell(windowsClientBridgeScript(clientSocketPath));
  if (encoded.length > 6000) throw new Error("Handoff Herdr byte bridge exceeded the safe Windows OpenSSH argv budget");
  return [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encoded,
  ];
}

function relaySocketPath() {
  return join(tmpdir(), `hn-herdr-${process.pid}-${randomBytes(6).toString("hex")}.sock`);
}

function startRelay(worker, remoteArgs) {
  const socketPath = relaySocketPath();
  const payload = Buffer.from(JSON.stringify({
    worker,
    socketPath,
    remoteArgs,
    parentPid: process.pid,
  }), "utf8").toString("base64url");
  const child = spawn(process.execPath, [RELAY_SCRIPT, payload], {
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });

  const deadline = Date.now() + RELAY_START_TIMEOUT_MS;
  while (!existsSync(socketPath) && Date.now() < deadline) sleepMs(10);
  if (!existsSync(socketPath)) {
    try { child.kill("SIGTERM"); } catch {}
    return { ready: false, reason: "the local Handoff Herdr relay did not become ready", child, socketPath };
  }
  return { ready: true, child, socketPath };
}

export function localThinClientEnvironment(local, socketPath, base = process.env) {
  const env = {
    ...base,
    HERDR_CONFIG_PATH: local.configPath,
    HERDR_CLIENT_SOCKET_PATH: socketPath,
    HERDR_RENDER_ENCODING: "terminal-ansi",
    HERDR_REATTACH_COMMAND: "hn -p",
    HERDR_REMOTE_KEYBINDINGS: "local",
    XDG_CONFIG_HOME: local.configHome,
    XDG_STATE_HOME: local.stateHome,
    XDG_CACHE_HOME: local.cacheHome,
  };
  delete env.HERDR_SOCKET_PATH;
  return env;
}

export function attachThinHerdr(worker, runtime, { readiness = null } = {}) {
  if (!thinTransportSupported(worker)) {
    return { available: false, reason: `thin client unsupported for ${process.platform}/${process.arch} -> ${worker?.platform}/${worker?.arch}` };
  }

  const observed = readiness ?? probeThinReadiness(worker, runtime);
  if (!thinWindowsSshShellCompatible(observed.sshShell)) {
    return { available: false, reason: `Windows OpenSSH DefaultShell '${observed.sshShell || "unknown"}' cannot safely carry the raw Herdr byte stream; use cmd.exe or pwsh.exe` };
  }
  if (!thinServerCompatible(observed.server, runtime)) {
    return { available: false, reason: `the existing Handoff Herdr server is not the expected detached ${THIN_HERDR_VERSION}/protocol-${THIN_HERDR_PROTOCOL} session` };
  }

  let clientSocket;
  try { clientSocket = thinClientSocketPath(observed.server); } catch (error) {
    return { available: false, reason: error.message };
  }

  let local;
  try { local = ensureLocalThinClient(); } catch (error) {
    return { available: false, reason: error.message };
  }

  let relay = null;
  try {
    relay = startRelay(worker, windowsClientBridgeArgs(clientSocket));
    if (!relay.ready) return { available: false, reason: relay.reason };

    const result = spawnSync(local.binary, ["client"], {
      stdio: "inherit",
      env: localThinClientEnvironment(local, relay.socketPath),
    });
    if (result.error) throw new Error(`local Herdr client failed to start: ${result.error.message}`);
    const code = result.status ?? 1;
    if (code !== 0) {
      // Once the real local client has launched, never silently fall back to a
      // second attachment transport. Official Herdr returns 0 for a deliberate
      // remote detach and non-zero for handshake/connection/protocol failures.
      throw new Error(`local Herdr client exited unexpectedly (${code}); the Windows desk was not restarted or modified`);
    }
    return { available: true, code: 0 };
  } finally {
    if (relay) {
      try { relay.child.kill("SIGTERM"); } catch {}
      try { rmSync(relay.socketPath, { force: true }); } catch {}
    }
  }
}
