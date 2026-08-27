import test from "node:test";
import assert from "node:assert/strict";
import { chooseTarget, normalizeConfig } from "../src/config.js";

test("legacy worker-bound workspaces migrate to a global default target", () => {
  const config = normalizeConfig({
    workers: { pc: { target: "me@pc", host: "pc", port: 22 } },
    workspaces: {
      main: {
        worker: "pc",
        roots: [{ local: "/tmp/GitHub", remote: "handoff/main/GitHub" }],
      },
    },
  });
  assert.deepEqual(config.workspaces.main, {
    roots: [{ local: "/tmp/GitHub", remote: "hn/main/GitHub", kind: "directory" }],
    grants: [],
  });
  assert.equal(config.workers.pc.trust, "trusted");
  assert.equal(config.activeTarget, "pc");
  assert.equal(config.version, 5);
  assert.match(config.controllerId, /^[0-9a-f]{32}$/);
});

test("explicit default target wins when there is no terminal override", () => {
  const config = normalizeConfig({
    activeTarget: "aws",
    workers: {
      pc: { target: "me@pc" },
      aws: { target: "ubuntu@aws", trust: "remote" },
    },
    workspaces: {},
  });
  assert.equal(config.activeTarget, "aws");
  assert.equal(config.workers.aws.trust, "remote");
});

test("invalid default target falls back to a configured worker", () => {
  const config = normalizeConfig({
    activeTarget: "gone",
    workers: { home: { target: "me@home" } },
    workspaces: {},
  });
  assert.equal(config.activeTarget, "home");
});

test("target precedence is environment then shell then global default", () => {
  const config = normalizeConfig({
    activeTarget: "aws",
    workers: {
      pc: { target: "me@pc" },
      home: { target: "me@home" },
      aws: { target: "ubuntu@aws" },
    },
  });
  assert.equal(chooseTarget(config, { envTarget: "pc", shellTarget: "home" }), "pc");
  assert.equal(chooseTarget(config, { shellTarget: "home" }), "home");
  assert.equal(chooseTarget(config), "aws");
});

test("the controller id survives a reload", async () => {
  const { normalizeConfig } = await import("../src/config.js");
  const first = normalizeConfig({});
  const again = normalizeConfig(first);
  assert.equal(again.controllerId, first.controllerId);
  assert.notEqual(normalizeConfig({}).controllerId, first.controllerId);
});
