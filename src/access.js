import { basename, relative, sep } from "node:path";
import { isInside, mapLocalToRemote, normalizeLocalPath } from "./resolve.js";

const GENERATED_NAMES = new Set([
  "node_modules", "dist", "build", "bin", "obj", ".next", ".nuxt", ".output",
  ".turbo", "target", ".gradle", "DerivedData", ".venv", "venv", ".tox",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__",
]);

function defaultLocalOnlyReason(root, local) {
  const rel = relative(root.local, local);
  const parts = rel.split(sep).filter(Boolean);
  if (parts.includes(".git")) return ".git stays local";
  if (parts.includes(".claude") && parts.includes("worktrees")) return "generated Claude worktrees stay local";
  if (root.policy !== "agent-profile") {
    const generated = parts.find((part) => GENERATED_NAMES.has(part));
    if (generated) return `${generated} is generated output`;
  }
  const name = basename(local);
  if (name === ".env" || (name.startsWith(".env.") && ![".env.example", ".env.sample"].includes(name))) {
    return "environment secrets stay local";
  }
  if (name.endsWith(".pyc") || name === ".DS_Store") return `${name} is generated metadata`;
  return null;
}

export function explainWorkspaceAccess(config, pathInput, workspaceName) {
  const local = normalizeLocalPath(pathInput);
  const entries = workspaceName
    ? [[workspaceName, config.workspaces?.[workspaceName]]]
    : Object.entries(config.workspaces ?? {});
  const matches = [];

  for (const [name, workspace] of entries) {
    for (const root of workspace?.roots ?? []) {
      const exactFile = root.kind === "file" && normalizeLocalPath(root.local) === local;
      const insideDirectory = root.kind !== "file" && isInside(normalizeLocalPath(root.local), local);
      if (!exactFile && !insideDirectory) continue;
      matches.push({ name, workspace, root, exactFile, depth: root.local.length });
    }
  }

  matches.sort((a, b) => b.depth - a.depth);
  const match = matches[0];
  if (!match) return { state: "outside", local };

  const remote = match.exactFile ? match.root.remote : mapLocalToRemote(match.root, local);
  const reason = defaultLocalOnlyReason(match.root, local);
  return {
    state: reason ? "local-only" : "shared",
    local,
    remote,
    reason,
    workspaceName: match.name,
    root: match.root,
  };
}
