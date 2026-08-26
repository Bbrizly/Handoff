import { existsSync } from "node:fs";
import { defaultRemoteRoot, normalizeLocalPath } from "./resolve.js";
import { requireWorker, requireWorkspace, saveConfig } from "./config.js";
import { ensureRemoteDirectory } from "./worker.js";
import { fail } from "./util.js";

export function addWorker(config, name, worker) {
  config.workers[name] = worker;
  saveConfig(config);
}

export function createWorkspace(config, name, workerName) {
  requireWorker(config, workerName);
  if (config.workspaces[name]) fail(`Workspace '${name}' already exists.`);
  config.workspaces[name] = { worker: workerName, roots: [] };
  saveConfig(config);
}

export function addWorkspaceRoot(config, workspaceName, localInput, remoteInput) {
  const workspace = requireWorkspace(config, workspaceName);
  const worker = requireWorker(config, workspace.worker);
  const local = normalizeLocalPath(localInput);
  if (!existsSync(local)) fail(`Local path does not exist: ${local}`);

  const remote = (remoteInput || defaultRemoteRoot(workspaceName, local)).replaceAll("\\", "/");
  const existing = workspace.roots.find((root) => normalizeLocalPath(root.local) === local);
  if (existing) {
    existing.remote = remote;
  } else {
    workspace.roots.push({ local, remote });
  }
  saveConfig(config);
  ensureRemoteDirectory(worker, remote);
  return { local, remote };
}
