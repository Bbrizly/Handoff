import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CODEX_REMOTE_MIN_VERSION,
  codexRemoteCompatibility,
  codexRemotePortCandidates,
  codexServiceId,
  codexVersionAtLeast,
  compareCodexVersions,
  parseCodexVersion,
  runCodexRemoteTui,
  shouldUseCodexRemoteTui,
} from "../src/codex-remote.js";
import { sshLocalForwardArgs } from "../src/ssh.js";

test("Codex version parsing and floor are explicit", () => {
  assert.deepEqual(parseCodexVersion("codex-cli 0.150.1\n"), {
    raw: "0.150.1", major: 0, minor: 150, patch: 1,
  });
  assert.deepEqual(parseCodexVersion("0.151.0-alpha.7"), {
    raw: "0.151.0", major: 0, minor: 151, patch: 0,
  });
  assert.equal(parseCodexVersion("not codex"), null);
  assert.equal(codexVersionAtLeast(parseCodexVersion(CODEX_REMOTE_MIN_VERSION)), true);
  assert.equal(codexVersionAtLeast(parseCodexVersion("0.150.0")), false);
  assert.equal(compareCodexVersions(parseCodexVersion("0.151.0"), parseCodexVersion("0.150.1")), 1);
});

test("interactive Codex stays eligible for remote TUI while management stays on the worker", () => {
  assert.equal(shouldUseCodexRemoteTui([]), true);
  assert.equal(shouldUseCodexRemoteTui(["--model", "gpt-5.5"]), true);
  assert.equal(shouldUseCodexRemoteTui(["resume"]), true);
  assert.equal(shouldUseCodexRemoteTui(["fix the tests"]), true);
  assert.equal(shouldUseCodexRemoteTui(["login"]), false);
  assert.equal(shouldUseCodexRemoteTui(["app-server"]), false);
  assert.equal(shouldUseCodexRemoteTui(["exec"]), false);
});

test("service identity and ports are deterministic without collapsing targets", () => {
  assert.equal(codexServiceId("controller:pc:u@host:22"), codexServiceId("controller:pc:u@host:22"));
  assert.notEqual(codexServiceId("controller:pc:u@host:22"), codexServiceId("controller:aws:u@host:22"));
  const first = codexRemotePortCandidates("controller:pc:u@host:22");
  const second = codexRemotePortCandidates("controller:pc:u@host:22");
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length);
  assert.ok(first.every((port) => port >= 43000 && port < 55000));
});

test("remote mode requires exact controller/worker Codex version parity", () => {
  const worker = { platform: "windows" };
  const ok = codexRemoteCompatibility(worker, {
    localProbe: () => ({ ok: true, version: parseCodexVersion("0.150.1") }),
    remoteProbe: () => ({ ok: true, version: parseCodexVersion("0.150.1") }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.version.raw, "0.150.1");

  const mismatch = codexRemoteCompatibility(worker, {
    localProbe: () => ({ ok: true, version: parseCodexVersion("0.151.0") }),
    remoteProbe: () => ({ ok: true, version: parseCodexVersion("0.150.1") }),
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /versions differ/);
});

test("Codex tunnel is a dedicated localhost-only SSH session", () => {
  const args = sshLocalForwardArgs(
    { target: "Lenovo@100.68.238.25", port: 22 },
    { localPort: 49123, remotePort: 43876 },
  );
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
  assert.ok(args.includes("ControlMaster=no"));
  assert.ok(args.includes("ControlPath=none"));
  assert.ok(args.includes("-N"));
  assert.ok(args.includes("127.0.0.1:49123:127.0.0.1:43876"));
  assert.equal(args.at(-1), "Lenovo@100.68.238.25");
  assert.throws(
    () => sshLocalForwardArgs({ target: "u@h" }, { localPort: 0, remotePort: 4500 }),
    /localPort/,
  );
});

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.kills.push(signal);
    child.signalCode = signal;
    return true;
  };
  return child;
}

test("remote TUI launches stock local Codex against worker cwd and always tears down only the SSH tunnel", async () => {
  const calls = [];
  const tunnel = fakeChild();
  const client = fakeChild();
  const worker = { target: "Lenovo@100.68.238.25", port: 22, platform: "windows" };
  const compatibility = { ok: true, version: parseCodexVersion("0.150.1") };

  const result = await runCodexRemoteTui(worker, {
    controllerId: "controller-1",
    targetName: "pc",
    remoteCwd: "~/hn/main/GitHub/Handoff",
    args: ["--model", "gpt-5.5"],
    compatibility,
    backend: {
      ensureServer: () => ({ serviceId: "svc", port: 43876, pid: 1234, reused: true }),
      resolveRemoteCwd: () => "C:\\Users\\Lenovo\\hn\\main\\GitHub\\Handoff",
      reserveLocalPort: async () => 49123,
      waitReady: async () => {},
      signalGuard: () => () => {},
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        if (command === "ssh") return tunnel;
        if (command === "codex") {
          setImmediate(() => {
            client.exitCode = 0;
            client.emit("close", 0, null);
          });
          return client;
        }
        throw new Error(`unexpected command ${command}`);
      },
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "ssh");
  assert.ok(calls[0].args.includes("127.0.0.1:49123:127.0.0.1:43876"));
  assert.equal(calls[1].command, "codex");
  assert.deepEqual(calls[1].args, [
    "--remote", "ws://127.0.0.1:49123",
    "--cd", "C:\\Users\\Lenovo\\hn\\main\\GitHub\\Handoff",
    "--model", "gpt-5.5",
  ]);
  assert.equal(calls[1].options.stdio, "inherit");
  assert.deepEqual(tunnel.kills, ["SIGTERM"]);
  assert.deepEqual(client.kills, []);
  assert.equal(result.service.pid, 1234);
  assert.equal(result.code, 0);
});
