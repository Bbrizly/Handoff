// Codex thin-client transport.
//
// The controller runs only Codex's stock remote TUI. The worker owns the
// stateful app-server, agent runtime, tools, and project working directory.
// Handoff contributes two things only: a persistent worker-side service and a
// disposable localhost-only SSH tunnel.

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { runPowerShell, sshLocalForwardArgs } from "./ssh.js";
import { remotePathExpression } from "./worker.js";
import { windowsDetachedLaunchScript } from "./windows-detach.js";
import { fail, quotePowerShell } from "./util.js";

export const CODEX_REMOTE_MIN_VERSION = "0.150.1";
const SERVER_PORT_BASE = 43000;
const SERVER_PORT_SPAN = 12000;
const SERVER_PORT_CANDIDATES = 24;

const CODEX_MANAGEMENT_COMMANDS = new Set([
  "agents", "login", "logout", "mcp", "plugin", "mcp-server", "app-server",
  "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug",
  "execpolicy", "apply", "queue", "archive", "delete", "migrate-rollouts",
  "unarchive", "exec",
]);

function hash32(value) {
  return Number.parseInt(createHash("sha256").update(String(value)).digest("hex").slice(0, 8), 16) >>> 0;
}

export function codexServiceId(identity) {
  return createHash("sha256").update(String(identity)).digest("hex").slice(0, 12);
}

export function codexRemotePortCandidates(identity, count = SERVER_PORT_CANDIDATES) {
  const start = hash32(identity) % SERVER_PORT_SPAN;
  const ports = [];
  for (let index = 0; index < count; index += 1) {
    ports.push(SERVER_PORT_BASE + ((start + index) % SERVER_PORT_SPAN));
  }
  return ports;
}

