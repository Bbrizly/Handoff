#!/usr/bin/env node

import { basename } from "node:path";
import { explainWorkspaceAccess } from "./access.js";
import {
  loadConfig,
  requireWorker,
  requireWorkspace,
  resolveActiveTargetName,
  setActiveTarget,
  setDefaultTarget,
  updateConfig,
} from "./config.js";
import { additionalWorkspaceDirs, augmentAgentCommand } from "./agent.js";
import { isPersistFlag, parseModeArgs, parseTargetInvocation } from "./cli-routing.js";
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
  remoteRootDirectory,
  setWorkerTrust,
  workspaceAllowsTarget,
  workspaceRootsForTarget,
} from "./workspace.js";
import {
  bootstrapWorker,
  detectWorker,
  doctorWorker,
  ensureRemoteDirectories,
  prepareWorkerCore,
} from "./worker.js";
import {
  ensureForward,
  ensureSyncRoot,
  flushSyncSessions,
  getSyncStatus,
  isSyncBackendInstalled,
  listForwards,
  listSyncSessions,
  stopForward,
  stopSyncSession,
  syncSessionName,
} from "./sync.js";
import { findContext, mapLocalToRemote, tryFindContext } from "./resolve.js";
import {
  attachSession,
  ensurePersistentCommand,
  killSession,
  listSessions,
  newSessionToken,
  sessionNameFor,
  shellCommand,
} from "./session.js";
import { runInteractiveRemoteCommand, runRemoteCommand } from "./remote.js";
import {
  claudeProfileRoots,
  enableClaudeProfile,
  ensureClaudeProfileProjection,
} from "./profile.js";
import { fail, normalizeName } from "./util.js";

const RESERVED_COMMANDS = new Set([
  "help", "status", "doctor", "worker", "workspace", "sync", "sessions", "attach",
  "port", "exec", "shell", "session", "new", "on", "use", "profile", "access",
]);
const TARGET_HINTS = new Set(["home", "pc", "aws", "local"]);

