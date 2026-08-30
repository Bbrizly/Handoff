import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { herdrAssetFor } from "../src/herdr.js";
import { sshSpawnArgs } from "../src/ssh.js";
import {
  THIN_HERDR_PROTOCOL,
  THIN_HERDR_VERSION,
  attachThinHerdr,
  localThinClientEnvironment,
  thinClientAsset,
  thinClientSocketPath,
  thinServerCompatible,
  thinTransportMode,
  thinTransportSupported,
  thinWindowsSshShellCompatible,
  forwardFailureReason,
  thinForwardArgs,
  windowsPipeBridgeArgs,
  windowsPipeBridgeScript,
} from "../src/herdr-thin.js";

test("thin Herdr uses the exact official v0.8.2 assets Handoff already pins", () => {
  assert.equal(THIN_HERDR_VERSION, "0.8.2");
  assert.equal(THIN_HERDR_PROTOCOL, 20);
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["linux", "x64"],
  ]) {
    assert.deepEqual(thinClientAsset(platform, arch), {
      file: herdrAssetFor(platform, arch).file,
      sha256: herdrAssetFor(platform, arch).sha256,
    });
  }
});

test("thin transport mode is safe and deterministic", () => {
  assert.equal(thinTransportMode({}), "auto");
  assert.equal(thinTransportMode({ HN_HERDR_TRANSPORT: "thin" }), "thin");
  assert.equal(thinTransportMode({ HN_HERDR_TRANSPORT: "legacy" }), "legacy");
  assert.equal(thinTransportMode({ HN_HERDR_TRANSPORT: "garbage" }), "auto");
});

test("thin transport only claims supported controller and worker pairs", () => {
  assert.equal(thinTransportSupported({ platform: "windows", arch: "x64" }, "darwin", "arm64"), true);
  assert.equal(thinTransportSupported({ platform: "linux", arch: "x64" }, "darwin", "arm64"), false);
  assert.equal(thinTransportSupported({ platform: "windows", arch: "arm64" }, "darwin", "arm64"), false);
  assert.equal(thinTransportSupported({ platform: "windows", arch: "x64" }, "win32", "x64"), false);
});

