import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fail } from "./util.js";

export const SYNC_POLICY_VERSION = 2;
export const SYNC_MODE = "two-way-resolved";

// Mutagen treats patterns containing '/' as root-relative. Leaf-name patterns
// intentionally omit a slash so generated directories are ignored at *any*
// depth in a workspace containing many projects.
export const DEFAULT_IGNORES = [
  "node_modules",
  "dist",
  "build",
  "bin",
  "obj",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  "target",
  ".gradle",
  "DerivedData",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "__pycache__",
  "*.pyc",
  ".DS_Store",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "**/.claude/worktrees/",
];

export const AGENT_PROFILE_IGNORES = [
  "node_modules",
  ".DS_Store",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  ".venv",
  "venv",
  ".tox",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "__pycache__",
  "*.pyc",
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
const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

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

function isGeneratedWalkPath(rel, name, { agentProfile = false } = {}) {
  if (agentProfile && new Set(["dist", "build", "bin", "obj", "target"]).has(name)) {
    return false;
  }
  if (WALK_SKIP_DIRS.has(name)) return true;
  return rel === ".claude/worktrees" || rel.endsWith("/.claude/worktrees");
}

function walkRoot(rootLocal, visitor, { limit = 100, agentProfile = false } = {}) {
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
      const match = visitor({ entry, absolute, rel });
      if (match) {
        found.push(rel);
        continue;
      }
      if (entry.isDirectory() && !isGeneratedWalkPath(rel, entry.name, { agentProfile })) stack.push(absolute);
    }
  }

  return found;
}

export function findWindowsIncompatiblePaths(rootLocal, options = {}) {
  return walkRoot(
    rootLocal,
    ({ entry }) => !isWindowsCompatibleName(entry.name),
    options,
  );
}

export function isPortableSymlinkTarget(target) {
  const value = String(target ?? "");
  return value !== "" && !isAbsolute(value) && !WINDOWS_ABSOLUTE.test(value);
}

export function findNonPortableSymlinks(rootLocal, options = {}) {
  return walkRoot(
    rootLocal,
    ({ entry, absolute }) => {
      if (!entry.isSymbolicLink()) return false;
      try {
        const target = readlinkSync(absolute);
        if (!isPortableSymlinkTarget(target)) return true;
        const resolved = resolve(dirname(absolute), target);
        const rel = relative(rootLocal, resolved);
        return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
      } catch {
        return true;
      }
    },
    options,
  );
}

function safeExactIgnores(paths, rootLocal, reason) {
  for (const path of paths) {
    if (MUTAGEN_PATTERN_META.test(path)) {
      fail(`${reason} '${path}', and hn cannot safely auto-ignore that exact path because it contains ignore-pattern metacharacters. Rename it or add a safe parent path to ${join(rootLocal, ".hnignore")}.`);
    }
  }
  return paths;
}

function windowsCompatibilityIgnores(rootLocal, options = {}) {
  return safeExactIgnores(
    findWindowsIncompatiblePaths(rootLocal, options),
    rootLocal,
    "Windows cannot represent",
  );
}

function nonPortableSymlinkIgnores(rootLocal, options = {}) {
  return safeExactIgnores(
    findNonPortableSymlinks(rootLocal, options),
    rootLocal,
    "Mutagen portable symlink mode cannot synchronize",
  );
}

export function syncPolicy(root, worker) {
  const custom = readHnIgnore(root.local);
  if (worker.platform === "windows" && root.kind === "file" && !isWindowsCompatibleName(posix.basename(root.remote))) {
    fail(`Windows cannot represent remote file '${root.remote}'. Choose a compatible remote filename.`);
  }
  // The default finder limit is suitable for a diagnostic preview, but an
  // ignore policy must be complete. Large skill trees can contain hundreds of
  // projected links; stopping at 100 leaves later links as live scan errors.
  const scanOptions = { agentProfile: root.policy === "agent-profile", limit: 10_000 };
  const incompatible = worker.platform === "windows" ? windowsCompatibilityIgnores(root.local, scanOptions) : [];
  const nonPortableSymlinks = nonPortableSymlinkIgnores(root.local, scanOptions);
  return {
    version: SYNC_POLICY_VERSION,
    mode: SYNC_MODE,
    ignores: [...new Set([
      ...(root.policy === "agent-profile" ? AGENT_PROFILE_IGNORES : DEFAULT_IGNORES),
      ...custom,
      ...incompatible,
      ...nonPortableSymlinks,
    ])],
    incompatible,
    nonPortableSymlinks,
  };
}

export function syncPolicyFingerprint(roots, worker) {
  const policies = roots.map((root) => {
    const policy = syncPolicy(root, worker);
    return { local: root.local, remote: root.remote, ignores: policy.ignores };
  });
  return createHash("sha256")
    .update(JSON.stringify(policies))
    .digest("hex")
    .slice(0, 16);
}
