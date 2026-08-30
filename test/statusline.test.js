import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANAGED_REPAIR_MARKER,
  claudeStatuslineCommand,
  claudeStatuslineSettings,
  handoffClaudeSettingsArgument,
  managedAssetGuardScript,
  managedExpectation,
  windowsStatuslineSettingsScript,
} from "../src/statusline.js";

const script = fileURLToPath(new URL("../assets/claude-statusline.cjs", import.meta.url));
const controllerStatusline = join(homedir(), ".claude", "statusline.sh");

const PAYLOAD = {
  model: { display_name: "Opus 4.8 (1M context)" },
  context_window: { used_percentage: 42 },
  rate_limits: {
    five_hour: { used_percentage: 20 },
    seven_day: { used_percentage: 71 },
  },
  workspace: { current_dir: "/worker/hn/main/Handoff" },
};

function render(payload) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 0);
  return result.stdout;
}

test("statusline settings use native worker path expansion", () => {
  assert.equal(
    claudeStatuslineCommand({ platform: "windows" }),
    'node "%USERPROFILE%\\.hn\\claude-statusline.cjs"',
  );
  assert.equal(
    claudeStatuslineCommand({ platform: "linux" }),
    'node "$HOME/.hn/claude-statusline.cjs" 2>/dev/null',
  );
  assert.deepEqual(JSON.parse(claudeStatuslineSettings({ platform: "windows" })), {
    statusLine: {
      type: "command",
      command: 'node "%USERPROFILE%\\.hn\\claude-statusline.cjs"',
      refreshInterval: 30,
    },
  });
  assert.equal(handoffClaudeSettingsArgument(), "__HN_CLAUDE_SETTINGS__");
});

test("Windows statusline settings resolve an absolute home path and write no NUL", () => {
  const generated = windowsStatuslineSettingsScript();
  assert.match(generated, /Join-Path \$HOME/);
  // A single backslash: PowerShell single quotes do not escape.
  assert.ok(generated.includes(".Replace('\\', '/')"));
  assert.match(generated, /claude-settings\.json/);
  // Any of these would leave a file literally named NUL in the working directory.
  assert.doesNotMatch(generated, /2>NUL/i);
  assert.doesNotMatch(generated, />\s*NUL/i);
  assert.doesNotMatch(claudeStatuslineCommand({ platform: "windows" }), /NUL/i);
});

test("worker statusline renders the controller's segments in order", () => {
  const out = render(PAYLOAD);
  assert.equal(
    out,
    "\x1b[2mCTX:\x1b[0m \x1b[32m42%\x1b[0m\x1b[2m | \x1b[0m"
    + "\x1b[2m5h\x1b[0m \x1b[32m20%\x1b[0m\x1b[2m | \x1b[0m"
    + "\x1b[2m7d\x1b[0m \x1b[33m71%\x1b[0m\x1b[2m | \x1b[0m"
    + "\x1b[36mOpus4.8_1M\x1b[0m\x1b[2m | \x1b[0m"
    + "\x1b[2m⎇ —\x1b[0m\x1b[2m | \x1b[0m"
    + "\x1b[34m/worker/hn/main/Handoff\x1b[0m\x1b[2m | \x1b[0m"
    + "\x1b[2m—\x1b[0m",
  );
});

