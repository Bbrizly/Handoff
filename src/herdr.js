// Herdr persistence backend.
//
// Everything Handoff knows about Herdr lives here. Nothing outside this module
// builds a Herdr command line.
//
// Herdr is Apache-2.0 and is downloaded from its immutable GitHub release,
// checksum-verified on the controller, then copied to the worker.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyToWorker, encodePowerShell, runPosix, runPowerShell, runSsh } from "./ssh.js";
import { ensureCachedRelease, runLocal } from "./runtime-assets.js";
import { remotePathExpression } from "./worker.js";
import { windowsPowerShellBootstrapCommand, windowsShellBootstrapScript } from "./remote.js";
import { windowsDetachedLaunchScript } from "./windows-detach.js";
import { fail, quotePosix, quotePowerShell, shortHash, slug } from "./util.js";
import { HANDOFF_CLAUDE_SETTINGS_TOKEN, MANAGED_REPAIR_MARKER } from "./statusline.js";
import { attachThinHerdr, thinTransportMode } from "./herdr-thin.js";
import { attachResponsiveHerdr } from "./herdr-responsive.js";

export const HERDR_VERSION = "0.8.2";

const HERDR_ASSETS = {
  "windows:x64": {
    file: "herdr-windows-x86_64.zip",
    sha256: "0ab3d0fe1434d55757997542b978c771d642987bb15a7130f4160f0db38821d5",
    archive: "zip",
    binary: "herdr.exe",
  },
  "linux:x64": {
    file: "herdr-linux-x86_64",
    sha256: "976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4",
    archive: "raw",
    binary: "herdr",
  },
  "linux:arm64": {
    file: "herdr-linux-aarch64",
    sha256: "f55610658e1c2e0d2aaef730b4b2ab885f7f8ba00285ab372bfb14f2e3d5b40d",
    archive: "raw",
    binary: "herdr",
  },
  "darwin:x64": {
    file: "herdr-macos-x86_64",
    sha256: "ab50262c8190cd7aa9056d249d255c08c328c3e8716de9cfa29db4f131b8e2c1",
    archive: "raw",
    binary: "herdr",
  },
  "darwin:arm64": {
    file: "herdr-macos-aarch64",
    sha256: "a5d4f4d504d8b309c91f811050559300faba31258425f53c50852fc96f6ae574",
    archive: "raw",
    binary: "herdr",
  },
};

const CONFIG_RELATIVE = ".hn/herdr/config.toml";

function herdrConfigRelative(worker) {
  return worker?.__hnHerdrConfigRelative ?? CONFIG_RELATIVE;
}

export function herdrReleaseUrl(asset) {
  return `https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/${asset.file}`;
}

export function herdrAssetFor(platform, arch) {
  const normalized = platform === "win32" ? "windows" : platform;
  return HERDR_ASSETS[`${normalized}:${arch}`] ?? null;
}

export function herdrInstallDir() {
  return `.hn/bin/herdr/${HERDR_VERSION}`;
}

export function herdrBinaryRelative(worker) {
  if (worker?.__hnHerdrBinaryRelative) return worker.__hnHerdrBinaryRelative;
  const asset = herdrAssetFor(worker.platform, worker.arch);
  return `${herdrInstallDir()}/${asset ? asset.binary : "herdr"}`;
}

// One runtime per controller + workspace. The controller id keeps two laptops
// sharing a worker out of each other's desk.
export function herdrRuntimeName(controllerId, workspaceName) {
  return `hn-${shortHash(String(controllerId ?? "unknown"))}-${slug(workspaceName)}`;
}

// Handoff owns this file. The user's own ~/.config/herdr/config.toml is left alone.
export function herdrConfigToml(platform = undefined) {
  const terminal = platform === "windows"
    ? `
[terminal]
default_shell = "~/.hn/bin/hn-powershell.cmd"
`
    : "";
  return `# Written by Handoff (hn). Your own Herdr config is untouched.
onboarding = false

[update]
version_check = false
manifest_check = false

[ui]
sidebar_width = 28
sidebar_min_width = 20
sidebar_max_width = 36
mouse_capture = true
copy_on_select = true
confirm_close = true
hide_tab_bar_when_single_tab = true
show_agent_labels_on_pane_borders = true
agent_panel_sort = "priority"
status_indicators = "symbols"
window_title = "hn: {workspace} on {hostname}"

# The synchronized tree has no .git, so branch and git status rows would be blank.
[ui.sidebar.spaces]
row_gap = 0
rows = [["state_icon", "workspace"]]

[ui.sidebar.agents]
row_gap = 0
rows = [["state_icon", "workspace"], ["agent", "state_text"]]
${terminal}
`;
}

