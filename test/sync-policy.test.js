import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_IGNORES,
  SYNC_MODE,
  findWindowsIncompatiblePaths,
  isWindowsCompatibleName,
  readHnIgnore,
  syncPolicy,
} from "../src/sync-policy.js";

test("sync policy is bidirectional with alpha/Mac conflict precedence", () => {
  assert.equal(SYNC_MODE, "two-way-resolved");
});

test("generated output and secrets are ignored by default", () => {
  for (const expected of ["obj/", "bin/", ".venv/", "venv/", ".pytest_cache/", ".env", ".env.*"]) {
    assert.ok(DEFAULT_IGNORES.includes(expected), `missing ${expected}`);
  }
  assert.ok(DEFAULT_IGNORES.includes("!.env.example"));
});

test("root .hnignore extends the session ignore list", () => {
  const root = mkdtempSync(join(tmpdir(), "hn-ignore-"));
  try {
    writeFileSync(join(root, ".hnignore"), "# local policy\nprivate-notes/\n*.scratch\n\n");
    assert.deepEqual(readHnIgnore(root), ["private-notes/", "*.scratch"]);
    const policy = syncPolicy({ local: root }, { platform: "linux" });
    assert.ok(policy.ignores.includes("private-notes/"));
    assert.ok(policy.ignores.includes("*.scratch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows filename compatibility catches NTFS-invalid names", () => {
  assert.equal(isWindowsCompatibleName("normal.pdf"), true);
  assert.equal(isWindowsCompatibleName("Adaptiv: Playbook.pdf"), false);
  assert.equal(isWindowsCompatibleName("CON"), false);
  assert.equal(isWindowsCompatibleName("trailing."), false);
});

test("Windows preflight finds incompatible paths but skips generated trees", { skip: process.platform === "win32" }, () => {
  // Windows itself cannot create the invalid filename required by this fixture.
  // The name validator above remains cross-platform; the filesystem walk is
  // exercised where such a filename can actually exist.
  const root = mkdtempSync(join(tmpdir(), "hn-win-path-"));
  try {
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "bad:name.pdf"), "x");
    mkdirSync(join(root, "obj"));
    writeFileSync(join(root, "obj", "bad:generated.dll"), "x");
    assert.deepEqual(findWindowsIncompatiblePaths(root), ["docs/bad:name.pdf"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
