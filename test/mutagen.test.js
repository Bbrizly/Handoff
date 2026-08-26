import test from "node:test";
import assert from "node:assert/strict";
import {
  checksumForAsset,
  mutagenEndpoint,
  mutagenReleaseAsset,
  parseSessionRecords,
  parseSyncStatusOutput,
  syncSessionName,
} from "../src/mutagen.js";

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

test("session records parse one real line per Mutagen session", () => {
  const output = [
    "hn-sync-a|sync_first|2026-08-26T20:00:00Z",
    "hn-sync-a|sync_second|2026-08-26T20:05:00Z",
    "hn-sync-b|sync_third|2026-08-26T20:06:00Z",
    "",
  ].join("\n");
  assert.deepEqual(parseSessionRecords(output), [
    { name: "hn-sync-a", identifier: "sync_first", creationTime: "2026-08-26T20:00:00Z" },
    { name: "hn-sync-a", identifier: "sync_second", creationTime: "2026-08-26T20:05:00Z" },
    { name: "hn-sync-b", identifier: "sync_third", creationTime: "2026-08-26T20:06:00Z" },
  ]);
});

test("session parser rejects the old literal-backslash newline failure mode", () => {
  const records = parseSessionRecords("hn-sync-a\\nhn-sync-b\\n");
  assert.equal(records.length, 0);
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

test("empty sync status means session is not started", () => {
  assert.deepEqual(parseSyncStatusOutput(""), {
    state: "not-started",
    conflicts: 0,
  });
});

test("managed Mutagen selects the official macOS ARM64 release asset", () => {
  assert.equal(mutagenReleaseAsset("darwin", "arm64"), "mutagen_darwin_arm64_v0.18.1.tar.gz");
});

test("managed Mutagen selects the official Linux x64 release asset", () => {
  assert.equal(mutagenReleaseAsset("linux", "x64"), "mutagen_linux_amd64_v0.18.1.tar.gz");
});

test("managed Mutagen rejects unsupported controller platforms", () => {
  assert.equal(mutagenReleaseAsset("win32", "x64"), null);
  assert.equal(mutagenReleaseAsset("darwin", "ia32"), null);
});

test("official SHA256SUMS parser finds exact release asset", () => {
  const asset = "mutagen_darwin_arm64_v0.18.1.tar.gz";
  const digest = "a".repeat(64);
  const sums = `${"b".repeat(64)}  another-file.tar.gz\n${digest}  ${asset}\n`;
  assert.equal(checksumForAsset(sums, asset), digest);
});

test("official SHA256SUMS parser accepts binary marker format", () => {
  const asset = "mutagen_linux_amd64_v0.18.1.tar.gz";
  const digest = "c".repeat(64);
  assert.equal(checksumForAsset(`${digest} *${asset}\n`, asset), digest);
});
