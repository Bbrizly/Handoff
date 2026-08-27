import { encodePowerShell, runPosix, runPowerShell, runSsh } from "./ssh.js";
import { remotePathExpression } from "./worker.js";
import { quotePosix, quotePowerShell } from "./util.js";

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

function windowsInteractiveShellSetup() {
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
`;
}

export function interactivePowerShellArgs(remoteCwd, commandArgs = []) {
  const script = commandArgs.length
    ? `$ErrorActionPreference = 'Stop'\n${windowsManagedToolSetup()}\nSet-Location ${remotePathExpression(remoteCwd)}\n${windowsInvocation(commandArgs[0], commandArgs.slice(1))}`
    : `${windowsManagedToolSetup()}\n${windowsInteractiveShellSetup()}\nSet-Location ${remotePathExpression(remoteCwd)}`;
  return [
    "powershell.exe",
    "-NoLogo",
    ...(commandArgs.length ? [] : ["-NoExit"]),
    "-EncodedCommand",
    encodePowerShell(script),
  ];
}

export function interactivePosixScript(remoteCwd, commandArgs = []) {
  const command = commandArgs.length
    ? commandArgs.map(quotePosix).join(" ")
    : '"${SHELL:-sh}" -l';
  return `${posixCwdSetup(remoteCwd)}\nexec ${command}`;
}

export function runInteractiveRemoteCommand(worker, remoteCwd, commandArgs = []) {
  if (worker.platform === "windows") {
    return runSsh(worker, interactivePowerShellArgs(remoteCwd, commandArgs), { tty: true });
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
