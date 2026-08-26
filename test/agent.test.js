import test from "node:test";
import assert from "node:assert/strict";
import { additionalWorkspaceDirs, augmentAgentCommand } from "../src/agent.js";

const workspace = {
  roots: [
    { local: "/Users/me/GitHub", remote: "hn/main/GitHub" },
    { local: "/Users/me/Obsidian", remote: "hn/main/Obsidian" },
    { local: "/Users/me/Downloads", remote: "hn/main/Downloads" },
  ],
};
const cwd = "hn/main/GitHub/Palmier";

test("additional workspace roots are relative to the remote project cwd", () => {
  assert.deepEqual(additionalWorkspaceDirs(workspace, cwd), ["..", "../../Obsidian", "../../Downloads"]);
});

test("Claude gets all workspace roots through --add-dir", () => {
  assert.deepEqual(
    augmentAgentCommand(["claude"], workspace, cwd),
    ["claude", "--add-dir", "..", "../../Obsidian", "../../Downloads"],
  );
});

test("Codex gets repeated --add-dir flags", () => {
  assert.deepEqual(
    augmentAgentCommand(["codex", "--full-auto"], workspace, cwd),
    ["codex", "--add-dir", "..", "--add-dir", "../../Obsidian", "--add-dir", "../../Downloads", "--full-auto"],
  );
});

test("other commands are not modified", () => {
  assert.deepEqual(augmentAgentCommand(["npm", "test"], workspace, cwd), ["npm", "test"]);
});
