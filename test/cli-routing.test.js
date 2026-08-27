import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const routingUrl = new URL("../src/cli-routing.js", import.meta.url);

test("configured target aliases route to transparent interactive handoff", async () => {
  assert.equal(existsSync(fileURLToPath(routingUrl)), true, "interactive target routing module is missing");
  const { parseTargetInvocation } = await import(routingUrl);
  const config = { workers: { pc: {}, aws: {} } };

  assert.deepEqual(parseTargetInvocation(config, "pc", []), {
    targetName: "pc",
    mode: "interactive",
    commandArgs: [],
  });
  assert.deepEqual(parseTargetInvocation(config, "pc", ["claude", "--help"]), {
    targetName: "pc",
    mode: "interactive",
    commandArgs: ["claude", "--help"],
  });
  assert.equal(parseTargetInvocation(config, "claude", []), null);
});

test("every persistence spelling means the same mode", async () => {
  const { parseTargetInvocation } = await import(routingUrl);
  const config = { workers: { pc: {} } };

  for (const flag of ["-p", "--p", "--persist"]) {
    assert.deepEqual(parseTargetInvocation(config, "pc", [flag]), {
      targetName: "pc",
      mode: "persistent",
      commandArgs: [],
    });
  }
  assert.deepEqual(parseTargetInvocation(config, "pc", ["-p", "claude"]), {
    targetName: "pc",
    mode: "persistent",
    commandArgs: ["claude"],
  });
});

test("a persistence flag after the remote command belongs to the remote command", async () => {
  const { parseModeArgs } = await import(routingUrl);

  assert.deepEqual(parseModeArgs(["npm", "run", "dev", "--", "--persist"]), {
    mode: "interactive",
    commandArgs: ["npm", "run", "dev", "--", "--persist"],
  });
  assert.deepEqual(parseModeArgs(["--", "npm", "run", "--persist"]), {
    mode: "interactive",
    commandArgs: ["npm", "run", "--persist"],
  });
  assert.deepEqual(parseModeArgs(["-p", "--", "foo", "--persist"]), {
    mode: "persistent",
    commandArgs: ["foo", "--persist"],
  });
});
