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
import { syncPolicy, SYNC_POLICY_VERSION } from "./sync-policy.js";
import { shortHash, fail, quotePosix } from "./util.js";

const MUTAGEN_VERSION = "0.18.1";
const MANAGED_MUTAGEN_DIR = join(homedir(), ".hn", "bin", `mutagen-v${MUTAGEN_VERSION}`);
const MANAGED_MUTAGEN_BINARY = join(
  MANAGED_MUTAGEN_DIR,
  process.platform === "win32" ? "mutagen.exe" : "mutagen",
);
const MANAGED_MUTAGEN_AGENTS = join(MANAGED_MUTAGEN_DIR, "mutagen-agents.tar.gz");

const SESSION_RECORD_TEMPLATE = `{{range .}}{{.Name}}|{{.Identifier}}|{{.CreationTime}}
{{end}}`;
const SYNC_STATUS_TEMPLATE = `{{range .}}{{.Status.Description}}|{{if .SessionState}}{{len .Conflicts}}|{{.ExcludedConflicts}}|{{len .Alpha.ScanProblems}}|{{len .Beta.ScanProblems}}|{{len .Alpha.TransitionProblems}}|{{len .Beta.TransitionProblems}}{{else}}0|0|0|0|0|0{{end}}
{{end}}`;
const SYNC_PROBLEMS_TEMPLATE = `{{range .}}{{range .Conflicts}}conflict|{{.Root}}|
{{end}}{{range .Alpha.ScanProblems}}local scan|{{.Path}}|{{.Error}}
{{end}}{{range .Beta.ScanProblems}}remote scan|{{.Path}}|{{.Error}}
{{end}}{{range .Alpha.TransitionProblems}}local write|{{.Path}}|{{.Error}}
{{end}}{{range .Beta.TransitionProblems}}remote write|{{.Path}}|{{.Error}}
{{end}}{{end}}`;

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

export function parseSessionRecords(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", identifier = "", creationTime = ""] = line.split("|");
      return { name, identifier, creationTime };
    })
    .filter((record) => record.identifier);
}

function sessionRecords(kind, { ensure = true } = {}) {
  const result = runMutagen(
    [kind, "list", "--template", SESSION_RECORD_TEMPLATE],
    { capture: true, allowFailure: true, ensure },
  );
  if (result.code !== 0) return [];
  return parseSessionRecords(result.stdout);
}

function namedSessions(kind, name, options = {}) {
  return sessionRecords(kind, options)
    .filter((record) => record.name === name)
    .sort((a, b) => String(a.creationTime).localeCompare(String(b.creationTime)));
}

function terminateNamedSessions(kind, name) {
  for (const record of namedSessions(kind, name)) {
    runMutagen([kind, "terminate", record.identifier], { capture: true, allowFailure: true });
  }
}

