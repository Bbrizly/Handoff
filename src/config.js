import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fail } from "./util.js";

const CONFIG_PATH = join(homedir(), ".hn", "config.json");
const LEGACY_CONFIG_PATH = join(homedir(), ".handoff", "config.json");

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizeConfig(input = {}) {
  const raw = objectOrEmpty(input);
  const workers = { ...objectOrEmpty(raw.workers) };
  const workspaces = {};
  const legacyWorkspaceTargets = [];

  for (const [name, workspaceInput] of Object.entries(objectOrEmpty(raw.workspaces))) {
    const workspace = objectOrEmpty(workspaceInput);
    const roots = Array.isArray(workspace.roots)
      ? workspace.roots.map((root) => ({
          ...root,
          remote: typeof root?.remote === "string"
            ? root.remote.replace(/^handoff\//, "hn/")
            : root?.remote,
        }))
      : [];
    const legacyTarget = workspace.defaultWorker ?? workspace.worker ?? null;
    if (legacyTarget) legacyWorkspaceTargets.push(legacyTarget);
    workspaces[name] = { roots };
  }

  const migratedTarget = legacyWorkspaceTargets.find((name) => workers[name]) ?? null;
  const requestedActive = raw.activeTarget ?? raw.activeWorker ?? migratedTarget ?? null;
  const activeTarget = requestedActive && workers[requestedActive]
    ? requestedActive
    : (Object.keys(workers)[0] ?? null);

  return {
    version: 2,
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

export function loadConfig() {
  if (existsSync(CONFIG_PATH)) return normalizeConfig(readConfig(CONFIG_PATH));
  if (existsSync(LEGACY_CONFIG_PATH)) {
    const migrated = normalizeConfig(readConfig(LEGACY_CONFIG_PATH));
    saveConfig(migrated);
    return migrated;
  }
  return normalizeConfig();
}

export function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(normalizeConfig(config), null, 2) + "\n", { mode: 0o600 });
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

export function resolveActiveTargetName(config) {
  if (config.activeTarget && config.workers[config.activeTarget]) return config.activeTarget;
  return Object.keys(config.workers)[0] ?? null;
}

export function setActiveTarget(config, name) {
  requireWorker(config, name);
  config.activeTarget = name;
  saveConfig(config);
}

export function configPath() {
  return CONFIG_PATH;
}
