import { spawnSync } from "node:child_process";
import { fail } from "./util.js";

export function parseSshTarget(input) {
  const match = input.match(/^(?:([^@]+)@)?([^:]+?)(?::(\d+))?$/);
  if (!match) fail(`Invalid SSH target '${input}'. Use user@host or user@host:port.`);
  const [, user, host, portText] = match;
  return {
    target: user ? `${user}@${host}` : host,
    host,
    user: user ?? null,
    port: portText ? Number(portText) : 22,
    platform: "windows",
  };
}

function baseArgs(worker, tty = false) {
  const args = [];
  if (tty) args.push("-tt");
  args.push("-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3");
  if (worker.port && worker.port !== 22) args.push("-p", String(worker.port));
  args.push(worker.target);
  return args;
}

export function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function runSsh(worker, remoteArgs = [], { tty = false, capture = false, allowFailure = false } = {}) {
  const args = [...baseArgs(worker, tty), ...remoteArgs];
  const result = spawnSync("ssh", args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: capture ? "utf8" : undefined,
  });

  if (result.error) fail(`SSH failed to start: ${result.error.message}`);
  const code = result.status ?? 1;
  if (code !== 0 && !allowFailure) {
    const detail = capture ? (result.stderr || result.stdout || "").trim() : "";
    fail(`SSH command failed (${code})${detail ? `: ${detail}` : ""}`);
  }
  return { code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function runPowerShell(worker, script, options = {}) {
  const encoded = encodePowerShell(script);
  return runSsh(
    worker,
    ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    options,
  );
}

export function testSsh(worker) {
  return runSsh(worker, ["whoami"], { capture: true, allowFailure: true });
}
