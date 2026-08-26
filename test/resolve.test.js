import test from "node:test";
import assert from "node:assert/strict";
import { isInside, mapLocalToRemote, findContext } from "../src/resolve.js";

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
  const root = { local: p("", "Users", "me", "GitHub"), remote: "handoff/main/GitHub" };
  const mapped = mapLocalToRemote(root, p(root.local, "Palmier", "apps", "web"));
  assert.equal(mapped, "handoff/main/GitHub/Palmier/apps/web");
});

test("findContext chooses the deepest matching root", () => {
  const broad = p("", "Users", "me");
  const git = p(broad, "GitHub");
  const config = {
    workspaces: {
      main: {
        worker: "lenovo",
        roots: [
          { local: broad, remote: "handoff/main/home" },
          { local: git, remote: "handoff/main/GitHub" },
        ],
      },
    },
  };
  const context = findContext(config, p(git, "Palmier"));
  assert.equal(context.root.remote, "handoff/main/GitHub");
});
