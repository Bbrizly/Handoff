import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureMutagen } from "../../src/mutagen.js";

const enabled = process.env.HN_INTEGRATION === "1" && ["darwin", "linux"].includes(process.platform);

function run(binary, args, { allowFailure = false } = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  if (!allowFailure && (result.status ?? 1) !== 0) {
    throw new Error(`${binary} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

function waitForFile(path, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8") === expected) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  assert.equal(existsSync(path) ? readFileSync(path, "utf8") : null, expected);
}

test("real Mutagen is bidirectional and resolves collisions in favor of alpha", { skip: !enabled, timeout: 120_000 }, () => {
  ensureMutagen();
  const binary = join(homedir(), ".hn", "bin", "mutagen-v0.18.1", "mutagen");
  assert.ok(existsSync(binary), `managed Mutagen missing at ${binary}`);

  const temp = mkdtempSync(join(tmpdir(), "hn-mutagen-it-"));
  const alpha = join(temp, "alpha");
  const beta = join(temp, "beta");
  mkdirSync(alpha);
  mkdirSync(beta);
  const session = `hn-it-${process.pid}-${Date.now()}`;

  try {
    run(binary, ["sync", "create", "--name", session, "--sync-mode", "two-way-resolved", alpha, beta]);

    writeFileSync(join(alpha, "from-alpha.txt"), "alpha-only");
    run(binary, ["sync", "flush", session]);
    waitForFile(join(beta, "from-alpha.txt"), "alpha-only");

    writeFileSync(join(beta, "from-beta.txt"), "beta-only");
    run(binary, ["sync", "flush", session]);
    waitForFile(join(alpha, "from-beta.txt"), "beta-only");

    writeFileSync(join(alpha, "collision.txt"), "base");
    run(binary, ["sync", "flush", session]);
    waitForFile(join(beta, "collision.txt"), "base");

    run(binary, ["sync", "pause", session]);
    writeFileSync(join(alpha, "collision.txt"), "alpha-wins");
    writeFileSync(join(beta, "collision.txt"), "beta-loses");
    run(binary, ["sync", "resume", session]);
    run(binary, ["sync", "flush", session]);

    waitForFile(join(alpha, "collision.txt"), "alpha-wins");
    waitForFile(join(beta, "collision.txt"), "alpha-wins");
  } finally {
    run(binary, ["sync", "terminate", session], { allowFailure: true });
    rmSync(temp, { recursive: true, force: true });
  }
});
