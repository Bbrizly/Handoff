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
const dirs = ["..", "../../Obsidian", "../../Downloads"];

test("additional workspace roots are relative to the remote project cwd", () => {
  assert.deepEqual(additionalWorkspaceDirs(workspace, cwd), dirs);
});

test("Claude gets all workspace roots through --add-dir", () => {
  assert.deepEqual(
    augmentAgentCommand(["claude"], workspace, cwd),
    ["claude", "--add-dir", ...dirs],
  );
});

test("Claude keeps a startup prompt before its variadic --add-dir", () => {
  assert.deepEqual(
    augmentAgentCommand(["claude", "fix the tests"], workspace, cwd),
    ["claude", "fix the tests", "--add-dir", ...dirs],
  );
});

test("Claude inserts --add-dir before an explicit separator", () => {
  assert.deepEqual(
    augmentAgentCommand(["claude", "-p", "check this", "--", "literal"], workspace, cwd),
    ["claude", "-p", "check this", "--add-dir", ...dirs, "--", "literal"],
  );
});

test("Claude management commands are not polluted with workspace flags", () => {
  assert.deepEqual(
    augmentAgentCommand(["claude", "auth", "status"], workspace, cwd),
    ["claude", "auth", "status"],
  );
});

test("Codex gets repeated --add-dir flags", () => {
  assert.deepEqual(
    augmentAgentCommand(["codex", "--full-auto"], workspace, cwd),
    ["codex", "--add-dir", "..", "--add-dir", "../../Obsidian", "--add-dir", "../../Downloads", "--full-auto"],
  );
});

test("Codex exec automatically skips the Git check because .git is local-only", () => {
  assert.deepEqual(
    augmentAgentCommand(["codex", "exec", "fix it"], workspace, cwd),
    [
      "codex",
      "--add-dir", "..",
      "--add-dir", "../../Obsidian",
      "--add-dir", "../../Downloads",
      "exec", "--skip-git-repo-check", "fix it",
    ],
  );
});

test("Codex management commands are not polluted with workspace flags", () => {
  assert.deepEqual(
    augmentAgentCommand(["codex", "login"], workspace, cwd),
    ["codex", "login"],
  );
});

test("other commands are not modified", () => {
  assert.deepEqual(augmentAgentCommand(["npm", "test"], workspace, cwd), ["npm", "test"]);
});
