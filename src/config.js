import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fail } from "./util.js";

const CONFIG_PATH = join(homedir(), ".handoff", "config.json");

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { workers: {}, workspaces: {} };
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      workers: parsed.workers ?? {},
      workspaces: parsed.workspaces ?? {},
    };
  } catch (error) {
    fail(`Could not read ${CONFIG_PATH}: ${error.message}`);
  }
}

export function saveConfig(config) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export function requireWorker(config, name) {
  const worker = config.workers[name];
  if (!worker) fail(`Unknown worker '${name}'.`);
  return worker;
}

export function requireWorkspace(config, name) {
  const workspace = config.workspaces[name];
  if (!workspace) fail(`Unknown workspace '${name}'.`);
  return workspace;
}

export function configPath() {
  return CONFIG_PATH;
}
