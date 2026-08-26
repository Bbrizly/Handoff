#!/usr/bin/env node

import { loadConfig, requireWorker, requireWorkspace } from "./config.js";
import { parseSshTarget, testSsh } from "./ssh.js";
import { addWorker, addWorkspaceRoot, createWorkspace } from "./workspace.js";
import { bootstrapWorker, doctorWorker } from "./worker.js";
import { ensureForward, ensureSyncRoot, showSyncStatus, syncSessionName } from "./mutagen.js";
import { findContext, mapLocalToRemote } from "./resolve.js";
import { attachSession, ensurePersistentCommand, listSessions, sessionNameFor } from "./zellij.js";
import { runRemoteCommand } from "./remote.js";
import { fail } from "./util.js";

function help() {
  console.log(`Handoff - local files, remote compute

Setup:
  handoff worker add <name> <user@host[:port]>
  handoff workspace create <name> <worker>
  handoff workspace add <workspace> <local-path> [remote-path]

Use from inside a configured root:
  handoff claude
  handoff codex
  handoff npm run dev
  handoff exec <command...>
  handoff port <remote-port> [local-port]

Inspect:
  handoff worker list
  handoff worker doctor <name>
  handoff sync [workspace]
  handoff status [workspace]
  handoff sessions
  handoff attach <session>
`);
}

function requireArgs(args, count, usage) {
  if (args.length < count) fail(`Usage: ${usage}`);
}

function currentContext(config, workspaceName) {
  const context = findContext(config, process.cwd(), workspaceName);
  const worker = requireWorker(config, context.workspace.worker);
  return { ...context, worker };
}

function ensureCurrentSync(context) {
  return ensureSyncRoot(context.name, context.worker, context.root);
}

function printWorkerChecks(name, checks) {
  console.log(`${name}:`);
  for (const [key, value] of Object.entries(checks)) {
    console.log(`  ${value ? "✓" : "✗"} ${key}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || ["help", "--help", "-h"].includes(argv[0])) {
    help();
    return;
  }

  const config = loadConfig();
  const [command, ...args] = argv;

  if (command === "worker") {
    const [sub, ...rest] = args;
    if (sub === "add") {
      requireArgs(rest, 2, "handoff worker add <name> <user@host[:port]>");
      const [name, target] = rest;
      const worker = parseSshTarget(target);
      const ssh = testSsh(worker);
      if (ssh.code !== 0) fail(`SSH is not working for ${target}: ${ssh.stderr.trim()}`);
      addWorker(config, name, worker);
      bootstrapWorker(worker);
      console.log(`Added worker '${name}'.`);
      return;
    }
    if (sub === "bootstrap") {
      requireArgs(rest, 1, "handoff worker bootstrap <name>");
      bootstrapWorker(requireWorker(config, rest[0]));
      return;
    }
    if (sub === "doctor") {
      requireArgs(rest, 1, "handoff worker doctor <name>");
      printWorkerChecks(rest[0], doctorWorker(requireWorker(config, rest[0])));
      return;
    }
    if (sub === "list") {
      const entries = Object.entries(config.workers);
      if (!entries.length) console.log("No workers configured.");
      for (const [name, worker] of entries) console.log(`${name}\t${worker.target}${worker.port !== 22 ? `:${worker.port}` : ""}`);
      return;
    }
    fail("Usage: handoff worker <add|bootstrap|doctor|list> ...");
  }

  if (command === "workspace") {
    const [sub, ...rest] = args;
    if (sub === "create") {
      requireArgs(rest, 2, "handoff workspace create <name> <worker>");
      createWorkspace(config, rest[0], rest[1]);
      console.log(`Created workspace '${rest[0]}'.`);
      return;
    }
    if (sub === "add") {
      requireArgs(rest, 2, "handoff workspace add <workspace> <local-path> [remote-path]");
      const root = addWorkspaceRoot(config, rest[0], rest[1], rest[2]);
      console.log(`${root.local} <-> ${root.remote}`);
      return;
    }
    if (sub === "list") {
      for (const [name, workspace] of Object.entries(config.workspaces)) {
        console.log(`${name} -> ${workspace.worker}`);
        for (const root of workspace.roots) console.log(`  ${root.local} <-> ${root.remote}`);
      }
      return;
    }
    fail("Usage: handoff workspace <create|add|list> ...");
  }

  if (command === "sync") {
    const workspaceName = args[0];
    if (workspaceName) {
      const workspace = requireWorkspace(config, workspaceName);
      const worker = requireWorker(config, workspace.worker);
      for (const root of workspace.roots) {
        console.log(`Syncing ${root.local}...`);
        ensureSyncRoot(workspaceName, worker, root);
      }
    } else {
      const context = currentContext(config);
      ensureCurrentSync(context);
    }
    return;
  }

  if (command === "status") {
    const workspaceName = args[0];
    const workspace = workspaceName ? requireWorkspace(config, workspaceName) : currentContext(config).workspace;
    const name = workspaceName ?? currentContext(config).name;
    console.log(`${name} -> ${workspace.worker}`);
    for (const root of workspace.roots) {
      const session = syncSessionName(name, root);
      console.log(`\n${root.local} <-> ${root.remote}`);
      showSyncStatus(session);
    }
    return;
  }

  if (command === "sessions") {
    const context = currentContext(config);
    bootstrapWorker(context.worker, { quiet: true });
    const result = listSessions(context.worker);
    process.stdout.write(result.stdout || "No Zellij sessions.\n");
    return;
  }

  if (command === "attach") {
    requireArgs(args, 1, "handoff attach <session>");
    const context = currentContext(config);
    bootstrapWorker(context.worker, { quiet: true });
    attachSession(context.worker, args[0]);
    return;
  }

  if (command === "port") {
    requireArgs(args, 1, "handoff port <remote-port> [local-port]");
    const context = currentContext(config);
    const remotePort = Number(args[0]);
    const localPort = args[1] ? Number(args[1]) : remotePort;
    if (!Number.isInteger(remotePort) || !Number.isInteger(localPort)) fail("Ports must be integers.");
    const name = ensureForward(context.worker, `${context.name}:${context.root.remote}`, remotePort, localPort);
    console.log(`Forwarding Windows:${remotePort} -> localhost:${localPort} (${name})`);
    return;
  }

  if (command === "exec") {
    requireArgs(args, 1, "handoff exec <command...>");
    const context = currentContext(config);
    ensureCurrentSync(context);
    const remoteCwd = mapLocalToRemote(context.root, process.cwd());
    runRemoteCommand(context.worker, remoteCwd, args);
    return;
  }

  // Anything else is a persistent remote command.
  const context = currentContext(config);
  bootstrapWorker(context.worker, { quiet: true });
  ensureCurrentSync(context);
  const remoteCwd = mapLocalToRemote(context.root, process.cwd());
  const commandArgs = [command, ...args];
  const sessionName = sessionNameFor(context.name, context.root, commandArgs);
  ensurePersistentCommand(context.worker, sessionName, remoteCwd, commandArgs);
  attachSession(context.worker, sessionName);
}

main().catch((error) => {
  console.error(`handoff: ${error.message}`);
  process.exit(1);
});
