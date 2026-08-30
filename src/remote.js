import { gzipSync } from "node:zlib";
import { encodePowerShell, runPosix, runPowerShell, runSsh, testSsh } from "./ssh.js";
import { remotePathExpression } from "./worker.js";
import { quotePosix, quotePowerShell } from "./util.js";
import { HANDOFF_CLAUDE_SETTINGS_TOKEN } from "./statusline.js";

const POWERSHELL_SAFE_ENCODED_LENGTH = 6000;

function interactiveEncodedPowerShell(script) {
  let encoded = encodePowerShell(script);
  if (encoded.length <= POWERSHELL_SAFE_ENCODED_LENGTH) return encoded;

  const payload = gzipSync(Buffer.from(script, "utf8")).toString("base64");
  const loader = `
$hnPayload = ${quotePowerShell(payload)}
$hnBytes = [Convert]::FromBase64String($hnPayload)
$hnInput = New-Object IO.MemoryStream(,$hnBytes)
$hnGzip = New-Object IO.Compression.GzipStream($hnInput, [IO.Compression.CompressionMode]::Decompress)
$hnReader = New-Object IO.StreamReader($hnGzip, [Text.Encoding]::UTF8)
$hnScript = $hnReader.ReadToEnd()
$hnReader.Dispose()
. ([scriptblock]::Create($hnScript))
`;
  encoded = encodePowerShell(loader);
  return encoded;
}

function posixCwdSetup(remoteCwd) {
  return `
PATH="$HOME/.hn/bin:$PATH"
export PATH
hn_cwd=${quotePosix(remoteCwd)}
case "$hn_cwd" in
  /*) ;;
  *) hn_cwd="$HOME/$hn_cwd" ;;
esac
cd -- "$hn_cwd"
`;
}

function windowsManagedToolSetup() {
  return `
$hnBin = Join-Path $HOME '.hn\\bin'
if (Test-Path -LiteralPath $hnBin -PathType Container) {
  $env:Path = "$hnBin$([IO.Path]::PathSeparator)$env:Path"
}
Remove-Variable hnBin -ErrorAction SilentlyContinue
`;
}

// Process-local only: Handoff must not edit the worker's PowerShell profile
// or change Windows' keyboard settings.
export function windowsPowerShellReadLineSetup() {
  return `
$hnPSReadLine = Get-Module -ListAvailable -Name PSReadLine
if ($hnPSReadLine) {
  try {
    Import-Module PSReadLine -ErrorAction Stop
    Set-PSReadLineKeyHandler -Chord 'Alt+Backspace' -Function BackwardKillWord -ErrorAction Stop
  } catch { }
}
Remove-Variable hnPSReadLine -ErrorAction SilentlyContinue
`;
}

// Herdr accepts an executable, not a shell command line, for pane shells.
// This shim keeps its panes on the same Handoff-owned bootstrap as hn pc.
export function windowsPowerShellBootstrapCommand() {
  return `@echo off\r\npowershell.exe -NoLogo -NoExit -File "%USERPROFILE%\\.hn\\shell.ps1"\r\n`;
}

export function windowsShellBootstrapScript(useEnvironment = true) {
  const directories = useEnvironment
    ? `$global:hnAgentDirectories = if ($env:HN_HANDOFF_AGENT_DIRECTORIES) { @($env:HN_HANDOFF_AGENT_DIRECTORIES -split [IO.Path]::PathSeparator | ForEach-Object { if ([IO.Path]::IsPathRooted($_)) { $_ } else { Join-Path (Get-Location) $_ } }) } else { @() }`
    : "$global:hnAgentDirectories = @()";
  const settings = useEnvironment
    ? "$global:hnClaudeSettings = if ($env:HN_HANDOFF_CLAUDE_SETTINGS -and [IO.Path]::IsPathRooted($env:HN_HANDOFF_CLAUDE_SETTINGS)) { $env:HN_HANDOFF_CLAUDE_SETTINGS } elseif ($env:HN_HANDOFF_CLAUDE_SETTINGS) { Join-Path $HOME $env:HN_HANDOFF_CLAUDE_SETTINGS } else { $null }"
    : "$global:hnClaudeSettings = $null";
  return `${windowsPowerShellReadLineSetup()}
$hnClaudeCommand = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
$hnCodexCommand = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
$global:hnClaudeApplication = if ($hnClaudeCommand.CommandType -eq 'Alias') { $hnClaudeCommand.Definition } else { $hnClaudeCommand.Source }
$global:hnCodexApplication = if ($hnCodexCommand.CommandType -eq 'Alias') { $hnCodexCommand.Definition } else { $hnCodexCommand.Source }
${directories}
${settings}
if ($global:hnClaudeApplication) {
  Remove-Item Alias:claude -Force -ErrorAction SilentlyContinue
  function global:claude {
    $hnArguments = @($args)
    $hnManagement = @('update', 'install', 'auth', 'agents', 'attach', 'auto-mode', 'logs', 'mcp', 'plugin', 'plugins', 'project')
    $hnFirst = if ($hnArguments.Count) { ([string]$hnArguments[0]).ToLowerInvariant() } else { '' }
    if ($hnManagement -contains $hnFirst) { & $global:hnClaudeApplication @hnArguments; return }
    if ($global:hnClaudeSettings -and -not ($hnArguments -contains '--settings')) { $hnArguments += @('--settings', $global:hnClaudeSettings) }
    $hnSeparator = [Array]::IndexOf($hnArguments, '--')
    if ($hnSeparator -ge 0) {
      $hnBefore = if ($hnSeparator -gt 0) { @($hnArguments[0..($hnSeparator - 1)]) } else { @() }
      $hnAfter = @($hnArguments[$hnSeparator..($hnArguments.Count - 1)])
      & $global:hnClaudeApplication @hnBefore '--add-dir' @($global:hnAgentDirectories) @hnAfter
      return
    }
    & $global:hnClaudeApplication @hnArguments '--add-dir' @($global:hnAgentDirectories)
  }
}
if ($global:hnCodexApplication) {
  Remove-Item Alias:codex -Force -ErrorAction SilentlyContinue
  function global:codex {
    $hnArguments = @($args)
    $hnManagement = @('agents', 'login', 'logout', 'mcp', 'plugin', 'mcp-server', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'execpolicy', 'apply', 'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive')
    $hnFirst = if ($hnArguments.Count) { ([string]$hnArguments[0]).ToLowerInvariant() } else { '' }
    if ($hnManagement -contains $hnFirst) { & $global:hnCodexApplication @hnArguments; return }
    $hnDirectoryArguments = @($global:hnAgentDirectories | ForEach-Object { '--add-dir'; $_ })
    & $global:hnCodexApplication @hnDirectoryArguments @hnArguments
  }
}
Remove-Variable hnClaudeCommand, hnCodexCommand -ErrorAction SilentlyContinue
`;
}

