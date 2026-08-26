import { basename } from "node:path";
import { encodePowerShell, runPowerShell, runSsh } from "./ssh.js";
import { remotePathExpression } from "./worker.js";
import { quotePowerShell, shortHash, slug } from "./util.js";

function zellijExpression() {
  return `(Join-Path $HOME '.handoff\\bin\\zellij.exe')`;
}

export function sessionNameFor(workspaceName, root, commandArgs) {
  const label = `${workspaceName}-${basename(root.local)}-${commandArgs[0] ?? "shell"}`;
  return `${slug(label)}-${shortHash(`${root.local}:${commandArgs.join("\u0000")}`)}`;
}

export function ensurePersistentCommand(worker, sessionName, remoteCwd, commandArgs) {
  const command = commandArgs[0];
  const rest = commandArgs.slice(1);
  const restArray = rest.map(quotePowerShell).join(", ");
  const script = `
$ErrorActionPreference = 'Stop'
$z = ${zellijExpression()}
$session = ${quotePowerShell(sessionName)}
$cwd = ${remotePathExpression(remoteCwd)}
& $z --session $session action list-panes --json *> $null
$exists = ($LASTEXITCODE -eq 0)
if (-not $exists) {
  & $z attach --create-background $session
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Start-Sleep -Milliseconds 300
  $cmd = ${quotePowerShell(command)}
  $rest = @(${restArray})
  & $z --session $session run --cwd $cwd --name ${quotePowerShell(command)} -- $cmd @rest
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
`;
  runPowerShell(worker, script, { capture: true });
}

export function attachSession(worker, sessionName) {
  const script = `
$z = ${zellijExpression()}
& $z attach ${quotePowerShell(sessionName)}
exit $LASTEXITCODE
`;
  return runSsh(
    worker,
    ["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encodePowerShell(script)],
    { tty: true },
  );
}

export function listSessions(worker) {
  const script = `$z = ${zellijExpression()}; & $z list-sessions`;
  return runPowerShell(worker, script, { capture: true, allowFailure: true });
}
