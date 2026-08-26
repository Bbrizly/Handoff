#!/usr/bin/env node

import { basename } from "node:path";
import {
  loadConfig,
  requireWorker,
  requireWorkspace,
  resolveActiveTargetName,
  saveConfig,
  setActiveTarget,
} from "./config.js";
import { augmentAgentCommand } from "./agent.js";
import { parseSshTarget, testSsh } from "./ssh.js";
import { addWorker, addWorkspaceRoot, createWorkspace } from "./workspace.js";
import { bootstrapWorker, detectWorker, doctorWorker, ensureRemoteDirectories } from "./worker.js";
import {
  ensureForward,
  ensureSyncRoot,
  flushSyncSessions,
  getSyncStatus,
  isMutagenInstalled,
  syncSessionName,
} from "./mutagen.js";
import { findContext, mapLocalToRemote, tryFindContext } from "./resolve.js";
import {
  attachSession,
  ensurePersistentCommand,
  listSessions,
  newSessionToken,
  sessionNameFor,
  shellCommand,
} from "./zellij.js";
import { runRemoteCommand } from "./remote.js";
import { fail, normalizeName } from "./util.js";

const RESERVED_COMMANDS = new Set([
  "help", "status", "doctor", "worker", "workspace", "sync", "sessions", "attach",
  "port", "exec", "shell", "new",
]);
const TARGET_HINTS = new Set(["home", "pc", "aws"]);

function help() {
  console.log(`hn - local files, compute anywhere

Everyday:
  hn                    status
  hn pc                 switch active target
  hn aws claude         switch target + launch Claude
  hn claude             persistent Claude in this project
  hn codex              persistent Codex in this project
  hn new claude         start another Claude session
  hn shell              persistent remote shell
  hn npm run dev        persistent arbitrary command
  hn exec npm test      one-shot remote command
  hn port 5173          remote 5173 -> local 5173

One-time setup:
  hn worker add pc <user@host[:port]>
  hn worker add aws <user@host[:port]>
  hn workspace add main ~/GitHub
  hn workspace add main ~/Obsidian
  hn workspace add main ~/Downloads

Inspect:
  hn doctor [target]
  hn worker list
  hn workspace list
  hn sync [workspace]
  hn sessions
  hn attach <session>
`);
}

function requireArgs(args, count, usage) {
  if (args.length < count) fail(`Usage: ${usage}`);
}

function targetFor(config) {
  const name = resolveActiveTargetName(config);
  if (!name) fail("No compute target configured. Run: hn worker add pc user@host");
  return { name, worker: requireWorker(config, name) };
}

function persistWorkerMetadata(config, name, worker) {
  const previous = config.workers[name] ?? {};
  if (previous.platform !== worker.platform || previous.arch !== worker.arch) {
    config.workers[name] = worker;
    saveConfig(config);
  }
  return worker;
}

function prepareTarget(config, name, { quiet = true } = {}) {
  const worker = requireWorker(config, name);
  const prepared = bootstrapWorker(worker, { quiet });
  return persistWorkerMetadata(config, name, prepared);
}

function currentContext(config, workspaceName = undefined) {
  const context = findContext(config, process.cwd(), workspaceName);
  const target = targetFor(config);
  return { ...context, targetName: target.name, worker: target.worker };
}

function workspaceSalt(workspace) {
  return (workspace.roots ?? [])
    .map((root) => `${root.local}->${root.remote}`)
    .sort()
    .join("\u0000");
}

function ensureWorkspaceSync(context) {
  ensureRemoteDirectories(context.worker, context.workspace.roots.map((root) => root.remote));
  const sessions = context.workspace.roots.map((root) =>
    ensureSyncRoot(context.name, context.targetName, context.worker, root),
  );
  if (sessions.some((session) => session.created)) {
    console.log(`syncing ${context.name} -> ${context.targetName}...`);
  }
  flushSyncSessions(sessions.map((session) => session.name));
}

function syncStatusText(status) {
  if (status.conflicts > 0) return `⚠ ${status.conflicts} conflict${status.conflicts === 1 ? "" : "s"}`;
  if (status.state === "mutagen-missing" || status.state === "not-started") return "—";
  if (status.state.includes("watching")) return "✓";
  if (["scanning", "staging", "reconciling", "saving"].some((value) => status.state.includes(value))) return "…";
  if (status.state.includes("disconnected") || status.state.includes("halted") || status.state === "error") return "✗";
  return status.state || "?";
}

