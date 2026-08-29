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
import { additionalWorkspaceDirs, augmentAgentCommand, isClaudeWorkCommand } from "./agent.js";
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
  assertHealthySync,
  ensureForward,
  ensureSyncRoot,
  flushSyncSessions,
  getSyncStatus,
  getSyncProblems,
  isSyncBackendInstalled,
  listForwards,
  listSyncSessions,
  stopForward,
  stopSyncSession,
  syncSessionName,
} from "./sync.js";
import { findContext, mapLocalToRemote, normalizeLocalPath, tryFindContext } from "./resolve.js";
import {
  HERDR_VERSION,
  attachHerdr,
  ensureHerdrInstalled,
  ensureHerdrProject,
  ensureHerdrServer,
  herdrRuntimeName,
  herdrVersion,
  probeHerdrDesk,
  runInHerdrProject,
} from "./herdr.js";
import {
  attachSession,
  ensurePersistentCommand,
  killSession,
  listSessions,
  newSessionToken,
  sessionNameFor,
  shellCommand,
} from "./session.js";
import { runInteractiveRemoteCommand, runRemoteCommand, sshTransportFailed } from "./remote.js";
import {
  claudeProfileLinks,
  claudeProfileRoots,
  claudeProfileProjectionFingerprint,
  enableClaudeProfile,
  ensureClaudeProfileProjection,
} from "./profile.js";
import { fail, normalizeName } from "./util.js";
import { syncPolicyFingerprint } from "./sync-policy.js";
import { terminateRootSyncSessions } from "./lifecycle.js";
import {
  HANDOFF_STATUSLINE_VERSION,
  ensureHandoffStatusline,
  handoffClaudeSettingsArgument,
  managedAssetGuardScript,
  managedAssetsNeedRepair,
  managedExpectation,
} from "./statusline.js";

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
    || previous.handoffStatuslineVersion !== worker.handoffStatuslineVersion
    || previous.claudeProfileProjection !== worker.claudeProfileProjection
    || previous.profileSyncPolicyFingerprint !== worker.profileSyncPolicyFingerprint
    || previous.herdrVersion !== worker.herdrVersion
  ) {
    updateConfig(config, (latest) => {
      const current = requireWorker(latest, name);
      latest.workers[name] = { ...current, ...worker };
    });
  }
  return config.workers[name] ?? worker;
}

function prepareClaudeExperience(config, targetName, worker, { force = false } = {}) {
  const prepared = ensureHandoffStatusline(worker, { force });
  return persistWorkerMetadata(config, targetName, prepared);
}

// The cached versions make the normal launch fast by assuming the worker still
// looks the way it did. When a launch reports otherwise, put the managed files
// back and let the caller try again once.
function repairManagedAssets(config, context, roots) {
  console.log("worker is missing Handoff's managed Claude files; restoring...");
  const worker = prepareClaudeExperience(config, context.targetName, context.worker, { force: true });
  return ensureProfileProjection(config, context.targetName, worker, roots, { force: true });
}

function ensureProfileProjection(config, targetName, worker, roots, { force = false } = {}) {
  const fingerprint = claudeProfileProjectionFingerprint(roots);
  if (!force && worker.claudeProfileProjection === fingerprint) return worker;
  ensureClaudeProfileProjection(worker, roots);
  return persistWorkerMetadata(config, targetName, { ...worker, claudeProfileProjection: fingerprint });
}

