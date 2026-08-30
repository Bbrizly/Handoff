#!/usr/bin/env node

// One-shot byte relay for the persistent Herdr desk.
//
// The local official Herdr client connects to a private Unix socket owned by
// this process. The relay then opens one ordinary Handoff SSH exec channel and
// copies bytes in both directions. It never provisions, starts, stops, updates,
// or discovers Herdr on the worker.

import { spawn } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import net from "node:net";
import { sshSpawnArgs } from "./ssh.js";

function decodePayload(raw) {
  try {
    return JSON.parse(Buffer.from(String(raw ?? ""), "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid Handoff Herdr relay payload");
  }
}

const payload = decodePayload(process.argv[2]);
const worker = payload.worker;
const socketPath = String(payload.socketPath ?? "");
const remoteArgs = Array.isArray(payload.remoteArgs) ? payload.remoteArgs.map(String) : [];
const parentPid = Number(payload.parentPid);

if (!worker?.target || !socketPath || remoteArgs.length === 0 || !Number.isInteger(parentPid) || parentPid <= 1) {
  throw new Error("incomplete Handoff Herdr relay payload");
}

try { rmSync(socketPath, { force: true }); } catch {}

let ssh = null;
let client = null;
let exiting = false;

function parentAlive() {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch {
    return false;
  }
}

function finish(code = 0) {
  if (exiting) return;
  exiting = true;
  try { client?.destroy(); } catch {}
  try {
    if (ssh && ssh.exitCode === null && !ssh.killed) ssh.kill("SIGTERM");
  } catch {}
  try { server.close(); } catch {}
  try { rmSync(socketPath, { force: true }); } catch {}
  process.exitCode = code;
}

const server = net.createServer({ allowHalfOpen: false }, (socket) => {
  if (client) {
    socket.destroy();
    return;
  }
  client = socket;
  server.close();

  ssh = spawn("ssh", [...sshSpawnArgs(worker), ...remoteArgs], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  ssh.stderr.pipe(process.stderr);
  socket.pipe(ssh.stdin);
  ssh.stdout.pipe(socket);

  socket.on("error", () => {});
  socket.on("close", () => {
    try {
      if (ssh && ssh.exitCode === null && !ssh.killed) ssh.kill("SIGTERM");
    } catch {}
  });

  ssh.on("error", (error) => {
    console.error(`Handoff Herdr relay could not start ssh: ${error.message}`);
    finish(1);
  });
  ssh.on("close", (code, signal) => {
    if ((code ?? 1) !== 0 && !exiting) {
      console.error(`Handoff Herdr relay lost ssh (${signal ?? code ?? "unknown"}).`);
    }
    finish((code ?? 1) === 0 ? 0 : 1);
  });
});

server.on("error", (error) => {
  console.error(`Handoff Herdr relay could not listen: ${error.message}`);
  finish(1);
});

server.listen(socketPath, () => {
  try { chmodSync(socketPath, 0o600); } catch {}
});

const parentWatch = setInterval(() => {
  if (!parentAlive()) finish(1);
}, 1000);
parentWatch.unref();

process.on("SIGINT", () => finish(0));
process.on("SIGTERM", () => finish(0));
process.on("exit", () => {
  try { rmSync(socketPath, { force: true }); } catch {}
});