function repairDuplicateNamedSessions(kind, name, knownRecords = null) {
  const matches = (knownRecords
    ? knownRecords.filter((record) => record.name === name)
    : namedSessions(kind, name))
    .sort((a, b) => String(a.creationTime).localeCompare(String(b.creationTime)));
  if (!matches.length) return null;

  const [keeper, ...duplicates] = matches;
  for (const duplicate of duplicates) {
    runMutagen([kind, "terminate", duplicate.identifier], { capture: true, allowFailure: true });
  }
  return keeper;
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

function syncIdentity(workspaceName, targetName, worker, root) {
  const policy = root.policy ? `:${root.policy}` : "";
  return `${workspaceName}:${targetName}:${workerIdentity(worker)}:${root.local}:${root.remote}${policy}`;
}

export function legacySyncSessionName(workspaceName, targetName, worker, root) {
  return `hn-sync-${shortHash(syncIdentity(workspaceName, targetName, worker, root))}`;
}

export function syncSessionName(workspaceName, targetName, worker, root) {
  return `hn-sync-v${SYNC_POLICY_VERSION}-${shortHash(syncIdentity(workspaceName, targetName, worker, root))}`;
}

export function ensureSyncRoot(workspaceName, targetName, worker, root, options = {}) {
  const name = syncSessionName(workspaceName, targetName, worker, root);
  let session = repairDuplicateNamedSessions("sync", name, options.knownRecords);
  if (session) {
    return { name, identifier: session.identifier, created: false };
  }

  // Policy v2 changes the mode and ignore set. Old sessions lock their creation
  // configuration, so terminate the known v1 session before recreating it. This
  // never deletes endpoint data; it only removes Mutagen's session metadata.
  terminateNamedSessions("sync", legacySyncSessionName(workspaceName, targetName, worker, root));

  const policy = syncPolicy(root, worker);
  if (policy.incompatible.length) {
    const preview = policy.incompatible.slice(0, 3).join(", ");
    const extra = policy.incompatible.length > 3 ? ` (+${policy.incompatible.length - 3} more)` : "";
    console.warn(`hn: ${policy.incompatible.length} Windows-incompatible path${policy.incompatible.length === 1 ? "" : "s"} will stay local: ${preview}${extra}`);
  }

  const args = ["sync", "create", "--name", name, "--sync-mode", policy.mode, "--ignore-vcs"];
  for (const pattern of policy.ignores) args.push("--ignore", pattern);
  args.push(root.local, mutagenEndpoint(worker, root.remote));
  runMutagen(args, { capture: true });

  session = repairDuplicateNamedSessions("sync", name);
  if (!session) fail(`Mutagen created sync '${name}' but hn could not find it afterwards.`);
  return { name, identifier: session.identifier, created: true };
}

export function parseSyncStatusOutput(output) {
  const lines = String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { state: "not-started", conflicts: 0, problemCount: 0 };

  let conflicts = 0;
  let problemCount = 0;
  let state = "unknown";
  for (const line of lines) {
    const [
      description = "unknown",
      visibleText = "0",
      excludedText = "0",
      localScan = "0",
      remoteScan = "0",
      localWrite = "0",
      remoteWrite = "0",
    ] = line.split("|");
    state = description.trim().toLowerCase() || state;
    conflicts += (Number.parseInt(visibleText, 10) || 0) + (Number.parseInt(excludedText, 10) || 0);
    problemCount += [localScan, remoteScan, localWrite, remoteWrite]
      .reduce((total, value) => total + (Number.parseInt(value, 10) || 0), 0);
  }
  return { state, conflicts, problemCount };
}

// `sync list --template` is deliberately small and fast, but it omits the
// one line a person needs when a session is unhealthy: "Last error". Keep
// the detailed query off the healthy path and surface it when it matters.
export function parseSyncDetailOutput(output) {
  const match = String(output ?? "").match(/^Last error:\s*(.+)$/mi);
  return match ? match[1].trim() : "";
}

export function parseSyncProblemsOutput(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [type = "problem", path = "", ...error] = line.split("|");
      return { type, path, error: error.join("|") };
    });
}

export function getSyncProblems(session) {
  if (!isMutagenInstalled()) return [];
  const result = runMutagen(["sync", "list", session, "--template", SYNC_PROBLEMS_TEMPLATE], {
    capture: true,
    allowFailure: true,
    ensure: false,
  });
  return result.code === 0 ? parseSyncProblemsOutput(result.stdout) : [];
}

export function syncErrorAdvice(detail) {
  const text = String(detail ?? "").toLowerCase();
  if (text.includes("alpha scan error") && text.includes("operation not permitted")) {
    return "The controller denied Handoff access. On macOS, give the app running 'hn' Full Disk Access, reopen it, then run 'hn sync main'.";
  }
  if (text.includes("invalid symbolic link") || text.includes("symbolic link")) {
    return "Replace the absolute/non-portable symlink with a relative link, or exclude it if it is generated, then run 'hn sync'.";
  }
  if (text.includes("filename") || text.includes("directory name") || text.includes("invalid name")) {
    return "Rename the Windows-incompatible path on the Mac or exclude it intentionally, then run 'hn sync'.";
  }
  if (text.includes("connection") || text.includes("disconnected")) {
    return "Run 'hn doctor' to verify the worker, then run 'hn sync'.";
  }
  if (text.includes("root deletion") || text.includes("root emptied") || text.includes("root type")) {
    return "Inspect both workspace roots before resuming; synchronization stopped to prevent propagated deletion.";
  }
  return "Run 'hn sync doctor' for the affected root and exact path.";
}

