import test from "node:test";
import assert from "node:assert/strict";
import { windowsPairCommand } from "../src/pair.js";

test("Windows pairing command embeds the public key without shell quoting hazards", () => {
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey hn";
  const command = windowsPairCommand(key);
  assert.match(command, /FromBase64String/);
  assert.match(command, /windows-bootstrap\.ps1/);
  assert.ok(!command.includes(key));
  const encoded = command.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), key);
});
