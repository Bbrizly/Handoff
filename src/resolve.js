import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { expandHome, fail } from "./util.js";

export function normalizeLocalPath(path) {
  return resolve(expandHome(path));
}

export function defaultRemoteRoot(workspaceName, localPath) {
  return `hn/${workspaceName}/${basename(localPath)}`.replaceAll("\\", "/");
}

export function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function findProjectRoot(workspaceRoot, cwd) {
  const boundary = normalizeLocalPath(workspaceRoot);
  let current = normalizeLocalPath(cwd);
  if (!isInside(boundary, current)) return current;

  while (isInside(boundary, current)) {
    if (existsSync(join(current, ".git"))) return current;
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return normalizeLocalPath(cwd);
}

export function tryFindContext(config, cwd = process.cwd(), workspaceName) {
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
        matches.push({
          name,
          workspace,
          root: { ...root, local },
          projectLocal: findProjectRoot(local, current),
          depth: local.length,
        });
      }
    }
  }

  matches.sort((a, b) => b.depth - a.depth);
  return matches[0] ?? null;
}

export function findContext(config, cwd = process.cwd(), workspaceName) {
  const context = tryFindContext(config, cwd, workspaceName);
  if (!context) fail("Current directory is not inside a configured workspace root.");
  return context;
}

export function mapLocalToRemote(root, localPath) {
  const current = normalizeLocalPath(localPath);
  const rel = relative(normalizeLocalPath(root.local), current)
    .split(sep)
    .filter(Boolean)
    .join("/");
  return rel ? `${root.remote.replace(/\/$/, "")}/${rel}` : root.remote;
}
