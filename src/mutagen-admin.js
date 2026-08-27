import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureMutagen, parseSessionRecords } from "./mutagen.js";
import { fail } from "./util.js";

const TEMPLATE = `{{range .}}{{.Name}}|{{.Identifier}}|{{.CreationTime}}
{{end}}`;

function command() {
  const managed = join(
    homedir(),
    ".hn",
    "bin",
    "mutagen-v0.18.1",
    process.platform === "win32" ? "mutagen.exe" : "mutagen",
  );
  if (existsSync(managed)) return managed;
  return "mutagen";
}

function run(args, { allowFailure = false } = {}) {
  ensureMutagen();
  const result = spawnSync(command(), args, { encoding: "utf8" });
  if (result.error) fail(`Mutagen failed to start: ${result.error.message}`);
  const code = result.status ?? 1;
  if (code !== 0 && !allowFailure) {
    fail(`Mutagen failed (${code}): ${(result.stderr || result.stdout || "").trim()}`);
  }
  return { code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function records(kind, prefix) {
  const result = run([kind, "list", "--template", TEMPLATE], { allowFailure: true });
  if (result.code !== 0) return [];
  return parseSessionRecords(result.stdout).filter((record) => record.name.startsWith(prefix));
}

export function listHandoffSyncs() {
  return records("sync", "hn-sync-");
}

export function listHandoffForwards() {
  return records("forward", "hn-port-");
}

function ownedRecord(kind, prefix, selector) {
  const matches = records(kind, prefix);
  return matches.find((record) => record.identifier === selector || record.name === selector) ?? null;
}

export function terminateHandoffSync(selector) {
  const record = ownedRecord("sync", "hn-sync-", selector);
  if (!record) fail(`Unknown Handoff sync '${selector}'.`);
  run(["sync", "terminate", record.identifier]);
  return record;
}

export function terminateHandoffForward(selector) {
  const record = ownedRecord("forward", "hn-port-", selector);
  if (!record) fail(`Unknown Handoff port forward '${selector}'.`);
  run(["forward", "terminate", record.identifier]);
  return record;
}
