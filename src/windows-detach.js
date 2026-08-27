// Detached process launch for native Windows workers.
//
// Windows OpenSSH tears down descendants when the exec channel closes, so a
// background process started the obvious way dies with the SSH command. This
// spawns through WMI instead, breaking out of the sshd job object and giving
// the child a real (hidden) console.

import { encodePowerShell } from "./ssh.js";
import { quotePowerShell } from "./util.js";

// CREATE_BREAKAWAY_FROM_JOB (0x01000000) | CREATE_NEW_CONSOLE (0x00000010)
const CREATE_FLAGS = 16777232;

export function windowsDetachedLaunchScript(childScript, { marker = "hn-detached" } = {}) {
  const encoded = encodePowerShell(childScript);
  return `
$ErrorActionPreference = 'Stop'
$hnEnvironment = @(Get-ChildItem Env: | ForEach-Object { "$($_.Name)=$($_.Value)" })
$startup = New-CimInstance -CimClass (Get-CimClass -ClassName Win32_ProcessStartup) -ClientOnly
$startup.CreateFlags = [uint32]${CREATE_FLAGS}
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
  throw "The detached process exited before Handoff could verify it."
}
$owner = Invoke-CimMethod -InputObject $spawned -MethodName GetOwner -ErrorAction SilentlyContinue
if ($owner -and $owner.ReturnValue -eq 0 -and $owner.User -and $owner.User -ine $env:USERNAME) {
  try { Invoke-CimMethod -InputObject $spawned -MethodName Terminate -Arguments @{ Reason = 1 } | Out-Null } catch {}
  throw "The detached process ran as '$($owner.User)' instead of '$env:USERNAME'."
}
Write-Output ("${marker}:{0}" -f $created.ProcessId)
`;
}
