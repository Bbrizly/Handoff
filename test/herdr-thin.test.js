import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { herdrAssetFor } from "../src/herdr.js";
import { sshSpawnArgs } from "../src/ssh.js";
import {
  THIN_HERDR_PROTOCOL,
  THIN_HERDR_VERSION,
  localThinClientEnvironment,
  thinClientAsset,
  thinClientSocketPath,
  thinServerCompatible,
  thinTransportMode,
  thinTransportSupported,
  thinWindowsSshShellCompatible,
  windowsClientBridgeArgs,
  windowsClientBridgeScript,
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

test("thin attach requires the exact existing Handoff session and detached official server", () => {
  const runtime = "hn-12345678-main";
  const good = {
    status: "running",
    running: true,
    version: "0.8.2",
    protocol: 20,
    session: runtime,
    socket: `C:\\Users\\dev\\AppData\\Roaming\\herdr\\sessions\\${runtime}\\herdr.sock`,
    capabilities: { detached_server_daemon: true },
  };
  assert.equal(thinServerCompatible(good, runtime), true);
  assert.equal(thinServerCompatible({ ...good, protocol: 19 }, runtime), false);
  assert.equal(thinServerCompatible({ ...good, version: "0.8.1" }, runtime), false);
  assert.equal(thinServerCompatible({ ...good, session: "other" }, runtime), false);
  assert.equal(thinServerCompatible({ ...good, capabilities: { detached_server_daemon: false } }, runtime), false);
});

test("thin bridge derives only the client socket beside the proven API socket", () => {
  const server = { socket: "C:\\Users\\dev\\AppData\\Roaming\\herdr\\sessions\\hn-main\\herdr.sock" };
  assert.equal(
    thinClientSocketPath(server),
    "C:\\Users\\dev\\AppData\\Roaming\\herdr\\sessions\\hn-main\\herdr-client.sock",
  );
  assert.throws(() => thinClientSocketPath({ socket: "C:\\tmp\\other.sock" }), /unexpected Windows server socket/);
});

test("Windows bridge is connect-only and carries raw byte streams", () => {
  const script = windowsClientBridgeScript("C:\\Users\\dev\\herdr-client.sock");
  assert.match(script, /NamedPipeClientStream/);
  assert.match(script, /OpenStandardInput/);
  assert.match(script, /OpenStandardOutput/);
  assert.match(script, /CopyToAsync/);
  assert.doesNotMatch(script, /herdr\.exe|Get-Command|server\s+start|server\s+stop|restart|provision/i);
  const args = windowsClientBridgeArgs("C:\\Users\\dev\\herdr-client.sock");
  assert.equal(args.at(-2), "-EncodedCommand");
  assert.ok(args.at(-1).length <= 6000);
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

test("Windows PowerShell bridge round-trips bytes through the real named-pipe API", {
  skip: process.platform !== "win32",
  timeout: 20_000,
}, async () => {
  const logicalName = `C:\\hn-herdr-${process.pid}-${Date.now()}\\herdr-client.sock`;
  const endpoint = `\\\\.\\pipe\\${logicalName}`;
  const server = net.createServer((socket) => {
    socket.once("data", (data) => {
      assert.equal(data.toString("utf8"), "ping");
      socket.end(Buffer.from("pong"));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });

  const args = windowsClientBridgeArgs(logicalName);
  const child = spawn("powershell.exe", args.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = Buffer.alloc(0);
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.stdin.write(Buffer.from("ping"));

  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await new Promise((resolve) => server.close(resolve));

  assert.equal(code, 0, stderr);
  assert.equal(stdout.toString("utf8"), "pong");
});
