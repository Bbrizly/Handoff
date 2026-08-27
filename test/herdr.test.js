import test from "node:test";
import assert from "node:assert/strict";
import {
  HERDR_VERSION,
  herdrAssetFor,
  herdrBinaryRelative,
  herdrCommandScript,
  herdrConfigToml,
  herdrRuntimeName,
  parseHerdrJson,
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
  const toml = herdrConfigToml();
  assert.match(toml, /^onboarding = false$/m);
  assert.match(toml, /^version_check = false$/m);
  assert.match(toml, /^manifest_check = false$/m);
  assert.match(toml, /^status_indicators = "symbols"$/m);
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
