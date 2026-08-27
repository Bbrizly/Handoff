import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { explainWorkspaceAccess } from "../src/access.js";

const root = resolve(sep, "Users", "me", "GitHub");
const file = resolve(sep, "Users", "me", "notes.md");
const config = {
  workspaces: {
    main: {
      roots: [
        { local: root, remote: "hn/main/GitHub", kind: "directory" },
        { local: file, remote: "hn/main/files/notes.md", kind: "file" },
      ],
    },
  },
};

test("access explains mapped directories and individual files", () => {
  assert.deepEqual(
    explainWorkspaceAccess(config, join(root, "Handoff", "src", "index.js")),
    {
      state: "shared",
      local: join(root, "Handoff", "src", "index.js"),
      remote: "hn/main/GitHub/Handoff/src/index.js",
      reason: null,
      workspaceName: "main",
      root: config.workspaces.main.roots[0],
    },
  );
  assert.equal(explainWorkspaceAccess(config, file).remote, "hn/main/files/notes.md");
});

test("access reports source-policy exclusions and paths outside the workspace", () => {
  const generated = explainWorkspaceAccess(config, join(root, "Handoff", "node_modules", "x.js"));
  assert.equal(generated.state, "local-only");
  assert.match(generated.reason, /generated/);
  assert.equal(explainWorkspaceAccess(config, resolve(sep, "Users", "me", "Desktop", "x.txt")).state, "outside");
});