function printStatus(config, workspaceName = undefined) {
  const context = workspaceName
    ? tryFindContext(config, process.cwd(), workspaceName)
    : tryFindContext(config, process.cwd());
  const workspace = workspaceName
    ? requireWorkspace(config, workspaceName)
    : context?.workspace ?? null;
  const targetName = resolveActiveTargetName(config);

  if (!targetName) {
    console.log("target     —");
    console.log("setup      hn worker add pc user@host");
    return;
  }

  const worker = requireWorker(config, targetName);
  const ssh = testSsh(worker);
  const platform = worker.platform ? `${worker.platform}/${worker.arch ?? "?"}` : "unknown";
  console.log(`target     ${targetName} ${ssh.code === 0 ? "✓" : "✗"}  ${platform}`);

  if (!workspace) {
    console.log("workspace  —");
    return;
  }

  const resolvedWorkspaceName = workspaceName ?? context.name;
  console.log(`workspace  ${resolvedWorkspaceName}`);
  if (context) console.log(`project    ${basename(context.projectLocal)}`);

  for (const root of workspace.roots ?? []) {
    const session = syncSessionName(resolvedWorkspaceName, targetName, worker, root);
    const status = getSyncStatus(session);
    console.log(`sync       ${syncStatusText(status)}  ${basename(root.local)}`);
  }
}

function printWorkerChecks(name, checks) {
  console.log(`${name}  ${checks.platform}/${checks.arch}`);
  for (const key of ["ssh", "zellij", "claude", "codex", "node"]) {
    console.log(`  ${checks[key] ? "✓" : "✗"} ${key}`);
  }
  console.log(`  ${isMutagenInstalled() ? "✓" : "✗"} mutagen (controller)`);
}

function selectTarget(config, nameInput, { quiet = false } = {}) {
  const name = normalizeName(nameInput, "target name");
  requireWorker(config, name);
  if (config.activeTarget !== name) setActiveTarget(config, name);
  if (!quiet) console.log(name);
  return name;
}

function addTarget(config, nameInput, targetInput) {
  const name = normalizeName(nameInput, "target name");
  if (RESERVED_COMMANDS.has(name)) fail(`'${name}' is reserved and cannot be a target name.`);
  const base = parseSshTarget(targetInput);
  const ssh = testSsh(base);
  if (ssh.code !== 0) fail(`SSH is not working for ${targetInput}: ${(ssh.stderr || ssh.stdout).trim()}`);
  const worker = { ...base, ...detectWorker(base) };
  const prepared = bootstrapWorker(worker, { quiet: true });
  addWorker(config, name, prepared);
  console.log(`${name} ✓  ${prepared.platform}/${prepared.arch}  ${prepared.target}${prepared.port !== 22 ? `:${prepared.port}` : ""}`);
}

function syncWholeWorkspace(config, workspaceName, workspace) {
  const target = targetFor(config);
  const worker = prepareTarget(config, target.name);
  ensureRemoteDirectories(worker, workspace.roots.map((root) => root.remote));
  const sessions = workspace.roots.map((root) =>
    ensureSyncRoot(workspaceName, target.name, worker, root),
  );
  console.log(`syncing ${workspaceName} -> ${target.name}...`);
  flushSyncSessions(sessions.map((session) => session.name));
  console.log("sync ✓");
}

function runPersistent(config, commandArgs, { unique = false, preparedWorker = null } = {}) {
  let context = currentContext(config);
  const worker = preparedWorker ?? prepareTarget(config, context.targetName);
  context = { ...context, worker };
  ensureWorkspaceSync(context);

  const remoteCwd = mapLocalToRemote(context.root, process.cwd());
  const remoteArgs = augmentAgentCommand(commandArgs, context.workspace, remoteCwd);
  const sessionName = sessionNameFor(
    context.name,
    context.targetName,
    context.projectLocal,
    commandArgs,
    workspaceSalt(context.workspace),
    unique ? newSessionToken() : "",
  );
  ensurePersistentCommand(worker, sessionName, remoteCwd, remoteArgs);
  attachSession(worker, sessionName);
}

