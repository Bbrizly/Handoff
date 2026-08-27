import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ZELLIJ_VERSION, zellijAssetFor } from "../../src/worker.js";

const enabled = process.env.HN_INTEGRATION === "1" && ["darwin", "linux"].includes(process.platform);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 60_000,
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && (result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function panes(binary, session, env) {
  const result = run(binary, ["--session", session, "action", "list-panes", "--json"], { env });
  return JSON.parse(result.stdout.trim());
}

test("real Zellij creates, controls, and kills an isolated Handoff session", { skip: !enabled, timeout: 120_000 }, () => {
  const asset = zellijAssetFor(process.platform, process.arch);
  assert.ok(asset, `no Zellij integration asset for ${process.platform}/${process.arch}`);

  const temp = mkdtempSync(join(tmpdir(), "hn-zellij-it-"));
  const archive = join(temp, asset.file);
  const extractDir = join(temp, "extract");
  const socketDir = join(temp, "sockets");
  const configDir = join(temp, "config");
  mkdirSync(extractDir);
  mkdirSync(socketDir);
  mkdirSync(configDir);

  const url = `https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/${asset.file}`;
  run("curl", ["-fL", "--retry", "3", "--connect-timeout", "10", "-o", archive, url]);
  assert.equal(sha256(archive), asset.sha256);
  run("tar", ["-xzf", archive, "-C", extractDir]);

  const binary = join(extractDir, asset.binary);
  assert.ok(existsSync(binary));
  chmodSync(binary, 0o755);

  const session = `hn-it-${process.pid}-${Date.now()}`;
  const env = {
    ...process.env,
    ZELLIJ_SOCKET_DIR: socketDir,
    ZELLIJ_CONFIG_DIR: configDir,
  };

  try {
    run(binary, ["attach", "--create-background", session], { env });
    const listed = run(binary, ["list-sessions"], { env });
    assert.match(listed.stdout, new RegExp(session));

    const initial = panes(binary, session, env);
    assert.ok(Array.isArray(initial));

    // A headless bootstrap shell is allowed to exit immediately. Handoff's
    // production path must still be able to create the actual persistent
    // command pane into the live session.
    run(binary, [
      "--session", session,
      "action", "new-pane",
      "--name", "hn:integration",
      "--",
      "sh", "-lc", "sleep 30",
    ], { env });

    const controlled = panes(binary, session, env);
    assert.ok(controlled.some((pane) => !pane.is_plugin && !pane.exited && pane.title === "hn:integration"));

    run(binary, ["kill-session", session], { env });
    const after = run(binary, ["list-sessions"], { env, allowFailure: true });
    assert.doesNotMatch(`${after.stdout}${after.stderr}`, new RegExp(session));
  } finally {
    run(binary, ["kill-session", session], { env, allowFailure: true });
    rmSync(temp, { recursive: true, force: true });
  }
});
