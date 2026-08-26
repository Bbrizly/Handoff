import { runPosix, runPowerShell } from "./ssh.js";
import { remotePathExpression } from "./worker.js";
import { quotePosix, quotePowerShell } from "./util.js";

function posixCwdSetup(remoteCwd) {
  return `
hn_cwd=${quotePosix(remoteCwd)}
case "$hn_cwd" in
  /*) ;;
  *) hn_cwd="$HOME/$hn_cwd" ;;
esac
cd -- "$hn_cwd"
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

export function runRemoteCommand(worker, remoteCwd, commandArgs) {
  if (worker.platform === "windows") {
    const [command, ...args] = commandArgs;
    const script = `
$ErrorActionPreference = 'Stop'
Set-Location ${remotePathExpression(remoteCwd)}
${windowsInvocation(command, args)}
`;
    return runPowerShell(worker, script);
  }

  const command = commandArgs.map(quotePosix).join(" ");
  return runPosix(worker, `${posixCwdSetup(remoteCwd)}\nexec ${command}`);
}
