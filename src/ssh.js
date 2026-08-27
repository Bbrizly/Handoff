import { spawnSync } from "node:child_process";
import { fail, quotePosix } from "./util.js";

const POWERSHELL_SAFE_ENCODED_LENGTH = 6000;

function parseHostPort(input) {
  if (input.startsWith("[")) {
    const match = input.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!match) return null;
    return { host: match[1], port: match[2] ? Number(match[2]) : 22 };
  }

  const colonCount = (input.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const index = input.lastIndexOf(":");
    const suffix = input.slice(index + 1);
    if (/^\d+$/.test(suffix)) {
      return { host: input.slice(0, index), port: Number(suffix) };
    }
  }

  return { host: input, port: 22 };
}

export function parseSshTarget(input) {
  const value = String(input ?? "").trim();
  if (!value) fail("SSH target cannot be empty.");

  const at = value.lastIndexOf("@");
  const user = at > 0 ? value.slice(0, at) : null;
  const hostPort = at > 0 ? value.slice(at + 1) : value;
  const parsed = parseHostPort(hostPort);
  if (!parsed?.host || !parsed.host.trim()) {
    fail(`Invalid SSH target '${input}'. Use user@host, user@host:port, or user@[ipv6]:port.`);
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    fail(`Invalid SSH port in '${input}'.`);
  }

  return {
    target: user ? `${user}@${parsed.host}` : parsed.host,
    host: parsed.host,
    user,
    port: parsed.port,
  };
}

function connectionArgs(worker) {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ConnectionAttempts=1",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=3",
  ];
}

function baseArgs(worker, tty = false) {
  const args = [];
  if (tty) args.push("-tt");
  args.push(...connectionArgs(worker));
  if (worker.port && worker.port !== 22) args.push("-p", String(worker.port));
  args.push(worker.target);
  return args;
}

export function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function powerShellInvocation(script) {
  const wrapped = `$ProgressPreference = 'SilentlyContinue'\n${script}`;
  const encoded = encodePowerShell(wrapped);
  const base = [
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-OutputFormat",
    "Text",
  ];

  // Windows/OpenSSH can reject large remote argv strings before PowerShell ever
  // starts. Keep normal commands encoded, but stream oversized scripts on stdin.
  if (encoded.length > POWERSHELL_SAFE_ENCODED_LENGTH) {
    return {
      args: [...base, "-Command", "-"],
      input: wrapped,
    };
  }

  return {
    args: [...base, "-EncodedCommand", encoded],
    input: null,
  };
}

export function runSsh(
  worker,
  remoteArgs = [],
  { tty = false, capture = false, allowFailure = false, timeoutMs, input = null } = {},
) {
  const args = [...baseArgs(worker, tty), ...remoteArgs];
  const hasInput = input !== null && input !== undefined;
  const stdio = capture
    ? [hasInput ? "pipe" : "ignore", "pipe", "pipe"]
    : hasInput
      ? ["pipe", "inherit", "inherit"]
      : "inherit";

  const result = spawnSync("ssh", args, {
    stdio,
    encoding: capture ? "utf8" : undefined,
    timeout: timeoutMs,
    input: hasInput ? input : undefined,
  });

  if (result.error) {
    if (allowFailure) {
      return { code: 124, stdout: result.stdout ?? "", stderr: result.stderr ?? result.error.message };
    }
    fail(`SSH failed to start: ${result.error.message}`);
  }

  const code = result.status ?? 1;
  if (code !== 0 && !allowFailure) {
    const detail = capture ? (result.stderr || result.stdout || "").trim() : "";
    fail(`SSH command failed (${code})${detail ? `: ${detail}` : ""}`);
  }
  return { code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function runPowerShell(worker, script, options = {}) {
  const invocation = powerShellInvocation(script);
  return runSsh(worker, invocation.args, { ...options, input: invocation.input });
}

export function runPosix(worker, script, options = {}) {
  return runSsh(worker, ["sh", "-lc", quotePosix(script)], options);
}

function scpRemoteTarget(worker) {
  const host = worker.host.includes(":") ? `[${worker.host}]` : worker.host;
  return worker.user ? `${worker.user}@${host}` : host;
}

export function copyToWorker(worker, localPath, remotePath) {
  const args = [...connectionArgs(worker)];
  if (worker.port && worker.port !== 22) args.push("-P", String(worker.port));
  args.push(localPath, `${scpRemoteTarget(worker)}:${remotePath}`);
  const result = spawnSync("scp", args, { encoding: "utf8" });
  if (result.error) fail(`scp failed to start: ${result.error.message}`);
  if ((result.status ?? 1) !== 0) {
    fail(`scp failed (${result.status ?? 1}): ${(result.stderr || result.stdout || "").trim()}`);
  }
}

export function testSsh(worker) {
  return runSsh(worker, ["echo", "hn-ok"], { capture: true, allowFailure: true, timeoutMs: 8000 });
}
