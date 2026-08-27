import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { runPosix, runPowerShell } from "./ssh.js";
import { quotePosix, quotePowerShell } from "./util.js";
import { addWorkspaceRoot } from "./workspace.js";

const CLAUDE_PORTABLE_PATHS = [
  [".agents/skills", ".agents/skills", "directory"],
  [".claude/skills", ".claude/skills", "directory"],
  [".claude/agents", ".claude/agents", "directory"],
  [".claude/commands", ".claude/commands", "directory"],
  [".claude/rules", ".claude/rules", "directory"],
  [".claude/hooks", ".claude/hooks", "directory"],
  [".claude/output-styles", ".claude/output-styles", "directory"],
  [".claude/CLAUDE.md", ".claude/CLAUDE.md", "file"],
];

export function claudeProfileCandidates(home = homedir(), pathExists = existsSync) {
  return CLAUDE_PORTABLE_PATHS
    .map(([localRelative, remote, kind]) => ({
      local: join(home, ...localRelative.split("/")),
      remote,
      kind,
      purpose: "claude-profile",
      policy: "agent-profile",
      scope: "trusted",
    }))
    .filter((root) => pathExists(root.local));
}

export function enableClaudeProfile(config, workspaceName, options = {}) {
  const candidates = claudeProfileCandidates(options.home, options.pathExists);
  return candidates.map((root) => addWorkspaceRoot(
    config,
    workspaceName,
    root.local,
    root.remote,
    {
      purpose: root.purpose,
      policy: root.policy,
      scope: root.scope,
    },
  ));
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function claudeProfileLinks(roots) {
  const agentRoot = roots.find((root) => root.remote === ".agents/skills");
  const claudeRoot = roots.find((root) => root.remote === ".claude/skills");
  if (!agentRoot || !claudeRoot) return [];

  const links = [];
  let entries = [];
  try {
    entries = readdirSync(claudeRoot.local, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    const localLink = join(claudeRoot.local, entry.name);
    let target;
    try {
      if (!lstatSync(localLink).isSymbolicLink()) continue;
      target = resolve(dirname(localLink), readlinkSync(localLink));
      if (!isInside(agentRoot.local, target) || !statSync(target).isDirectory()) continue;
    } catch {
      continue;
    }
    const targetRelative = relative(agentRoot.local, target).split(sep).join("/");
    links.push({
      name: entry.name,
      link: `${claudeRoot.remote}/${entry.name}`,
      target: targetRelative ? `${agentRoot.remote}/${targetRelative}` : agentRoot.remote,
    });
  }
  return links.sort((a, b) => a.name.localeCompare(b.name));
}

export function ensureClaudeProfileProjection(worker, roots) {
  const links = claudeProfileLinks(roots);
  if (!links.length) return { created: 0 };

  if (worker.platform === "windows") {
    const data = quotePowerShell(JSON.stringify(links));
    const script = `
$ErrorActionPreference = 'Stop'
$links = ConvertFrom-Json ${data}
$backupRoot = Join-Path $HOME ('.hn\\backups\\claude-profile-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$created = 0
foreach ($link in $links) {
  $destination = Join-Path $HOME ($link.link -replace '/', '\\')
  $target = Join-Path $HOME ($link.target -replace '/', '\\')
  if (-not (Test-Path -LiteralPath $target -PathType Container)) { continue }
  $item = Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
  $correct = $item -and $item.LinkType -eq 'Junction' -and ($item.Target -contains $target)
  if ($correct) { continue }
  if ($item) {
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    Move-Item -LiteralPath $destination -Destination (Join-Path $backupRoot $link.name)
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  New-Item -ItemType Junction -Path $destination -Target $target | Out-Null
  $created += 1
}
Write-Output $created
`;
    const result = runPowerShell(worker, script, { capture: true });
    return { created: Number.parseInt(result.stdout.trim(), 10) || 0 };
  }

  const statements = links.map((link) => {
    const destination = `$HOME/${link.link}`;
    const target = `$HOME/${link.target}`;
    return `if [ ! -e ${quotePosix(destination)} ] && [ ! -L ${quotePosix(destination)} ]; then ln -s -- ${quotePosix(target)} ${quotePosix(destination)}; fi`;
  });
  runPosix(worker, statements.join("\n"));
  return { created: links.length };
}

export function claudeProfileRoots(workspace) {
  return (workspace?.roots ?? []).filter((root) => root.purpose === "claude-profile");
}
