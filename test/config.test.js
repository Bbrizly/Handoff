import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig } from "../src/config.js";

test("legacy worker-bound workspaces migrate to a global active target", () => {
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
    roots: [{ local: "/tmp/GitHub", remote: "hn/main/GitHub" }],
  });
  assert.equal(config.activeTarget, "pc");
});

test("explicit active target wins", () => {
  const config = normalizeConfig({
    activeTarget: "aws",
    workers: {
      pc: { target: "me@pc" },
      aws: { target: "ubuntu@aws" },
    },
    workspaces: {},
  });
  assert.equal(config.activeTarget, "aws");
});

test("invalid active target falls back to a configured worker", () => {
  const config = normalizeConfig({
    activeTarget: "gone",
    workers: { home: { target: "me@home" } },
    workspaces: {},
  });
  assert.equal(config.activeTarget, "home");
});
