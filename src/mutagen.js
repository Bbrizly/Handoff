import { spawnSync } from "node:child_process";
import { shortHash, fail, quotePosix } from "./util.js";

const DEFAULT_IGNORES = [
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  ".output/",
  "target/",
  ".gradle/",
  "__pycache__/",
  "*.pyc",
  ".DS_Store",
];

export function commandExists(command) {
  if (process.platform === "win32") {
    return spawnSync("where", [command], { stdio: "ignore" }).status === 0;
  }
  return spawnSync("sh", ["-lc", `command -v ${quotePosix(command)}`], { stdio: "ignore" }).status === 0;
}

export function isMutagenInstalled() {
  return commandExists("mutagen");
}

export function ensureMutagen() {
  if (isMutagenInstalled()) return;
  if (process.platform === "darwin" && commandExists("brew")) {
    console.log("setting up Mutagen on this Mac...");
    const result = spawnSync("brew", ["install", "mutagen-io/mutagen/mutagen"], { stdio: "inherit" });
    if (result.status === 0 && isMutagenInstalled()) return;
  }
  fail("Mutagen is required on the controller. Install Mutagen and retry.");
}

function runMutagen(args, { capture = false, allowFailure = false, ensure = true } = {}) {
  if (ensure) ensureMutagen();
  if (!isMutagenInstalled()) {
    return { code: 127, stdout: "", stderr: "Mutagen is not installed" };
  }

  const result = spawnSync("mutagen", args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: capture ? "utf8" : undefined,
  });
  if (result.error) fail(`Mutagen failed to start: ${result.error.message}`);
  const code = result.status ?? 1;
  if (code !== 0 && !allowFailure) {
    const detail = capture ? (result.stderr || result.stdout || "").trim() : "";
    fail(`Mutagen failed (${code})${detail ? `: ${detail}` : ""}`);
  }
  return { code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function sessionNames(kind, { ensure = true } = {}) {
  const result = runMutagen(
    [kind, "list", "--template", "{{range .}}{{.Name}}\\n{{end}}"],
    { capture: true, allowFailure: true, ensure },
  );
  if (result.code !== 0) return [];
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function endpointHost(worker) {
  const host = worker.host.includes(":") ? `[${worker.host}]` : worker.host;
  return `${worker.user ? `${worker.user}@` : ""}${host}${worker.port && worker.port !== 22 ? `:${worker.port}` : ""}`;
}

export function mutagenEndpoint(worker, remotePath) {
  return `${endpointHost(worker)}:${remotePath}`;
}

export function workerIdentity(worker) {
  return `${worker.user ?? ""}@${worker.host}:${worker.port ?? 22}`;
}

export function syncSessionName(workspaceName, targetName, worker, root) {
  return `hn-sync-${shortHash(`${workspaceName}:${targetName}:${workerIdentity(worker)}:${root.local}:${root.remote}`)}`;
}

export function ensureSyncRoot(workspaceName, targetName, worker, root) {
  const name = syncSessionName(workspaceName, targetName, worker, root);
  if (sessionNames("sync").includes(name)) {
    runMutagen(["sync", "resume", name], { capture: true, allowFailure: true });
    return name;
  }

  const args = ["sync", "create", "--name", name, "--sync-mode", "two-way-safe", "--ignore-vcs"];
  for (const pattern of DEFAULT_IGNORES) args.push("--ignore", pattern);
  args.push(root.local, mutagenEndpoint(worker, root.remote));
  runMutagen(args);
  return name;
}

export function getSyncStatus(name) {
  if (!isMutagenInstalled()) return { state: "mutagen-missing", conflicts: 0 };
  if (!sessionNames("sync", { ensure: false }).includes(name)) {
    return { state: "not-started", conflicts: 0 };
  }

  const result = runMutagen(
    ["sync", "list", name, "--template", "{{range .}}{{.Status.Description}}|{{len .Conflicts}}{{end}}"],
    { capture: true, allowFailure: true, ensure: false },
  );
  if (result.code !== 0) return { state: "error", conflicts: 0 };
  const [description = "unknown", conflictText = "0"] = result.stdout.trim().split("|");
  return {
    state: description.trim().toLowerCase() || "unknown",
    conflicts: Number.parseInt(conflictText, 10) || 0,
  };
}

export function showSyncStatus(name) {
  if (!isMutagenInstalled()) {
    console.log("  Mutagen not installed");
    return;
  }
  if (!sessionNames("sync", { ensure: false }).includes(name)) {
    console.log("  not started");
    return;
  }
  runMutagen(["sync", "list", name], { ensure: false });
}

export function ensureForward(worker, key, remotePort, localPort = remotePort) {
  const name = `hn-port-${shortHash(`${workerIdentity(worker)}:${key}:${remotePort}:${localPort}`)}`;
  if (sessionNames("forward").includes(name)) {
    runMutagen(["forward", "resume", name], { capture: true, allowFailure: true });
    return name;
  }

  runMutagen([
    "forward", "create",
    "--name", name,
    `tcp:127.0.0.1:${localPort}`,
    mutagenEndpoint(worker, `tcp:127.0.0.1:${remotePort}`),
  ]);
  return name;
}