test("Windows thin attach accepts only streaming-safe OpenSSH shells", () => {
  assert.equal(thinWindowsSshShellCompatible("cmd.exe"), true);
  assert.equal(thinWindowsSshShellCompatible("C:\\Windows\\System32\\cmd.exe"), true);
  assert.equal(thinWindowsSshShellCompatible("pwsh.exe"), true);
  assert.equal(thinWindowsSshShellCompatible("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), true);
  assert.equal(thinWindowsSshShellCompatible("powershell.exe"), false);
  assert.equal(thinWindowsSshShellCompatible(""), false);
});

test("thin attach requires the exact existing Handoff session and a compatible official server", () => {
  const runtime = "hn-12345678-main";
  const good = {
    status: "running",
    running: true,
    version: "0.8.2",
    protocol: 20,
    session: runtime,
    socket: `C:\\Users\\dev\\AppData\\Roaming\\herdr\\sessions\\${runtime}\\herdr.sock`,
    compatible: true,
    restart_needed: false,
    capabilities: { live_handoff: false, detached_server_daemon: false },
  };
  assert.equal(thinServerCompatible(good, runtime), true);
  assert.equal(thinServerCompatible({ ...good, protocol: 19 }, runtime), false);
  assert.equal(thinServerCompatible({ ...good, version: "0.8.1" }, runtime), false);
  assert.equal(thinServerCompatible({ ...good, session: "other" }, runtime), false);
  assert.equal(thinServerCompatible({ ...good, running: false, status: "not_running" }, runtime), false);
  assert.equal(thinServerCompatible({ ...good, compatible: false }, runtime), false);
  assert.equal(thinServerCompatible({ ...good, restart_needed: true }, runtime), false);
});

// Real hardware, 2026-08-30: the Windows 0.8.2 desk reports both remote
// capabilities false, and a clean macOS 0.8.2 server does the same. A gate on
// detached_server_daemon could never pass, so thin mode never engaged.
test("the pinned Herdr never reports detached_server_daemon, so it cannot gate attach", () => {
  const runtime = "hn-9620c868-main";
  const observed = {
    status: "running",
    running: true,
    version: "0.8.2",
    protocol: 20,
    capabilities: { live_handoff: false, detached_server_daemon: false },
    compatible: true,
    socket: `C:\\Users\\Lenovo\\AppData\\Roaming\\herdr\\sessions\\${runtime}\\herdr.sock`,
    session: runtime,
    restart_needed: false,
  };
  assert.equal(thinServerCompatible(observed, runtime), true);
});

test("thin bridge derives only the client socket beside the proven API socket", () => {
  const server = { socket: "C:\\Users\\dev\\AppData\\Roaming\\herdr\\sessions\\hn-main\\herdr.sock" };
  assert.equal(
    thinClientSocketPath(server),
    "C:\\Users\\dev\\AppData\\Roaming\\herdr\\sessions\\hn-main\\herdr-client.sock",
  );
  assert.throws(() => thinClientSocketPath({ socket: "C:\\tmp\\other.sock" }), /unexpected Windows server socket/);
});

test("the worker helper is connect-only, loopback-only and holds no lifecycle authority", () => {
  const pipe = "C:\\Users\\dev\\AppData\\Roaming\\herdr\\sessions\\hn-main\\herdr-client.sock";
  const script = windowsPipeBridgeScript(pipe, 41234);
  assert.match(script, /NamedPipeClientStream/);
  assert.ok(script.includes(pipe), "the helper must target the exact already-running pipe");
  assert.match(script, /IPAddress\.Loopback/);
  assert.doesNotMatch(script, /IPAddress\.Any|0\.0\.0\.0|IPAddress\.IPv6Any/);
  assert.doesNotMatch(script, /Firewall/i);
  assert.doesNotMatch(script, /herdr\.exe|Get-Command|server\s+start|server\s+stop|restart|provision|update/i);
  assert.doesNotMatch(script, /\.herdr|config\.toml|profile\.ps1/i);
  // Protocol bytes ride the forwarded channel. The exec channel must stay out of
  // the data path, because Windows OpenSSH stops delivering its stdin.
  assert.doesNotMatch(script, /OpenStandardInput|OpenStandardOutput/);
});

test("the worker helper takes one attachment, checks its peer, and lets go", () => {
  const script = windowsPipeBridgeScript("C:\\hn\\herdr-client.sock", 41234);
  assert.match(script, /listener\.Stop\(\)/);
  assert.match(script, /acceptMs/);
  assert.match(script, /HN-NOCLIENT/);
  assert.match(script, /HN-PORTBUSY/);
  // A loopback port is open to every local account; the named pipe is not.
  assert.match(script, /WindowsIdentity\.GetCurrent\(\)\.User\.Value/);
  assert.match(script, /HN-DENIED/);
});

test("the helper runner fits a Windows OpenSSH argv and cleans its own script up", () => {
  const args = windowsPipeBridgeArgs(".hn-herdr-bridge-deadbeef.ps1");
  assert.equal(args.at(-2), "-EncodedCommand");
  assert.ok(args.at(-1).length <= 6000);
  const runner = Buffer.from(args.at(-1), "base64").toString("utf16le");
  assert.match(runner, /Remove-Item/);
  assert.doesNotMatch(runner, /powershell\.exe\s+-File|&\s*\$hnScript/);
});

test("Herdr bytes travel on a forwarded socket, never on the exec channel", () => {
  const args = thinForwardArgs({ target: "dev@example", port: 2222 }, "/tmp/private/relay.sock", 41234, ["powershell.exe", "-EncodedCommand", "x"]);
  assert.ok(args.includes("-L"));
  assert.equal(args[args.indexOf("-L") + 1], "/tmp/private/relay.sock:127.0.0.1:41234");
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
  assert.ok(!args.includes("-tt"), "a ConPTY would rewrite the raw byte stream");
  assert.ok(args.includes("-T"));
  // ssh keeps the first value it sees, so the attachment's own connection wins.
  assert.ok(args.indexOf("ControlMaster=no") < args.indexOf("ControlMaster=auto"));
  assert.ok(args.indexOf("ControlPath=none") < args.findIndex((value) => value.startsWith("ControlPath=") && value !== "ControlPath=none"));
  const target = args.indexOf("dev@example");
  assert.deepEqual(args.slice(target - 2, target), ["-p", "2222"]);
  assert.deepEqual(args.slice(target + 1), ["powershell.exe", "-EncodedCommand", "x"]);
});

test("a worker that refuses TCP forwarding says so instead of blaming Herdr", () => {
  assert.match(
    forwardFailureReason("channel 2: open failed: administratively prohibited: open failed"),
    /refuses TCP forwarding/,
  );
  assert.match(forwardFailureReason("unix_listener: cannot bind to path /tmp/x"), /local Herdr socket/);
  assert.match(forwardFailureReason(""), /failed to start/);
});

test("local renderer gets a fully Handoff-owned namespace and ignores ambient Herdr state", () => {
  const local = {
    configPath: "/hn/config/herdr/config.toml",
    configHome: "/hn/config",
    stateHome: "/hn/state",
    cacheHome: "/hn/cache",
  };
  const env = localThinClientEnvironment(local, "/tmp/relay.sock", {
    HOME: "/Users/test",
    HERDR_SOCKET_PATH: "/tmp/wrong.sock",
    HERDR_SESSION: "wrong-session",
    HERDR_ENV: "1",
    HERDR_REMOTE_BINARY: "/tmp/wrong-herdr",
  });
  assert.equal(env.HERDR_CONFIG_PATH, local.configPath);
  assert.equal(env.XDG_CONFIG_HOME, local.configHome);
  assert.equal(env.XDG_STATE_HOME, local.stateHome);
  assert.equal(env.XDG_CACHE_HOME, local.cacheHome);
  assert.equal(env.HERDR_CLIENT_SOCKET_PATH, "/tmp/relay.sock");
  assert.equal(env.HERDR_REMOTE_KEYBINDINGS, "local");
  assert.equal(env.HERDR_RENDER_ENCODING, "terminal-ansi");
  assert.equal(env.HERDR_SOCKET_PATH, undefined);
  assert.equal(env.HERDR_SESSION, undefined);
  assert.equal(env.HERDR_ENV, undefined);
  assert.equal(env.HERDR_REMOTE_BINARY, undefined);
});

test("streaming relay reuses Handoff SSH policy including control socket and custom port", () => {
  const args = sshSpawnArgs({ target: "dev@example", port: 2222 });
  assert.ok(args.includes("ControlMaster=auto"));
  assert.ok(args.includes("ControlPersist=60"));
  assert.ok(args.some((value) => value.startsWith("ControlPath=")));
  assert.deepEqual(args.slice(-3), ["-p", "2222", "dev@example"]);
});

test("the Windows helper carries delayed binary traffic between TCP and the real named pipe", {
  skip: process.platform !== "win32",
  timeout: 60_000,
}, async () => {
  const { randomBytes } = await import("node:crypto");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const logicalName = `C:\\hn-herdr-${process.pid}-${Date.now()}\\herdr-client.sock`;
  const endpoint = `\\\\.\\pipe\\${logicalName}`;
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });

  const port = 41000 + (randomBytes(2).readUInt16BE(0) % 4000);
  const stage = mkdtempSync(join(tmpdir(), "hn-herdr-test-"));
  const scriptPath = join(stage, "bridge.ps1");
  writeFileSync(scriptPath, `\uFEFF${windowsPipeBridgeScript(logicalName, port, 30_000)}`, "utf8");
  const child = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `. ([scriptblock]::Create((Get-Content -LiteralPath '${scriptPath}' -Raw)))`,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  const deadline = Date.now() + 30_000;
  while (!stdout.includes("HN-READY") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(stdout.includes("HN-READY"), `helper never bound: ${stdout} ${stderr}`);

  const wire = net.connect({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    wire.once("connect", resolve);
    wire.once("error", reject);
  });
  let inbox = Buffer.alloc(0);
  wire.on("data", (chunk) => { inbox = Buffer.concat([inbox, chunk]); });

  // The stdio bridge this replaced delivered only what was buffered before the
  // remote command started. Every later write vanished, so the delays matter.
  for (const [waitMs, size] of [[0, 64], [1500, 64], [1500, 64], [2000, 4096], [6000, 2048]]) {
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    inbox = Buffer.alloc(0);
    const payload = randomBytes(size);
    wire.write(payload);
    const until = Date.now() + 10_000;
    while (inbox.length < size && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(inbox.equals(payload), `binary payload of ${size} bytes after ${waitMs}ms did not survive`);
  }

  wire.end();
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 0, stderr);
  await new Promise((resolve) => server.close(resolve));
  rmSync(stage, { recursive: true, force: true });
});

test("the Windows helper refuses a busy loopback port so the attach can retry", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async () => {
  const blocker = net.createServer(() => {});
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = blocker.address().port;
  const child = spawn("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(windowsPipeBridgeScript("C:\\hn\\nothing.sock", port, 5000), "utf16le").toString("base64"),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await new Promise((resolve) => blocker.close(resolve));
  assert.match(stdout, /HN-PORTBUSY/);
  assert.equal(code, 3);
});
