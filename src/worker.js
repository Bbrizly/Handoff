import { quotePowerShell, fail } from "./util.js";
import { runPowerShell, testSsh } from "./ssh.js";

export const ZELLIJ_VERSION = "0.45.0";
const ZELLIJ_URL = `https://github.com/zellij-org/zellij/releases/download/v${ZELLIJ_VERSION}/zellij-no-web-x86_64-pc-windows-msvc.zip`;
const ZELLIJ_SHA256 = "2c76164fd082ffa1ca815b5f4515b7a2eb45600b2e1d562650a31e9b69bd61f6";

export function remotePathExpression(remotePath) {
  if (/^[a-zA-Z]:[\\/]/.test(remotePath)) return quotePowerShell(remotePath);
  return `(Join-Path $HOME ${quotePowerShell(remotePath.replaceAll("/", "\\"))})`;
}

export function bootstrapWorker(worker, { quiet = false } = {}) {
  const ssh = testSsh(worker);
  if (ssh.code !== 0) fail(`Cannot SSH to ${worker.target}. ${ssh.stderr.trim()}`);

  const script = `
$ErrorActionPreference = 'Stop'
$base = Join-Path $HOME '.handoff\\bin'
$zellij = Join-Path $base 'zellij.exe'
New-Item -ItemType Directory -Force -Path $base | Out-Null
if (-not (Test-Path $zellij)) {
  $zip = Join-Path $env:TEMP 'handoff-zellij-${ZELLIJ_VERSION}.zip'
  Invoke-WebRequest -UseBasicParsing -Uri ${quotePowerShell(ZELLIJ_URL)} -OutFile $zip
  $actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
  if ($actual -ne ${quotePowerShell(ZELLIJ_SHA256)}) {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    throw "Zellij checksum mismatch"
  }
  Expand-Archive -Path $zip -DestinationPath $base -Force
  Remove-Item $zip -Force
}
& $zellij --version
`;

  const result = runPowerShell(worker, script, { capture: true });
  if (!quiet) console.log(`Worker ready: ${worker.target} (${result.stdout.trim()})`);
  return result.stdout.trim();
}

export function ensureRemoteDirectory(worker, remotePath) {
  const pathExpr = remotePathExpression(remotePath);
  runPowerShell(worker, `New-Item -ItemType Directory -Force -Path ${pathExpr} | Out-Null`);
}

export function doctorWorker(worker) {
  const ssh = testSsh(worker);
  const checks = { ssh: ssh.code === 0, zellij: false, claude: false, codex: false, node: false };
  if (!checks.ssh) return checks;

  const script = `
$zellij = Join-Path $HOME '.handoff\\bin\\zellij.exe'
@{
  zellij = (Test-Path $zellij)
  claude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
  codex = [bool](Get-Command codex -ErrorAction SilentlyContinue)
  node = [bool](Get-Command node -ErrorAction SilentlyContinue)
} | ConvertTo-Json -Compress
`;
  const result = runPowerShell(worker, script, { capture: true, allowFailure: true });
  if (result.code === 0) {
    try { Object.assign(checks, JSON.parse(result.stdout.trim())); } catch {}
  }
  return checks;
}
