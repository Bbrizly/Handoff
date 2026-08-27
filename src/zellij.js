import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { encodePowerShell, runPosix, runPowerShell, runSsh } from "./ssh.js";
import { remotePathExpression } from "./worker.js";
import { fail, quotePosix, quotePowerShell, shortHash, slug } from "./util.js";

function zellijPowerShellExpression() {
  return `(Join-Path $HOME '.hn\\bin\\zellij.exe')`;
}

export function windowsZellijRuntimeSetup() {
  return `
$hnZellijSocketDir = Join-Path $HOME '.hn\\zellij-sockets'
$hnZellijConfigDir = Join-Path $HOME '.hn\\zellij\\config'
New-Item -ItemType Directory -Force -Path $hnZellijSocketDir | Out-Null
New-Item -ItemType Directory -Force -Path $hnZellijConfigDir | Out-Null
$env:ZELLIJ_SOCKET_DIR = $hnZellijSocketDir
$env:ZELLIJ_CONFIG_DIR = $hnZellijConfigDir
`;
}

export function posixZellijRuntimeSetup() {
  return `
hn_zellij_socket_dir="$HOME/.hn/zellij-sockets"
hn_zellij_config_dir="$HOME/.hn/zellij/config"
mkdir -p -- "$hn_zellij_socket_dir" "$hn_zellij_config_dir"
export ZELLIJ_SOCKET_DIR="$hn_zellij_socket_dir"
export ZELLIJ_CONFIG_DIR="$hn_zellij_config_dir"
`;
}

export function windowsZellijProcessCleanupScript(sessionName) {
  return `
$hnZellij = Join-Path $HOME '.hn\\bin\\zellij.exe'
$hnSessionPattern = '[\\\\/]' + [regex]::Escape(${quotePowerShell(sessionName)}) + '(?:["'']?\\s*$)'
$hnServers = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -ieq 'zellij.exe' -and
  $_.ExecutablePath -ieq $hnZellij -and
  $_.CommandLine -match $hnSessionPattern
}
foreach ($hnServer in $hnServers) {
  Invoke-CimMethod -InputObject $hnServer -MethodName Terminate -Arguments @{ Reason = 0 } | Out-Null
}
`;
}