function refreshProfileSyncPolicy(config, context, roots, records) {
  const profileRoots = roots.filter((root) => root.purpose === "claude-profile");
  if (!profileRoots.length) return { worker: context.worker, records };
  const fingerprint = syncPolicyFingerprint(profileRoots, context.worker);
  if (context.worker.profileSyncPolicyFingerprint === fingerprint) {
    return { worker: context.worker, records };
  }

  const staleNames = new Set(profileRoots.map((root) =>
    syncSessionName(context.name, context.targetName, context.worker, root)));
  for (const record of records) {
    if (staleNames.has(record.name)) stopSyncSession(record.identifier);
  }
  const worker = persistWorkerMetadata(config, context.targetName, {
    ...context.worker,
    profileSyncPolicyFingerprint: fingerprint,
  });
  return {
    worker,
    records: records.filter((record) => !staleNames.has(record.name)),
  };
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

function ensureWorkspaceSync(config, context) {
  requireWorkspacePermission(context);
  const workspace = targetWorkspace(context);
  let knownRecords = isSyncBackendInstalled() ? listSyncSessions() : [];
  ({ worker: context.worker, records: knownRecords } = refreshProfileSyncPolicy(
    config,
    context,
    workspace.roots,
    knownRecords,
  ));
  const knownNames = new Set(knownRecords.map((record) => record.name));
  const missingRoots = workspace.roots.filter((root) => !knownNames.has(
    syncSessionName(context.name, context.targetName, context.worker, root),
  ));
  ensureRemoteDirectories(context.worker, missingRoots.map(remoteRootDirectory));
  const sessions = workspace.roots.map((root) =>
    ensureSyncRoot(context.name, context.targetName, context.worker, root, { knownRecords }),
  );
  if (sessions.some((session) => session.created)) {
    console.log(`syncing ${context.name} -> ${context.targetName}...`);
  }
  flushSyncSessions(sessions.map((session) => session.name));
  context.worker = ensureProfileProjection(
    config,
    context.targetName,
    context.worker,
    workspace.roots,
    { force: sessions.some((session) => session.created) },
  );
}

function syncStatusText(status) {
  if (status.conflicts > 0) return `⚠ ${status.conflicts} conflict${status.conflicts === 1 ? "" : "s"}`;
  if (status.state === "mutagen-missing" || status.state === "not-started") return "—";
  if (status.state.includes("watching")) return "✓";
  if (["scanning", "staging", "reconciling", "saving"].some((value) => status.state.includes(value))) return "…";
  if (status.state.includes("disconnected") || status.state.includes("halted") || status.state === "error") return "✗";
  return status.state || "?";
}

function syncRootLabel(root) {
  return root.purpose === "claude-profile" ? `~/${root.remote}` : basename(root.local);
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
    console.log(`sync       ${syncStatusText(status)}  ${syncRootLabel(root)}`);
    if (status.error) console.log(`           ${status.error}`);
    if (status.advice) console.log(`           ${status.advice}`);
  }
}

function workerChecks(worker) {
  const checks = doctorWorker(worker);
  checks.persistence = checks.ssh && herdrVersion(worker).includes(HERDR_VERSION);
  return checks;
}

function healthyStatus(status) {
  return status.conflicts === 0 && status.problemCount === 0 && status.state.includes("watching");
}

function checkLine(state, label, detail = "") {
  const symbol = state === true ? "✓" : state === false ? "✗" : "—";
  return `  ${symbol} ${label}${detail ? `  ${detail}` : ""}`;
}

