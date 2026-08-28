import test from "node:test";
import assert from "node:assert/strict";
import {
  checksumForAsset,
  assertHealthySync,
  legacySyncSessionName,
  mutagenEndpoint,
  mutagenReleaseAsset,
  parseSessionRecords,
  parseSyncStatusOutput,
  parseSyncDetailOutput,
  parseSyncProblemsOutput,
  syncErrorAdvice,
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

test("specialized root policies use isolated synchronization sessions", () => {
  const pc = { user: "me", host: "pc", target: "me@pc", port: 22 };
  assert.notEqual(
    syncSessionName("main", "pc", pc, root),
    syncSessionName("main", "pc", pc, { ...root, policy: "agent-profile" }),
  );
});

test("sync policy v2 gets a versioned session name and can identify v1", () => {
  const pc = { user: "me", host: "pc", target: "me@pc", port: 22 };
  const current = syncSessionName("main", "pc", pc, root);
  const legacy = legacySyncSessionName("main", "pc", pc, root);
  assert.match(current, /^hn-sync-v2-/);
  assert.match(legacy, /^hn-sync-/);
  assert.notEqual(current, legacy);
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
    problemCount: 0,
  });
});

test("sync status counts scan and transition problems", () => {
  assert.deepEqual(parseSyncStatusOutput("Watching for changes|0|0|2|1|0|3"), {
    state: "watching for changes",
    conflicts: 0,
    problemCount: 6,
  });
});

test("sync status tolerates empty conflict counts", () => {
  assert.deepEqual(parseSyncStatusOutput("Scanning||"), {
    state: "scanning",
    conflicts: 0,
    problemCount: 0,
  });
});

test("empty sync status means session is not started", () => {
  assert.deepEqual(parseSyncStatusOutput(""), {
    state: "not-started",
    conflicts: 0,
    problemCount: 0,
  });
});

test("sync detail extracts Mutagen's last error", () => {
  const detail = parseSyncDetailOutput(`Alpha:\n  Connected: Yes\nLast error: alpha scan error: unable to open synchronization root: operation not permitted\nStatus: Waiting 5 seconds for rescan\n`);
  assert.equal(detail, "alpha scan error: unable to open synchronization root: operation not permitted");
});

test("sync problem details use local/remote language and preserve exact paths", () => {
  assert.deepEqual(parseSyncProblemsOutput(
    "conflict|src/app.js|\nremote write|docs/name:bad.pdf|filename is invalid\nlocal scan|private/file|operation not permitted\n",
  ), [
    { type: "conflict", path: "src/app.js", error: "" },
    { type: "remote write", path: "docs/name:bad.pdf", error: "filename is invalid" },
    { type: "local scan", path: "private/file", error: "operation not permitted" },
  ]);
});

test("controller permission errors include an actionable macOS fix", () => {
  assert.match(
    syncErrorAdvice("alpha scan error: unable to open synchronization root: operation not permitted"),
    /Full Disk Access/,
  );
});

test("rescan retries fail immediately when they carry a Mutagen error", () => {
  assert.throws(
    () => assertHealthySync("sync_test", {
      state: "waiting 5 seconds for rescan",
      conflicts: 0,
      error: "alpha scan error: unable to open synchronization root: operation not permitted",
      advice: "Give Terminal Full Disk Access.",
    }),
    /Last error: alpha scan error.*Full Disk Access/s,
  );
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
