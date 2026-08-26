import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRemotePath,
  remotePathsOverlap,
  validateWorkerAssignment,
  workerEndpointsEqual,
} from "../src/workspace.js";

test("remote paths normalize to portable forward slashes", () => {
  assert.equal(normalizeRemotePath("~/hn\\main\\GitHub/"), "hn/main/GitHub");
});

test("remote paths reject parent traversal", () => {
  assert.throws(() => normalizeRemotePath("hn/main/../secret"), /cannot contain '\.\.'/);
});

test("remote path overlap detects nesting and equality", () => {
  assert.equal(remotePathsOverlap("hn/main/GitHub", "hn/main/GitHub/Palmier"), true);
  assert.equal(remotePathsOverlap("hn/main/GitHub", "HN/MAIN/GITHUB"), true);
});

test("sibling remote roots do not overlap", () => {
  assert.equal(remotePathsOverlap("hn/main/GitHub", "hn/main/Obsidian"), false);
});

test("worker endpoint equality uses user, host and port", () => {
  const a = { user: "me", host: "PC.local", port: 22 };
  const b = { user: "me", host: "pc.LOCAL", port: 22 };
  const c = { user: "me", host: "pc.local", port: 2222 };
  assert.equal(workerEndpointsEqual(a, b), true);
  assert.equal(workerEndpointsEqual(a, c), false);
});

test("a target name cannot silently move to another machine", () => {
  const config = { workers: { pc: { user: "me", host: "old-pc", port: 22, target: "me@old-pc" } } };
  assert.throws(
    () => validateWorkerAssignment(config, "pc", { user: "me", host: "new-pc", port: 22, target: "me@new-pc" }),
    /already points to/,
  );
});

test("one SSH endpoint cannot have two target aliases", () => {
  const config = { workers: { pc: { user: "me", host: "pc", port: 22, target: "me@pc" } } };
  assert.throws(
    () => validateWorkerAssignment(config, "home", { user: "me", host: "pc", port: 22, target: "me@pc" }),
    /already points to this SSH endpoint/,
  );
});
