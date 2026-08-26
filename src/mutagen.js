import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { shortHash, fail, quotePosix } from "./util.js";

const MUTAGEN_VERSION = "0.18.1";
const MANAGED_MUTAGEN_DIR = join(homedir(), ".hn", "bin", `mutagen-v${MUTAGEN_VERSION}`);
const MANAGED_MUTAGEN_BINARY = join(
  MANAGED_MUTAGEN_DIR,
  process.platform === "win32" ? "mutagen.exe" : "mutagen",
);
const MANAGED_MUTAGEN_AGENTS = join(MANAGED_MUTAGEN_DIR, "mutagen-agents.tar.gz");

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

function managedMutagenReady() {
  return existsSync(MANAGED_MUTAGEN_BINARY) && existsSync(MANAGED_MUTAGEN_AGENTS);
}

function mutagenCommand() {
  if (managedMutagenReady()) return MANAGED_MUTAGEN_BINARY;
  if (commandExists("mutagen")) return "mutagen";
  return null;
}

export function isMutagenInstalled() {
  return mutagenCommand() !== null;
}

export function mutagenReleaseAsset(platform = process.platform, arch = process.arch) {
  const osName = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const archName = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
  if (!osName || !archName) return null;
  return `mutagen_${osName}_${archName}_v${MUTAGEN_VERSION}.tar.gz`;
}

export function checksumForAsset(contents, assetName) {
  for (const rawLine of String(contents).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && match[2].trim() === assetName) return match[1].toLowerCase();
  }
  return null;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function download(url, destination) {
  if (!commandExists("curl")) {
    fail("hn needs curl once to bootstrap Mutagen automatically.");
  }
  const result = spawnSync(
    "curl",
    ["-fsSL", "--retry", "3", "--retry-delay", "1", "-o", destination, url],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    fail(`Unable to download Mutagen: ${(result.stderr || "curl failed").trim()}`);
  }
}

