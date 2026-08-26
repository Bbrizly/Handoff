param(
  [Parameter(Mandatory = $true)]
  [string]$PublicKey
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this command in PowerShell as Administrator.'
}

$cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*' | Select-Object -First 1
if (-not $cap -or $cap.State -ne 'Installed') {
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
}

Set-Service -Name sshd -StartupType Automatic
Start-Service sshd

$authorizedFile = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
New-Item -ItemType File -Path $authorizedFile -Force | Out-Null
$existing = Get-Content -Path $authorizedFile -ErrorAction SilentlyContinue
if ($existing -notcontains $PublicKey) {
  Add-Content -Path $authorizedFile -Value $PublicKey
}
icacls.exe $authorizedFile /inheritance:r /grant '*S-1-5-32-544:F' /grant 'SYSTEM:F' | Out-Null

Restart-Service sshd
Write-Host "hn worker ready: $env:USERNAME"
