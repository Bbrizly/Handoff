import { posix } from "node:path";

const CLAUDE_MANAGEMENT_COMMANDS = new Set([
  "update", "install", "auth", "agents", "attach", "auto-mode", "logs", "mcp",
  "plugin", "plugins", "project",
]);

const CODEX_MANAGEMENT_COMMANDS = new Set([
  "agents", "login", "logout", "mcp", "plugin", "mcp-server", "app-server",
  "remote-control", "app", "completion", "update", "doctor", "sandbox", "debug",
  "execpolicy", "apply", "queue", "archive", "delete", "migrate-rollouts", "unarchive",
]);

function normalizeRemote(value) {
  return String(value).replaceAll("\\", "/").replace(/\/$/, "");
}

function executableName(command) {
  return String(command).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
}

export function isClaudeWorkCommand(commandArgs = []) {
  if (executableName(commandArgs[0]) !== "claude") return false;
  return !CLAUDE_MANAGEMENT_COMMANDS.has(String(commandArgs[1] ?? "").toLowerCase());
}

function insertBeforeSeparator(args, additions) {
  const separator = args.indexOf("--");
  if (separator === -1) return [...args, ...additions];
  return [...args.slice(0, separator), ...additions, ...args.slice(separator)];
}

export function additionalWorkspaceDirs(workspace, remoteCwd) {
  const cwd = normalizeRemote(remoteCwd);
  const dirs = [];
  for (const root of workspace.roots ?? []) {
    if (root.purpose === "claude-profile") continue;
    const remote = root.kind === "file" ? posix.dirname(normalizeRemote(root.remote)) : normalizeRemote(root.remote);
    const relative = posix.relative(cwd, remote) || ".";
    if (relative !== "." && !dirs.includes(relative)) dirs.push(relative);
  }
  return dirs;
}

export function augmentAgentCommand(commandArgs, workspace, remoteCwd, options = {}) {
  if (!commandArgs.length) return commandArgs;
  const [command, ...rest] = commandArgs;
  const executable = executableName(command);
  const dirs = additionalWorkspaceDirs(workspace, remoteCwd);

  if (executable === "claude") {
    if (CLAUDE_MANAGEMENT_COMMANDS.has(String(rest[0] ?? "").toLowerCase())) {
      return [...commandArgs];
    }

    // Claude's --add-dir is variadic. It must come after positional prompts (or
    // immediately before an explicit -- separator), otherwise a startup prompt
    // can be consumed as another directory.
    const settings = options.claudeSettings && !rest.includes("--settings")
      ? ["--settings", options.claudeSettings]
      : [];
    const directories = dirs.length ? ["--add-dir", ...dirs] : [];
    return [command, ...insertBeforeSeparator(rest, [...settings, ...directories])];
  }

  if (executable === "codex") {
    if (CODEX_MANAGEMENT_COMMANDS.has(String(rest[0] ?? "").toLowerCase())) {
      return [...commandArgs];
    }

    const addDirArgs = dirs.flatMap((dir) => ["--add-dir", dir]);
    if (["exec", "e"].includes(String(rest[0] ?? "").toLowerCase())) {
      const execArgs = rest.slice(1);
      const hasSkipGit = execArgs.includes("--skip-git-repo-check");
      return [
        command,
        ...addDirArgs,
        rest[0],
        ...(hasSkipGit ? [] : ["--skip-git-repo-check"]),
        ...execArgs,
      ];
    }
    return [command, ...addDirArgs, ...rest];
  }

  return [...commandArgs];
}
