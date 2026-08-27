import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyWorkspaceRoot,
  normalizeRemotePath,
  remoteRootDirectory,
  remotePathsOverlap,
  workspaceRootsForTarget,
  validateWorkerAssignment,
  workerEndpointsEqual,
  workspaceAllowsTarget,
} from "../src/workspace.js";

test("workspace roots distinguish directories from individual files", () => {
  const temp = mkdtempSync(join(tmpdir(), "hn-root-kind-"));
  try {
    const directory = join(temp, "folder");
    const file = join(temp, "notes.md");
    mkdirSync(directory);
    writeFileSync(file, "hello\n");
    assert.equal(classifyWorkspaceRoot(directory), "directory");
    assert.equal(classifyWorkspaceRoot(file), "file");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("file roots create only their remote parent directory", () => {
  assert.equal(remoteRootDirectory({ kind: "directory", remote: "hn/main/GitHub" }), "hn/main/GitHub");
  assert.equal(remoteRootDirectory({ kind: "file", remote: "hn/main/files/notes.md" }), "hn/main/files");
});

test("personal profile roots only synchronize to trusted targets", () => {
  const workspace = {
    roots: [
      { local: "/code", remote: "hn/main/code", kind: "directory" },
      { local: "/skills", remote: ".claude/skills", kind: "directory", scope: "trusted" },
    ],
  };
  assert.equal(workspaceRootsForTarget(workspace, { trust: "trusted" }).length, 2);
  assert.deepEqual(workspaceRootsForTarget(workspace, { trust: "remote" }), [workspace.roots[0]]);
});

test("remote paths normalize to portable forward slashes", () => {
  assert.equal(normalizeRemotePath("~/hn\\main\\GitHub/"), "hn/main/GitHub");
});

test("remote paths reject parent traversal", () => {
  assert.throws(() => normalizeRemotePath("hn/main/../secret"), /cannot contain '\.\.'/);
});

test("remote path overlap detects nesting and equality", () => {
  assert.equal(remotePathsOverlap("hn/main/GitHub", "hn/main/GitHub/Palmier"), true);
  assert.equal(remotePathsOverlap("hn/main/GitHub", "HN/MAIN/GITHUB"), true);
});

test("sibling remote roots do not overlap", () => {
  assert.equal(remotePathsOverlap("hn/main/GitHub", "hn/main/Obsidian"), false);
});

test("worker endpoint equality uses user, host and port", () => {
  const a = { user: "me", host: "PC.local", port: 22 };
  const b = { user: "me", host: "pc.LOCAL", port: 22 };
  const c = { user: "me", host: "pc.local", port: 2222 };
  assert.equal(workerEndpointsEqual(a, b), true);
  assert.equal(workerEndpointsEqual(a, c), false);
});

test("a target name cannot silently move to another machine", () => {
  const config = { workers: { pc: { user: "me", host: "old-pc", port: 22, target: "me@old-pc" } } };
  assert.throws(
    () => validateWorkerAssignment(config, "pc", { user: "me", host: "new-pc", port: 22, target: "me@new-pc" }),
    /already points to/,
  );
});

test("one SSH endpoint cannot have two target aliases", () => {
  const config = { workers: { pc: { user: "me", host: "pc", port: 22, target: "me@pc" } } };
  assert.throws(
    () => validateWorkerAssignment(config, "home", { user: "me", host: "pc", port: 22, target: "me@pc" }),
    /already points to this SSH endpoint/,
  );
});

test("trusted targets can use the whole workspace without grants", () => {
  assert.equal(workspaceAllowsTarget({ roots: [], grants: [] }, "pc", { trust: "trusted" }), true);
});

test("remote targets require an explicit workspace grant", () => {
  const workspace = { roots: [], grants: ["aws"] };
  assert.equal(workspaceAllowsTarget(workspace, "aws", { trust: "remote" }), true);
  assert.equal(workspaceAllowsTarget(workspace, "hetzner", { trust: "remote" }), false);
});