function windowsPrelude(worker, runtime) {
  return `$env:HERDR_CONFIG_PATH = ${remotePathExpression(herdrConfigRelative(worker))}
$hnHerdr = ${remotePathExpression(herdrBinaryRelative(worker))}
$hnSession = ${quotePowerShell(runtime)}
`;
}

function posixPrelude(worker, runtime) {
  return `HERDR_CONFIG_PATH="$HOME/${herdrConfigRelative(worker)}"
export HERDR_CONFIG_PATH
hn_herdr="$HOME/${herdrBinaryRelative(worker)}"
hn_session=${quotePosix(runtime)}
`;
}

export function herdrCommandScript(worker, runtime, args) {
  if (worker.platform === "windows") {
    const rest = args.map(quotePowerShell).join(" ");
    return `${windowsPrelude(worker, runtime)}& $hnHerdr --session $hnSession ${rest}
exit $LASTEXITCODE
`;
  }
  const rest = args.map(quotePosix).join(" ");
  return `${posixPrelude(worker, runtime)}exec "$hn_herdr" --session "$hn_session" ${rest}
`;
}

function runHerdr(worker, runtime, args, options = {}) {
  const script = herdrCommandScript(worker, runtime, args);
  return worker.platform === "windows"
    ? runPowerShell(worker, script, options)
    : runPosix(worker, script, options);
}

// Herdr answers with one JSON object. Tolerate banner noise around it.
export function parseHerdrJson(output) {
  const text = String(output ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) fail(`Herdr returned no JSON: ${text.trim().slice(0, 200)}`);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    fail(`Herdr returned unreadable JSON: ${error.message}`);
  }
}

