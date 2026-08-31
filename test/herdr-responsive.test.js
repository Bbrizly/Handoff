import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RESPONSIVE_HERDR_PROTOCOL,
  RESPONSIVE_HERDR_REF,
  RESPONSIVE_HERDR_VERSION,
  responsiveApiSocketPath,
  responsiveAsset,
  responsiveHerdrRequested,
  responsiveHerdrWorker,
  responsiveLocalEnvironment,
  responsiveRuntimeName,
  responsiveServerCompatible,
  responsiveTransportSupported,
} from "../src/herdr-responsive.js";
import { herdrBinaryRelative, herdrCommandScript } from "../src/herdr.js";
import { thinTransportMode } from "../src/herdr-thin.js";

test("responsive Herdr is pinned to one exact source/protocol contract", () => {
  assert.equal(RESPONSIVE_HERDR_REF, "20a0cd5294fb15ef17209612d80d5a2704169990");
  assert.equal(RESPONSIVE_HERDR_VERSION, "0.7.4");
  assert.equal(RESPONSIVE_HERDR_PROTOCOL, 17);
});

test("every responsive runtime binary is checksum pinned", () => {
  assert.equal(
    responsiveAsset("darwin", "arm64")?.sha256,
    "cb7f5495cf50555a83813cc1f16e280517978b0e4771178c2513d3d3d5805b4f",
  );
  assert.equal(
    responsiveAsset("darwin", "x64")?.sha256,
    "ae255d36f935b66ac7585e7e4157bb7bd02a8598136f5465ef143b7cced64c2f",
  );
  assert.equal(
    responsiveAsset("windows", "x64")?.sha256,
    "3e6fd237375940724c2085adb477f76b5f6d1d42f204913055dda025bd4863a9",
  );
  assert.equal(responsiveAsset("linux", "x64"), null);
});

test("mirror transport is explicit and never aliases auto mode", () => {
  assert.equal(responsiveHerdrRequested({ HN_HERDR_TRANSPORT: "mirror" }), true);
  assert.equal(responsiveHerdrRequested({ HN_HERDR_TRANSPORT: "MIRROR" }), true);
  assert.equal(responsiveHerdrRequested({ HN_HERDR_TRANSPORT: "auto" }), false);
  assert.equal(thinTransportMode({ HN_HERDR_TRANSPORT: "mirror" }), "mirror");
  assert.equal(thinTransportMode({ HN_HERDR_TRANSPORT: "garbage" }), "auto");
});

test("responsive transport claims only the dogfooded Mac to Windows topology", () => {
  const windows = { platform: "windows", arch: "x64" };
  assert.equal(responsiveTransportSupported(windows, "darwin", "arm64"), true);
  assert.equal(responsiveTransportSupported(windows, "darwin", "x64"), true);
  assert.equal(responsiveTransportSupported(windows, "linux", "x64"), false);
  assert.equal(responsiveTransportSupported({ platform: "windows", arch: "arm64" }, "darwin", "arm64"), false);
  assert.equal(responsiveTransportSupported({ platform: "linux", arch: "x64" }, "darwin", "arm64"), false);
});

test("responsive worker view is isolated from stable Herdr paths and does not mutate the worker", () => {
  const worker = { platform: "windows", arch: "x64", target: "u@h", herdrVersion: "0.8.2" };
  const desk = responsiveHerdrWorker(worker);
  assert.notEqual(desk, worker);
  assert.equal(worker.__hnHerdrBinaryRelative, undefined);
  assert.equal(worker.__hnHerdrConfigRelative, undefined);
  assert.match(desk.__hnHerdrBinaryRelative, /^\.hn\/bin\/herdr-mirror\/20a0cd5294fb15ef17209612d80d5a2704169990\/herdr\.exe$/);
  assert.match(desk.__hnHerdrConfigRelative, /^\.hn\/herdr-mirror\/20a0cd5294fb15ef17209612d80d5a2704169990\/config\.toml$/);
  assert.equal(herdrBinaryRelative(worker), ".hn/bin/herdr/0.8.2/herdr.exe");
  assert.equal(herdrBinaryRelative(desk), desk.__hnHerdrBinaryRelative);

  const command = herdrCommandScript(desk, "hn-test-mirror-20a0cd5", ["workspace", "list"]);
  assert.match(command, /herdr-mirror/);
  assert.match(command, /config\.toml/);
  assert.doesNotMatch(command, /\.hn\\herdr\\config\.toml/);
});

test("responsive desk name cannot collide with the stable desk", () => {
  const stable = "hn-deadbeef-main";
  const mirror = responsiveRuntimeName(stable);
  assert.equal(mirror, "hn-deadbeef-main-mirror-20a0cd5");
  assert.notEqual(mirror, stable);
});

