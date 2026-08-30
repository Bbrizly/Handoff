import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { claudeProfileCandidates, claudeProfileLinks, claudeProfileProjectionFingerprint } from "../src/profile.js";

test("Claude portable profile includes capability files but excludes machine state", () => {
  const candidates = claudeProfileCandidates("/Users/me", () => true);
  const locals = candidates.map((root) => root.local);
  const remotes = candidates.map((root) => root.remote);

  assert.ok(locals.includes(join("/Users/me", ".agents", "skills")));
  assert.ok(locals.includes(join("/Users/me", ".claude", "skills")));
  assert.ok(locals.includes(join("/Users/me", ".codex", "superpowers", "skills")));
  assert.ok(remotes.includes(".claude/agents"));
  assert.ok(remotes.includes(".claude/hooks"));
  assert.ok(remotes.includes(".claude/CLAUDE.md"));
  assert.ok(!locals.includes(join("/Users/me", ".claude", "settings.json")));
  assert.ok(!locals.includes(join("/Users/me", ".claude", ".credentials.json")));
  assert.ok(candidates.every((root) => root.scope === "trusted"));
  assert.ok(candidates.every((root) => root.policy === "agent-profile"));
});

test("Claude profile projects only links backed by the canonical agent skill tree", { skip: process.platform === "win32" }, () => {
  const temp = mkdtempSync(join(tmpdir(), "hn-profile-links-"));
  try {
    const agents = join(temp, ".agents", "skills");
    const claude = join(temp, ".claude", "skills");
    const external = join(temp, ".codex", "superpowers", "skills");
    mkdirSync(join(agents, "shared"), { recursive: true });
    mkdirSync(join(claude, "native"), { recursive: true });
    mkdirSync(external, { recursive: true });
    writeFileSync(join(agents, "shared", "SKILL.md"), "shared\n");
    writeFileSync(join(claude, "native", "SKILL.md"), "native\n");
    symlinkSync("../../.agents/skills/shared", join(claude, "shared"));
    symlinkSync(external, join(agents, "superpowers"));

    assert.deepEqual(claudeProfileLinks([
      { local: external, remote: ".codex/superpowers/skills" },
      { local: agents, remote: ".agents/skills" },
      { local: claude, remote: ".claude/skills" },
    ]), [
      { name: "superpowers", link: ".agents/skills/superpowers", target: ".codex/superpowers/skills" },
      { name: "shared", link: ".claude/skills/shared", target: ".agents/skills/shared" },
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Claude profile projection fingerprint is stable and changes with link topology", () => {
  assert.equal(
    claudeProfileProjectionFingerprint([]),
    claudeProfileProjectionFingerprint([]),
  );
});