function herdrJson(worker, runtime, args) {
  const result = runHerdr(worker, runtime, args, { capture: true, allowFailure: true });
  if (result.code !== 0) {
    fail(`Herdr command failed (${args.join(" ")}): ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  return parseHerdrJson(result.stdout);
}

export function herdrVersion(worker) {
  const binary = herdrBinaryRelative(worker);
  const options = { capture: true, allowFailure: true, timeoutMs: 15000 };
  const result = worker.platform === "windows"
    ? runPowerShell(worker, `$hnHerdr = ${remotePathExpression(binary)}
if (-not (Test-Path -LiteralPath $hnHerdr)) { exit 1 }
& $hnHerdr --version
exit $LASTEXITCODE
`, options)
    : runPosix(worker, `h="$HOME/${binary}"; [ -x "$h" ] || exit 1; "$h" --version`, options);
  return result.code === 0 ? result.stdout.trim() : "";
}

function extractHerdr(asset, archivePath) {
  const dir = mkdtempSync(join(tmpdir(), "hn-herdr-"));
  if (asset.archive === "zip") {
    runLocal("unzip", ["-oq", archivePath, "-d", dir]);
    if (!existsSync(join(dir, asset.binary))) {
      rmSync(dir, { recursive: true, force: true });
      fail(`Herdr archive did not contain ${asset.binary}.`);
    }
  }
  return dir;
}

export function ensureHerdrConfig(worker) {
  const toml = herdrConfigToml(worker.platform);
  const configRelative = herdrConfigRelative(worker);
  const configDir = configRelative.slice(0, configRelative.lastIndexOf("/"));
  if (worker.platform === "windows") {
    runPowerShell(worker, `$ErrorActionPreference = 'Stop'
$hnDir = ${remotePathExpression(configDir)}
New-Item -ItemType Directory -Force -Path $hnDir | Out-Null
Set-Content -LiteralPath ${remotePathExpression(configRelative)} -Value ${quotePowerShell(toml)} -Encoding utf8
$hnBin = ${remotePathExpression(".hn/bin")}
New-Item -ItemType Directory -Force -Path $hnBin | Out-Null
$hnShell = ${remotePathExpression(".hn/bin/hn-powershell.cmd")}
Set-Content -LiteralPath $hnShell -Value ${quotePowerShell(windowsPowerShellBootstrapCommand())} -Encoding ascii
$hnBootstrap = ${remotePathExpression(".hn/shell.ps1")}
Set-Content -LiteralPath $hnBootstrap -Value ${quotePowerShell(windowsShellBootstrapScript())} -Encoding utf8
`);
    return;
  }
  runPosix(worker, `mkdir -p "$HOME/${configDir}"
printf '%s' ${quotePosix(toml)} > "$HOME/${configRelative}"
`);
}

export function ensureHerdrInstalled(worker, { quiet = true } = {}) {
  if (herdrVersion(worker).includes(HERDR_VERSION)) {
    ensureHerdrConfig(worker);
    return;
  }

  const asset = herdrAssetFor(worker.platform, worker.arch);
  if (!asset) fail(`Herdr ${HERDR_VERSION} has no build for ${worker.platform}/${worker.arch}.`);
  if (!quiet) console.log(`installing Herdr ${HERDR_VERSION} on ${worker.target}...`);

  const archivePath = ensureCachedRelease({
    name: "herdr",
    version: HERDR_VERSION,
    file: asset.file,
    url: herdrReleaseUrl(asset),
    sha256: asset.sha256,
  });

  if (worker.platform === "windows") {
    // The Windows release is a bundle: herdr.exe plus its ConPTY components.
    // Ship the archive and expand it on the worker so nothing is dropped.
    const remoteZip = `.hn/cache/${asset.file}`;
    runPowerShell(worker, `$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path ${remotePathExpression(".hn/cache")} | Out-Null
`);
    copyToWorker(worker, archivePath, remoteZip);
    // Expanding straight over the install directory fails once a desk is
    // running: its ConPTY DLLs are locked. Those locked files are already the
    // right ones, so unpack beside them and copy what will move. The version
    // check below is what decides whether the install actually worked.
    runPowerShell(worker, `$ErrorActionPreference = 'Stop'
$hnTarget = ${remotePathExpression(herdrInstallDir())}
$hnStage = Join-Path $env:TEMP ('hn-herdr-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $hnTarget | Out-Null
New-Item -ItemType Directory -Force -Path $hnStage | Out-Null
try {
  Expand-Archive -LiteralPath ${remotePathExpression(remoteZip)} -DestinationPath $hnStage -Force
  Copy-Item -Path (Join-Path $hnStage '*') -Destination $hnTarget -Recurse -Force -ErrorAction SilentlyContinue
} finally {
  Remove-Item -LiteralPath $hnStage -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath ${remotePathExpression(remoteZip)} -Force -ErrorAction SilentlyContinue
}
`);
  } else {
    const extracted = extractHerdr(asset, archivePath);
    try {
      runPosix(worker, `mkdir -p "$HOME/${herdrInstallDir()}"`);
      copyToWorker(
        worker,
        asset.archive === "zip" ? join(extracted, asset.binary) : archivePath,
        herdrBinaryRelative(worker),
      );
      runPosix(worker, `chmod 755 "$HOME/${herdrBinaryRelative(worker)}"`);
    } finally {
      rmSync(extracted, { recursive: true, force: true });
    }
  }

  ensureHerdrConfig(worker);
  const verified = herdrVersion(worker);
  if (!verified.includes(HERDR_VERSION)) {
    fail(`Herdr install failed on ${worker.target}. Got '${verified || "no version"}'.`);
  }
}

// One round trip answers two questions: is the desk up, and are Handoff's
// managed files still on the worker. The guard is optional so callers that do
// not care pay nothing for it.
const HERDR_MISSING_MARKER = "hn-no-herdr";

export function probeHerdrDesk(worker, runtime, guard = "", run = null) {
  const binary = herdrBinaryRelative(worker);
  const presence = worker.platform === "windows"
    ? `if (-not (Test-Path -LiteralPath ${remotePathExpression(binary)} -PathType Leaf)) { Write-Output '${HERDR_MISSING_MARKER}'; exit 0 }\n`
    : `[ -x "$HOME/${binary}" ] || { echo ${HERDR_MISSING_MARKER}; exit 0; }\n`;
  const script = guard + presence + herdrCommandScript(worker, runtime, ["workspace", "list"]);
  const options = { capture: true, allowFailure: true, timeoutMs: 15000 };
  const result = run
    ? run(script)
    : worker.platform === "windows"
      ? runPowerShell(worker, script, options)
      : runPosix(worker, script, options);
  return {
    installed: !result.stdout.includes(HERDR_MISSING_MARKER),
    running: result.code === 0 && result.stdout.includes("workspace_list"),
    repairNeeded: result.stdout.includes(MANAGED_REPAIR_MARKER),
  };
}

function serverIsRunning(worker, runtime) {
  return probeHerdrDesk(worker, runtime).running;
}

// Cheap enough to run after a broken attachment: it asks the desk itself, not
// the network, whether anything is actually wrong.
export function deskIsHealthy(worker, runtime) {
  const result = runHerdr(worker, runtime, ["status", "server"], {
    capture: true,
    allowFailure: true,
    timeoutMs: 15000,
  });
  return result.code === 0 && /status:\s*running/.test(result.stdout);
}

export function ensureHerdrServer(worker, runtime, { agentDirectories = [], claudeSettings = "" } = {}) {
  if (serverIsRunning(worker, runtime)) return;

  if (worker.platform === "windows") {
    // Windows OpenSSH kills descendants when the exec channel closes, and Herdr
    // needs real console handles, so redirecting its stdio to a file kills it
    // too. Break out of the sshd job with a hidden console instead.
    const child = `$ErrorActionPreference = 'Stop'
${windowsPrelude(worker, runtime)}& $hnHerdr --session $hnSession server
`;
    const absoluteDirectories = agentDirectories
      .map((directory) => `(Join-Path $HOME ${quotePowerShell(directory.replaceAll("/", "\\"))})`)
      .join(", ");
    const environment = `$env:HN_HANDOFF_AGENT_DIRECTORIES = @(${absoluteDirectories}) -join [IO.Path]::PathSeparator
$env:HN_HANDOFF_CLAUDE_SETTINGS = ${claudeSettings ? quotePowerShell(claudeSettings) : "''"}
`;
    runPowerShell(
      worker,
      windowsDetachedLaunchScript(environment + child, { marker: "hn-desk" }),
      { capture: true },
    );
  } else {
    runPosix(worker, `${posixPrelude(worker, runtime)}
mkdir -p "$HOME/.hn/logs"
nohup "$hn_herdr" --session "$hn_session" server </dev/null >> "$HOME/.hn/logs/$hn_session.log" 2>&1 &
`);
  }

  // Each probe is its own SSH round trip, which is also the delay.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (serverIsRunning(worker, runtime)) return;
  }
  fail(
    `The persistent desk did not start on ${worker.target}.\n`
    + `Try: hn doctor\n`
    + `Log: the herdr-server.log inside the '${runtime}' session directory on that machine.`,
  );
}

export function listHerdrWorkspaces(worker, runtime) {
  return herdrJson(worker, runtime, ["workspace", "list"])?.result?.workspaces ?? [];
}

// Labels survive a server restart; metadata tokens do not. So the label is the
// durable key and the token is the exact match while the server is up.
function matchWorkspace(workspaces, remoteRoot, label) {
  return workspaces.find((workspace) => workspace?.tokens?.hn_root === remoteRoot)
    ?? workspaces.find((workspace) => workspace?.label === label)
    ?? null;
}

export function projectLabel(name, existingLabels = []) {
  if (!existingLabels.includes(name)) return name;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${name} ${suffix}`;
    if (!existingLabels.includes(candidate)) return candidate;
  }
  return `${name} ${shortHash(name)}`;
}

export function ensureHerdrProject(worker, runtime, { remoteRoot, name }) {
  const workspaces = listHerdrWorkspaces(worker, runtime);
  const existing = matchWorkspace(workspaces, remoteRoot, name);

  if (existing) {
    runHerdr(worker, runtime, ["workspace", "focus", existing.workspace_id], {
      capture: true,
      allowFailure: true,
    });
    tagProject(worker, runtime, existing.workspace_id, remoteRoot);
    return { workspaceId: existing.workspace_id, created: false };
  }

  const label = projectLabel(name, workspaces.map((workspace) => workspace.label));
  const created = herdrJson(worker, runtime, [
    "workspace", "create", "--cwd", remoteRoot, "--label", label, "--focus",
  ]);
  const workspaceId = created?.result?.workspace?.workspace_id;
  if (!workspaceId) fail("Herdr did not return a workspace id.");
  tagProject(worker, runtime, workspaceId, remoteRoot);
  return { workspaceId, created: true };
}

function tagProject(worker, runtime, workspaceId, remoteRoot) {
  runHerdr(
    worker,
    runtime,
    ["workspace", "report-metadata", workspaceId, "--source", "hn", "--token", `hn_root=${remoteRoot}`],
    { capture: true, allowFailure: true },
  );
}

export const HERDR_AGENT_KINDS = new Set([
  "claude", "codex", "cursor", "cursor-agent", "gemini", "opencode", "copilot", "amp", "droid",
]);

function agentKind(command) {
  const name = String(command).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  if (!HERDR_AGENT_KINDS.has(name)) return null;
  return name === "cursor-agent" ? "cursor" : name;
}

// The pane runs a real shell, so arguments need that shell's quoting. Windows
// needs the call operator in front, or PowerShell prints a quoted path instead
// of running it.
export function paneCommandLine(worker, commandArgs) {
  const [command, ...rest] = commandArgs;
  const quote = worker.platform === "windows" ? quotePowerShell : quotePosix;
  const quotedRest = rest.map((arg) => {
    if (arg !== HANDOFF_CLAUDE_SETTINGS_TOKEN) return quote(arg);
    return worker.platform === "windows"
      ? "(Join-Path $HOME '.hn\\claude-settings.json')"
      : '"$HOME/.hn/claude-settings.json"';
  });
  if (worker.platform === "windows") return ["&", quote(command), ...quotedRest].join(" ");
  return [quote(command), ...quotedRest].join(" ");
}

function projectPane(worker, runtime, workspaceId) {
  const panes = herdrJson(worker, runtime, ["pane", "list", "--workspace", workspaceId])
    ?.result?.panes ?? [];
  return panes.find((pane) => pane.focused) ?? panes[0] ?? null;
}

function processName(value) {
  return String(value ?? "").split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");
}

// Herdr nests this one reply a level deeper than the rest. Reading
// result.foreground_processes gave an empty list every time, which read as
// "this pane is busy", so no pane was ever bootstrapped.
export function paneForegroundProcesses(reply) {
  return reply?.result?.process_info?.foreground_processes ?? [];
}

// A pane can only be bootstrapped safely while its foreground process is the
// shell itself. Never write into a live agent, build, server, or other tool.
export function bootstrapIdleWindowsPane(worker, runtime, pane, { agentDirectories = [], claudeSettings = "" } = {}) {
  if (worker.platform !== "windows" || pane?.agent) return false;
  const processes = paneForegroundProcesses(
    herdrJson(worker, runtime, ["pane", "process-info", "--pane", pane.pane_id]),
  );
  if (!processes.length || processes.some((process) => !["powershell", "pwsh"].includes(processName(process.name)))) {
    return false;
  }
  const settings = claudeSettings ? quotePowerShell(claudeSettings) : "''";
  const absoluteDirectories = agentDirectories
    .map((directory) => `(Join-Path $HOME ${quotePowerShell(directory.replaceAll("/", "\\"))})`)
    .join(", ");
  const command = `$env:HN_HANDOFF_AGENT_DIRECTORIES = @(${absoluteDirectories}) -join [IO.Path]::PathSeparator; $env:HN_HANDOFF_CLAUDE_SETTINGS = ${settings}; . (Join-Path $HOME '.hn\\shell.ps1')`;
  const result = runHerdr(worker, runtime, ["pane", "run", pane.pane_id, command], {
    capture: true,
    allowFailure: true,
  });
  return result.code === 0;
}

export function bootstrapHerdrProjectPane(worker, runtime, workspaceId, options = {}) {
  const pane = projectPane(worker, runtime, workspaceId);
  return pane ? bootstrapIdleWindowsPane(worker, runtime, pane, options) : false;
}

// 'hn pc -p claude' should return to the Claude already running in this project
// instead of stacking another one beside it.
export function runInHerdrProject(worker, runtime, workspaceId, commandArgs) {
  const kind = agentKind(commandArgs[0]);
  if (kind) {
    const live = herdrAgents(worker, runtime).find(
      (agent) => agent.workspace_id === workspaceId && String(agent.agent ?? "").toLowerCase() === kind,
    );
    if (live) {
      runHerdr(worker, runtime, ["agent", "focus", live.pane_id], { capture: true, allowFailure: true });
      return { focused: true };
    }
  }

  const pane = projectPane(worker, runtime, workspaceId);
  if (!pane) fail("The persistent desk has no pane to run that command in.");
  // 'pane run' answers with an empty body, so only the exit code matters.
  const result = runHerdr(worker, runtime, ["pane", "run", pane.pane_id, paneCommandLine(worker, commandArgs)], {
    capture: true,
    allowFailure: true,
  });
  if (result.code !== 0) {
    fail(`The desk could not run that command: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  return { focused: false };
}

// Prefer Herdr's local thin-client architecture when the controller/worker pair
// supports the pinned Windows bridge. Handoff still owns the Windows server,
// config and persistence lifetime; the local Herdr process is only the renderer.
// Any pre-launch compatibility failure falls back to the proven ssh-tty path in
// auto mode. Tests can continue injecting backend.attach without touching the
// real thin-client runtime.
export function attachHerdr(worker, runtime, backend = {}) {
  const healthy = backend.healthy ?? deskIsHealthy;
  const transport = backend.transport ?? thinTransportMode();

  if (!backend.attach && transport === "mirror") {
    const mirror = attachResponsiveHerdr(worker, runtime);
    if (!mirror.available) {
      fail(`Responsive Herdr mirror is unavailable: ${mirror.reason}`);
    }
    const result = { code: mirror.code, stdout: "", stderr: "" };
    if (result.code === 0) return { ...result, desk: "detached" };
    if (healthy(worker, runtime)) return { ...result, desk: "detached" };
    fail(
      `Lost the responsive local mirror connection to the persistent desk on ${worker.target} (exit ${result.code}).\n`
      + "Try: hn doctor",
    );
  }

  if (!backend.attach && ["auto", "thin"].includes(transport)) {
    const thin = attachThinHerdr(worker, runtime);
    if (thin.available) {
      const result = { code: thin.code, stdout: "", stderr: "" };
      if (result.code === 0) return { ...result, desk: "quit" };
      if (healthy(worker, runtime)) return { ...result, desk: "detached" };
      fail(
        `Lost the local thin-client connection to the persistent desk on ${worker.target} (exit ${result.code}).\n`
        + "Try: hn doctor",
      );
    }
    if (transport === "thin") {
      fail(`Local Herdr thin client is unavailable: ${thin.reason}`);
    }
  }

  const script = herdrCommandScript(worker, runtime, []);
  const attach = backend.attach ?? (() => (worker.platform === "windows"
    // stdin belongs to the TUI, so the script has to travel in argv.
    ? runSsh(
      worker,
      ["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encodePowerShell(script)],
      { tty: true, allowFailure: true },
    )
    : runPosix(worker, script, { tty: true, allowFailure: true })));

  const result = attach();
  if (result.code === 0) return { ...result, desk: "quit" };
  if (healthy(worker, runtime)) return { ...result, desk: "detached" };
  fail(
    `Lost the connection to the persistent desk on ${worker.target} (exit ${result.code}).\n`
    + "Try: hn doctor",
  );
}

export function stopHerdrServer(worker, runtime) {
  return runHerdr(worker, runtime, ["server", "stop"], { capture: true, allowFailure: true });
}

export function herdrAgents(worker, runtime) {
  const result = runHerdr(worker, runtime, ["agent", "list"], { capture: true, allowFailure: true });
  if (result.code !== 0) return [];
  return parseHerdrJson(result.stdout)?.result?.agents ?? [];
}
