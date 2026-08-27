import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_IGNORES,
  SYNC_MODE,
  findNonPortableSymlinks,
  findWindowsIncompatiblePaths,
  isPortableSymlinkTarget,
  isWindowsCompatibleName,
  readHnIgnore,
  syncPolicy,
} from "../src/sync-policy.js";

test("sync policy is bidirectional with alpha/Mac conflict precedence", () => {
  assert.equal(SYNC_MODE, "two-way-resolved");
});

test("generated output and secrets are ignored at any workspace depth", () => {
  for (const expected of ["obj", "bin", ".venv", "venv", ".pytest_cache", ".env", ".env.*"]) {
    assert.ok(DEFAULT_IGNORES.includes(expected), `missing ${expected}`);
  }
  assert.ok(DEFAULT_IGNORES.includes("!.env.example"));
  assert.ok(DEFAULT_IGNORES.includes("**/.claude/worktrees/"));
  assert.ok(!DEFAULT_IGNORES.includes("obj/"), "obj/ would only match the sync root in Mutagen");
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
  const root = mkdtempSync(join(tmpdir(), "hn-win-path-"));
  try {
    mkdirSync(join(root, "project", "docs"), { recursive: true });
    writeFileSync(join(root, "project", "docs", "bad:name.pdf"), "x");
    mkdirSync(join(root, "project", "obj"));
    writeFileSync(join(root, "project", "obj", "bad:generated.dll"), "x");
    assert.deepEqual(findWindowsIncompatiblePaths(root), ["project/docs/bad:name.pdf"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable symlink detection rejects absolute targets on either OS family", () => {
  assert.equal(isPortableSymlinkTarget("../shared/tool"), true);
  assert.equal(isPortableSymlinkTarget("/Users/me/tool"), false);
  assert.equal(isPortableSymlinkTarget("C:\\Users\\me\\tool"), false);
  assert.equal(isPortableSymlinkTarget("\\\\server\\share\\tool"), false);
});

test("non-portable symlink preflight ignores exact absolute links but skips Claude worktrees", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "hn-symlink-"));
  try {
    mkdirSync(join(root, "project", ".claude", ".agents", "skills"), { recursive: true });
    const real = join(root, "real-tool");
    writeFileSync(real, "x");
    const link = join(root, "project", ".claude", ".agents", "skills", "tool");
    symlinkSync(real, link);

    mkdirSync(join(root, "project", ".claude", "worktrees", "generated"), { recursive: true });
    symlinkSync(real, join(root, "project", ".claude", "worktrees", "generated", "tool"));

    assert.deepEqual(findNonPortableSymlinks(root), ["project/.claude/.agents/skills/tool"]);
    const policy = syncPolicy({ local: root }, { platform: "windows" });
    assert.ok(policy.ignores.includes("project/.claude/.agents/skills/tool"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
