import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { encodePowerShell, runPosix, runPowerShell, runSsh } from "./ssh.js";
import { remotePathExpression } from "./worker.js";
import { fail, quotePosix, quotePowerShell, shortHash, slug } from "./util.js";

function zellijPowerShellExpression() {
  return `(Join-Path $HOME '.hn\\bin\\zellij.exe')`;
}

function runZellij(worker, args, options = {}) {
  if (worker.platform === "windows") {
    const literals = args.map(quotePowerShell).join(", ");
    const script = `
$z = ${zellijPowerShellExpression()}
$hnArgs = @(${literals})
& $z @hnArgs
exit $LASTEXITCODE
`;
    return runPowerShell(worker, script, options);
  }

  const command = args.map(quotePosix).join(" ");
  return runPosix(worker, `z="$HOME/.hn/bin/zellij"; "$z" ${command}`, options);
}

export function sessionNameFor(workspaceName, targetName, projectLocal, commandArgs, workspaceSalt = "", uniqueToken = "") {
  const command = commandArgs[0] ?? "shell";
  const label = `${workspaceName}-${targetName}-${basename(projectLocal)}-${command}`;
  const hash = shortHash(`${targetName}\u0000${projectLocal}\u0000${commandArgs.join("\u0000")}\u0000${workspaceSalt}`);
  const suffix = uniqueToken ? `-${slug(uniqueToken).slice(0, 10)}` : "";
  return `${slug(label)}-${hash}${suffix}`;
}

export function newSessionToken() {
  return randomBytes(4).toString("hex");
}

function normalizeExecutable(value) {
  const leaf = String(value ?? "").trim().split(/[\\/]/).pop() ?? "";
  return leaf.toLowerCase().replace(/\.exe$/, "");
}

export function paneMatchesCommand(pane, commandArgs, paneName) {
  if (!pane || pane.is_plugin || pane.exited) return false;
  if (pane.title === paneName) return true;
  const expected = normalizeExecutable(commandArgs[0]);
  return expected !== "" && normalizeExecutable(pane.pane_command) === expected;
}

