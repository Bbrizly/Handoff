import test from "node:test";
import assert from "node:assert/strict";
import { mutagenEndpoint, parseSyncStatusOutput, syncSessionName } from "../src/mutagen.js";

const root = { local: "/Users/me/GitHub", remote: "hn/main/GitHub" };

test("Mutagen SSH endpoint includes custom ports correctly", () => {
  const worker = { user: "me", host: "example.com", target: "me@example.com", port: 2222 };
  assert.equal(mutagenEndpoint(worker, "hn/main/GitHub"), "me@example.com:2222:hn/main/GitHub");
});

test("Mutagen rejects literal IPv6 and asks for an SSH alias", () => {
  const worker = { user: "me", host: "fd7a:115c:a1e0::1", target: "me@fd7a:115c:a1e0::1", port: 22 };
  assert.throws(
    () => mutagenEndpoint(worker, "hn/main/GitHub"),
    /SSH hostname\/alias/,
  );
});

test("sync session identity changes when target changes", () => {
  const pc = { user: "me", host: "pc", target: "me@pc", port: 22 };
  const aws = { user: "ubuntu", host: "aws", target: "ubuntu@aws", port: 22 };
  const pcName = syncSessionName("main", "pc", pc, root);
  const awsName = syncSessionName("main", "aws", aws, root);
  assert.notEqual(pcName, awsName);
});

test("sync status counts visible and excluded conflicts", () => {
  assert.deepEqual(parseSyncStatusOutput("Watching for changes|2|3"), {
    state: "watching for changes",
    conflicts: 5,
  });
});

test("sync status tolerates empty conflict counts", () => {
  assert.deepEqual(parseSyncStatusOutput("Scanning||"), {
    state: "scanning",
    conflicts: 0,
  });
});