function help() {
  console.log(`hn - local files, compute anywhere

Everyday:
  hn                         status
  hn pc                      open pc at this project's mapped remote directory
  hn aws claude              run Claude interactively on aws in the mapped directory
  hn use pc                  use pc for commands without an explicit target
  hn on <target> <command>   one-shot target without changing terminal state
  HN_TARGET=pc hn claude     explicit environment override
  hn claude                  direct interactive Claude on the selected target
  hn shell                   open the selected target's mapped remote shell
  hn pc -p                   same compute, persistent desk that survives closing this
  hn pc -p claude            persistent desk, running Claude
  hn -p                      persistent desk on the selected target
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
  hn workspace add main ~/notes.md       # share exactly one file
  hn profile enable claude [workspace]   # personal skills/tools on trusted targets
  hn access [path]                       # explain whether and where a path is shared

Remote-target privacy:
  hn workspace grant main aws
  hn workspace revoke main aws

Inspect/admin:
  hn doctor [target]
  hn worker list
  hn worker default <target>
  hn workspace list
  hn sync [workspace]
  hn sync list
  hn sync stop [workspace]
  hn sessions
  hn sessions kill <session>
  hn attach <session>
  hn port list
  hn port stop <forward>
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

function prepareTarget(config, name, { quiet = true, persistence = false } = {}) {
  const worker = requireWorker(config, name);
  if (worker.pending) fail(`Target '${name}' is not paired yet. Run: hn worker finish ${name}`);
  const prepared = persistence
    ? bootstrapWorker(worker, { quiet })
    : prepareWorkerCore(worker, { quiet });
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

function targetWorkspace(context) {
  return {
    ...context.workspace,
    roots: workspaceRootsForTarget(context.workspace, context.worker),
  };
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
  const workspace = targetWorkspace(context);
  ensureRemoteDirectories(context.worker, workspace.roots.map(remoteRootDirectory));
  const sessions = workspace.roots.map((root) =>
    ensureSyncRoot(context.name, context.targetName, context.worker, root),
  );
  if (sessions.some((session) => session.created)) {
    console.log(`syncing ${context.name} -> ${context.targetName}...`);
  }
  flushSyncSessions(sessions.map((session) => session.name));
  ensureClaudeProfileProjection(context.worker, workspace.roots);
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
    if (root.scope === "trusted" && (worker.trust ?? "trusted") !== "trusted") {
      console.log(`sync       private  ${basename(root.local)}`);
      continue;
    }
    const session = syncSessionName(resolvedWorkspaceName, targetName, worker, root);
    const status = getSyncStatus(session);
    console.log(`sync       ${syncStatusText(status)}  ${basename(root.local)}`);
  }
}

function printWorkerChecks(name, checks, trust) {
  console.log(`${name}  ${checks.platform}/${checks.arch}  ${trust}`);
  for (const key of ["ssh", "claude", "codex", "node"]) {
    console.log(`  ${checks[key] ? "✓" : "✗"} ${key}`);
  }
  // Persistence is optional. Missing is not unhealthy, it just means no '-p' yet.
  console.log(checks.zellij ? "  ✓ persistence" : "  — persistence  (installs on first 'hn <target> -p')");
  console.log(`  ${isSyncBackendInstalled() ? "✓" : "✗"} mutagen (controller)`);
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
  const prepared = prepareWorkerCore(detected, { quiet: true });
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
  const prepared = prepareWorkerCore(worker, { quiet: true });
  addWorker(config, name, prepared);
  console.log(`${name} ✓  ${prepared.platform}/${prepared.arch}  ${prepared.target}${prepared.port !== 22 ? `:${prepared.port}` : ""}  remote`);
  console.log(`grant a workspace explicitly before first sync: hn workspace grant <workspace> ${name}`);
}

function syncWholeWorkspace(config, workspaceName, workspace) {
  const target = targetFor(config);
  const worker = prepareTarget(config, target.name);
  const context = { name: workspaceName, workspace, targetName: target.name, worker };
  requireWorkspacePermission(context);
  const roots = workspaceRootsForTarget(workspace, worker);
  ensureRemoteDirectories(worker, roots.map(remoteRootDirectory));
  const sessions = roots.map((root) =>
    ensureSyncRoot(workspaceName, target.name, worker, root),
  );
  console.log(`syncing ${workspaceName} -> ${target.name}...`);
  flushSyncSessions(sessions.map((session) => session.name), { monitor: true });
  ensureClaudeProfileProjection(worker, roots);
  console.log("sync ✓");
}

function printRecords(records, emptyText) {
  if (!records.length) {
    console.log(emptyText);
    return;
  }
  for (const record of records) console.log(`${record.name}\t${record.identifier}`);
}

function stopWorkspaceSync(config, workspaceName) {
  const workspace = requireWorkspace(config, workspaceName);
  const target = targetFor(config);
  const existing = new Map(listSyncSessions().map((record) => [record.name, record]));
  let stopped = 0;
  for (const root of workspace.roots ?? []) {
    const name = syncSessionName(workspaceName, target.name, target.worker, root);
    const record = existing.get(name);
    if (!record) continue;
    stopSyncSession(record.identifier);
    stopped += 1;
  }
  console.log(stopped ? `stopped ${stopped} sync session${stopped === 1 ? "" : "s"}` : "No active Handoff syncs for that workspace/target.");
}

function runPersistent(config, commandArgs, { unique = false, preparedWorker = null, targetName = null } = {}) {
  let context = currentContext(config);
  if (targetName) context = { ...context, targetName, worker: requireWorker(config, targetName) };
  const worker = preparedWorker ?? prepareTarget(config, context.targetName, { persistence: true });
  context = { ...context, worker };
  ensureWorkspaceSync(context);

  const remoteCwd = mapLocalToRemote(context.root, process.cwd());
  const remoteArgs = augmentAgentCommand(commandArgs, targetWorkspace(context), remoteCwd);
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

// Persistent mode is opt-in and installs the persistence runtime on first use.
// The backend behind it is still Zellij; swapping it does not change this call.
function runPersistentDesk(config, targetName, commandArgs = []) {
  const worker = prepareTarget(config, targetName, { persistence: true });
  runPersistent(config, commandArgs.length ? commandArgs : shellCommand(worker), {
    targetName,
    preparedWorker: worker,
  });
}

function runInteractive(config, targetName, commandArgs = [], { preparedWorker = null } = {}) {
  let context = findContext(config, process.cwd());
  const worker = preparedWorker ?? prepareTarget(config, targetName);
  context = { ...context, targetName, worker };
  ensureWorkspaceSync(context);

  const remoteCwd = mapLocalToRemote(context.root, process.cwd());
  const workspace = targetWorkspace(context);
  const remoteArgs = commandArgs.length
    ? augmentAgentCommand(commandArgs, workspace, remoteCwd)
    : [];
  runInteractiveRemoteCommand(worker, remoteCwd, remoteArgs, {
    agentDirs: additionalWorkspaceDirs(workspace, remoteCwd),
  });
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

  if (isPersistFlag(argv[0])) {
    const { commandArgs } = parseModeArgs(argv);
    runPersistentDesk(config, targetFor(config).name, commandArgs);
    return;
  }

  let [command, ...args] = argv;
  const possibleTarget = String(command).toLowerCase();
  const targetInvocation = RESERVED_COMMANDS.has(possibleTarget)
    ? null
    : parseTargetInvocation(config, command, args);
  if (targetInvocation) {
    if (targetInvocation.mode === "persistent") {
      runPersistentDesk(config, targetInvocation.targetName, targetInvocation.commandArgs);
    } else {
      runInteractive(config, targetInvocation.targetName, targetInvocation.commandArgs);
    }
    return;
  } else if (TARGET_HINTS.has(possibleTarget) && !config.workers[possibleTarget]) {
    fail(`Target '${possibleTarget}' is not configured. Run: hn worker pair ${possibleTarget} user@host`);
  }

  if (command === "use") {
    requireArgs(args, 1, "hn use <target>");
    selectTarget(config, args[0]);
    return;
  }

  if (command === "status") {
    printStatus(config, args[0]);
    return;
  }

  if (command === "access") {
    const local = args[0] ?? process.cwd();
    const result = explainWorkspaceAccess(config, local, args[1]);
    if (result.state === "outside") {
      const context = tryFindContext(config, process.cwd());
      console.log(`not shared  ${result.local}`);
      if (context) console.log(`add it       hn workspace add ${context.name} ${JSON.stringify(result.local)}`);
      return;
    }
    const privacy = result.root.scope === "trusted" ? "  trusted targets only" : "";
    if (result.state === "local-only") {
      console.log(`local only  ${result.local}`);
      console.log(`reason      ${result.reason}`);
      return;
    }
    console.log(`shared ✓    ${result.local}`);
    console.log(`remote      ~/${result.remote}${privacy}`);
    console.log(`workspace   ${result.workspaceName}  ${result.root.kind}`);
    return;
  }

  if (command === "profile") {
    const [sub, tool, workspaceInput] = args;
    if (sub === "enable" && tool === "claude") {
      const context = tryFindContext(config, process.cwd());
      const workspaceName = workspaceInput ?? context?.name;
      if (!workspaceName) fail("Usage: hn profile enable claude <workspace>");
      requireWorkspace(config, workspaceName);
      const roots = enableClaudeProfile(config, workspaceName);
      if (!roots.length) fail("No portable Claude profile directories were found on this machine.");
      console.log(`Claude profile enabled for trusted targets in workspace '${workspaceName}':`);
      for (const root of roots) console.log(`  ${root.local} <-> ~/${root.remote}`);
      console.log("kept local: credentials, settings, MCP auth, plugins, history, sessions, caches");
      if (!resolveActiveTargetName(config)) {
        console.log("no target configured yet; run 'hn sync' once you add one");
        return;
      }
      syncWholeWorkspace(config, workspaceName, requireWorkspace(config, workspaceName));
      return;
    }
    if (sub === "disable" && tool === "claude") {
      const context = tryFindContext(config, process.cwd());
      const workspaceName = workspaceInput ?? context?.name;
      if (!workspaceName) fail("Usage: hn profile disable claude <workspace>");
      const roots = claudeProfileRoots(requireWorkspace(config, workspaceName));
      if (!roots.length) {
        console.log("No portable profiles enabled.");
        return;
      }
      // Turning sharing off must not trigger a first-time sync-backend install.
      const live = new Map(
        isSyncBackendInstalled() ? listSyncSessions().map((record) => [record.name, record]) : [],
      );
      for (const root of roots) {
        for (const [targetName, worker] of Object.entries(config.workers)) {
          const record = live.get(syncSessionName(workspaceName, targetName, worker, root));
          if (record) stopSyncSession(record.identifier);
        }
        removeWorkspaceRoot(config, workspaceName, root.local);
        console.log(`removed ${root.local}`);
      }
      console.log("copies already on a worker stay there until you delete them on that machine");
      return;
    }
    if (sub === "list" || sub === "status") {
      const context = tryFindContext(config, process.cwd());
      const workspaceName = tool ?? context?.name;
      if (!workspaceName) fail("Usage: hn profile list <workspace>");
      const roots = claudeProfileRoots(requireWorkspace(config, workspaceName));
      if (!roots.length) console.log("No portable profiles enabled.");
      for (const root of roots) console.log(`claude  ${root.local} <-> ~/${root.remote}  trusted-only`);
      return;
    }
    fail("Usage: hn profile <enable claude [workspace]|disable claude [workspace]|list [workspace]>");
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
      prepareTarget(config, name, { quiet: false, persistence: true });
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
      requireArgs(rest, 2, "hn workspace add <workspace> <local-file-or-directory> [remote-path]");
      const root = addWorkspaceRoot(config, rest[0], rest[1], rest[2]);
      console.log(`${root.kind}  ${root.local} <-> ${root.remote}`);
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
        for (const root of workspace.roots ?? []) {
          const flags = [root.kind, root.scope === "trusted" ? "trusted-only" : null, root.purpose]
            .filter(Boolean)
            .join(", ");
          console.log(`  ${root.local} <-> ${root.remote}${flags ? `  [${flags}]` : ""}`);
        }
        if ((workspace.grants ?? []).length) console.log(`  remote grants: ${workspace.grants.join(", ")}`);
      }
      return;
    }
    fail("Usage: hn workspace <create|add|remove-root|remove|grant|revoke|list> ...");
  }

  if (command === "sync") {
    const [sub, ...rest] = args;
    if (sub === "list") {
      printRecords(listSyncSessions(), "No Handoff sync sessions.");
      return;
    }
    if (sub === "stop") {
      const context = tryFindContext(config, process.cwd());
      const workspaceName = rest[0]
        ? normalizeName(rest[0], "workspace name")
        : context?.name;
      if (!workspaceName) fail("Usage: hn sync stop <workspace>");
      stopWorkspaceSync(config, workspaceName);
      return;
    }
    if (sub) {
      const workspaceName = normalizeName(sub, "workspace name");
      syncWholeWorkspace(config, workspaceName, requireWorkspace(config, workspaceName));
    } else {
      const context = currentContext(config);
      syncWholeWorkspace(config, context.name, context.workspace);
    }
    return;
  }

  if (command === "sessions") {
    const target = targetFor(config);
    const worker = prepareTarget(config, target.name, { persistence: true });
    if (args[0] === "kill") {
      requireArgs(args.slice(1), 1, "hn sessions kill <session>");
      killSession(worker, args[1]);
      console.log(`killed ${args[1]}`);
      return;
    }
    if (args.length && args[0] !== "list") fail("Usage: hn sessions [list|kill <session>]");
    const result = listSessions(worker);
    process.stdout.write(result.stdout || "No Handoff sessions.\n");
    return;
  }

  if (command === "attach") {
    requireArgs(args, 1, "hn attach <session>");
    const target = targetFor(config);
    const worker = prepareTarget(config, target.name, { persistence: true });
    attachSession(worker, args[0]);
    return;
  }

  if (command === "port") {
    if (args[0] === "list") {
      printRecords(listForwards(), "No Handoff port forwards.");
      return;
    }
    if (args[0] === "stop") {
      requireArgs(args.slice(1), 1, "hn port stop <forward-name-or-id>");
      const stopped = stopForward(args[1]);
      console.log(`stopped ${stopped.name}`);
      return;
    }
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
    runRemoteCommand(worker, remoteCwd, augmentAgentCommand(args, targetWorkspace(context), remoteCwd));
    return;
  }

  if (command === "shell") {
    const context = currentContext(config);
    runInteractive(config, context.targetName);
    return;
  }

  if (command === "session") {
    const unique = args[0] === "new";
    const sessionArgs = unique ? args.slice(1) : args;
    const context = currentContext(config);
    const worker = prepareTarget(config, context.targetName, { persistence: true });
    runPersistent(
      config,
      sessionArgs.length ? sessionArgs : shellCommand(worker),
      { unique, preparedWorker: worker },
    );
    return;
  }

  if (command === "new") {
    requireArgs(args, 1, "hn new <command...>");
    runPersistent(config, args, { unique: true });
    return;
  }

  const context = currentContext(config);
  runInteractive(config, context.targetName, [command, ...args]);
}

main().catch((error) => {
  console.error(`hn: ${error.message}`);
  process.exit(1);
});
