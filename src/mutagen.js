import { spawnSync } from "node:child_process";
import { shortHash, fail } from "./util.js";

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

function commandExists(command) {
  return spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

export function ensureMutagen() {
  if (commandExists("mutagen")) return;
  if (process.platform === "darwin" && commandExists("brew")) {
    console.log("Mutagen is missing; installing it with Homebrew...");
    const result = spawnSync("brew", ["install", "mutagen-io/mutagen/mutagen"], { stdio: "inherit" });
    if (result.status === 0 && commandExists("mutagen")) return;
  }
  fail("Mutagen is required on the controller. Install it and retry.");
}

function runMutagen(args, { capture = false, allowFailure = false } = {}) {
  ensureMutagen();
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

function sessionNames(kind) {
  const result = runMutagen(
    [kind, "list", "--template", "{{range .}}{{.Name}}\\n{{end}}"],
    { capture: true, allowFailure: true },
  );
  if (result.code !== 0) return [];
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

export function mutagenEndpoint(worker, remotePath) {
  return worker.port && worker.port !== 22
    ? `${worker.target}:${worker.port}:${remotePath}`
    : `${worker.target}:${remotePath}`;
}

export function syncSessionName(workspaceName, root) {
  return `handoff-sync-${shortHash(`${workspaceName}:${root.local}:${root.remote}`)}`;
}

export function ensureSyncRoot(workspaceName, worker, root) {
  const name = syncSessionName(workspaceName, root);
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

export function showSyncStatus(name) {
  if (!sessionNames("sync").includes(name)) {
    console.log("  not started");
    return;
  }
  runMutagen(["sync", "list", name]);
}

export function ensureForward(worker, key, remotePort, localPort = remotePort) {
  const name = `handoff-port-${shortHash(`${key}:${remotePort}:${localPort}`)}`;
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
