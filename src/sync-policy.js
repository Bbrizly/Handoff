import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fail } from "./util.js";

export const SYNC_POLICY_VERSION = 2;
export const SYNC_MODE = "two-way-resolved";

export const DEFAULT_IGNORES = [
  "node_modules/",
  "dist/",
  "build/",
  "bin/",
  "obj/",
  ".next/",
  ".nuxt/",
  ".output/",
  ".turbo/",
  "target/",
  ".gradle/",
  "DerivedData/",
  ".venv/",
  "venv/",
  ".tox/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".ruff_cache/",
  "__pycache__/",
  "*.pyc",
  ".DS_Store",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  ".claude/worktrees/",
];

const WALK_SKIP_DIRS = new Set([
  ".git", ".svn", ".hg",
  "node_modules", "dist", "build", "bin", "obj", ".next", ".nuxt", ".output",
  ".turbo", "target", ".gradle", "DerivedData", ".venv", "venv", ".tox",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__",
]);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const WINDOWS_INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/;
const MUTAGEN_PATTERN_META = /[!?*\[\]]/;

export function readHnIgnore(rootLocal) {
  const path = join(rootLocal, ".hnignore");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function isWindowsCompatibleName(name) {
  const value = String(name ?? "");
  if (!value || WINDOWS_INVALID_CHARS.test(value)) return false;
  if (/[. ]$/.test(value)) return false;
  return !WINDOWS_RESERVED.test(value);
}

function toSlash(value) {
  return String(value).replaceAll("\\", "/");
}

export function findWindowsIncompatiblePaths(rootLocal, { limit = 100 } = {}) {
  const found = [];
  const stack = [rootLocal];

  while (stack.length && found.length < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (found.length >= limit) break;
      const absolute = join(current, entry.name);
      const rel = toSlash(relative(rootLocal, absolute));
      if (!isWindowsCompatibleName(entry.name)) {
        found.push(rel);
        continue;
      }
      if (entry.isDirectory() && !WALK_SKIP_DIRS.has(entry.name)) stack.push(absolute);
    }
  }

  return found;
}

function windowsCompatibilityIgnores(rootLocal) {
  const paths = findWindowsIncompatiblePaths(rootLocal);
  for (const path of paths) {
    if (MUTAGEN_PATTERN_META.test(path)) {
      fail(`Windows cannot represent '${path}', and hn cannot safely auto-ignore that path because it contains ignore-pattern metacharacters. Rename it or add a safe parent path to ${join(rootLocal, ".hnignore")}.`);
    }
  }
  return paths;
}

export function syncPolicy(root, worker) {
  const custom = readHnIgnore(root.local);
  const incompatible = worker.platform === "windows" ? windowsCompatibilityIgnores(root.local) : [];
  return {
    version: SYNC_POLICY_VERSION,
    mode: SYNC_MODE,
    ignores: [...new Set([...DEFAULT_IGNORES, ...custom, ...incompatible])],
    incompatible,
  };
}