function printWorkerChecks(config, name, checks, worker) {
  const trust = worker.trust ?? "trusted";
  console.log(`${name}  ${checks.platform}/${checks.arch}  ${trust}`);
  const context = tryFindContext(config, process.cwd());
  const workspace = context?.workspace ?? null;
  const roots = workspace ? workspaceRootsForTarget(workspace, worker) : [];
  const rootStatuses = roots.map((root) => ({
    root,
    status: getSyncStatus(syncSessionName(context.name, name, worker, root)),
  }));
  const profile = rootStatuses.filter(({ root }) => root.purpose === "claude-profile");
  const workspaceAllowed = workspace && workspaceAllowsTarget(workspace, name, worker);
  const syncHealthy = rootStatuses.length > 0 && rootStatuses.every(({ status }) => healthyStatus(status));
  const profileHealthy = profile.length > 0 && profile.every(({ status }) => healthyStatus(status));
  const projectionCurrent = workspace
    ? worker.claudeProfileProjection === claudeProfileProjectionFingerprint(roots)
    : false;

  console.log("\ncore");
  console.log(checkLine(checks.ssh, "ssh"));
  console.log(checkLine(
    workspaceAllowed ? true : workspace ? false : null,
    "workspace",
    workspace ? `${context.name} (${roots.length} roots)` : "run inside a configured workspace",
  ));
  console.log(checkLine(syncHealthy ? true : rootStatuses.length ? false : null, "sync"));
  console.log(checkLine(isSyncBackendInstalled(), "sync engine", "controller"));
  console.log(checkLine(checks.persistence ? true : null, "persistence", checks.persistence
    ? `Herdr ${HERDR_VERSION}`
    : "installs on first -p"));

  console.log("\nai");
  console.log(checkLine(checks.claude, "claude"));
  console.log(checkLine(checks.claude ? checks.claudeAuth : false, "claude auth", "plausibility check"));
  console.log(checkLine(checks.codex, "codex"));
  console.log(checkLine(checks.node, "node"));
  // Synchronized is all this proves. Whether a given skill or agent file is
  // valid is the agent's own check, not Handoff's.
  console.log(checkLine(profile.length ? profileHealthy && projectionCurrent : null, "profile", profile.length
    ? `${profile.length} roots synchronized${projectionCurrent ? "" : "; projection refresh needed"}`
    : "not enabled"));
  const statuslineActive = checks.statusline
    && worker.handoffStatuslineVersion === HANDOFF_STATUSLINE_VERSION;
  console.log(checkLine(statuslineActive, "statusline", "Handoff launches only"));

  console.log("\noptional");
  console.log(checkLine(checks.chrome ? true : null, "chrome", checks.chrome ? "installed" : "not found"));
  console.log(checkLine(null, "chrome extension", "worker-local; verify with claude --chrome"));
  const mcp = checks.mcp ?? { available: false, reason: "not checked", servers: [] };
  const failed = mcp.servers.filter((server) => !server.ok);
  if (!mcp.available) {
    console.log(checkLine(null, "mcp", mcp.reason));
  } else if (!mcp.servers.length) {
    console.log(checkLine(null, "mcp", "claude mcp list: none configured"));
  } else if (failed.length) {
    console.log(checkLine(false, "mcp", `claude mcp list: ${failed.length}/${mcp.servers.length} not connected: ${failed.map((server) => server.name).join(", ")}`));
  } else {
    console.log(checkLine(true, "mcp", `claude mcp list: ${mcp.servers.length}/${mcp.servers.length} connected`));
  }
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
  let worker = prepareTarget(config, target.name);
  const context = { name: workspaceName, workspace, targetName: target.name, worker };
  requireWorkspacePermission(context);
  const roots = workspaceRootsForTarget(workspace, worker);
  let knownRecords = isSyncBackendInstalled() ? listSyncSessions() : [];
  ({ worker, records: knownRecords } = refreshProfileSyncPolicy(config, context, roots, knownRecords));
  context.worker = worker;
  const knownNames = new Set(knownRecords.map((record) => record.name));
  const missingRoots = roots.filter((root) => !knownNames.has(
    syncSessionName(workspaceName, target.name, worker, root),
  ));
  ensureRemoteDirectories(worker, missingRoots.map(remoteRootDirectory));
  const sessions = roots.map((root) => ({
    root,
    session: ensureSyncRoot(workspaceName, target.name, worker, root, { knownRecords }),
  }));
  const statuses = sessions.map(({ root, session }) => ({
    root,
    session,
    status: getSyncStatus(session.name),
  }));
  const meaningful = statuses.filter(({ session, status }) => session.created || !healthyStatus(status));
  if (meaningful.length) {
    console.log(`${workspaceName} -> ${target.name}`);
    for (const { root, status } of meaningful) {
      console.log(`  ${syncRootLabel(root)}  ${syncStatusText(status)}`);
    }
  }
  for (const { root, session, status } of statuses) {
    try {
      // Do this before Mutagen's blocking flush. A denied root otherwise sits
      // on its retry interval with no actionable output.
      assertHealthySync(session.name, status);
    } catch (error) {
      fail(`${syncRootLabel(root)}: ${error.message}`);
    }
  }
  flushSyncSessions(sessions.map(({ session }) => session.name));
  ensureProfileProjection(config, target.name, worker, roots, {
    force: sessions.some(({ session }) => session.created),
  });
  console.log(`✓ ${workspaceName} synced`);
}

