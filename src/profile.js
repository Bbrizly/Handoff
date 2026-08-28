import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { copyToWorker, runPosix, runPowerShell } from "./ssh.js";
import { fail, quotePosix, quotePowerShell } from "./util.js";
import { ensureRemoteDirectory } from "./worker.js";
import { addWorkspaceRoot } from "./workspace.js";

const CLAUDE_PORTABLE_PATHS = [
  [".codex/superpowers/skills", ".codex/superpowers/skills", "directory"],
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
  for (const entry of readdirSync(agentRoot.local, { withFileTypes: true })) {
    const localLink = join(agentRoot.local, entry.name);
    let target;
    try {
      if (!lstatSync(localLink).isSymbolicLink()) continue;
      target = resolve(dirname(localLink), readlinkSync(localLink));
      const targetRoot = roots.find((root) => resolve(root.local) === target);
      if (!targetRoot || !statSync(target).isDirectory()) continue;
      links.push({ name: entry.name, link: `${agentRoot.remote}/${entry.name}`, target: targetRoot.remote });
    } catch {
      continue;
    }
  }

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
  return links.sort((a, b) => {
    const depth = a.link.split("/").length - b.link.split("/").length;
    return depth || a.link.localeCompare(b.link);
  });
}

export function claudeProfileProjectionFingerprint(roots) {
  return createHash("sha256")
    .update(JSON.stringify(claudeProfileLinks(roots)))
    .digest("hex")
    .slice(0, 16);
}

export function ensureClaudeProfileProjection(worker, roots) {
  const links = claudeProfileLinks(roots);
  if (!links.length) return { created: 0, missing: 0, total: 0 };

  if (worker.platform === "windows") {
    const stage = mkdtempSync(join(tmpdir(), "hn-claude-profile-"));
    const manifest = join(stage, "links.json");
    const remoteManifest = `.hn/state/claude-profile-links-${process.pid}-${Date.now()}.json`;
    writeFileSync(manifest, JSON.stringify(links), { mode: 0o600 });
    try {
      ensureRemoteDirectory(worker, ".hn/state");
      copyToWorker(worker, manifest, remoteManifest);
      const script = `
$ErrorActionPreference = 'Stop'
$manifest = Join-Path $HOME ${quotePowerShell(remoteManifest.replaceAll("/", "\\"))}
$backupRoot = Join-Path $HOME ('.hn\\backups\\claude-profile-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$created = 0
$missing = 0
try {
  $links = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  foreach ($link in $links) {
    $destination = Join-Path $HOME ($link.link -replace '/', '\\')
    $target = Join-Path $HOME ($link.target -replace '/', '\\')
    if (-not (Test-Path -LiteralPath $target -PathType Container)) { $missing += 1; continue }
    $item = Get-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
    $correct = $item -and $item.LinkType -eq 'Junction' -and ($item.Target -contains $target)
    if ($correct) { continue }
    if ($item) {
      $backupName = ([string]$link.link).Replace('/', '__').Replace('\\', '__')
      New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
      Move-Item -LiteralPath $destination -Destination (Join-Path $backupRoot $backupName)
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    New-Item -ItemType Junction -Path $destination -Target $target | Out-Null
    $created += 1
  }
} finally {
  Remove-Item -LiteralPath $manifest -Force -ErrorAction SilentlyContinue
}
Write-Output ("{0}|{1}|{2}" -f $created, $missing, @($links).Count)
`;
      const result = runPowerShell(worker, script, { capture: true });
      const [created = 0, missing = 0, total = 0] = result.stdout
        .trim()
        .split("|")
        .map((value) => Number.parseInt(value, 10) || 0);
      if (missing) {
        fail(`Claude profile is missing ${missing} linked skill source${missing === 1 ? "" : "s"} on ${worker.target}.`);
      }
      return { created, missing, total };
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  const statements = links.map((link) => {
    const destination = `"$HOME"/${quotePosix(link.link)}`;
    const target = `"$HOME"/${quotePosix(link.target)}`;
    return `if [ ! -d ${target} ]; then missing=$((missing + 1)); elif [ ! -e ${destination} ] && [ ! -L ${destination} ]; then mkdir -p -- "$(dirname -- ${destination})"; ln -s -- ${target} ${destination}; created=$((created + 1)); fi`;
  });
  const result = runPosix(
    worker,
    `created=0\nmissing=0\n${statements.join("\n")}\nprintf '%s|%s|%s' "$created" "$missing" '${links.length}'`,
    { capture: true },
  );
  const [created = 0, missing = 0, total = 0] = result.stdout
    .trim()
    .split("|")
    .map((value) => Number.parseInt(value, 10) || 0);
  if (missing) {
    fail(`Claude profile is missing ${missing} linked skill source${missing === 1 ? "" : "s"} on ${worker.target}.`);
  }
  return { created, missing, total };
}

export function claudeProfileRoots(workspace) {
  return (workspace?.roots ?? []).filter((root) => root.purpose === "claude-profile");
}
