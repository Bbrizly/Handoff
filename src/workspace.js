import { existsSync } from "node:fs";
import { defaultRemoteRoot, normalizeLocalPath } from "./resolve.js";
import { requireWorker, saveConfig } from "./config.js";
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

export function addWorker(config, nameInput, worker) {
  const name = normalizeName(nameInput, "target name");
  config.workers[name] = worker;
  if (!config.activeTarget) config.activeTarget = name;
  saveConfig(config);
  return name;
}

export function createWorkspace(config, nameInput, defaultWorker = null) {
  const name = normalizeName(nameInput, "workspace name");
  if (config.workspaces[name]) fail(`Workspace '${name}' already exists.`);
  if (defaultWorker) requireWorker(config, defaultWorker);
  config.workspaces[name] = defaultWorker ? { defaultWorker, roots: [] } : { roots: [] };
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
  if (existing) {
    existing.remote = remote;
  } else {
    workspace.roots.push({ local, remote });
  }
  saveConfig(config);
  return { local, remote };
}