export function parseCodexVersion(output) {
  const match = String(output ?? "").match(/(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?/i);
  if (!match) return null;
  return {
    raw: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareCodexVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    const delta = Number(left?.[key] ?? 0) - Number(right?.[key] ?? 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

export function codexVersionAtLeast(version, minimum = parseCodexVersion(CODEX_REMOTE_MIN_VERSION)) {
  return Boolean(version && minimum && compareCodexVersions(version, minimum) >= 0);
}

export function shouldUseCodexRemoteTui(args = []) {
  const first = String(args[0] ?? "").toLowerCase();
  if (!first || first.startsWith("-")) return true;
  return !CODEX_MANAGEMENT_COMMANDS.has(first);
}

function localCodexProbe(run = spawnSync) {
  const versionResult = run("codex", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (versionResult.error || (versionResult.status ?? 1) !== 0) {
    return { ok: false, reason: "codex is not installed on the controller" };
  }
  const version = parseCodexVersion(`${versionResult.stdout ?? ""}\n${versionResult.stderr ?? ""}`);
  if (!version) return { ok: false, reason: "could not read the controller Codex version" };

  const help = run("codex", ["--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const helpText = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  if ((help.status ?? 1) !== 0 || !/(^|\s)--remote(?:\s|,|$)/m.test(helpText)) {
    return { ok: false, reason: "controller Codex does not support --remote" };
  }
  if (!codexVersionAtLeast(version)) {
    return {
      ok: false,
      reason: `controller Codex ${version.raw} is older than the tested remote-TUI floor ${CODEX_REMOTE_MIN_VERSION}`,
    };
  }
  return { ok: true, version };
}

function remoteCodexProbe(worker) {
  if (worker.platform !== "windows") {
    return { ok: false, reason: `Codex app-server dogfood currently supports Windows workers, not ${worker.platform}` };
  }
  const result = runPowerShell(worker, `$ErrorActionPreference = 'Stop'
$codex = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $codex) { Write-Output 'HN_CODEX_MISSING'; exit 3 }
$version = (& $codex.Source --version 2>&1 | Out-String).Trim()
$help = (& $codex.Source app-server --help 2>&1 | Out-String)
Write-Output $version
if ($help -match '(?m)(^|\\s)--listen(?:\\s|,|$)') { Write-Output 'HN_CODEX_LISTEN=1' } else { Write-Output 'HN_CODEX_LISTEN=0' }
`, { capture: true, allowFailure: true, timeoutMs: 20000 });
  if (result.code !== 0) {
    return {
      ok: false,
      reason: result.code === 3
        ? "codex is not installed on the worker"
        : `worker Codex probe failed: ${(result.stderr || result.stdout).trim().slice(0, 240)}`,
    };
  }
  const version = parseCodexVersion(result.stdout);
  if (!version) return { ok: false, reason: "could not read the worker Codex version" };
  if (!result.stdout.includes("HN_CODEX_LISTEN=1")) {
    return { ok: false, reason: "worker Codex does not support app-server --listen" };
  }
  if (!codexVersionAtLeast(version)) {
    return {
      ok: false,
      reason: `worker Codex ${version.raw} is older than the tested remote-TUI floor ${CODEX_REMOTE_MIN_VERSION}`,
    };
  }
  return { ok: true, version };
}

export function codexRemoteCompatibility(worker, backend = {}) {
  const local = (backend.localProbe ?? localCodexProbe)();
  if (!local.ok) return { ok: false, reason: local.reason, local, remote: null };
  const remote = (backend.remoteProbe ?? remoteCodexProbe)(worker);
  if (!remote.ok) return { ok: false, reason: remote.reason, local, remote };
  if (local.version.raw !== remote.version.raw) {
    return {
      ok: false,
      reason: `Codex versions differ (controller ${local.version.raw}, worker ${remote.version.raw}); update them to the same version before remote-TUI use`,
      local,
      remote,
    };
  }
  return { ok: true, local, remote, version: remote.version };
}

function serviceStateRelative(serviceId) {
  return `.hn/state/codex-app-server-${serviceId}.json`;
}

function serviceLogRelative(serviceId, stream) {
  return `.hn/logs/codex-app-server-${serviceId}.${stream}.log`;
}

function serviceIdentity(controllerId, targetName, worker) {
  return `${controllerId ?? "unknown"}:${targetName}:${worker.user ?? ""}@${worker.host}:${worker.port ?? 22}`;
}

function parseJsonObject(output) {
  const text = String(output ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function probeWindowsService(worker, serviceId) {
  const state = serviceStateRelative(serviceId);
  const result = runPowerShell(worker, `$ErrorActionPreference = 'SilentlyContinue'
$statePath = ${remotePathExpression(state)}
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { exit 4 }
try { $hn = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { exit 5 }
$ready = $false
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/readyz" -f [int]$hn.port) -TimeoutSec 1
  $ready = $response.StatusCode -eq 200
} catch { }
$processOk = $false
$commandLine = ''
try {
  $process = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$hn.pid) -ErrorAction Stop
  if ($process) {
    $commandLine = [string]$process.CommandLine
    $processOk = $commandLine -match '(?i)app-server' -and $commandLine -match [regex]::Escape(("127.0.0.1:{0}" -f [int]$hn.port))
  }
} catch { }
@{ port = [int]$hn.port; pid = [int]$hn.pid; version = [string]$hn.version; ready = $ready; processOk = $processOk } | ConvertTo-Json -Compress
`, { capture: true, allowFailure: true, timeoutMs: 10000 });
  if (result.code !== 0) return null;
  return parseJsonObject(result.stdout);
}

function portState(worker, port) {
  const result = runPowerShell(worker, `$ErrorActionPreference = 'SilentlyContinue'
$port = ${Number(port)}
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/readyz" -f $port) -TimeoutSec 1
  if ($response.StatusCode -eq 200) { Write-Output 'ready'; exit 0 }
} catch { }
$client = New-Object Net.Sockets.TcpClient
try {
  $task = $client.ConnectAsync('127.0.0.1', $port)
  if ($task.Wait(250) -and $client.Connected) { Write-Output 'busy'; exit 0 }
} catch { } finally { $client.Dispose() }
Write-Output 'free'
`, { capture: true, allowFailure: true, timeoutMs: 5000 });
  return result.code === 0 ? result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) : "unknown";
}

function stopWindowsService(worker, serviceId, expectedPort = null) {
  const state = serviceStateRelative(serviceId);
  const result = runPowerShell(worker, `$ErrorActionPreference = 'SilentlyContinue'
$statePath = ${remotePathExpression(state)}
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { Write-Output 'stopped'; exit 0 }
try { $hn = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } catch { Remove-Item -LiteralPath $statePath -Force; Write-Output 'stopped'; exit 0 }
${expectedPort == null ? "" : `if ([int]$hn.port -ne ${Number(expectedPort)}) { throw 'Handoff Codex service port changed unexpectedly.' }`}
try {
  $process = Get-CimInstance Win32_Process -Filter ("ProcessId = {0}" -f [int]$hn.pid) -ErrorAction Stop
  if ($process) {
    $commandLine = [string]$process.CommandLine
    $expected = ("127.0.0.1:{0}" -f [int]$hn.port)
    if ($commandLine -match '(?i)app-server' -and $commandLine -match [regex]::Escape($expected)) {
      Invoke-CimMethod -InputObject $process -MethodName Terminate -Arguments @{ Reason = 0 } | Out-Null
    } else {
      throw 'Refusing to stop a PID that no longer looks like Handoff Codex app-server.'
    }
  }
} catch {
  if ($_.Exception.Message -match 'Refusing|unexpected') { throw }
}
Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
Write-Output 'stopped'
`, { capture: true, allowFailure: true, timeoutMs: 10000 });
  if (result.code !== 0) {
    fail(`Could not stop the worker Codex app-server safely: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  return true;
}

function launchWindowsService(worker, { serviceId, port, version }) {
  const state = serviceStateRelative(serviceId);
  const stdoutLog = serviceLogRelative(serviceId, "out");
  const stderrLog = serviceLogRelative(serviceId, "err");
  const childScript = `$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path ${remotePathExpression(".hn/state")} | Out-Null
New-Item -ItemType Directory -Force -Path ${remotePathExpression(".hn/logs")} | Out-Null
$codex = Get-Command codex -CommandType Application -ErrorAction Stop | Select-Object -First 1
$stdoutLog = ${remotePathExpression(stdoutLog)}
$stderrLog = ${remotePathExpression(stderrLog)}
$arguments = @('app-server', '--listen', ${quotePowerShell(`ws://127.0.0.1:${port}`)})
$process = Start-Process -FilePath $codex.Source -ArgumentList $arguments -WorkingDirectory $HOME -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
@{ pid = $process.Id; port = ${Number(port)}; version = ${quotePowerShell(version.raw)}; startedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${remotePathExpression(state)} -Encoding utf8
Wait-Process -Id $process.Id
`;
  const launched = runPowerShell(
    worker,
    windowsDetachedLaunchScript(childScript, { marker: `hn-codex-${serviceId}` }),
    { capture: true, allowFailure: true, timeoutMs: 15000 },
  );
  if (launched.code !== 0) {
    return { ok: false, reason: (launched.stderr || launched.stdout).trim().slice(0, 400) };
  }

  const ready = runPowerShell(worker, `$ErrorActionPreference = 'SilentlyContinue'
for ($i = 0; $i -lt 60; $i++) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ${quotePowerShell(`http://127.0.0.1:${port}/readyz`)} -TimeoutSec 1
    if ($response.StatusCode -eq 200) { Write-Output 'ready'; exit 0 }
  } catch { }
  Start-Sleep -Milliseconds 200
}
Write-Output 'not-ready'
if (Test-Path -LiteralPath ${remotePathExpression(stderrLog)}) { Get-Content -LiteralPath ${remotePathExpression(stderrLog)} -Tail 20 }
exit 1
`, { capture: true, allowFailure: true, timeoutMs: 20000 });
  if (ready.code !== 0 || !ready.stdout.includes("ready")) {
    return { ok: false, reason: (ready.stderr || ready.stdout).trim().slice(0, 800) };
  }
  const stateRecord = probeWindowsService(worker, serviceId);
  if (!stateRecord?.ready || !stateRecord?.processOk) {
    return { ok: false, reason: "app-server answered readyz but Handoff could not verify its recorded process" };
  }
  return { ok: true, ...stateRecord };
}

export function ensureCodexAppServer(worker, { controllerId, targetName, version }) {
  if (worker.platform !== "windows") fail("Codex thin-client service currently requires a Windows worker.");
  const identity = serviceIdentity(controllerId, targetName, worker);
  const serviceId = codexServiceId(identity);
  const existing = probeWindowsService(worker, serviceId);
  if (existing?.ready && existing?.processOk && existing.version === version.raw) {
    return { serviceId, port: existing.port, pid: existing.pid, reused: true };
  }
  if (existing) stopWindowsService(worker, serviceId, existing.port);

  const ports = codexRemotePortCandidates(identity);
  for (const port of ports) {
    if (portState(worker, port) !== "free") continue;
    const launched = launchWindowsService(worker, { serviceId, port, version });
    if (launched.ok) {
      return { serviceId, port, pid: launched.pid, reused: false };
    }
  }
  fail(`Could not start Codex app-server on ${worker.target}; no verified Handoff port became ready.`);
}

export function codexAppServerStatus(worker, { controllerId, targetName }) {
  if (worker.platform !== "windows") return { serviceId: null, ready: false, processOk: false };
  const serviceId = codexServiceId(serviceIdentity(controllerId, targetName, worker));
  const state = probeWindowsService(worker, serviceId);
  return state ? { serviceId, ...state } : { serviceId, ready: false, processOk: false };
}

export function stopCodexAppServer(worker, { controllerId, targetName }) {
  if (worker.platform !== "windows") return false;
  const serviceId = codexServiceId(serviceIdentity(controllerId, targetName, worker));
  const state = probeWindowsService(worker, serviceId);
  if (!state) return false;
  stopWindowsService(worker, serviceId, state.port);
  return true;
}

export function resolveWindowsRemoteCwd(worker, remoteCwd) {
  const result = runPowerShell(worker, `$ErrorActionPreference = 'Stop'
$path = ${remotePathExpression(remoteCwd)}
if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "Remote project path does not exist: $path" }
[Console]::Out.Write([IO.Path]::GetFullPath($path))
`, { capture: true, allowFailure: true, timeoutMs: 10000 });
  if (result.code !== 0) {
    fail(`Could not resolve the worker project path: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  return result.stdout.trim();
}

async function reserveLocalPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForLocalReady(port, tunnel, stderrText) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (tunnel.exitCode != null) {
      fail(`Codex SSH tunnel exited early (${tunnel.exitCode}): ${stderrText().trim().slice(0, 400)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.status === 200) return;
    } catch { }
    await sleep(100);
  }
  fail(`Codex app-server tunnel never became ready on localhost:${port}.`);
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
  });
}

function terminateChild(child, signal = "SIGTERM") {
  if (child && child.exitCode == null && child.signalCode == null) {
    try { child.kill(signal); } catch { }
  }
}

function controllerSignalGuard(client, tunnel) {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  let shuttingDown = false;
  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      terminateChild(client, signal);
      terminateChild(tunnel, "SIGTERM");
      // Restore normal signal semantics after our children are cleaned up.
      for (const [name, fn] of handlers) process.off(name, fn);
      process.kill(process.pid, signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

export async function runCodexRemoteTui(worker, {
  controllerId,
  targetName,
  remoteCwd,
  args = [],
  compatibility = null,
  backend = {},
}) {
  const compatible = compatibility ?? codexRemoteCompatibility(worker, backend);
  if (!compatible.ok) fail(compatible.reason);
  const service = (backend.ensureServer ?? ensureCodexAppServer)(worker, {
    controllerId,
    targetName,
    version: compatible.version,
  });
  const remoteAbsoluteCwd = (backend.resolveRemoteCwd ?? resolveWindowsRemoteCwd)(worker, remoteCwd);
  const localPort = await (backend.reserveLocalPort ?? reserveLocalPort)();
  if (!localPort) fail("Could not allocate a localhost port for the Codex tunnel.");

  const tunnelArgs = sshLocalForwardArgs(worker, {
    localHost: "127.0.0.1",
    localPort,
    remoteHost: "127.0.0.1",
    remotePort: service.port,
  });
  let tunnelStderr = "";
  const spawnProcess = backend.spawn ?? spawn;
  const tunnel = spawnProcess("ssh", tunnelArgs, { stdio: ["ignore", "ignore", "pipe"] });
  tunnel.stderr?.on("data", (chunk) => { tunnelStderr += String(chunk); });
  let client = null;
  let releaseSignalGuard = () => {};

  try {
    await (backend.waitReady ?? waitForLocalReady)(localPort, tunnel, () => tunnelStderr);
    const codexArgs = [
      "--remote", `ws://127.0.0.1:${localPort}`,
      "--cd", remoteAbsoluteCwd,
      ...args,
    ];
    client = spawnProcess("codex", codexArgs, { stdio: "inherit", env: process.env });
    releaseSignalGuard = (backend.signalGuard ?? controllerSignalGuard)(client, tunnel);
    const result = await waitForChild(client);
    return { ...result, service, localPort, remoteCwd: remoteAbsoluteCwd };
  } finally {
    releaseSignalGuard();
    terminateChild(tunnel, "SIGTERM");
  }
}
