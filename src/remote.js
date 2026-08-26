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

export function runRemoteCommand(worker, remoteCwd, commandArgs) {
  if (worker.platform === "windows") {
    const command = commandArgs[0];
    const rest = commandArgs.slice(1).map(quotePowerShell).join(", ");
    const script = `
$ErrorActionPreference = 'Stop'
Set-Location ${remotePathExpression(remoteCwd)}
$cmd = ${quotePowerShell(command)}
$hnArgs = @(${rest})
& $cmd @hnArgs
exit $LASTEXITCODE
`;
    return runPowerShell(worker, script);
  }

  const command = commandArgs.map(quotePosix).join(" ");
  return runPosix(worker, `${posixCwdSetup(remoteCwd)}\nexec ${command}`);
}
