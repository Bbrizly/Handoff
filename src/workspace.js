import { existsSync } from "node:fs";
import { defaultRemoteRoot, isInside, normalizeLocalPath } from "./resolve.js";
import { saveConfig } from "./config.js";
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
  const name = validateWorkerAssignment(config, nameInput, worker);
  config.workers[name] = worker;
  if (!config.activeTarget) config.activeTarget = name;
  saveConfig(config);
  return name;
}

export function createWorkspace(config, nameInput) {
  const name = normalizeName(nameInput, "workspace name");
  if (config.workspaces[name]) fail(`Workspace '${name}' already exists.`);
  config.workspaces[name] = { roots: [] };
  saveConfig(config);
  return name;
}

export function addWorkspaceRoot(config, workspaceNameInput, localInput, remoteInput) {
  const workspaceName = normalizeName(workspaceNameInput, "workspace name");
  if (!config.workspaces[workspaceName]) config.workspaces[workspaceName] = { roots: [] };
  const workspace = config.workspaces[workspaceName];
  const local = normalizeLocalPath(localInput);
  if (!existsSync(local)) fail(`Local path does not exist: ${local}`);

  const remote = normalizeRemotePath(remoteInput || defaultRemoteRoot(workspaceName, local));
  const existing = workspace.roots.find((root) => normalizeLocalPath(root.local) === local);

  for (const [otherWorkspaceName, otherWorkspace] of Object.entries(config.workspaces)) {
    for (const root of otherWorkspace.roots ?? []) {
      if (otherWorkspaceName === workspaceName && root === existing) continue;
      const otherLocal = normalizeLocalPath(root.local);
      if (isInside(otherLocal, local) || isInside(local, otherLocal)) {
        fail(`Workspace roots cannot overlap: ${local} and ${otherLocal}`);
      }
      if (remotePathsOverlap(root.remote, remote)) {
        fail(`Remote workspace roots cannot overlap: ${remote} and ${root.remote}`);
      }
    }
  }

  if (existing) {
    existing.remote = remote;
  } else {
    workspace.roots.push({ local, remote });
  }
  saveConfig(config);
  return { local, remote };
}