function printSyncDoctor(config, workspaceName) {
  const workspace = requireWorkspace(config, workspaceName);
  const target = targetFor(config);
  const worker = requireWorker(config, target.name);
  const roots = workspaceRootsForTarget(workspace, worker);
  let issues = 0;
  for (const root of roots) {
    const session = syncSessionName(workspaceName, target.name, worker, root);
    const status = getSyncStatus(session);
    const problems = status.problems ?? getSyncProblems(session);
    if (healthyStatus(status) && !problems.length) continue;
    issues += 1;
    console.log(`${syncRootLabel(root)}  ${syncStatusText(status)}`);
    if (status.error) console.log(`  error  ${status.error}`);
    for (const problem of problems) {
      console.log(`  ${problem.type}  ${problem.path || "(root)"}${problem.error ? ` — ${problem.error}` : ""}`);
    }
    if (status.advice) console.log(`  fix    ${status.advice}`);
  }
  if (!issues) console.log(`✓ ${workspaceName} sync healthy`);
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
  ensureWorkspaceSync(config, context);

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

// Persistent mode: one desk per controller + workspace on the target, one
// project per synchronized Git project. The runtime installs on first use.
function runPersistentDesk(config, targetName, commandArgs = []) {
  let context = findContext(config, process.cwd());
  let worker = prepareTarget(config, targetName);
  if (isClaudeWorkCommand(commandArgs)) worker = prepareClaudeExperience(config, targetName, worker);
  context = { ...context, targetName, worker };
  ensureWorkspaceSync(config, context);
  worker = context.worker;

  if (worker.herdrVersion !== HERDR_VERSION) {
    ensureHerdrInstalled(worker, { quiet: false });
    worker = persistWorkerMetadata(config, targetName, { ...worker, herdrVersion: HERDR_VERSION });
    context = { ...context, worker };
  }
  const runtime = herdrRuntimeName(config.controllerId, context.name);

  // The desk probe has to happen anyway, so it carries the managed-file check.
  const roots = targetWorkspace(context).roots;
  const probe = probeHerdrDesk(worker, runtime, managedGuard(context, roots));
  if (probe.repairNeeded) {
    worker = repairManagedAssets(config, context, roots);
    context = { ...context, worker };
  }
  // A cached herdrVersion is only a claim about the worker. The probe is the
  // fact, so a binary that went missing gets put back before the desk starts.
  if (!probe.installed) {
    ensureHerdrInstalled(worker, { quiet: false });
    worker = persistWorkerMetadata(config, targetName, { ...worker, herdrVersion: HERDR_VERSION });
    context = { ...context, worker };
  }
  if (!probe.running) ensureHerdrServer(worker, runtime);

  // Project-scoped, not cwd-scoped. An existing desk keeps the directory it has.
  const remoteRoot = mapLocalToRemote(context.root, context.projectLocal);
  const project = ensureHerdrProject(worker, runtime, {
    remoteRoot,
    name: basename(context.projectLocal),
  });
  if (project.created) {
    console.log(`desk ready. click a project or agent in the sidebar; 'hn ${targetName} -p' comes back here`);
  }
  if (commandArgs.length) {
    const remoteArgs = augmentAgentCommand(
      commandArgs,
      targetWorkspace(context),
      remoteRoot,
      { claudeSettings: handoffClaudeSettingsArgument() },
    );
    runInHerdrProject(worker, runtime, project.workspaceId, remoteArgs);
  }
  const attached = attachHerdr(worker, runtime);
  if (attached.desk === "detached") {
    console.log(`desk still running on ${targetName}. 'hn ${targetName} -p' comes back to it`);
  }
}

// Covers only what Handoff itself put on the worker. Sync owns the rest.
function managedExpectationFor(roots) {
  const profileRoots = roots.filter((root) => root.purpose === "claude-profile");
  return managedExpectation(profileRoots.length ? claudeProfileLinks(profileRoots) : []);
}

function managedGuard(context, roots) {
  return managedAssetGuardScript(context.worker, managedExpectationFor(roots));
}

function runInteractive(config, targetName, commandArgs = [], { preparedWorker = null } = {}) {
  let context = findContext(config, process.cwd());
  let worker = preparedWorker ?? prepareTarget(config, targetName);
  const managed = !commandArgs.length || isClaudeWorkCommand(commandArgs);
  if (managed) worker = prepareClaudeExperience(config, targetName, worker);
  context = { ...context, targetName, worker };
  ensureWorkspaceSync(config, context);
  worker = context.worker;

  const remoteCwd = mapLocalToRemote(context.root, process.cwd());
  const workspace = targetWorkspace(context);
  const remoteArgs = commandArgs.length
    ? augmentAgentCommand(commandArgs, workspace, remoteCwd, {
      claudeSettings: handoffClaudeSettingsArgument(),
    })
    : [];
  if (managed && managedAssetsNeedRepair(worker, managedExpectationFor(workspace.roots))) {
    worker = repairManagedAssets(config, context, workspace.roots);
  }
  const result = runInteractiveRemoteCommand(worker, remoteCwd, remoteArgs, {
    agentDirs: additionalWorkspaceDirs(workspace, remoteCwd),
    claudeSettings: handoffClaudeSettingsArgument(),
  });
  // The remote program's exit code is the user's answer, not a Handoff error.
  // Only a dead connection gets explained.
  if (result.code) {
    if (sshTransportFailed(worker, result.code)) {
      console.error(`lost the connection to ${targetName} (${worker.target}). the worker may be asleep or off the network`);
      console.error(`check it with: hn status ${targetName}`);
    }
    process.exitCode = result.code;
  }
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
      const stopped = terminateRootSyncSessions(config, workspaceName, roots);
      for (const root of roots) {
        removeWorkspaceRoot(config, workspaceName, root.local);
        console.log(`removed ${root.local}`);
      }
      if (stopped.length) console.log(`stopped and verified ${stopped.length} sync session${stopped.length === 1 ? "" : "s"}`);
      console.log("worker copies remain at their existing ~/.claude and ~/.agents paths; Handoff did not delete them");
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
    printWorkerChecks(config, name, workerChecks(saved), saved);
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
      const bootstrapped = prepareTarget(config, name, { quiet: false });
      ensureHerdrInstalled(bootstrapped, { quiet: false });
      persistWorkerMetadata(config, name, { ...bootstrapped, herdrVersion: HERDR_VERSION });
      console.log(`persistence ✓  Herdr ${HERDR_VERSION}`);
      return;
    }
    if (sub === "doctor") {
      requireArgs(rest, 1, "hn worker doctor <name>");
      const name = normalizeName(rest[0], "target name");
      const worker = requireWorker(config, name);
      if (worker.pending) fail(`Target '${name}' is not paired yet. Run: hn worker finish ${name}`);
      const metadata = worker.platform && worker.arch ? worker : { ...worker, ...detectWorker(worker) };
      const saved = persistWorkerMetadata(config, name, metadata);
      printWorkerChecks(config, name, workerChecks(saved), saved);
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
      const workspaceName = normalizeName(rest[0], "workspace name");
      const workspace = requireWorkspace(config, workspaceName);
      const local = normalizeLocalPath(rest[1]);
      const root = workspace.roots.find((candidate) => normalizeLocalPath(candidate.local) === local);
      if (!root) fail(`Workspace '${workspaceName}' does not contain root ${local}.`);
      const stopped = terminateRootSyncSessions(config, workspaceName, [root]);
      console.log(`removed ${removeWorkspaceRoot(config, workspaceName, local)}`);
      if (stopped.length) console.log(`stopped and verified ${stopped.length} sync session${stopped.length === 1 ? "" : "s"}`);
      console.log(`worker files remain at ~/${root.remote}; Handoff did not delete them`);
      return;
    }
    if (sub === "remove") {
      requireArgs(rest, 1, "hn workspace remove <workspace>");
      const workspaceName = normalizeName(rest[0], "workspace name");
      const workspace = requireWorkspace(config, workspaceName);
      const stopped = terminateRootSyncSessions(config, workspaceName, workspace.roots ?? []);
      console.log(`removed ${removeWorkspace(config, workspaceName)}`);
      if (stopped.length) console.log(`stopped and verified ${stopped.length} sync session${stopped.length === 1 ? "" : "s"}`);
      console.log("worker files remain at the configured remote paths; Handoff did not delete them");
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
    if (sub === "doctor") {
      const context = tryFindContext(config, process.cwd());
      const workspaceName = rest[0]
        ? normalizeName(rest[0], "workspace name")
        : context?.name;
      if (!workspaceName) fail("Usage: hn sync doctor [workspace]");
      printSyncDoctor(config, workspaceName);
      return;
    }
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
    ensureWorkspaceSync(config, context);
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
