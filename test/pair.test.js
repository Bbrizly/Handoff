import test from "node:test";
import assert from "node:assert/strict";
import { windowsPairCommand } from "../src/pair.js";

function embeddedBase64(command) {
  return [...command.matchAll(/FromBase64String\('([^']+)'\)/g)].map((match) => match[1]);
}

test("Windows pairing command is self-contained and safely embeds the public key", () => {
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey hn";
  const command = windowsPairCommand(key);
  const payloads = embeddedBase64(command);

  assert.equal(payloads.length, 2);
  assert.equal(Buffer.from(payloads[0], "base64").toString("utf8"), key);
  assert.ok(!command.includes(key));
  assert.doesNotMatch(command, /https?:\/\//i);
  assert.doesNotMatch(command, /Invoke-RestMethod|\birm\b/i);
});

test("bundled Windows bootstrap preserves an existing authorized-keys file", () => {
  const command = windowsPairCommand("ssh-ed25519 AAAATEST hn");
  const [, encodedBootstrap] = embeddedBase64(command);
  const bootstrap = Buffer.from(encodedBootstrap, "base64").toString("utf8");

  assert.match(bootstrap, /if \(-not \(Test-Path -LiteralPath \$authorizedFile\)\)/);
  assert.match(bootstrap, /Add-Content -LiteralPath \$authorizedFile/);
  assert.doesNotMatch(bootstrap, /New-Item -ItemType File -Path \$authorizedFile -Force/);
});
