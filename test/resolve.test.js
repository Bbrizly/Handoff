import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findContext, findProjectRoot, isInside, mapLocalToRemote } from "../src/resolve.js";

const slash = process.platform === "win32" ? "\\" : "/";

function p(...parts) {
  return parts.join(slash);
}

test("isInside accepts a root and descendants only", () => {
  const root = p("", "Users", "me", "GitHub");
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, p(root, "Palmier")), true);
  assert.equal(isInside(root, p("", "Users", "me", "Downloads")), false);
});

test("mapLocalToRemote keeps relative subdirectories", () => {
  const root = { local: p("", "Users", "me", "GitHub"), remote: "hn/main/GitHub" };
  const mapped = mapLocalToRemote(root, p(root.local, "Palmier", "apps", "web"));
  assert.equal(mapped, "hn/main/GitHub/Palmier/apps/web");
});

test("findContext chooses the deepest matching root", () => {
  const broad = p("", "Users", "me");
  const git = p(broad, "GitHub");
  const config = {
    workspaces: {
      main: {
        roots: [
          { local: broad, remote: "hn/main/home" },
          { local: git, remote: "hn/main/GitHub" },
        ],
      },
    },
  };
  const context = findContext(config, p(git, "Palmier"));
  assert.equal(context.root.remote, "hn/main/GitHub");
});

test("findProjectRoot uses the nearest local Git repository", () => {
  const temp = mkdtempSync(join(tmpdir(), "hn-resolve-"));
  try {
    const workspace = join(temp, "GitHub");
    const repo = join(workspace, "Palmier");
    const child = join(repo, "apps", "web");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(child, { recursive: true });
    assert.equal(findProjectRoot(workspace, child), repo);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
