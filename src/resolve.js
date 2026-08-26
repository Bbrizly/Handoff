import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { expandHome, fail } from "./util.js";

export function normalizeLocalPath(path) {
  return resolve(expandHome(path));
}

export function defaultRemoteRoot(workspaceName, localPath) {
  return `handoff/${workspaceName}/${basename(localPath)}`.replaceAll("\\", "/");
}

export function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function findContext(config, cwd = process.cwd(), workspaceName) {
  const current = normalizeLocalPath(cwd);
  const entries = workspaceName
    ? [[workspaceName, config.workspaces[workspaceName]]]
    : Object.entries(config.workspaces);

  const matches = [];
  for (const [name, workspace] of entries) {
    if (!workspace) continue;
    for (const root of workspace.roots ?? []) {
      const local = normalizeLocalPath(root.local);
      if (isInside(local, current)) {
        matches.push({ name, workspace, root: { ...root, local }, depth: local.length });
      }
    }
  }

  matches.sort((a, b) => b.depth - a.depth);
  if (!matches.length) fail("Current directory is not inside a configured workspace root.");
  return matches[0];
}

export function mapLocalToRemote(root, localPath) {
  const current = normalizeLocalPath(localPath);
  const rel = relative(normalizeLocalPath(root.local), current)
    .split(sep)
    .filter(Boolean)
    .join("/");
  return rel ? `${root.remote.replace(/\/$/, "")}/${rel}` : root.remote;
}
