import { runPowerShell } from "./ssh.js";
import { remotePathExpression } from "./worker.js";
import { quotePowerShell } from "./util.js";

export function runRemoteCommand(worker, remoteCwd, commandArgs) {
  const command = commandArgs[0];
  const rest = commandArgs.slice(1).map(quotePowerShell).join(", ");
  const script = `
$ErrorActionPreference = 'Stop'
Set-Location ${remotePathExpression(remoteCwd)}
$cmd = ${quotePowerShell(command)}
$rest = @(${rest})
& $cmd @rest
exit $LASTEXITCODE
`;
  return runPowerShell(worker, script);
}
