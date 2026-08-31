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
import { basename, dirname, join, win32 } from "node:path";
import { copyToWorker, powerShellInvocation, runPowerShell, sshSpawnArgs } from "./ssh.js";
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

// The forward is up as soon as sshd answers and the helper binds, so this only
// has to cover a cold SSH connection, not a Herdr start.
const FORWARD_READY_TIMEOUT_MS = 30000;
// How long the worker helper waits for the renderer before giving up and exiting.
const BRIDGE_ACCEPT_MS = 20000;
const PORT_ATTEMPTS = 5;

function normalizedArch(value) {
  if (["x64", "amd64", "x86_64"].includes(value)) return "x64";
  if (["arm64", "aarch64"].includes(value)) return "arm64";
  return value;
}

// Attach latency is the product question, so the stages are separable on demand
// instead of guessed at afterwards.
const stageOrigin = Date.now();
function stage(name) {
  if (process.env.HN_HERDR_TIMING !== "1") return;
  process.stderr.write(`hn thin ${name} +${Date.now() - stageOrigin}ms\n`);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function thinTransportMode(env = process.env) {
  const value = String(env.HN_HERDR_TRANSPORT ?? "auto").trim().toLowerCase();
  if (["auto", "mirror", "thin", "legacy"].includes(value)) return value;
  return "auto";
}

export function thinClientAsset(platform = process.platform, arch = process.arch) {
  return CLIENT_ASSETS[`${platform}:${normalizedArch(arch)}`] ?? null;
}

// Real hardware, 2026-08-30. Herdr protocol bytes never ride an SSH exec
// channel. Windows OpenSSH only keeps exec stdin alive under a ConPTY, so the
// first bridge drew one frame and then ignored every key, and -tt is no answer
// because a ConPTY echoes and rewrites what has to stay a raw byte stream.
// The bytes take a direct-tcpip channel instead: ssh -L publishes the private
// Unix socket the renderer wants and forwards it to a loopback-only port the
// worker helper opened for this one attachment.
export function thinTransportSupported(worker, platform = process.platform, arch = process.arch) {
  return Boolean(thinClientAsset(platform, arch))
    && worker?.platform === "windows"
    && worker?.arch === "x64";
}

export function thinWindowsSshShellCompatible(value) {
  const name = basename(String(value ?? "").trim().replaceAll("\\", "/")).toLowerCase();
  return ["cmd", "cmd.exe", "pwsh", "pwsh.exe"].includes(name);
}

// `capabilities.detached_server_daemon` is not a gate. It belongs to Herdr's
// RemoteServerCapabilities, which describe `herdr --remote`, and 0.8.2 reports
// it false on every platform, so requiring it made thin mode unreachable.
// `compatible` and `restart_needed` are Herdr's own verdict on whether a client
// may attach to this server, so use those instead.
export function thinServerCompatible(server, runtime = null) {
  return Boolean(
    server?.running
    && server?.status === "running"
    && String(server.version ?? "") === THIN_HERDR_VERSION
    && Number(server.protocol) === THIN_HERDR_PROTOCOL
    && server?.compatible === true
    && server?.restart_needed !== true
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
// This helper connects to that exact already-running pipe and copies bytes. It
// holds no Herdr path and no start, stop, restart or update logic.
//
// A loopback port is reachable by every account on the machine, which the pipe
// itself is not, so the helper drops any connection whose process does not run
// as the same Windows user. That keeps the pipe's own trust boundary.
//
// The copying is C# because a PowerShell scriptblock gets no runspace on a
// thread-pool thread, so the obvious Task-based version silently does nothing.
export function windowsPipeBridgeSource() {
  return `using System;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
public static class HnHerdrBridge {
  [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr t, ref int size, bool order, int af, int cls, int res);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] struct Row { public uint state, local, localPort, remote, remotePort, pid; }
  public static int Run(string pipeName, int port, int acceptMs) {
    TcpListener listener = new TcpListener(IPAddress.Loopback, port);
    try { listener.Start(); }
    catch (SocketException) { Console.Out.WriteLine("HN-PORTBUSY"); Console.Out.Flush(); return 3; }
    Console.Out.WriteLine("HN-READY");
    Console.Out.Flush();
    try {
      IAsyncResult pending = listener.BeginAcceptTcpClient(null, null);
      if (!pending.AsyncWaitHandle.WaitOne(acceptMs)) { Console.Error.WriteLine("HN-NOCLIENT"); return 4; }
      using (TcpClient client = listener.EndAcceptTcpClient(pending)) {
        listener.Stop();
        client.NoDelay = true;
        int peer = ((IPEndPoint)client.Client.RemoteEndPoint).Port;
        if (Sid(OwnerPid(port, peer)) != WindowsIdentity.GetCurrent().User.Value) {
          Console.Error.WriteLine("HN-DENIED");
          return 5;
        }
        NetworkStream wire = client.GetStream();
        using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous)) {
          pipe.Connect(5000);
          Thread down = new Thread(delegate() { Pump(pipe, wire); });
          down.IsBackground = true;
          down.Start();
          Pump(wire, pipe);
        }
      }
    } finally { try { listener.Stop(); } catch {} }
    return 0;
  }
  static void Pump(Stream from, Stream to) {
    byte[] buffer = new byte[65536];
    try { int n; while ((n = from.Read(buffer, 0, buffer.Length)) > 0) { to.Write(buffer, 0, n); to.Flush(); } } catch {}
  }
  static string Sid(int pid) {
    if (pid <= 0) return null;
    IntPtr proc = OpenProcess(0x1000, false, pid);
    if (proc == IntPtr.Zero) return null;
    try {
      IntPtr token;
      if (!OpenProcessToken(proc, 0x8, out token)) return null;
      try { return new WindowsIdentity(token).User.Value; } finally { CloseHandle(token); }
    } finally { CloseHandle(proc); }
  }
  static int OwnerPid(int local, int remote) {
    int size = 0;
    GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 5, 0);
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      if (GetExtendedTcpTable(buffer, ref size, false, 2, 5, 0) != 0) return -1;
      int rows = Marshal.ReadInt32(buffer);
      int stride = Marshal.SizeOf(typeof(Row));
      for (int i = 0; i < rows; i++) {
        Row row = (Row)Marshal.PtrToStructure((IntPtr)((long)buffer + 4 + i * stride), typeof(Row));
        if (Port(row.localPort) == local && Port(row.remotePort) == remote) return (int)row.pid;
      }
      return -1;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  static int Port(uint value) { return (int)(((value & 0xff) << 8) | ((value >> 8) & 0xff)); }
}`;
}

export function windowsPipeBridgeScript(pipePath, port, acceptMs = BRIDGE_ACCEPT_MS) {
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${windowsPipeBridgeSource()}
'@
exit [HnHerdrBridge]::Run(${quotePowerShell(pipePath)}, ${Number(port)}, ${Number(acceptMs)})
`;
}

// The helper is far too big for a Windows OpenSSH argv even gzipped, so it
// travels by scp like Handoff's other oversized scripts. Calling a .ps1 by path
// is what the worker's execution policy blocks, hence the scriptblock. The name
// is random per attachment and the runner deletes it on the way out.
export function windowsPipeBridgeRunner(remoteScript) {
  return `$hnScript = Join-Path $HOME ${quotePowerShell(remoteScript)}
try {
  . ([scriptblock]::Create((Get-Content -LiteralPath $hnScript -Raw -ErrorAction Stop)))
} finally {
  Remove-Item -LiteralPath $hnScript -Force -ErrorAction SilentlyContinue
}
`;
}

export function windowsPipeBridgeArgs(remoteScript) {
  const invocation = powerShellInvocation(windowsPipeBridgeRunner(remoteScript));
  if (!invocation.args) throw new Error("Handoff Herdr bridge runner exceeded the safe Windows OpenSSH argv budget");
  return invocation.args;
}

function stageBridgeScript(worker, pipePath, port) {
  const remote = `.hn-herdr-bridge-${randomBytes(8).toString("hex")}.ps1`;
  const stage = mkdtempSync(join(tmpdir(), "hn-herdr-ps-"));
  const local = join(stage, "bridge.ps1");
  // The BOM is what makes Windows PowerShell read the file as UTF-8.
  writeFileSync(local, `\uFEFF${windowsPipeBridgeScript(pipePath, port)}`, "utf8");
  try {
    copyToWorker(worker, local, remote);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return remote;
}

// The renderer wants a Unix socket, so let SSH publish one. Nothing of Handoff's
// sits in the byte path: sshd forwards the socket to the helper's loopback port
// over a direct-tcpip channel.
//
// The attachment owns its SSH connection. A shared ControlMaster would hand the
// forward's lifetime to a connection Handoff did not open and cannot close, and
// a stale master refuses new sessions outright. ssh keeps the first value it
// sees for an option, so these win over the shared policy that follows.
export function thinForwardArgs(worker, socketPath, port, remoteArgs) {
  return [
    "-T",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-L", `${socketPath}:127.0.0.1:${port}`,
    ...sshSpawnArgs(worker),
    ...remoteArgs,
  ];
}

function ephemeralLoopbackPort() {
  return 20000 + (randomBytes(2).readUInt16BE(0) % 40000);
}

function forwardSocketLocation() {
  // tmpdir() is world-shared on some Unix systems, and ssh creates the forward
  // socket world-writable. Put it inside a private directory so no other local
  // account can reach the renderer's end of the channel.
  const dir = mkdtempSync(join(tmpdir(), "hn-herdr-"));
  chmodSync(dir, 0o700);
  return { dir, socketPath: join(dir, "relay.sock") };
}

function startThinForward(worker, pipePath) {
  let last = "the SSH forward for the Herdr renderer never became ready";
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const port = ephemeralLoopbackPort();
    const remoteScript = stageBridgeScript(worker, pipePath, port);
    const { dir, socketPath } = forwardSocketLocation();
    const logPath = join(dir, "forward.log");
    // The CLI attach is synchronous, so the helper reports readiness through a
    // file this can poll rather than a stream this would have to await.
    const log = openSync(logPath, "a+");
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
      return { ready: true, child, socketPath, dir, logPath, port };
    }

    try { child.kill("SIGTERM"); } catch {}
    if (/HN-PORTBUSY/.test(text)) {
      rmSync(dir, { recursive: true, force: true });
      last = `loopback port ${port} on the worker was busy`;
      continue;
    }
    const detail = text.trim().split("\n").filter((line) => !line.startsWith("HN-")).slice(-3).join("; ");
    rmSync(dir, { recursive: true, force: true });
    return { ready: false, reason: forwardFailureReason(detail) };
  }
  return { ready: false, reason: `${last} after ${PORT_ATTEMPTS} tries` };
}

export function forwardFailureReason(detail) {
  const text = String(detail ?? "");
  if (/administratively prohibited|open failed/i.test(text)) {
    return "the worker's sshd refuses TCP forwarding, so the Herdr renderer has no way in (AllowTcpForwarding)";
  }
  if (/cannot bind to path|Address already in use/i.test(text)) {
    return `the local Herdr socket could not be created: ${text}`;
  }
  return `the SSH forward for the Herdr renderer failed to start${text ? `: ${text}` : ""}`;
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
  // `--session` / HERDR_SESSION outranks HERDR_CLIENT_SOCKET_PATH in upstream
  // Herdr. Never let an ambient Herdr shell/session redirect Handoff's renderer
  // away from the private relay socket. HERDR_ENV would also trigger nested-Herdr
  // rejection before client mode can connect.
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_SESSION;
  delete env.HERDR_ENV;
  delete env.HERDR_REMOTE_BINARY;
  return env;
}

export function attachThinHerdr(worker, runtime, { readiness = null } = {}) {
  if (!thinTransportSupported(worker)) {
    return { available: false, reason: `thin client unsupported for ${process.platform}/${process.arch} -> ${worker?.platform}/${worker?.arch}` };
  }

  stage("probe-start");
  const observed = readiness ?? probeThinReadiness(worker, runtime);
  stage("probe-done");
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

  let forward = null;
  try {
    stage("forward-start");
    forward = startThinForward(worker, clientSocket);
    if (!forward.ready) return { available: false, reason: forward.reason };
    stage("forward-ready");

    const result = spawnSync(local.binary, ["client"], {
      stdio: "inherit",
      env: localThinClientEnvironment(local, forward.socketPath),
    });
    stage("client-exit");
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
    if (forward) {
      try { forward.child.kill("SIGTERM"); } catch {}
      try { rmSync(forward.dir, { recursive: true, force: true }); } catch {}
    }
  }
}
