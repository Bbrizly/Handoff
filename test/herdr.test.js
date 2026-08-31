import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HERDR_VERSION,
  herdrAssetFor,
  herdrBinaryRelative,
  herdrCommandScript,
  herdrConfigToml,
  herdrRuntimeName,
  paneForegroundProcesses,
  parseHerdrJson,
  attachHerdr,
  paneCommandLine,
  probeHerdrDesk,
  projectLabel,
} from "../src/herdr.js";

test("every supported worker platform has a pinned Herdr build", () => {
  for (const [platform, arch] of [
    ["windows", "x64"], ["linux", "x64"], ["linux", "arm64"],
    ["darwin", "x64"], ["darwin", "arm64"],
  ]) {
    const asset = herdrAssetFor(platform, arch);
    assert.ok(asset, `${platform}/${arch} has no asset`);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(herdrAssetFor("plan9", "x64"), null);
});

test("pane commands quote executable paths on Windows and POSIX", () => {
  assert.equal(
    paneCommandLine({ platform: "windows" }, "C:\\Program Files\\Claude\\claude.exe".split("|")),
    "& 'C:\\Program Files\\Claude\\claude.exe'",
  );
  assert.equal(
    paneCommandLine({ platform: "linux" }, ["/opt/Claude Code/claude", "hello world"]),
    "'/opt/Claude Code/claude' 'hello world'",
  );
  assert.match(
    paneCommandLine({ platform: "windows" }, ["claude", "--settings", "__HN_CLAUDE_SETTINGS__"]),
    /Join-Path \$HOME.*claude-settings\.json/,
  );
});

test("the Windows bundle keeps its own directory so ConPTY files survive", () => {
  assert.equal(herdrBinaryRelative({ platform: "windows", arch: "x64" }), `.hn/bin/herdr/${HERDR_VERSION}/herdr.exe`);
  assert.equal(herdrBinaryRelative({ platform: "linux", arch: "arm64" }), `.hn/bin/herdr/${HERDR_VERSION}/herdr`);
});

test("two controllers sharing one worker get different desks", () => {
  const a = herdrRuntimeName("11111111111111111111111111111111", "main");
  const b = herdrRuntimeName("22222222222222222222222222222222", "main");
  assert.notEqual(a, b);
  assert.equal(a, herdrRuntimeName("11111111111111111111111111111111", "main"));
  assert.match(a, /^hn-[0-9a-f]{8}-main$/);
});

test("remote commands carry Handoff's own Herdr config and session", () => {
  const windows = herdrCommandScript({ platform: "windows", arch: "x64" }, "hn-abc-main", ["workspace", "list"]);
  assert.match(windows, /HERDR_CONFIG_PATH/);
  assert.match(windows, /\.hn\\herdr\\config\.toml/);
  assert.match(windows, /--session \$hnSession 'workspace' 'list'/);

  const posix = herdrCommandScript({ platform: "linux", arch: "x64" }, "hn-abc-main", ["workspace", "list"]);
  assert.match(posix, /HERDR_CONFIG_PATH="\$HOME\/\.hn\/herdr\/config\.toml"/);
  assert.match(posix, /exec "\$hn_herdr" --session "\$hn_session" 'workspace' 'list'/);
});

test("the generated config turns off onboarding and update checks", () => {
  const toml = herdrConfigToml("windows");
  assert.match(toml, /^onboarding = false$/m);
  assert.match(toml, /^version_check = false$/m);
  assert.match(toml, /^manifest_check = false$/m);
  assert.match(toml, /^status_indicators = "symbols"$/m);
  assert.match(toml, /^default_shell = "~\/\.hn\/bin\/hn-powershell\.cmd"$/m);
  // The synced tree has no .git, so a branch row would always be blank.
  assert.match(toml, /^rows = \[\["state_icon", "workspace"\]\]$/m);
});

test("JSON replies survive banner noise", () => {
  const parsed = parseHerdrJson('warning: something\n{"id":"x","result":{"type":"workspace_list","workspaces":[]}}\n');
  assert.equal(parsed.result.type, "workspace_list");
  assert.throws(() => parseHerdrJson("no json here"), /no JSON/);
});

test("two projects with the same folder name get distinct labels", () => {
  assert.equal(projectLabel("app", []), "app");
  assert.equal(projectLabel("app", ["app"]), "app 2");
  assert.equal(projectLabel("app", ["app", "app 2"]), "app 3");
});

test("the desk probe reads managed-file and binary markers from one round trip", () => {
  const worker = { platform: "windows", arch: "x64", target: "u@h" };
  const scripts = [];
  const probe = (stdout, code) => probeHerdrDesk(worker, "hn-x", "GUARD\n", (script) => {
    scripts.push(script);
    return { code, stdout, stderr: "" };
  });

  const healthy = probe('{"result":{"workspaces":[]},"kind":"workspace_list"}', 0);
  assert.deepEqual(healthy, { installed: true, running: true, repairNeeded: false });
  assert.match(scripts[0], /^GUARD/);
  assert.match(scripts[0], /hn-no-herdr/);

  assert.deepEqual(
    probe("hn-repair\n{\"kind\":\"workspace_list\"}", 0),
    { installed: true, running: true, repairNeeded: true },
  );
  assert.deepEqual(
    probe("hn-no-herdr", 0),
    { installed: false, running: false, repairNeeded: false },
  );
  assert.deepEqual(
    probe("could not connect", 1),
    { installed: true, running: false, repairNeeded: false },
  );
});

test("closing an attachment to a healthy desk is not a failure", () => {
  const worker = { platform: "windows", target: "u@h" };
  assert.equal(
    attachHerdr(worker, "hn-x", { attach: () => ({ code: 0 }), healthy: () => true }).desk,
    "quit",
  );
  // ssh's own 255 with the desk still answering: the user detached.
  assert.equal(
    attachHerdr(worker, "hn-x", { attach: () => ({ code: 255 }), healthy: () => true }).desk,
    "detached",
  );
  // Same 255, but the desk is gone: that is a real failure and must say so.
  assert.throws(
    () => attachHerdr(worker, "hn-x", { attach: () => ({ code: 255 }), healthy: () => false }),
    /Lost the connection to the persistent desk/,
  );
});

// The bug this guards: the desk start called ensureHerdrConfig only through
// ensureHerdrInstalled, which is skipped when the pinned binary is already
// there. Workers that already ran Herdr never got shell.ps1 or the pane shell
// shim, so the desk's Claude lost its statusline and Alt+Backspace.
test("starting the desk refreshes Handoff's own Herdr files, not just the binary", () => {
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const desk = source.slice(source.indexOf("function runPersistentDesk"), source.indexOf("function managedExpectationFor"));
  assert.match(desk, /ensureHerdrConfig\(deskWorker\);/);
  assert.ok(
    desk.indexOf("ensureHerdrConfig(deskWorker);") < desk.indexOf("probeHerdrDesk("),
    "the runtime-specific config has to be current before the desk server is probed or started",
  );
});

// Captured from herdr 0.8.2 on the reference Windows worker.
test("a pane's foreground processes come out of the nested process_info", () => {
  const reply = parseHerdrJson('{"id":"cli:pane:process_info","result":{"process_info":'
    + '{"foreground_process_group_id":29768,"foreground_processes":[{"name":"powershell.exe"}]}}}');
  assert.deepEqual(paneForegroundProcesses(reply), [{ name: "powershell.exe" }]);
  assert.deepEqual(paneForegroundProcesses({ result: { foreground_processes: [{ name: "x" }] } }), []);
  assert.deepEqual(paneForegroundProcesses(null), []);
});
