import test from "node:test";
import assert from "node:assert/strict";
import { additionalWorkspaceDirs, augmentAgentCommand, isClaudeWorkCommand } from "../src/agent.js";

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

test("individual files expose their remote parent while agent profiles stay implicit", () => {
  const roots = {
    roots: [
      ...workspace.roots,
      { local: "/Users/me/license.txt", remote: "hn/main/files/license.txt", kind: "file" },
      {
        local: "/Users/me/.claude/skills",
        remote: ".claude/skills",
        kind: "directory",
        purpose: "claude-profile",
      },
    ],
  };
  assert.deepEqual(additionalWorkspaceDirs(roots, cwd), [...dirs, "../../files"]);
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

test("Claude work launches receive only Handoff's additive statusline settings", () => {
  const workspace = { roots: [{ remote: "hn/main/GitHub", kind: "directory" }] };
  const settings = '{"statusLine":{"type":"command","command":"node statusline.cjs"}}';
  assert.deepEqual(
    augmentAgentCommand(["claude"], workspace, "hn/main/GitHub/app", { claudeSettings: settings }),
    ["claude", "--settings", settings, "--add-dir", ".."],
  );
  assert.equal(isClaudeWorkCommand(["claude"]), true);
  assert.equal(isClaudeWorkCommand(["claude", "mcp", "list"]), false);
  assert.equal(isClaudeWorkCommand(["codex"]), false);
});

test("Claude management commands and explicit settings remain untouched", () => {
  const workspace = { roots: [] };
  assert.deepEqual(
    augmentAgentCommand(["claude", "mcp", "list"], workspace, "hn/main", { claudeSettings: "{}" }),
    ["claude", "mcp", "list"],
  );
  assert.deepEqual(
    augmentAgentCommand(["claude", "--settings", "user.json"], workspace, "hn/main", { claudeSettings: "{}" }),
    ["claude", "--settings", "user.json"],
  );
});

test("non-Claude commands are unaffected by statusline settings", () => {
  assert.deepEqual(
    augmentAgentCommand(["npm", "test"], { roots: [] }, "hn/main", { claudeSettings: "{}" }),
    ["npm", "test"],
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