export function windowsDetachedZellijLaunchScript(sessionName) {
  const safeSession = slug(sessionName).slice(0, 80) || "session";
  const childScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${windowsZellijRuntimeSetup()}
$z = ${zellijPowerShellExpression()}
$logDir = Join-Path $HOME '.hn\\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ${quotePowerShell(`zellij-create-${safeSession}.log`)}
("starting Windows Zellij anchor at {0:o}" -f (Get-Date)) | Out-File -FilePath $logFile -Encoding utf8
try {
  # On native Windows, --create-background can return successfully while its
  # server disappears as the launcher exits. Keep one hidden attached client
  # alive instead; it anchors the Zellij server independently of OpenSSH.
  & $z attach --create ${quotePowerShell(sessionName)}
  $hnCode = $LASTEXITCODE
  ("anchor exited with code {0} at {1:o}" -f $hnCode, (Get-Date)) | Add-Content -Path $logFile -Encoding utf8
} catch {
  $_ | Out-String | Add-Content -Path $logFile -Encoding utf8
  $hnCode = 1
}
exit $hnCode
`;
  const encoded = encodePowerShell(childScript);

  return `
$ErrorActionPreference = 'Stop'
$hnEnvironment = @(Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" })
$startup = New-CimInstance -CimClass (Get-CimClass -ClassName Win32_ProcessStartup) -ClientOnly
# Windows OpenSSH can tear down descendants when an exec channel closes. Spawn
# a long-lived Zellij anchor through WMI, explicitly escaping the sshd job and
# giving Zellij a real Windows console while keeping that console hidden.
# CREATE_BREAKAWAY_FROM_JOB (0x01000000) | CREATE_NEW_CONSOLE (0x00000010)
$startup.CreateFlags = [uint32]16777232
$startup.ShowWindow = [uint16]0
$startup.EnvironmentVariables = [string[]]$hnEnvironment
$childPowerShell = Join-Path $PSHOME 'powershell.exe'
$commandLine = '"' + $childPowerShell + '" -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}'
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $commandLine
  CurrentDirectory = $HOME
  ProcessStartupInformation = $startup
}
if ($created.ReturnValue -ne 0) {
  throw "Win32_Process.Create failed with return value $($created.ReturnValue)."
}
Start-Sleep -Milliseconds 150
$spawned = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($created.ProcessId)" -ErrorAction SilentlyContinue
if (-not $spawned) {
  throw "Detached Zellij anchor exited before Handoff could verify it."
}
$owner = Invoke-CimMethod -InputObject $spawned -MethodName GetOwner -ErrorAction SilentlyContinue
if ($owner -and $owner.ReturnValue -eq 0 -and $owner.User -and $owner.User -ine $env:USERNAME) {
  try { Invoke-CimMethod -InputObject $spawned -MethodName Terminate -Arguments @{ Reason = 1 } | Out-Null } catch {}
  throw "Detached Zellij launcher ran as '$($owner.User)' instead of '$env:USERNAME'."
}
Write-Output ("hn-zellij-anchor:{0}" -f $created.ProcessId)
`;
}

function runZellij(worker, args, options = {}) {
  if (worker.platform === "windows") {
    const literals = args.map(quotePowerShell).join(", ");
    const script = `
${windowsZellijRuntimeSetup()}
$z = ${zellijPowerShellExpression()}
$hnArgs = @(${literals})
& $z @hnArgs
exit $LASTEXITCODE
`;
    return runPowerShell(worker, script, options);
  }

  const command = args.map(quotePosix).join(" ");
  return runPosix(worker, `${posixZellijRuntimeSetup()}\nz="$HOME/.hn/bin/zellij"; "$z" ${command}`, options);
}

export function sessionNameFor(workspaceName, targetName, projectLocal, commandArgs, workspaceSalt = "", uniqueToken = "") {
  const command = commandArgs[0] ?? "shell";
  const label = `${workspaceName}-${targetName}-${basename(projectLocal)}-${command}`;
  const hash = shortHash(`${targetName}\u0000${projectLocal}\u0000${commandArgs.join("\u0000")}\u0000${workspaceSalt}`);
  const suffix = uniqueToken ? `-${slug(uniqueToken).slice(0, 10)}` : "";
  return `hn-${slug(label)}-${hash}${suffix}`;
}

export function newSessionToken() {
  return randomBytes(4).toString("hex");
}

function normalizeExecutable(value) {
  const leaf = String(value ?? "").trim().split(/[\\/]/).pop() ?? "";
  return leaf.toLowerCase().replace(/\.exe$/, "");
}

export function paneMatchesCommand(pane, commandArgs, paneName) {
  if (!pane || pane.is_plugin || pane.exited) return false;
  if (pane.title === paneName) return true;
  const expected = normalizeExecutable(commandArgs[0]);
  return expected !== "" && normalizeExecutable(pane.pane_command) === expected;
}

export function parsePaneListOutput(output) {
  const text = String(output ?? "").trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end < start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function sleepMs(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function inspectSession(worker, sessionName, { attempts = 1, delayMs = 125 } = {}) {
  let lastResult = { code: 1, stdout: "", stderr: "" };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastResult = runZellij(
      worker,
      ["--session", sessionName, "action", "list-panes", "--json"],
      { capture: true, allowFailure: true },
    );

    if (lastResult.code === 0) {
      const panes = parsePaneListOutput(lastResult.stdout);
      if (panes) return { panes, result: lastResult };
    }

    if (attempt < attempts - 1) sleepMs(delayMs);
  }

  return { panes: null, result: lastResult };
}

function diagnosticText(result) {
  if (!result) return "no diagnostic output";
  const pieces = [`exit ${result.code}`];
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  if (stdout) pieces.push(`stdout: ${stdout.slice(0, 1200)}`);
  if (stderr) pieces.push(`stderr: ${stderr.slice(0, 1200)}`);
  return pieces.join("; ");
}

export function killSession(worker, sessionName) {
  runZellij(worker, ["delete-session", "--force", sessionName], { capture: true, allowFailure: true });
  if (worker.platform === "windows") {
    runPowerShell(
      worker,
      windowsZellijProcessCleanupScript(sessionName),
      { capture: true, allowFailure: true },
    );
  }
  sleepMs(250);
  runZellij(worker, ["delete-session", sessionName], { capture: true, allowFailure: true });
}

function windowsZellijLaunchLog(worker, sessionName) {
  const safeSession = slug(sessionName).slice(0, 80) || "session";
  const script = `
$logFile = Join-Path (Join-Path $HOME '.hn\\logs') ${quotePowerShell(`zellij-create-${safeSession}.log`)}
if (Test-Path $logFile) { Get-Content -Raw $logFile }
`;
  return runPowerShell(worker, script, { capture: true, allowFailure: true });
}

function createBackgroundSession(worker, sessionName) {
  let created;
  if (worker.platform === "windows") {
    created = runPowerShell(
      worker,
      windowsDetachedZellijLaunchScript(sessionName),
      { capture: true, allowFailure: true },
    );
  } else {
    created = runZellij(
      worker,
      ["attach", "--create-background", sessionName],
      { capture: true, allowFailure: true },
    );
  }

  if (created.code !== 0) {
    fail(`Zellij session '${sessionName}' could not be created (${diagnosticText(created)}).`);
  }

  const inspection = inspectSession(worker, sessionName, { attempts: 50, delayMs: 100 });
  if (!inspection.panes) {
    const listed = runZellij(worker, ["list-sessions"], { capture: true, allowFailure: true });
    const launchLog = worker.platform === "windows" ? windowsZellijLaunchLog(worker, sessionName) : null;
    const logText = launchLog && String(launchLog.stdout ?? "").trim()
      ? `; launcher-log: ${String(launchLog.stdout).trim().slice(0, 1600)}`
      : "";
    fail(
      `Zellij session '${sessionName}' was created but could not be inspected (${diagnosticText(inspection.result)}; list-sessions: ${diagnosticText(listed)}${logText}).`,
    );
  }
  return inspection.panes;
}

function posixCwdSetup(remoteCwd) {
  return `
hn_cwd=${quotePosix(remoteCwd)}
case "$hn_cwd" in
  /*) ;;
  *) hn_cwd="$HOME/$hn_cwd" ;;
esac
`;
}

function windowsCommandRunner(commandArgs) {
  const command = commandArgs[0];
  const rest = commandArgs.slice(1).map(quotePowerShell).join(", ");
  const script = `
$ErrorActionPreference = 'Stop'
$cmd = ${quotePowerShell(command)}
$hnArgs = @(${rest})
$application = Get-Command $cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($application) {
  & $application.Source @hnArgs
} else {
  & $cmd @hnArgs
}
exit $LASTEXITCODE
`;
  return ["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encodePowerShell(script)];
}

function replacementPaneArgs(paneId) {
  return paneId === null || paneId === undefined
    ? []
    : ["--in-place", "--close-replaced-pane", "--pane-id", String(paneId)];
}

function startCommandPane(worker, sessionName, paneId, remoteCwd, commandArgs, paneName) {
  const replacementArgs = replacementPaneArgs(paneId);
  if (worker.platform === "windows") {
    const paneCommand = windowsCommandRunner(commandArgs);
    const elements = [
      quotePowerShell("--session"),
      quotePowerShell(sessionName),
      quotePowerShell("action"),
      quotePowerShell("new-pane"),
      ...replacementArgs.map(quotePowerShell),
      quotePowerShell("--cwd"),
      "$hnCwd",
      quotePowerShell("--name"),
      quotePowerShell(paneName),
      quotePowerShell("--"),
      ...paneCommand.map(quotePowerShell),
    ];
    const script = `
$ErrorActionPreference = 'Stop'
${windowsZellijRuntimeSetup()}
$z = ${zellijPowerShellExpression()}
$hnCwd = ${remotePathExpression(remoteCwd)}
$hnArgs = @(${elements.join(", ")})
& $z @hnArgs
exit $LASTEXITCODE
`;
    runPowerShell(worker, script, { capture: true });
    return;
  }

  const command = commandArgs.map(quotePosix).join(" ");
  const replacement = replacementArgs.map(quotePosix).join(" ");
  const script = `${posixZellijRuntimeSetup()}\n${posixCwdSetup(remoteCwd)}
z="$HOME/.hn/bin/zellij"
"$z" --session ${quotePosix(sessionName)} action new-pane ${replacement} --cwd "$hn_cwd" --name ${quotePosix(paneName)} -- ${command}
`;
  runPosix(worker, script, { capture: true });
}

export function ensurePersistentCommand(worker, sessionName, remoteCwd, commandArgs) {
  const paneName = `hn:${slug(commandArgs[0] ?? "shell").slice(0, 30)}`;
  let inspection = inspectSession(worker, sessionName, { attempts: 2, delayMs: 100 });
  let panes = inspection.panes;
  if (panes?.some((pane) => paneMatchesCommand(pane, commandArgs, paneName))) return;

  if (panes) killSession(worker, sessionName);
  panes = createBackgroundSession(worker, sessionName);
  const initialPane = panes.find((pane) => !pane.is_plugin && !pane.exited) ?? null;

  // In headless/noninteractive environments Zellij can successfully create the
  // session while its bootstrap shell exits immediately. A live bootstrap pane
  // is therefore an optimization (replace it in-place), not a correctness
  // requirement. If it has already exited, create the command as a fresh pane.
  startCommandPane(worker, sessionName, initialPane?.id ?? null, remoteCwd, commandArgs, paneName);
  inspection = inspectSession(worker, sessionName, { attempts: 30, delayMs: 100 });
  if (!inspection.panes?.some((pane) => paneMatchesCommand(pane, commandArgs, paneName))) {
    fail(`Remote command '${commandArgs[0]}' did not start inside Zellij (${diagnosticText(inspection.result)}).`);
  }
}

export function attachSession(worker, sessionName) {
  if (worker.platform === "windows") {
    const script = `
${windowsZellijRuntimeSetup()}
$z = ${zellijPowerShellExpression()}
& $z attach ${quotePowerShell(sessionName)}
exit $LASTEXITCODE
`;
    return runSsh(
      worker,
      ["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encodePowerShell(script)],
      { tty: true },
    );
  }

  return runPosix(
    worker,
    `${posixZellijRuntimeSetup()}\nexec "$HOME/.hn/bin/zellij" attach ${quotePosix(sessionName)}`,
    { tty: true },
  );
}

export function listSessions(worker) {
  return runZellij(worker, ["list-sessions"], { capture: true, allowFailure: true });
}

export function shellCommand(worker) {
  return worker.platform === "windows" ? ["powershell.exe", "-NoLogo"] : ["sh"];
}