test("responsive readiness accepts only the exact version protocol and session", () => {
  const valid = {
    running: true,
    status: "running",
    version: "0.7.4",
    protocol: 17,
    compatible: true,
    restart_needed: false,
    session: "hn-x-mirror-20a0cd5",
  };
  assert.equal(responsiveServerCompatible(valid, valid.session), true);
  assert.equal(responsiveServerCompatible({ ...valid, version: "0.8.2", protocol: 20 }, valid.session), false);
  assert.equal(responsiveServerCompatible({ ...valid, protocol: 18 }, valid.session), false);
  assert.equal(responsiveServerCompatible({ ...valid, session: "hn-x" }, valid.session), false);
  assert.equal(responsiveServerCompatible({ ...valid, restart_needed: true }, valid.session), false);
  assert.equal(responsiveServerCompatible({ ...valid, running: false }, valid.session), false);
});

test("responsive control socket must be the proven Herdr API socket", () => {
  assert.equal(
    responsiveApiSocketPath({ socket: "C:\\Users\\u\\.local\\state\\herdr\\x\\herdr.sock" }),
    "C:\\Users\\u\\.local\\state\\herdr\\x\\herdr.sock",
  );
  assert.throws(() => responsiveApiSocketPath({ socket: "C:\\tmp\\wrong.sock" }), /unexpected API socket/);
  assert.throws(() => responsiveApiSocketPath({}), /unexpected API socket/);
});

test("local mirror owns a private Herdr namespace and ignores ambient remote state", () => {
  const local = {
    configPath: "/private/config/herdr/config.toml",
    configHome: "/private/config",
    stateHome: "/private/state",
    cacheHome: "/private/cache",
  };
  const env = responsiveLocalEnvironment(local, "/private/relay/herdr.sock", {
    PATH: "/bin",
    HERDR_CLIENT_SOCKET_PATH: "/bad/client.sock",
    HERDR_SESSION: "wrong",
    HERDR_ENV: "wrong",
    HERDR_REMOTE_BINARY: "wrong",
    HERDR_RENDER_ENCODING: "wrong",
    HERDR_REMOTE_KEYBINDINGS: "wrong",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HERDR_CONFIG_PATH, local.configPath);
  assert.equal(env.HERDR_SOCKET_PATH, "/private/relay/herdr.sock");
  assert.equal(env.XDG_CONFIG_HOME, local.configHome);
  assert.equal(env.XDG_STATE_HOME, local.stateHome);
  assert.equal(env.XDG_CACHE_HOME, local.cacheHome);
  for (const key of [
    "HERDR_CLIENT_SOCKET_PATH", "HERDR_SESSION", "HERDR_ENV", "HERDR_REMOTE_BINARY",
    "HERDR_RENDER_ENCODING", "HERDR_REMOTE_KEYBINDINGS",
  ]) assert.equal(key in env, false, `${key} leaked into the mirror client`);
});

test("responsive attach forwards sibling control and raw-data sockets then launches local --mirror", () => {
  const source = readFileSync(new URL("../src/herdr-responsive.js", import.meta.url), "utf8");
  assert.match(source, /join\(dir, "herdr\.sock"\)/);
  assert.match(source, /join\(dir, "herdr-client\.sock"\)/);
  assert.match(source, /startPipeForward\(worker, apiPipe, localApi, dir, "control"\)/);
  assert.match(source, /startPipeForward\(worker, clientPipe, localClient, dir, "data"\)/);
  assert.match(source, /spawnSync\(local\.binary, \["--mirror"\]/);
  assert.match(source, /chmodSync\(dir, 0o700\)/);
});

test("persistent desk keeps runtime-only Herdr overrides out of worker metadata", () => {
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const desk = source.slice(source.indexOf("function runPersistentDesk"), source.indexOf("function managedExpectationFor"));
  assert.match(desk, /let deskWorker = responsive \? responsiveHerdrWorker\(worker\) : worker;/);
  assert.match(desk, /ensureHerdrServer\(deskWorker, runtime/);
  assert.match(desk, /attachHerdr\(deskWorker, runtime\)/);
  assert.doesNotMatch(desk, /persistWorkerMetadata\([^\n]*__hnHerdr/);
  assert.doesNotMatch(desk, /context = \{ \.\.\.context, worker: deskWorker \}/);
});

test("responsive port retries cannot inherit stale readiness markers", () => {
  const source = readFileSync(new URL("../src/herdr-responsive.js", import.meta.url), "utf8");
  assert.match(source, /forward-\$\{label\}-\$\{attempt\}\.log/);
  assert.match(source, /openSync\(logPath, "w\+"\)/);
  assert.doesNotMatch(source, /openSync\(logPath, "a\+"\)/);
});