function installManagedMutagen() {
  const asset = mutagenReleaseAsset();
  if (!asset) {
    fail(`Automatic Mutagen setup is not supported on ${process.platform}/${process.arch}. Install Mutagen and retry.`);
  }
  if (!commandExists("tar")) {
    fail("hn needs tar once to bootstrap Mutagen automatically.");
  }

  console.log(`setting up Mutagen ${MUTAGEN_VERSION}...`);
  const stage = mkdtempSync(join(tmpdir(), "hn-mutagen-"));
  const archive = join(stage, asset);
  const sums = join(stage, "SHA256SUMS");
  const base = `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}`;

  try {
    download(`${base}/SHA256SUMS`, sums);
    download(`${base}/${asset}`, archive);

    const expected = checksumForAsset(readFileSync(sums, "utf8"), asset);
    if (!expected) fail(`Official Mutagen checksum for '${asset}' was not found.`);
    const actual = sha256File(archive);
    if (actual !== expected) {
      fail(`Mutagen download checksum mismatch (expected ${expected}, got ${actual}).`);
    }

    const extracted = join(stage, "extracted");
    mkdirSync(extracted, { recursive: true });
    const unpack = spawnSync("tar", ["-xzf", archive, "-C", extracted], {
      stdio: ["ignore", "ignore", "pipe"],
      encoding: "utf8",
    });
    if ((unpack.status ?? 1) !== 0) {
      fail(`Unable to unpack Mutagen: ${(unpack.stderr || "tar failed").trim()}`);
    }

    const binaryName = process.platform === "win32" ? "mutagen.exe" : "mutagen";
    const extractedBinary = join(extracted, binaryName);
    const extractedAgents = join(extracted, "mutagen-agents.tar.gz");
    if (!existsSync(extractedBinary) || !existsSync(extractedAgents)) {
      fail("Official Mutagen archive did not contain the expected binary and agent bundle.");
    }

    mkdirSync(MANAGED_MUTAGEN_DIR, { recursive: true });
    copyFileSync(extractedBinary, MANAGED_MUTAGEN_BINARY);
    copyFileSync(extractedAgents, MANAGED_MUTAGEN_AGENTS);
    if (process.platform !== "win32") chmodSync(MANAGED_MUTAGEN_BINARY, 0o755);

    const verified = spawnSync(MANAGED_MUTAGEN_BINARY, ["version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if ((verified.status ?? 1) !== 0 || !`${verified.stdout}${verified.stderr}`.includes(MUTAGEN_VERSION)) {
      rmSync(MANAGED_MUTAGEN_DIR, { recursive: true, force: true });
      fail("Mutagen was installed but failed its version check.");
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function ensureMutagen() {
  if (isMutagenInstalled()) return;
  installManagedMutagen();
  if (!managedMutagenReady()) fail("Mutagen bootstrap did not complete successfully.");
}

function runMutagen(args, { capture = false, allowFailure = false, ensure = true } = {}) {
  if (ensure) ensureMutagen();
  const command = mutagenCommand();
  if (!command) {
    return { code: 127, stdout: "", stderr: "Mutagen is not installed" };
  }

  const result = spawnSync(command, args, {
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
  if (String(worker.host).includes(":")) {
    fail("Mutagen's SSH endpoint syntax cannot encode a literal IPv6 address. Use an SSH hostname/alias (for example Tailscale MagicDNS or ~/.ssh/config) for this target.");
  }
  return `${worker.user ? `${worker.user}@` : ""}${worker.host}${worker.port && worker.port !== 22 ? `:${worker.port}` : ""}`;
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
    return { name, created: false };
  }

  const args = ["sync", "create", "--name", name, "--sync-mode", "two-way-safe", "--ignore-vcs"];
  for (const pattern of DEFAULT_IGNORES) args.push("--ignore", pattern);
  args.push(root.local, mutagenEndpoint(worker, root.remote));
  runMutagen(args);
  return { name, created: true };
}

export function parseSyncStatusOutput(output) {
  const [description = "unknown", visibleText = "0", excludedText = "0"] = String(output).trim().split("|");
  const visible = Number.parseInt(visibleText, 10) || 0;
  const excluded = Number.parseInt(excludedText, 10) || 0;
  return {
    state: description.trim().toLowerCase() || "unknown",
    conflicts: visible + excluded,
  };
}

export function getSyncStatus(name) {
  if (!isMutagenInstalled()) return { state: "mutagen-missing", conflicts: 0 };
  if (!sessionNames("sync", { ensure: false }).includes(name)) {
    return { state: "not-started", conflicts: 0 };
  }

  const template = "{{range .}}{{.Status.Description}}|{{if .SessionState}}{{len .Conflicts}}|{{.ExcludedConflicts}}{{else}}0|0{{end}}{{end}}";
  const result = runMutagen(
    ["sync", "list", name, "--template", template],
    { capture: true, allowFailure: true, ensure: false },
  );
  if (result.code !== 0) return { state: "error", conflicts: 0 };
  return parseSyncStatusOutput(result.stdout);
}

export function flushSyncSessions(names) {
  const sessions = [...new Set(names.filter(Boolean))];
  if (!sessions.length) return;

  runMutagen(["sync", "flush", ...sessions], { capture: true });

  for (const name of sessions) {
    const status = getSyncStatus(name);
    if (status.conflicts > 0) {
      fail(`Mutagen sync '${name}' has ${status.conflicts} conflict${status.conflicts === 1 ? "" : "s"}. Run 'hn status' before starting remote work.`);
    }
    if (
      ["error", "mutagen-missing", "not-started"].includes(status.state)
      || status.state.includes("disconnected")
      || status.state.includes("halted")
      || status.state.includes("waiting for rescan")
    ) {
      fail(`Mutagen sync '${name}' is not healthy (${status.state}). Run 'hn status' for details.`);
    }
  }
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