export function getSyncStatus(session) {
  if (!isMutagenInstalled()) return { state: "mutagen-missing", conflicts: 0, problemCount: 0 };
  const result = runMutagen(
    ["sync", "list", session, "--template", SYNC_STATUS_TEMPLATE],
    { capture: true, allowFailure: true, ensure: false },
  );
  if (result.code !== 0) return { state: "not-started", conflicts: 0, problemCount: 0 };
  const status = parseSyncStatusOutput(result.stdout);
  const unhealthy = status.conflicts > 0
    || status.problemCount > 0
    || status.state.includes("waiting")
    || status.state.includes("disconnected")
    || status.state.includes("halted")
    || status.state === "error";
  if (!unhealthy) return status;

  const detail = runMutagen(["sync", "list", session], {
    capture: true,
    allowFailure: true,
    ensure: false,
  });
  const error = detail.code === 0 ? parseSyncDetailOutput(detail.stdout) : "";
  const problems = getSyncProblems(session);
  return { ...status, error, advice: error ? syncErrorAdvice(error) : "", problems };
}

export function assertHealthySync(session, status = getSyncStatus(session)) {
  if (status.conflicts > 0) {
    fail(`Mutagen sync '${session}' has ${status.conflicts} conflict${status.conflicts === 1 ? "" : "s"}. Run 'hn status' before starting remote work.`);
  }
  if (status.problemCount > 0) {
    const preview = (status.problems ?? []).slice(0, 3)
      .map((problem) => `\n  ${problem.type}: ${problem.path || "(root)"}${problem.error ? ` — ${problem.error}` : ""}`)
      .join("");
    fail(`Sync '${session}' has ${status.problemCount} filesystem problem${status.problemCount === 1 ? "" : "s"}.${preview}\n  Fix: Run 'hn sync doctor'.`);
  }
  if (
    ["error", "mutagen-missing", "not-started"].includes(status.state)
    || status.state.includes("disconnected")
    || status.state.includes("halted")
    // Mutagen includes its retry interval here (for example, "Waiting 5
    // seconds for rescan"), so matching the literal phrase misses exactly
    // the failure state we want to explain.
    || status.state.includes("rescan")
  ) {
    const reason = status.error ? `\n  Last error: ${status.error}` : "";
    const advice = status.advice ? `\n  Fix: ${status.advice}` : "\n  Fix: Run 'hn status' for details.";
    fail(`Mutagen sync '${session}' is not healthy (${status.state}).${reason}${advice}`);
  }
}

export function flushSyncSessions(sessions) {
  const requested = [...new Set(sessions.filter(Boolean))];
  if (!requested.length) return;

  runMutagen(["sync", "flush", ...requested], { capture: true });

  for (const session of requested) {
    assertHealthySync(session);
  }
}

export function showSyncStatus(session) {
  if (!isMutagenInstalled()) {
    console.log("  Mutagen not installed");
    return;
  }
  const result = runMutagen(["sync", "list", session], { capture: true, allowFailure: true, ensure: false });
  if (result.code !== 0 || !result.stdout.trim()) {
    console.log("  not started");
    return;
  }
  process.stdout.write(result.stdout);
}

export function terminateSyncSession(session) {
  runMutagen(["sync", "terminate", session], { capture: true, allowFailure: true });
}

export function ensureForward(worker, key, remotePort, localPort = remotePort) {
  const name = `hn-port-${shortHash(`${workerIdentity(worker)}:${key}:${remotePort}:${localPort}`)}`;
  let session = repairDuplicateNamedSessions("forward", name);
  if (session) {
    runMutagen(["forward", "resume", session.identifier], { capture: true, allowFailure: true });
    return session.identifier;
  }

  runMutagen([
    "forward", "create",
    "--name", name,
    `tcp:127.0.0.1:${localPort}`,
    mutagenEndpoint(worker, `tcp:127.0.0.1:${remotePort}`),
  ], { capture: true });

  session = repairDuplicateNamedSessions("forward", name);
  if (!session) fail(`Mutagen created forwarding session '${name}' but hn could not find it afterwards.`);
  return session.identifier;
}