function windowsInvocation(command, args) {
  const rest = args.map((arg) => arg === HANDOFF_CLAUDE_SETTINGS_TOKEN
    ? "(Join-Path $HOME '.hn\\claude-settings.json')"
    : quotePowerShell(arg)).join(", ");
  return `
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
}

function windowsInteractiveShellSetup(agentDirs = [], claudeSettings = "") {
  const directories = agentDirs.map(quotePowerShell).join(", ");
  const settings = claudeSettings === HANDOFF_CLAUDE_SETTINGS_TOKEN
    ? "(Join-Path $HOME '.hn\\claude-settings.json')"
    : quotePowerShell(claudeSettings);
  return `$env:HN_HANDOFF_AGENT_DIRECTORIES = @(${directories}) -join [IO.Path]::PathSeparator
$env:HN_HANDOFF_CLAUDE_SETTINGS = ${settings}
${windowsShellBootstrapScript()}
foreach ($hnCommandName in @('claude', 'codex', 'cursor')) {
  $hnResolvedCommand = Get-Command $hnCommandName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hnResolvedCommand -and $hnResolvedCommand.CommandType -eq 'ExternalScript') {
    $hnApplication = Get-Command $hnCommandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hnApplication) { Set-Alias -Name $hnCommandName -Value $hnApplication.Source -Scope Global }
  }
}
Remove-Variable hnCommandName, hnResolvedCommand, hnApplication -ErrorAction SilentlyContinue
`;
}

export function interactivePowerShellArgs(remoteCwd, commandArgs = [], options = {}) {
  const script = commandArgs.length
    ? `$ErrorActionPreference = 'Stop'\n${windowsManagedToolSetup()}\nSet-Location ${remotePathExpression(remoteCwd)}\n${windowsInvocation(commandArgs[0], commandArgs.slice(1))}`
    : `${windowsManagedToolSetup()}\nSet-Location ${remotePathExpression(remoteCwd)}\n${windowsInteractiveShellSetup(options.agentDirs, options.claudeSettings)}`;
  return [
    "powershell.exe",
    "-NoLogo",
    ...(commandArgs.length ? [] : ["-NoExit"]),
    "-EncodedCommand",
    interactiveEncodedPowerShell(script),
  ];
}

export function interactivePosixScript(remoteCwd, commandArgs = []) {
  const command = commandArgs.length
    ? commandArgs.map((arg) => arg === HANDOFF_CLAUDE_SETTINGS_TOKEN
      ? '"$HOME/.hn/claude-settings.json"'
      : quotePosix(arg)).join(" ")
    : '"${SHELL:-sh}" -l';
  return `${posixCwdSetup(remoteCwd)}\nexec ${command}`;
}

// ssh reports its own transport failures as 255, and a remote program is free
// to exit 255 too. Ask the connection before blaming it: that keeps ordinary
// failures quiet and still tells the user when the link is what broke.
export const SSH_TRANSPORT_EXIT = 255;

export function sshTransportFailed(worker, code, probe = testSsh) {
  if (code !== SSH_TRANSPORT_EXIT) return false;
  return probe(worker).code !== 0;
}

// The remote program owns the exit code here, so the caller decides what a
// non-zero one means. Reporting every one as "SSH command failed" turns an
// ordinary quit into an alarm. A Windows worker returns 0 either way: OpenSSH
// drops the remote status once a pty is allocated.
export function runInteractiveRemoteCommand(worker, remoteCwd, commandArgs = [], options = {}) {
  if (worker.platform === "windows") {
    return runSsh(worker, interactivePowerShellArgs(remoteCwd, commandArgs, options), {
      tty: true,
      allowFailure: true,
    });
  }
  return runPosix(worker, interactivePosixScript(remoteCwd, commandArgs), {
    tty: true,
    allowFailure: true,
  });
}

export function runRemoteCommand(worker, remoteCwd, commandArgs) {
  if (worker.platform === "windows") {
    const [command, ...args] = commandArgs;
    const script = `
$ErrorActionPreference = 'Stop'
${windowsManagedToolSetup()}
Set-Location ${remotePathExpression(remoteCwd)}
${windowsInvocation(command, args)}
`;
    return runPowerShell(worker, script);
  }

  const command = commandArgs.map((arg) => arg === HANDOFF_CLAUDE_SETTINGS_TOKEN
    ? '"$HOME/.hn/claude-settings.json"'
    : quotePosix(arg)).join(" ");
  return runPosix(worker, `${posixCwdSetup(remoteCwd)}\nexec ${command}`);
}
