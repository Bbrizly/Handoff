import test from "node:test";
import assert from "node:assert/strict";
import {
  THIN_HERDR_PROTOCOL,
  THIN_HERDR_RELEASE,
  THIN_HERDR_UPSTREAM_VERSION,
  thinBridgeCompatible,
  thinClientAsset,
  thinServerCompatible,
  thinTransportMode,
  thinTransportSupported,
} from "../src/herdr-thin.js";

test("thin Herdr runtime is pinned to the reviewed 0.8.2-compatible release", () => {
  assert.equal(THIN_HERDR_RELEASE, "2026.08.27.5");
  assert.equal(THIN_HERDR_UPSTREAM_VERSION, "0.8.2");
  assert.equal(THIN_HERDR_PROTOCOL, 20);
  assert.equal(
    thinClientAsset("darwin", "arm64")?.sha256,
    "d39a3a6f0c00ef42392533c7ba547933e7480836556c10e054faf747a37733ca",
  );
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

test("thin attach requires the existing Handoff server to be protocol-compatible and detached", () => {
  const good = {
    running: true,
    version: "0.8.2",
    protocol: 20,
    capabilities: { detached_server_daemon: true },
  };
  assert.equal(thinServerCompatible(good), true);
  assert.equal(thinServerCompatible({ ...good, protocol: 19 }), false);
  assert.equal(thinServerCompatible({ ...good, version: "0.8.1" }), false);
  assert.equal(thinServerCompatible({ ...good, capabilities: { detached_server_daemon: false } }), false);
});

test("thin bridge must be the exact pinned fork release and protocol", () => {
  const good = {
    state: "ok",
    version: "herdr-win 2026.08.27.5 (Herdr 0.8.2)",
    protocol: 20,
  };
  assert.equal(thinBridgeCompatible(good), true);
  assert.equal(thinBridgeCompatible({ ...good, protocol: 19 }), false);
  assert.equal(thinBridgeCompatible({ ...good, version: "herdr 0.8.2" }), false);
  assert.equal(thinBridgeCompatible({ ...good, state: "broken" }), false);
});