test("worker statusline renders the fable window when one arrives", () => {
  const out = render({
    ...PAYLOAD,
    rate_limits: { ...PAYLOAD.rate_limits, fable: { used_percentage: 88 } },
  });
  assert.match(out, /71%\x1b\[0m \x1b\[2mF\x1b\[0m\x1b\[33m88%/);
});

// The real proof: the same payload through both renderers. Everything except
// the Git state must match byte for byte.
test("worker statusline matches the controller's own statusline", {
  skip: existsSync(controllerStatusline) ? false : "controller statusline.sh not present",
}, () => {
  const now = Math.floor(Date.now() / 1000);
  const payloads = [
    PAYLOAD,
    { ...PAYLOAD, rate_limits: {
      five_hour: { used_percentage: 91, resets_at: now + 7400 },
      seven_day: { used_percentage: 4, resets_at: now + 260000 },
    } },
    { ...PAYLOAD, model: { display_name: "Sonnet 4.6" }, context_window: { used_percentage: 95 } },
    {},
  ];
  for (const payload of payloads) {
    const mine = render(payload);
    const theirs = spawnSync("bash", [controllerStatusline], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 5000,
    }).stdout;
    // The controller claims "clean" where it finds no repository. Handoff will
    // not assert a Git state it cannot see, so that one segment is allowed to
    // differ and nothing else is.
    const separator = "\x1b[2m | \x1b[0m";
    assert.equal(
      mine.split(separator).slice(0, -1).join(separator),
      theirs.split(separator).slice(0, -1).join(separator),
    );
    assert.equal(mine.split(separator).at(-1), "\x1b[2m—\x1b[0m");
    assert.equal(theirs.split(separator).at(-1), "\x1b[2mclean\x1b[0m");
  }
});

test("portable statusline fails silently on invalid input", () => {
  const result = spawnSync(process.execPath, [script], { input: "not json", encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("managed asset guard checks every link by exact path and target", () => {
  const expectation = managedExpectation([
    { link: ".claude/skills/one", target: ".agents/skills/one" },
    { link: ".agents/skills/two", target: ".agents/skills/two" },
  ]);
  assert.deepEqual(expectation, {
    links: [
      { link: ".claude/skills/one", target: ".agents/skills/one" },
      { link: ".agents/skills/two", target: ".agents/skills/two" },
    ],
  });

  const windows = managedAssetGuardScript({ platform: "windows" }, expectation);
  assert.match(windows, /claude-statusline\.cjs/);
  assert.match(windows, /claude-settings\.json/);
  assert.match(windows, /'\.claude\\skills\\one\|\.agents\\skills\\one'/);
  assert.match(windows, /'\.agents\\skills\\two\|\.agents\\skills\\two'/);
  assert.match(windows, /LinkType -eq 'Junction'/);
  assert.match(windows, /Target -contains/);
  assert.match(windows, new RegExp(MANAGED_REPAIR_MARKER));
  // A count would let one stray junction cover for a missing expected link.
  assert.doesNotMatch(windows, /Get-ChildItem/);

  const posix = managedAssetGuardScript({ platform: "linux" }, expectation);
  assert.match(posix, /\[ -f "\$HOME\/\.hn\/claude-settings\.json" \]/);
  assert.match(posix, /readlink "\$HOME"\/'\.claude\/skills\/one'/);
  assert.match(posix, new RegExp(MANAGED_REPAIR_MARKER));
});

// A pty drops the remote exit code on Windows, so the guard must never rely on
// one: the marker has to arrive on stdout and the script has to exit clean.
test("managed asset guard signals on stdout and never by exit code", () => {
  const posix = managedAssetGuardScript({ platform: "linux" }, managedExpectation([]));
  const missing = spawnSync("sh", ["-c", `HOME=/definitely/not/here\n${posix}`], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(missing.status, 0);
  assert.match(missing.stdout, new RegExp(MANAGED_REPAIR_MARKER));
});

function guardHome(t) {
  const home = mkdtempSync(join(tmpdir(), "hn-guard-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".hn"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills", "real"), { recursive: true });
  mkdirSync(join(home, ".agents", "skills", "other"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  writeFileSync(join(home, ".hn", "claude-statusline.cjs"), "");
  writeFileSync(join(home, ".hn", "claude-settings.json"), "{}");
  return home;
}

const EXPECTED_LINK = { link: ".claude/skills/one", target: ".agents/skills/real" };

function runGuard(home, links = [EXPECTED_LINK]) {
  const script = managedAssetGuardScript({ platform: "linux" }, managedExpectation(links));
  return spawnSync("sh", ["-c", script], { env: { ...process.env, HOME: home }, encoding: "utf8" });
}

test("healthy exact projection stays quiet", (t) => {
  const home = guardHome(t);
  symlinkSync(join(home, ".agents", "skills", "real"), join(home, ".claude", "skills", "one"));
  assert.equal(runGuard(home).stdout.trim(), "");
});

test("an expected link is missing even when an unrelated junction is there", (t) => {
  const home = guardHome(t);
  // The count is right; the one link a launch depends on is not there.
  symlinkSync(join(home, ".agents", "skills", "other"), join(home, ".claude", "skills", "stray"));
  assert.match(runGuard(home).stdout, new RegExp(MANAGED_REPAIR_MARKER));
});

test("an expected link that points at the wrong target asks for a repair", (t) => {
  const home = guardHome(t);
  symlinkSync(join(home, ".agents", "skills", "other"), join(home, ".claude", "skills", "one"));
  assert.match(runGuard(home).stdout, new RegExp(MANAGED_REPAIR_MARKER));
});
