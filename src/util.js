import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";

export function expandHome(input) {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

export function slug(value) {
  const cleaned = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return cleaned || "session";
}

export function normalizeName(value, label = "name") {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || !/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    fail(`Invalid ${label} '${value}'. Use letters, numbers, '.', '_' or '-'.`);
  }
  return normalized;
}

export function shortHash(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

export function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function quotePosix(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
}

export function fail(message) {
  const error = new Error(message);
  error.name = "HnError";
  throw error;
}
