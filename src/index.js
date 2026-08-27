#!/usr/bin/env node

import { basename } from "node:path";
import {
  loadConfig,
  requireWorker,
  requireWorkspace,
  resolveActiveTargetName,
  setActiveTarget,
  setDefaultTarget,
  updateConfig,
} from "./config.js";
import { augmentAgentCommand } from "./agent.js";
import { ensureControllerSshKey, windowsPairCommand } from "./pair.js";
import { parseSshTarget, testSsh } from "./ssh.js";
import {
  addWorker,
  addWorkspaceRoot,
  createWorkspace,
  grantWorkspaceTarget,
  removeWorker,
  removeWorkspace,
  removeWorkspaceRoot,
  revokeWorkspaceTarget,
  setWorkerTrust,
  workspaceAllowsTarget,
} from "./workspace.js";
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
  "port", "exec", "shell", "new", "on",
]);
const TARGET_HINTS = new Set(["home", "pc", "aws", "local"]);

function help() {
  console.log(`hn - local files, compute anywhere

Everyday:
  hn                         status
  hn pc                      use pc in this terminal
  hn aws claude              use aws in this terminal + launch Claude
  hn on <target> <command>   one-shot target without changing terminal state
  HN_TARGET=pc hn claude     explicit environment override
  hn claude                  persistent Claude in this project
  hn codex                   persistent Codex in this project
  hn new claude              start another Claude session
  hn shell                   persistent remote shell
  hn npm run dev             persistent arbitrary command
  hn exec npm test           one-shot remote command
  hn port 5173               remote 5173 -> local 5173

Windows setup:
  hn worker pair pc <user@host[:port]>
  # paste the generated self-contained command once in PowerShell as Administrator
  hn worker finish pc

Already have key-based SSH:
  hn worker add aws <user@host[:port]>   # new manual targets default to remote trust
  hn worker trust aws trusted            # opt in only for machines you fully trust

Workspace setup:
  hn workspace add main ~/GitHub
  hn workspace add main ~/Obsidian
  hn workspace add main ~/Downloads

Remote-target privacy:
  hn workspace grant main aws
  hn workspace revoke main aws

Inspect/admin:
  hn doctor [target]
  hn worker list
  hn worker default <target>
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
  if (!name) fail("No compute target configured. Run: hn worker pair pc user@host");
  return { name, worker: requireWorker(config, name) };
}

function persistWorkerMetadata(config, name, worker) {
  const previous = config.workers[name] ?? {};
  if (
    previous.platform !== worker.platform
    || previous.arch !== worker.arch
    || previous.pending !== worker.pending
    || previous.trust !== worker.trust
  ) {
    updateConfig(config, (latest) => {
      const current = requireWorker(latest, name);
      latest.workers[name] = { ...current, ...worker };
    });
  }
  return config.workers[name] ?? worker;
}

function prepareTarget(config, name, { quiet = true } = {}) {
  const worker = requireWorker(config, name);
  if (worker.pending) fail(`Target '${name}' is not paired yet. Run: hn worker finish ${name}`);
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

function requireWorkspacePermission(context) {
  if (workspaceAllowsTarget(context.workspace, context.targetName, context.worker)) return;
  fail(
    `Target '${context.targetName}' is marked remote and workspace '${context.name}' has not been granted to it. `
    + `Review the workspace roots, then run: hn workspace grant ${context.name} ${context.targetName}`,
  );
}

function ensureWorkspaceSync(context) {
  requireWorkspacePermission(context);
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
    console.log("setup      hn worker pair pc user@host");
    return;
  }

  const worker = requireWorker(config, targetName);
  const ssh = worker.pending ? { code: 1 } : testSsh(worker);
  const platform = worker.platform ? `${worker.platform}/${worker.arch ?? "?"}` : (worker.pending ? "pairing" : "unknown");
  console.log(`target     ${targetName} ${ssh.code === 0 ? "✓" : "✗"}  ${platform}  ${worker.trust ?? "trusted"}`);

  if (!workspace) {
    console.log("workspace  —");
    return;
  }

  const resolvedWorkspaceName = workspaceName ?? context.name;
  console.log(`workspace  ${resolvedWorkspaceName}`);
  if (context) console.log(`project    ${basename(context.projectLocal)}`);
  if (!workspaceAllowsTarget(workspace, targetName, worker)) console.log("grant      required before sync");

  for (const root of workspace.roots ?? []) {
    const session = syncSessionName(resolvedWorkspaceName, targetName, worker, root);
    const status = getSyncStatus(session);
    console.log(`sync       ${syncStatusText(status)}  ${basename(root.local)}`);
  }
}

function printWorkerChecks(name, checks, trust) {
  console.log(`${name}  ${checks.platform}/${checks.arch}  ${trust}`);
  for (const key of ["ssh", "zellij", "claude", "codex", "node"]) {
    console.log(`  ${checks[key] ? "✓" : "✗"} ${key}`);
  }
  console.log(`  ${isMutagenInstalled() ? "✓" : "✗"} mutagen (controller)`);
}

function selectTarget(config, nameInput, { quiet = false } = {}) {
  const name = normalizeName(nameInput, "target name");
  requireWorker(config, name);
  setActiveTarget(config, name);
  if (!quiet) console.log(name);
  return name;
}

function validateTargetName(nameInput) {
  const name = normalizeName(nameInput, "target name");
  if (RESERVED_COMMANDS.has(name)) fail(`'${name}' is reserved and cannot be a target name.`);
  return name;
}

function pairTarget(config, nameInput, targetInput) {
  const name = validateTargetName(nameInput);
  const base = parseSshTarget(targetInput);
  const key = ensureControllerSshKey();
  addWorker(config, name, { ...base, pending: true, trust: "trusted" });

  console.log(key.created ? `created SSH key ${key.privateKey}` : `using SSH key ${key.privateKey}`);
  console.log("\nOn Windows: open PowerShell as Administrator and paste this ONE command:\n");
  console.log(windowsPairCommand(key.publicKey));
  console.log(`\nThen back on this Mac run:\n  hn worker finish ${name}`);
}

function finishTarget(config, nameInput) {
  const name = normalizeName(nameInput, "target name");
  const worker = requireWorker(config, name);
  const ssh = testSsh(worker);
  if (ssh.code !== 0) {
    fail(`Pairing is not complete for '${name}'. Run the generated Windows PowerShell command, then retry 'hn worker finish ${name}'.`);
  }

  const detected = { ...worker, ...detectWorker(worker) };
  delete detected.pending;
  const prepared = bootstrapWorker(detected, { quiet: true });
  updateConfig(config, (latest) => {
    const current = requireWorker(latest, name);
    latest.workers[name] = { ...current, ...prepared, pending: undefined };
    delete latest.workers[name].pending;
  });
  const saved = requireWorker(config, name);
  console.log(`${name} ✓  ${saved.platform}/${saved.arch}  ${saved.target}${saved.port !== 22 ? `:${saved.port}` : ""}  ${saved.trust}`);
}

function addTarget(config, nameInput, targetInput) {
  const name = validateTargetName(nameInput);
  const base = parseSshTarget(targetInput);
  const ssh = testSsh(base);
  if (ssh.code !== 0) {
    fail(`SSH is not working for ${targetInput}. For a new Windows worker use: hn worker pair ${name} ${targetInput}`);
  }
  const worker = { ...base, ...detectWorker(base), trust: "remote" };
  const prepared = bootstrapWorker(worker, { quiet: true });
  addWorker(config, name, prepared);
  console.log(`${name} ✓  ${prepared.platform}/${prepared.arch}  ${prepared.target}${prepared.port !== 22 ? `:${prepared.port}` : ""}  remote`);
  console.log(`grant a workspace explicitly before first sync: hn workspace grant <workspace> ${name}`);
}

function syncWholeWorkspace(config, workspaceName, workspace) {
  const target = targetFor(config);
  const worker = prepareTarget(config, target.name);
  const context = { name: workspaceName, workspace, targetName: target.name, worker };
  requireWorkspacePermission(context);
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
  let argv = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(argv[0])) {
    help();
    return;
  }

  const config = loadConfig();
  if (!argv.length) {
    printStatus(config);
    return;
  }

  if (argv[0] === "on") {
    requireArgs(argv.slice(1), 2, "hn on <target> <command...>");
    const name = normalizeName(argv[1], "target name");
    requireWorker(config, name);
    process.env.HN_TARGET = name;
    argv = argv.slice(2);
  }

  let [command, ...args] = argv;
  const possibleTarget = String(command).toLowerCase();
  const configuredTarget = config.workers[possibleTarget];
  const targetShorthandAllowed = args.length === 0 || TARGET_HINTS.has(possibleTarget);
  if (!RESERVED_COMMANDS.has(possibleTarget) && configuredTarget && targetShorthandAllowed) {
    selectTarget(config, possibleTarget, { quiet: args.length > 0 });
    if (!args.length) return;
    [command, ...args] = args;
  } else if (TARGET_HINTS.has(possibleTarget) && !configuredTarget) {
    fail(`Target '${possibleTarget}' is not configured. Run: hn worker pair ${possibleTarget} user@host`);
  }

  if (command === "status") {
    printStatus(config, args[0]);
    return;
  }

  if (command === "doctor") {
    const name = args[0] ? normalizeName(args[0], "target name") : resolveActiveTargetName(config);
    if (!name) fail("No target configured.");
    const worker = requireWorker(config, name);
    if (worker.pending) fail(`Target '${name}' is not paired yet. Run: hn worker finish ${name}`);
    const metadata = worker.platform && worker.arch ? worker : { ...worker, ...detectWorker(worker) };
    const saved = persistWorkerMetadata(config, name, metadata);
    printWorkerChecks(name, doctorWorker(saved), saved.trust ?? "trusted");
    return;
  }

  if (command === "worker") {
    const [sub, ...rest] = args;
    if (sub === "pair") {
      requireArgs(rest, 2, "hn worker pair <name> <user@host[:port]>");
      pairTarget(config, rest[0], rest[1]);
      return;
    }
    if (sub === "finish") {
      requireArgs(rest, 1, "hn worker finish <name>");
      finishTarget(config, rest[0]);
      return;
    }
    if (sub === "add") {
      requireArgs(rest, 2, "hn worker add <name> <user@host[:port]>");
      addTarget(config, rest[0], rest[1]);
      return;
    }
    if (sub === "trust") {
      requireArgs(rest, 2, "hn worker trust <name> <trusted|remote>");
      const trust = setWorkerTrust(config, rest[0], rest[1]);
      console.log(`${normalizeName(rest[0], "target name")}  ${trust}`);
      return;
    }
    if (sub === "default") {
      requireArgs(rest, 1, "hn worker default <name>");
      const name = normalizeName(rest[0], "target name");
      setDefaultTarget(config, name);
      console.log(`default ${name}`);
      return;
    }
    if (sub === "remove") {
      requireArgs(rest, 1, "hn worker remove <name>");
      console.log(`removed ${removeWorker(config, rest[0])}`);
      return;
    }
    if (sub === "bootstrap") {
      requireArgs(rest, 1, "hn worker bootstrap <name>");
      const name = normalizeName(rest[0], "target name");
      prepareTarget(config, name, { quiet: false });
      return;
    }
    if (sub === "doctor") {
      requireArgs(rest, 1, "hn worker doctor <name>");
      const name = normalizeName(rest[0], "target name");
      const worker = requireWorker(config, name);
      if (worker.pending) fail(`Target '${name}' is not paired yet. Run: hn worker finish ${name}`);
      const metadata = worker.platform && worker.arch ? worker : { ...worker, ...detectWorker(worker) };
      const saved = persistWorkerMetadata(config, name, metadata);
      printWorkerChecks(name, doctorWorker(saved), saved.trust ?? "trusted");
      return;
    }
    if (sub === "list") {
      const entries = Object.entries(config.workers);
      const activeName = resolveActiveTargetName(config);
      if (!entries.length) console.log("No targets configured.");
      for (const [name, worker] of entries) {
        const active = activeName === name ? "*" : " ";
        const fallback = config.activeTarget === name ? "d" : " ";
        const platform = worker.platform ? `${worker.platform}/${worker.arch ?? "?"}` : (worker.pending ? "pairing" : "unknown");
        console.log(`${active}${fallback} ${name}\t${worker.trust ?? "trusted"}\t${platform}\t${worker.target}${worker.port !== 22 ? `:${worker.port}` : ""}`);
      }
      return;
    }
    fail("Usage: hn worker <pair|finish|add|trust|default|remove|bootstrap|doctor|list> ...");
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
    if (sub === "remove-root") {
      requireArgs(rest, 2, "hn workspace remove-root <workspace> <local-path>");
      console.log(`removed ${removeWorkspaceRoot(config, rest[0], rest[1])}`);
      return;
    }
    if (sub === "remove") {
      requireArgs(rest, 1, "hn workspace remove <workspace>");
      console.log(`removed ${removeWorkspace(config, rest[0])}`);
      return;
    }
    if (sub === "grant") {
      requireArgs(rest, 2, "hn workspace grant <workspace> <target>");
      const grant = grantWorkspaceTarget(config, rest[0], rest[1]);
      console.log(`${grant.workspaceName} -> ${grant.targetName} granted`);
      return;
    }
    if (sub === "revoke") {
      requireArgs(rest, 2, "hn workspace revoke <workspace> <target>");
      const grant = revokeWorkspaceTarget(config, rest[0], rest[1]);
      console.log(`${grant.workspaceName} -> ${grant.targetName} revoked`);
      return;
    }
    if (sub === "list") {
      for (const [name, workspace] of Object.entries(config.workspaces)) {
        console.log(name);
        for (const root of workspace.roots ?? []) console.log(`  ${root.local} <-> ${root.remote}`);
        if ((workspace.grants ?? []).length) console.log(`  remote grants: ${workspace.grants.join(", ")}`);
      }
      return;
    }
    fail("Usage: hn workspace <create|add|remove-root|remove|grant|revoke|list> ...");
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
    process.stdout.write(result.stdout || "No Handoff sessions.\n");
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
    requireWorkspacePermission({ ...context, worker });
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
    if (context.worker.platform && !context.worker.pending) {
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
