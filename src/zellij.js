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

export function sessionNameFor(workspaceName, projectLocal, commandArgs, workspaceSalt = "", uniqueToken = "") {
  const command = commandArgs[0] ?? "shell";
  const label = `${workspaceName}-${basename(projectLocal)}-${command}`;
  const hash = shortHash(`${projectLocal}\u0000${commandArgs.join("\u0000")}\u0000${workspaceSalt}`);
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

function inspectSession(worker, sessionName) {
  const result = runZellij(
    worker,
    ["--session", sessionName, "action", "list-panes", "--json"],
    { capture: true, allowFailure: true },
  );
  if (result.code !== 0) return null;
  try {
    const panes = JSON.parse(result.stdout.trim());
    return Array.isArray(panes) ? panes : null;
  } catch {
    return null;
  }
}

function killSession(worker, sessionName) {
  runZellij(worker, ["kill-sessions", sessionName], { capture: true, allowFailure: true });
}

function createBackgroundSession(worker, sessionName) {
  runZellij(worker, ["attach", "--create-background", sessionName], { capture: true });
  const panes = inspectSession(worker, sessionName);
  if (!panes) fail(`Zellij session '${sessionName}' was created but could not be inspected.`);
  return panes;
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

function startCommandPane(worker, sessionName, paneId, remoteCwd, commandArgs, paneName) {
  if (worker.platform === "windows") {
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
      ...commandArgs.map(quotePowerShell),
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
  let panes = inspectSession(worker, sessionName);
  if (panes?.some((pane) => paneMatchesCommand(pane, commandArgs, paneName))) return;

  if (panes) killSession(worker, sessionName);
  panes = createBackgroundSession(worker, sessionName);
  const initialPane = panes.find((pane) => !pane.is_plugin && !pane.exited);
  if (!initialPane) fail(`Zellij session '${sessionName}' has no terminal pane.`);

  startCommandPane(worker, sessionName, initialPane.id, remoteCwd, commandArgs, paneName);
  const verified = inspectSession(worker, sessionName);
  if (!verified?.some((pane) => paneMatchesCommand(pane, commandArgs, paneName))) {
    fail(`Remote command '${commandArgs[0]}' did not start inside Zellij.`);
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
