import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const script = new URL("../scripts/dogfood-codex-thin.sh", import.meta.url);

test("Codex thin dogfood harness is bash-parseable on POSIX", { skip: process.platform === "win32" }, () => {
  const result = spawnSync("bash", ["-n", script.pathname], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Codex thin dogfood harness is strict and fail-closed", () => {
  const text = readFileSync(script, "utf8");
  assert.match(text, /set -euo pipefail/);
  assert.match(text, /HN_CODEX_TRANSPORT=app-server/);
  assert.match(text, /codex-server status/);
  assert.match(text, /codex-server stop/);
  assert.match(text, /refs\/remotes\/origin\/\$BRANCH/);
});
