import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fail } from "./util.js";

const CONFIG_VERSION = 5;
const HN_DIR = join(homedir(), ".hn");
const CONFIG_PATH = join(HN_DIR, "config.json");
const CONFIG_BACKUP_PATH = join(HN_DIR, "config.backup.json");
const CONFIG_LOCK_PATH = join(HN_DIR, ".config.lock");
const SHELL_TARGET_DIR = join(HN_DIR, "state", "targets");
const LEGACY_CONFIG_PATH = join(homedir(), ".handoff", "config.json");

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeTrust(value) {
  return value === "remote" ? "remote" : "trusted";
}

export function normalizeConfig(input = {}) {
  const raw = objectOrEmpty(input);
  const workers = {};
  for (const [name, workerInput] of Object.entries(objectOrEmpty(raw.workers))) {
    const worker = objectOrEmpty(workerInput);
    // Existing/legacy targets were explicitly configured by the user before the
    // trust model existed, so preserve compatibility by treating them as trusted.
    workers[name] = { ...worker, trust: normalizeTrust(worker.trust) };
  }

  const workspaces = {};
  const legacyWorkspaceTargets = [];

  for (const [name, workspaceInput] of Object.entries(objectOrEmpty(raw.workspaces))) {
    const workspace = objectOrEmpty(workspaceInput);
    const roots = Array.isArray(workspace.roots)
      ? workspace.roots.map((root) => ({
          ...root,
          kind: root?.kind === "file" ? "file" : "directory",
          remote: typeof root?.remote === "string"
            ? root.remote.replace(/^handoff\//, "hn/")
            : root?.remote,
        }))
      : [];
    const grants = Array.isArray(workspace.grants)
      ? [...new Set(workspace.grants.filter((value) => typeof value === "string" && value.trim()))]
      : [];
    const legacyTarget = workspace.defaultWorker ?? workspace.worker ?? null;
    if (legacyTarget) legacyWorkspaceTargets.push(legacyTarget);
    workspaces[name] = { roots, grants };
  }

  const migratedTarget = legacyWorkspaceTargets.find((name) => workers[name]) ?? null;
  const requestedActive = raw.activeTarget ?? raw.activeWorker ?? migratedTarget ?? null;
  const activeTarget = requestedActive && workers[requestedActive]
    ? requestedActive
    : (Object.keys(workers)[0] ?? null);

  // Identifies this controller so two laptops sharing a worker do not attach to
  // each other's persistent desk. Generated once, never regenerated.
  const controllerId = typeof raw.controllerId === "string" && /^[0-9a-f]{32}$/.test(raw.controllerId)
    ? raw.controllerId
    : randomBytes(16).toString("hex");

  return {
    version: CONFIG_VERSION,
    controllerId,
    activeTarget,
    workers,
    workspaces,
  };
}

function readConfig(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`Could not read ${path}: ${error.message}`);
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withConfigLock(callback) {
  mkdirSync(HN_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(HN_DIR, 0o700); } catch {}

  let acquired = false;
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      mkdirSync(CONFIG_LOCK_PATH, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - statSync(CONFIG_LOCK_PATH).mtimeMs;
        if (age > 30_000) {
          rmSync(CONFIG_LOCK_PATH, { recursive: true, force: true });
          continue;
        }
      } catch {}
      sleepMs(10);
    }
  }

  if (!acquired) fail("Could not acquire the hn config lock. Remove ~/.hn/.config.lock if no hn process is running.");
  try {
    return callback();
  } finally {
    rmSync(CONFIG_LOCK_PATH, { recursive: true, force: true });
  }
}

function atomicWriteConfig(config) {
  const normalized = normalizeConfig(config);
  const serialized = JSON.stringify(normalized, null, 2) + "\n";
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });

  if (existsSync(CONFIG_PATH)) {
    try { copyFileSync(CONFIG_PATH, CONFIG_BACKUP_PATH); } catch {}
  }

  const tempPath = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  let fd;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, CONFIG_PATH);
    try { chmodSync(CONFIG_PATH, 0o600); } catch {}

    // Best-effort directory fsync makes the rename durable on POSIX filesystems.
    try {
      const dirFd = openSync(dirname(CONFIG_PATH), "r");
      fsyncSync(dirFd);
      closeSync(dirFd);
    } catch {}
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    if (existsSync(tempPath)) rmSync(tempPath, { force: true });
  }
  return normalized;
}

function replaceConfigObject(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

export function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    const raw = readConfig(CONFIG_PATH);
    const normalized = normalizeConfig(raw);
    if (raw.version !== CONFIG_VERSION) saveConfig(normalized);
    return normalized;
  }
  if (existsSync(LEGACY_CONFIG_PATH)) {
    const migrated = normalizeConfig(readConfig(LEGACY_CONFIG_PATH));
    saveConfig(migrated);
    return migrated;
  }
  return normalizeConfig();
}

export function saveConfig(config) {
  return withConfigLock(() => atomicWriteConfig(config));
}

export function updateConfig(config, mutator) {
  return withConfigLock(() => {
    const latest = existsSync(CONFIG_PATH)
      ? normalizeConfig(readConfig(CONFIG_PATH))
      : normalizeConfig(config);
    const result = mutator(latest);
    const saved = atomicWriteConfig(latest);
    replaceConfigObject(config, saved);
    return result;
  });
}

export function requireWorker(config, name) {
  const worker = config.workers[name];
  if (!worker) fail(`Unknown target '${name}'. Add it with: hn worker add ${name} user@host`);
  return worker;
}

export function requireWorkspace(config, name) {
  const workspace = config.workspaces[name];
  if (!workspace) fail(`Unknown workspace '${name}'.`);
  return workspace;
}

export function chooseTarget(config, { envTarget = null, shellTarget = null } = {}) {
  for (const candidate of [envTarget, shellTarget, config.activeTarget]) {
    if (candidate && config.workers[candidate]) return candidate;
  }
  return Object.keys(config.workers)[0] ?? null;
}

function shellTargetPath(ppid = process.ppid) {
  return join(SHELL_TARGET_DIR, `${ppid}.target`);
}

export function readShellTarget(ppid = process.ppid) {
  const path = shellTargetPath(ppid);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export function resolveActiveTargetName(config) {
  const envTarget = String(process.env.HN_TARGET ?? "").trim() || null;
  if (envTarget && !config.workers[envTarget]) {
    fail(`HN_TARGET points to unknown target '${envTarget}'.`);
  }
  return chooseTarget(config, { envTarget, shellTarget: readShellTarget() });
}

export function setActiveTarget(config, name) {
  requireWorker(config, name);
  mkdirSync(SHELL_TARGET_DIR, { recursive: true, mode: 0o700 });
  const destination = shellTargetPath();
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, `${name}\n`, { mode: 0o600 });
  renameSync(temp, destination);
}

export function setDefaultTarget(config, name) {
  requireWorker(config, name);
  updateConfig(config, (latest) => {
    requireWorker(latest, name);
    latest.activeTarget = name;
  });
}

export function configPath() {
  return CONFIG_PATH;
}

export function configBackupPath() {
  return CONFIG_BACKUP_PATH;
}
