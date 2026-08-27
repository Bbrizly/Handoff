// Shared download/verify for the pinned binaries Handoff installs on workers.
//
// Every managed runtime comes from an immutable upstream release, is checked
// against a pinned SHA-256, and is cached under ~/.hn/cache.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fail } from "./util.js";

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function runLocal(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if ((result.status ?? 1) !== 0) {
    fail(`${command} failed (${result.status ?? 1}): ${(result.stderr || result.stdout || "").trim()}`);
  }
}

export function ensureCachedRelease({ name, version, file, url, sha256 }) {
  const cacheDir = join(homedir(), ".hn", "cache", name, version);
  mkdirSync(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, file);
  if (existsSync(archivePath) && sha256File(archivePath) === sha256) return archivePath;
  if (existsSync(archivePath)) unlinkSync(archivePath);

  const tempPath = `${archivePath}.tmp-${process.pid}`;
  try {
    runLocal("curl", ["-fL", "--retry", "3", "--connect-timeout", "10", "-o", tempPath, url]);
    const actual = sha256File(tempPath);
    if (actual !== sha256) fail(`${name} checksum mismatch: expected ${sha256}, got ${actual}.`);
    renameSync(tempPath, archivePath);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return archivePath;
}