async function main() {
  const argv = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(argv[0])) {
    help();
    return;
  }

  const config = loadConfig();
  if (!argv.length) {
    printStatus(config);
    return;
  }

  let [command, ...args] = argv;
  const possibleTarget = String(command).toLowerCase();
  if (!RESERVED_COMMANDS.has(possibleTarget) && config.workers[possibleTarget]) {
    selectTarget(config, possibleTarget, { quiet: args.length > 0 });
    if (!args.length) return;
    [command, ...args] = args;
  } else if (TARGET_HINTS.has(possibleTarget) && !config.workers[possibleTarget]) {
    fail(`Target '${possibleTarget}' is not configured. Run: hn worker add ${possibleTarget} user@host`);
  }

  if (command === "status") {
    printStatus(config, args[0]);
    return;
  }

  if (command === "doctor") {
    const name = args[0] ? normalizeName(args[0], "target name") : resolveActiveTargetName(config);
    if (!name) fail("No target configured.");
    const worker = requireWorker(config, name);
    const metadata = worker.platform && worker.arch ? worker : { ...worker, ...detectWorker(worker) };
    persistWorkerMetadata(config, name, metadata);
    printWorkerChecks(name, doctorWorker(metadata));
    return;
  }

  if (command === "worker") {
    const [sub, ...rest] = args;
    if (sub === "add") {
      requireArgs(rest, 2, "hn worker add <name> <user@host[:port]>");
      addTarget(config, rest[0], rest[1]);
      return;
    }
    if (sub === "bootstrap") {
      requireArgs(rest, 1, "hn worker bootstrap <name>");
      const name = normalizeName(rest[0], "target name");
      const worker = prepareTarget(config, name, { quiet: false });
      config.workers[name] = worker;
      saveConfig(config);
      return;
    }
    if (sub === "doctor") {
      requireArgs(rest, 1, "hn worker doctor <name>");
      const name = normalizeName(rest[0], "target name");
      const worker = requireWorker(config, name);
      const metadata = worker.platform && worker.arch ? worker : { ...worker, ...detectWorker(worker) };
      persistWorkerMetadata(config, name, metadata);
      printWorkerChecks(name, doctorWorker(metadata));
      return;
    }
    if (sub === "list") {
      const entries = Object.entries(config.workers);
      if (!entries.length) console.log("No targets configured.");
      for (const [name, worker] of entries) {
        const active = config.activeTarget === name ? "*" : " ";
        const platform = worker.platform ? `${worker.platform}/${worker.arch ?? "?"}` : "unknown";
        console.log(`${active} ${name}\t${platform}\t${worker.target}${worker.port !== 22 ? `:${worker.port}` : ""}`);
      }
      return;
    }
    fail("Usage: hn worker <add|bootstrap|doctor|list> ...");
  }

  if (command === "workspace") {
    const [sub, ...rest] = args;
    if (sub === "create") {
      requireArgs(rest, 1, "hn workspace create <name>");
      const name = createWorkspace(config, rest[0]);
      console.log(`created ${name}`);
      return;
    }
    if (sub === "add") {
      requireArgs(rest, 2, "hn workspace add <workspace> <local-path> [remote-path]");
      const root = addWorkspaceRoot(config, rest[0], rest[1], rest[2]);
      console.log(`${root.local} <-> ${root.remote}`);
      return;
    }
    if (sub === "list") {
      for (const [name, workspace] of Object.entries(config.workspaces)) {
        console.log(name);
        for (const root of workspace.roots ?? []) console.log(`  ${root.local} <-> ${root.remote}`);
      }
      return;
    }
    fail("Usage: hn workspace <create|add|list> ...");
  }

  if (command === "sync") {
    if (args[0]) {
      const workspaceName = normalizeName(args[0], "workspace name");
      syncWholeWorkspace(config, workspaceName, requireWorkspace(config, workspaceName));
    } else {
      const context = currentContext(config);
      syncWholeWorkspace(config, context.name, context.workspace);
    }
    return;
  }

  if (command === "sessions") {
    const target = targetFor(config);
    const worker = prepareTarget(config, target.name);
    const result = listSessions(worker);
    process.stdout.write(result.stdout || "No Zellij sessions.\n");
    return;
  }

  if (command === "attach") {
    requireArgs(args, 1, "hn attach <session>");
    const target = targetFor(config);
    const worker = prepareTarget(config, target.name);
    attachSession(worker, args[0]);
    return;
  }

  if (command === "port") {
    requireArgs(args, 1, "hn port <remote-port> [local-port]");
    const context = currentContext(config);
    const worker = prepareTarget(config, context.targetName);
    const remotePort = Number(args[0]);
    const localPort = args[1] ? Number(args[1]) : remotePort;
    if (![remotePort, localPort].every((port) => Number.isInteger(port) && port >= 1 && port <= 65535)) {
      fail("Ports must be integers from 1 to 65535.");
    }
    const name = ensureForward(worker, `${context.name}:${context.root.remote}`, remotePort, localPort);
    console.log(`${context.targetName}:${remotePort} -> localhost:${localPort}  (${name})`);
    return;
  }

  if (command === "exec") {
    requireArgs(args, 1, "hn exec <command...>");
    let context = currentContext(config);
    const worker = prepareTarget(config, context.targetName);
    context = { ...context, worker };
    ensureWorkspaceSync(context);
    const remoteCwd = mapLocalToRemote(context.root, process.cwd());
    runRemoteCommand(worker, remoteCwd, augmentAgentCommand(args, context.workspace, remoteCwd));
    return;
  }

  if (command === "shell") {
    const context = currentContext(config);
    if (context.worker.platform) {
      runPersistent(config, shellCommand(context.worker));
    } else {
      const worker = prepareTarget(config, context.targetName);
      runPersistent(config, shellCommand(worker), { preparedWorker: worker });
    }
    return;
  }

  if (command === "new") {
    requireArgs(args, 1, "hn new <command...>");
    runPersistent(config, args, { unique: true });
    return;
  }

  runPersistent(config, [command, ...args]);
}

main().catch((error) => {
  console.error(`hn: ${error.message}`);
  process.exit(1);
});
