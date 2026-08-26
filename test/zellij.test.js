import test from "node:test";
import assert from "node:assert/strict";
import { paneMatchesCommand, sessionNameFor } from "../src/zellij.js";

test("default session names are stable for the same project and command", () => {
  const a = sessionNameFor("main", "/Users/me/GitHub/Palmier", ["claude"], "roots");
  const b = sessionNameFor("main", "/Users/me/GitHub/Palmier", ["claude"], "roots");
  assert.equal(a, b);
});

test("different projects get different sessions even inside one sync root", () => {
  const palmier = sessionNameFor("main", "/Users/me/GitHub/Palmier", ["claude"], "roots");
  const qcm = sessionNameFor("main", "/Users/me/GitHub/QCM", ["claude"], "roots");
  assert.notEqual(palmier, qcm);
});

test("unique tokens create another session", () => {
  const normal = sessionNameFor("main", "/Users/me/GitHub/Palmier", ["claude"], "roots");
  const another = sessionNameFor("main", "/Users/me/GitHub/Palmier", ["claude"], "roots", "abcdef12");
  assert.notEqual(normal, another);
});

test("pane matching ignores exited processes", () => {
  assert.equal(paneMatchesCommand({ title: "hn:claude", exited: false, is_plugin: false }, ["claude"], "hn:claude"), true);
  assert.equal(paneMatchesCommand({ title: "hn:claude", exited: true, is_plugin: false }, ["claude"], "hn:claude"), false);
});

test("pane matching tolerates missing pane_command", () => {
  assert.equal(paneMatchesCommand({ title: "shell", exited: false, is_plugin: false }, ["claude"], "hn:claude"), false);
});
