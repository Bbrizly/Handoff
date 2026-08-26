import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRemotePath, remotePathsOverlap } from "../src/workspace.js";

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
