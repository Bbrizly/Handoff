import test from "node:test";
import assert from "node:assert/strict";
import { paneMatchesCommand, sessionNameFor } from "../src/zellij.js";

const project = "/Users/me/GitHub/Palmier";

test("default session names are stable for the same target, project and command", () => {
  const a = sessionNameFor("main", "pc", project, ["claude"], "roots");
  const b = sessionNameFor("main", "pc", project, ["claude"], "roots");
  assert.equal(a, b);
});

test("different projects get different sessions even inside one sync root", () => {
  const palmier = sessionNameFor("main", "pc", project, ["claude"], "roots");
  const qcm = sessionNameFor("main", "pc", "/Users/me/GitHub/QCM", ["claude"], "roots");
  assert.notEqual(palmier, qcm);
});

test("different targets get different sessions", () => {
  const pc = sessionNameFor("main", "pc", project, ["claude"], "roots");
  const aws = sessionNameFor("main", "aws", project, ["claude"], "roots");
  assert.notEqual(pc, aws);
});

test("unique tokens create another session", () => {
  const normal = sessionNameFor("main", "pc", project, ["claude"], "roots");
  const another = sessionNameFor("main", "pc", project, ["claude"], "roots", "abcdef12");
  assert.notEqual(normal, another);
});

test("pane matching ignores exited processes", () => {
  assert.equal(paneMatchesCommand({ title: "hn:claude", exited: false, is_plugin: false }, ["claude"], "hn:claude"), true);
  assert.equal(paneMatchesCommand({ title: "hn:claude", exited: true, is_plugin: false }, ["claude"], "hn:claude"), false);
});

test("pane matching tolerates missing pane_command", () => {
  assert.equal(paneMatchesCommand({ title: "shell", exited: false, is_plugin: false }, ["claude"], "hn:claude"), false);
});
