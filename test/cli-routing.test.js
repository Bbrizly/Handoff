import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const routingUrl = new URL("../src/cli-routing.js", import.meta.url);

test("configured target aliases route to transparent interactive handoff", async () => {
  assert.equal(existsSync(fileURLToPath(routingUrl)), true, "interactive target routing module is missing");
  const { targetAliasInvocation } = await import(routingUrl);
  const config = { workers: { pc: {}, aws: {} } };

  assert.deepEqual(targetAliasInvocation(config, "pc", []), {
    targetName: "pc",
    commandArgs: [],
  });
  assert.deepEqual(targetAliasInvocation(config, "pc", ["claude", "--help"]), {
    targetName: "pc",
    commandArgs: ["claude", "--help"],
  });
  assert.equal(targetAliasInvocation(config, "claude", []), null);
});

