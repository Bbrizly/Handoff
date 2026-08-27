import { existsSync } from "node:fs";
import { defaultRemoteRoot, isInside, normalizeLocalPath } from "./resolve.js";
import { requireWorker, updateConfig } from "./config.js";
import { fail, normalizeName } from "./util.js";

export function normalizeRemotePath(input) {
  let value = String(input ?? "").trim().replaceAll("\\", "/");
  if (value.startsWith("~/")) value = value.slice(2);
  value = value.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  if (!value) fail("Remote path cannot be empty.");
  const segments = value.split("/").filter(Boolean);
  if (segments.includes("..")) fail("Remote paths cannot contain '..'.");
  return value;
}

export function remotePathsOverlap(first, second) {
  const a = normalizeRemotePath(first).toLowerCase();
  const b = normalizeRemotePath(second).toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function workerEndpointsEqual(first, second) {
  if (!first || !second) return false;
  return (first.user ?? "") === (second.user ?? "")
    && String(first.host ?? "").toLowerCase() === String(second.host ?? "").toLowerCase()
    && (first.port ?? 22) === (second.port ?? 22);
}

export function validateWorkerAssignment(config, nameInput, worker) {
  const name = normalizeName(nameInput, "target name");
  const existing = config.workers[name];
  if (existing && !workerEndpointsEqual(existing, worker)) {
    fail(`Target '${name}' already points to ${existing.target ?? existing.host}. Use a different target name instead of replacing a live target.`);
  }

  for (const [otherName, other] of Object.entries(config.workers)) {
    if (otherName !== name && workerEndpointsEqual(other, worker)) {
      fail(`Target '${otherName}' already points to this SSH endpoint. One machine should have one target name.`);
    }
  }
  return name;
}

export function addWorker(config, nameInput, worker) {
  let name;
  updateConfig(config, (latest) => {
    name = validateWorkerAssignment(latest, nameInput, worker);
    latest.workers[name] = worker;
    if (!latest.activeTarget) latest.activeTarget = name;
  });
  return name;
}

export function setWorkerTrust(config, nameInput, trustInput) {
  const name = normalizeName(nameInput, "target name");
  const trust = String(trustInput ?? "").trim().toLowerCase();
  if (!new Set(["trusted", "remote"]).has(trust)) fail("Target trust must be 'trusted' or 'remote'.");
  updateConfig(config, (latest) => {
    const worker = requireWorker(latest, name);
    worker.trust = trust;
  });
  return trust;
}

export function removeWorker(config, nameInput) {
  const name = normalizeName(nameInput, "target name");
  updateConfig(config, (latest) => {
    requireWorker(latest, name);
    delete latest.workers[name];
    for (const workspace of Object.values(latest.workspaces)) {
      workspace.grants = (workspace.grants ?? []).filter((target) => target !== name);
    }
    if (latest.activeTarget === name) latest.activeTarget = Object.keys(latest.workers)[0] ?? null;
  });
  return name;
}

export function createWorkspace(config, nameInput) {
  const name = normalizeName(nameInput, "workspace name");
  updateConfig(config, (latest) => {
    if (latest.workspaces[name]) fail(`Workspace '${name}' already exists.`);
    latest.workspaces[name] = { roots: [], grants: [] };
  });
  return name;
}

function validateRootAgainstConfig(config, workspaceName, local, remote, existingLocal = null) {
  for (const [otherWorkspaceName, otherWorkspace] of Object.entries(config.workspaces)) {
    for (const root of otherWorkspace.roots ?? []) {
      const otherLocal = normalizeLocalPath(root.local);
      if (otherWorkspaceName === workspaceName && existingLocal && otherLocal === existingLocal) continue;
      if (isInside(otherLocal, local) || isInside(local, otherLocal)) {
        fail(`Workspace roots cannot overlap: ${local} and ${otherLocal}`);
      }
      if (remotePathsOverlap(root.remote, remote)) {
        fail(`Remote workspace roots cannot overlap: ${remote} and ${root.remote}`);
      }
    }
  }
}

export function addWorkspaceRoot(config, workspaceNameInput, localInput, remoteInput) {
  const workspaceName = normalizeName(workspaceNameInput, "workspace name");
  const local = normalizeLocalPath(localInput);
  if (!existsSync(local)) fail(`Local path does not exist: ${local}`);
  const remote = normalizeRemotePath(remoteInput || defaultRemoteRoot(workspaceName, local));

  updateConfig(config, (latest) => {
    if (!latest.workspaces[workspaceName]) latest.workspaces[workspaceName] = { roots: [], grants: [] };
    const workspace = latest.workspaces[workspaceName];
    const existing = workspace.roots.find((root) => normalizeLocalPath(root.local) === local);
    validateRootAgainstConfig(latest, workspaceName, local, remote, existing ? local : null);
    if (existing) existing.remote = remote;
    else workspace.roots.push({ local, remote });
  });
  return { local, remote };
}

export function removeWorkspaceRoot(config, workspaceNameInput, localInput) {
  const workspaceName = normalizeName(workspaceNameInput, "workspace name");
  const local = normalizeLocalPath(localInput);
  updateConfig(config, (latest) => {
    const workspace = latest.workspaces[workspaceName];
    if (!workspace) fail(`Unknown workspace '${workspaceName}'.`);
    const before = workspace.roots.length;
    workspace.roots = workspace.roots.filter((root) => normalizeLocalPath(root.local) !== local);
    if (workspace.roots.length === before) fail(`Workspace '${workspaceName}' does not contain root ${local}.`);
  });
  return local;
}

export function removeWorkspace(config, workspaceNameInput) {
  const workspaceName = normalizeName(workspaceNameInput, "workspace name");
  updateConfig(config, (latest) => {
    if (!latest.workspaces[workspaceName]) fail(`Unknown workspace '${workspaceName}'.`);
    delete latest.workspaces[workspaceName];
  });
  return workspaceName;
}

export function grantWorkspaceTarget(config, workspaceNameInput, targetNameInput) {
  const workspaceName = normalizeName(workspaceNameInput, "workspace name");
  const targetName = normalizeName(targetNameInput, "target name");
  updateConfig(config, (latest) => {
    requireWorker(latest, targetName);
    const workspace = latest.workspaces[workspaceName];
    if (!workspace) fail(`Unknown workspace '${workspaceName}'.`);
    workspace.grants = [...new Set([...(workspace.grants ?? []), targetName])];
  });
  return { workspaceName, targetName };
}

export function revokeWorkspaceTarget(config, workspaceNameInput, targetNameInput) {
  const workspaceName = normalizeName(workspaceNameInput, "workspace name");
  const targetName = normalizeName(targetNameInput, "target name");
  updateConfig(config, (latest) => {
    const workspace = latest.workspaces[workspaceName];
    if (!workspace) fail(`Unknown workspace '${workspaceName}'.`);
    workspace.grants = (workspace.grants ?? []).filter((name) => name !== targetName);
  });
  return { workspaceName, targetName };
}

export function workspaceAllowsTarget(workspace, targetName, worker) {
  if ((worker.trust ?? "trusted") === "trusted") return true;
  return (workspace.grants ?? []).includes(targetName);
}
