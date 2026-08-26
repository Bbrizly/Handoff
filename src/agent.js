import { posix } from "node:path";

function normalizeRemote(value) {
  return String(value).replaceAll("\\", "/").replace(/\/$/, "");
}

export function additionalWorkspaceDirs(workspace, remoteCwd) {
  const cwd = normalizeRemote(remoteCwd);
  const dirs = [];
  for (const root of workspace.roots ?? []) {
    const relative = posix.relative(cwd, normalizeRemote(root.remote)) || ".";
    if (relative !== "." && !dirs.includes(relative)) dirs.push(relative);
  }
  return dirs;
}

export function augmentAgentCommand(commandArgs, workspace, remoteCwd) {
  if (!commandArgs.length) return commandArgs;
  const [command, ...rest] = commandArgs;
  const executable = String(command).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
  const dirs = additionalWorkspaceDirs(workspace, remoteCwd);
  if (!dirs.length) return [...commandArgs];

  if (executable === "claude") {
    return [command, "--add-dir", ...dirs, ...rest];
  }
  if (executable === "codex") {
    return [command, ...dirs.flatMap((dir) => ["--add-dir", dir]), ...rest];
  }
  return [...commandArgs];
}
