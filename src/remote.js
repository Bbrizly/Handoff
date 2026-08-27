import { gzipSync } from "node:zlib";
import { encodePowerShell, runPosix, runPowerShell, runSsh } from "./ssh.js";
import { remotePathExpression } from "./worker.js";
import { quotePosix, quotePowerShell } from "./util.js";

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

function windowsInvocation(command, args) {
  const rest = args.map(quotePowerShell).join(", ");
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

function windowsInteractiveShellSetup(agentDirs = []) {
  const directories = agentDirs.map(quotePowerShell).join(", ");
  const agentWrappers = agentDirs.length ? `
$hnClaudeCommand = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
$hnCodexCommand = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
$global:hnClaudeApplication = if ($hnClaudeCommand.CommandType -eq 'Alias') { $hnClaudeCommand.Definition } else { $hnClaudeCommand.Source }
$global:hnCodexApplication = if ($hnCodexCommand.CommandType -eq 'Alias') { $hnCodexCommand.Definition } else { $hnCodexCommand.Source }
$global:hnAgentDirectories = @(${directories})
if ($global:hnClaudeApplication) {
  Remove-Item Alias:claude -Force -ErrorAction SilentlyContinue
  function global:claude {
    $hnArguments = @($args)
    $hnDirectories = @($global:hnAgentDirectories)
    $hnManagement = @('update', 'install', 'auth', 'agents', 'attach', 'auto-mode', 'logs', 'mcp', 'plugin', 'plugins', 'project')
    $hnFirst = if ($hnArguments.Count) { ([string]$hnArguments[0]).ToLowerInvariant() } else { '' }
    if ($hnManagement -contains $hnFirst) {
      & $global:hnClaudeApplication @hnArguments
      return
    }
    $hnSeparator = [Array]::IndexOf($hnArguments, '--')
    if ($hnSeparator -ge 0) {
      $hnBefore = if ($hnSeparator -gt 0) { @($hnArguments[0..($hnSeparator - 1)]) } else { @() }
      $hnAfter = @($hnArguments[$hnSeparator..($hnArguments.Count - 1)])
      & $global:hnClaudeApplication @hnBefore '--add-dir' @hnDirectories @hnAfter
      return
    }
    & $global:hnClaudeApplication @hnArguments '--add-dir' @hnDirectories
  }
}
if ($global:hnCodexApplication) {
  Remove-Item Alias:codex -Force -ErrorAction SilentlyContinue
  function global:codex {
    $hnArguments = @($args)
    $hnManagement = @('agents', 'login', 'logout', 'mcp', 'plugin', 'mcp-server', 'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'execpolicy', 'apply', 'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive')
    $hnFirst = if ($hnArguments.Count) { ([string]$hnArguments[0]).ToLowerInvariant() } else { '' }
    if ($hnManagement -contains $hnFirst) {
      & $global:hnCodexApplication @hnArguments
      return
    }
    $hnDirectoryArguments = @($global:hnAgentDirectories | ForEach-Object { '--add-dir'; $_ })
    & $global:hnCodexApplication @hnDirectoryArguments @hnArguments
  }
}
Remove-Variable hnClaudeCommand, hnCodexCommand -ErrorAction SilentlyContinue
` : "";
  return `
foreach ($hnCommandName in @('claude', 'codex', 'cursor')) {
  $hnResolvedCommand = Get-Command $hnCommandName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hnResolvedCommand -and $hnResolvedCommand.CommandType -eq 'ExternalScript') {
    $hnApplication = Get-Command $hnCommandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hnApplication) {
      Set-Alias -Name $hnCommandName -Value $hnApplication.Source -Scope Global
    }
  }
}
Remove-Variable hnCommandName, hnResolvedCommand, hnApplication -ErrorAction SilentlyContinue
${agentWrappers}
`;
}

export function interactivePowerShellArgs(remoteCwd, commandArgs = [], options = {}) {
  const script = commandArgs.length
    ? `$ErrorActionPreference = 'Stop'\n${windowsManagedToolSetup()}\nSet-Location ${remotePathExpression(remoteCwd)}\n${windowsInvocation(commandArgs[0], commandArgs.slice(1))}`
    : `${windowsManagedToolSetup()}\n${windowsInteractiveShellSetup(options.agentDirs)}\nSet-Location ${remotePathExpression(remoteCwd)}`;
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
    ? commandArgs.map(quotePosix).join(" ")
    : '"${SHELL:-sh}" -l';
  return `${posixCwdSetup(remoteCwd)}\nexec ${command}`;
}

export function runInteractiveRemoteCommand(worker, remoteCwd, commandArgs = [], options = {}) {
  if (worker.platform === "windows") {
    return runSsh(worker, interactivePowerShellArgs(remoteCwd, commandArgs, options), { tty: true });
  }
  return runPosix(worker, interactivePosixScript(remoteCwd, commandArgs), { tty: true });
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

  const command = commandArgs.map(quotePosix).join(" ");
  return runPosix(worker, `${posixCwdSetup(remoteCwd)}\nexec ${command}`);
}
