param(
  [Parameter(Mandatory = $true)]
  [string]$SessionName
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$hnZellijSocketDir = Join-Path $HOME '.hn\zellij-sockets'
New-Item -ItemType Directory -Force -Path $hnZellijSocketDir | Out-Null
$env:ZELLIJ_SOCKET_DIR = $hnZellijSocketDir

$z = Join-Path $HOME '.hn\bin\zellij.exe'
$logDir = Join-Path $HOME '.hn\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$safeSession = ($SessionName -replace '[^A-Za-z0-9._-]', '-').Trim('-')
if (-not $safeSession) { $safeSession = 'session' }
if ($safeSession.Length -gt 80) { $safeSession = $safeSession.Substring(0, 80) }
$logFile = Join-Path $logDir ("zellij-create-{0}.log" -f $safeSession)

try {
  $hnOutput = & $z attach --create-background $SessionName 2>&1
  $hnCode = $LASTEXITCODE
  $hnOutput | Out-File -FilePath $logFile -Encoding utf8
} catch {
  $_ | Out-String | Out-File -FilePath $logFile -Encoding utf8
  $hnCode = 1
}

Start-Sleep -Milliseconds 800
exit $hnCode
