import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HERDR_VERSION, herdrAssetFor, herdrReleaseUrl } from "../../src/herdr.js";
import { ensureCachedRelease } from "../../src/runtime-assets.js";

const enabled = process.env.HN_INTEGRATION === "1" && ["darwin", "linux"].includes(process.platform);

// Every Herdr command line Handoff builds, and the shape it builds it in.
// 'hn pc -p' once sent a pane id where 'pane process-info' wanted --pane, and
// nothing caught it until a Windows worker did.
//
// ponytail: hand-kept table. It proves Herdr still accepts what we send; it
// cannot know we stopped sending it. Grep src/herdr.js when a call site moves.
const CALLS = [
  { command: ["agent", "list"] },
  { command: ["agent", "focus"], positionals: 1 },
  { command: ["pane", "list"], flags: ["--workspace"] },
  { command: ["pane", "process-info"], flags: ["--pane"] },
  { command: ["pane", "run"], positionals: 2 },
  { command: ["server", "stop"] },
  { command: ["status", "server"] },
  { command: ["workspace", "list"] },
  { command: ["workspace", "focus"], positionals: 1 },
  { command: ["workspace", "create"], flags: ["--cwd", "--label", "--focus"] },
  { command: ["workspace", "report-metadata"], positionals: 1, flags: ["--source", "--token"] },
];

// 'Usage: herdr workspace report-metadata [OPTIONS] --source <ID> <WORKSPACE_ID>'
// carries one real positional. Drop the options and the flag values first.
function usagePositionals(help) {
  const usage = help.split("\n").find((line) => line.startsWith("Usage:")) ?? "";
  return usage
    .replace("[OPTIONS]", "")
    .replace(/--[a-z-]+ <[^>]+>/g, "")
    .match(/<[^>]+>/g)?.length ?? 0;
}

test("Herdr still accepts every command line Handoff builds", { skip: !enabled, timeout: 120_000 }, (t) => {
  const asset = herdrAssetFor(process.platform, process.arch);
  assert.ok(asset, `no Herdr build for ${process.platform}/${process.arch}`);
  assert.equal(asset.archive, "raw", "this test expects the single-file release");

  const cached = ensureCachedRelease({
    name: "herdr",
    version: HERDR_VERSION,
    file: asset.file,
    url: herdrReleaseUrl(asset),
    sha256: asset.sha256,
  });
  const temp = mkdtempSync(join(tmpdir(), "hn-herdr-it-"));
  const binary = join(temp, asset.binary);
  copyFileSync(cached, binary);
  chmodSync(binary, 0o755);
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  for (const { command, positionals = 0, flags = [] } of CALLS) {
    const result = spawnSync(binary, [...command, "--help"], { encoding: "utf8", timeout: 30_000 });
    const help = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const label = `herdr ${command.join(" ")}`;
    assert.equal(result.status, 0, `${label} --help failed: ${help.trim().slice(0, 200)}`);
    assert.equal(usagePositionals(help), positionals, `${label} takes a different number of positionals`);
    for (const flag of flags) {
      assert.match(help, new RegExp(`(^|\\s)${flag}(\\s|$)`, "m"), `${label} no longer accepts ${flag}`);
    }
  }
});