export function parsePaneListOutput(output) {
  const text = String(output ?? "").trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    // Be tolerant of harmless wrapper noise around otherwise-valid JSON.
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end < start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function sleepMs(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function inspectSession(worker, sessionName, { attempts = 1, delayMs = 125 } = {}) {
  let lastResult = { code: 1, stdout: "", stderr: "" };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastResult = runZellij(
      worker,
      ["--session", sessionName, "action", "list-panes", "--json"],
      { capture: true, allowFailure: true },
    );

    if (lastResult.code === 0) {
      const panes = parsePaneListOutput(lastResult.stdout);
      if (panes) return { panes, result: lastResult };
    }

    if (attempt < attempts - 1) sleepMs(delayMs);
  }

  return { panes: null, result: lastResult };
}

function diagnosticText(result) {
  if (!result) return "no diagnostic output";
  const pieces = [`exit ${result.code}`];
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  if (stdout) pieces.push(`stdout: ${stdout.slice(0, 1200)}`);
  if (stderr) pieces.push(`stderr: ${stderr.slice(0, 1200)}`);
  return pieces.join("; ");
}

function killSession(worker, sessionName) {
  runZellij(worker, ["kill-sessions", sessionName], { capture: true, allowFailure: true });
}

function createBackgroundSession(worker, sessionName) {
  runZellij(worker, ["attach", "--create-background", sessionName], { capture: true });
  const inspection = inspectSession(worker, sessionName, { attempts: 20, delayMs: 100 });
  if (!inspection.panes) {
    fail(`Zellij session '${sessionName}' was created but could not be inspected (${diagnosticText(inspection.result)}).`);
  }
  return inspection.panes;
}

function posixCwdSetup(remoteCwd) {
  return `
hn_cwd=${quotePosix(remoteCwd)}
case "$hn_cwd" in
  /*) ;;
  *) hn_cwd="$HOME/$hn_cwd" ;;
esac
`;
}

function windowsCommandRunner(commandArgs) {
  const command = commandArgs[0];
  const rest = commandArgs.slice(1).map(quotePowerShell).join(", ");
  const script = `
$ErrorActionPreference = 'Stop'
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
  return ["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encodePowerShell(script)];
}

function startCommandPane(worker, sessionName, paneId, remoteCwd, commandArgs, paneName) {
  if (worker.platform === "windows") {
    // Resolve .exe/.cmd/.bat applications before PowerShell script shims so
    // npm-installed tools still work under restrictive execution policies.
    const paneCommand = windowsCommandRunner(commandArgs);
    const elements = [
      quotePowerShell("--session"),
      quotePowerShell(sessionName),
      quotePowerShell("action"),
      quotePowerShell("new-pane"),
      quotePowerShell("--in-place"),
      quotePowerShell("--close-replaced-pane"),
      quotePowerShell("--pane-id"),
      quotePowerShell(String(paneId)),
      quotePowerShell("--cwd"),
      "$hnCwd",
      quotePowerShell("--name"),
      quotePowerShell(paneName),
      quotePowerShell("--"),
      ...paneCommand.map(quotePowerShell),
    ];
    const script = `
$ErrorActionPreference = 'Stop'
$z = ${zellijPowerShellExpression()}
$hnCwd = ${remotePathExpression(remoteCwd)}
$hnArgs = @(${elements.join(", ")})
& $z @hnArgs
exit $LASTEXITCODE
`;
    runPowerShell(worker, script, { capture: true });
    return;
  }

  const command = commandArgs.map(quotePosix).join(" ");
  const script = `${posixCwdSetup(remoteCwd)}
z="$HOME/.hn/bin/zellij"
"$z" --session ${quotePosix(sessionName)} action new-pane --in-place --close-replaced-pane --pane-id ${quotePosix(String(paneId))} --cwd "$hn_cwd" --name ${quotePosix(paneName)} -- ${command}
`;
  runPosix(worker, script, { capture: true });
}

export function ensurePersistentCommand(worker, sessionName, remoteCwd, commandArgs) {
  const paneName = `hn:${slug(commandArgs[0] ?? "shell").slice(0, 30)}`;
  let inspection = inspectSession(worker, sessionName, { attempts: 2, delayMs: 100 });
  let panes = inspection.panes;
  if (panes?.some((pane) => paneMatchesCommand(pane, commandArgs, paneName))) return;

  if (panes) killSession(worker, sessionName);
  panes = createBackgroundSession(worker, sessionName);
  const initialPane = panes.find((pane) => !pane.is_plugin && !pane.exited);
  if (!initialPane) fail(`Zellij session '${sessionName}' has no terminal pane.`);

  startCommandPane(worker, sessionName, initialPane.id, remoteCwd, commandArgs, paneName);
  inspection = inspectSession(worker, sessionName, { attempts: 20, delayMs: 100 });
  if (!inspection.panes?.some((pane) => paneMatchesCommand(pane, commandArgs, paneName))) {
    fail(`Remote command '${commandArgs[0]}' did not start inside Zellij (${diagnosticText(inspection.result)}).`);
  }
}

export function attachSession(worker, sessionName) {
  if (worker.platform === "windows") {
    const script = `
$z = ${zellijPowerShellExpression()}
& $z attach ${quotePowerShell(sessionName)}
exit $LASTEXITCODE
`;
    return runSsh(
      worker,
      ["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encodePowerShell(script)],
      { tty: true },
    );
  }

  return runPosix(
    worker,
    `exec "$HOME/.hn/bin/zellij" attach ${quotePosix(sessionName)}`,
    { tty: true },
  );
}

export function listSessions(worker) {
  return runZellij(worker, ["list-sessions"], { capture: true, allowFailure: true });
}

export function shellCommand(worker) {
  return worker.platform === "windows" ? ["powershell.exe", "-NoLogo"] : ["sh"];
}
