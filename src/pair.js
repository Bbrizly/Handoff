import { existsSync, mkdirSync, readFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fail } from "./util.js";

const SSH_DIR = join(homedir(), ".ssh");
const DEFAULT_KEYS = ["id_ed25519", "id_rsa", "id_ecdsa"];
const WINDOWS_BOOTSTRAP_PATH = fileURLToPath(new URL("../scripts/windows-bootstrap.ps1", import.meta.url));

function usableKey(base) {
  return existsSync(base) && existsSync(`${base}.pub`);
}

export function ensureControllerSshKey() {
  mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(SSH_DIR, 0o700); } catch {}

  for (const name of DEFAULT_KEYS) {
    const base = join(SSH_DIR, name);
    if (usableKey(base)) {
      return { privateKey: base, publicKey: readFileSync(`${base}.pub`, "utf8").trim(), created: false };
    }
  }

  const base = join(SSH_DIR, "id_ed25519");
  const result = spawnSync(
    "ssh-keygen",
    ["-q", "-t", "ed25519", "-N", "", "-C", "hn", "-f", base],
    { encoding: "utf8" },
  );
  if (result.error) fail(`ssh-keygen failed to start: ${result.error.message}`);
  if ((result.status ?? 1) !== 0 || !usableKey(base)) {
    fail(`Could not create SSH key: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  try { chmodSync(base, 0o600); } catch {}
  return { privateKey: base, publicKey: readFileSync(`${base}.pub`, "utf8").trim(), created: true };
}

export function windowsPairCommand(publicKey) {
  // Pairing is intentionally self-contained: the elevated Windows shell executes
  // the bootstrap bundled with this exact hn install, never mutable GitHub main.
  const encodedKey = Buffer.from(String(publicKey).trim(), "utf8").toString("base64");
  const bootstrap = readFileSync(WINDOWS_BOOTSTRAP_PATH, "utf8");
  const encodedBootstrap = Buffer.from(bootstrap, "utf8").toString("base64");
  return `$k=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedKey}')); $s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedBootstrap}')); & ([ScriptBlock]::Create($s)) -PublicKey $k`;
}
