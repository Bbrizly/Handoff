import test from "node:test";
import assert from "node:assert/strict";
import {
  paneMatchesCommand,
  parsePaneListOutput,
  posixZellijRuntimeSetup,
  sessionNameFor,
  windowsDetachedZellijLaunchScript,
  windowsZellijRuntimeSetup,
} from "../src/zellij.js";

const project = "/Users/me/GitHub/Palmier";

test("default session names are stable and Handoff-prefixed", () => {
  const a = sessionNameFor("main", "pc", project, ["claude"], "roots");
  const b = sessionNameFor("main", "pc", project, ["claude"], "roots");
  assert.equal(a, b);
  assert.match(a, /^hn-/);
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

test("pane JSON parser accepts clean Zellij output", () => {
  const panes = [{ id: 0, is_plugin: false, title: "PowerShell", exited: false }];
  assert.deepEqual(parsePaneListOutput(JSON.stringify(panes)), panes);
});

test("pane JSON parser tolerates harmless wrapper noise", () => {
  const panes = [{ id: 0, is_plugin: false, title: "PowerShell", exited: false }];
  assert.deepEqual(parsePaneListOutput(`notice\n${JSON.stringify(panes)}\n`), panes);
});

test("pane JSON parser rejects non-JSON output", () => {
  assert.equal(parsePaneListOutput("session is still starting"), null);
});

test("Windows Zellij uses Handoff-owned socket and config directories", () => {
  const setup = windowsZellijRuntimeSetup();
  assert.match(setup, /ZELLIJ_SOCKET_DIR/);
  assert.match(setup, /ZELLIJ_CONFIG_DIR/);
  assert.match(setup, /\.hn\\zellij-sockets/);
  assert.match(setup, /\.hn\\zellij\\config/);
});

test("POSIX Zellij uses Handoff-owned socket and config directories", () => {
  const setup = posixZellijRuntimeSetup();
  assert.match(setup, /ZELLIJ_SOCKET_DIR/);
  assert.match(setup, /ZELLIJ_CONFIG_DIR/);
  assert.match(setup, /\.hn\/zellij-sockets/);
  assert.match(setup, /\.hn\/zellij\/config/);
});

test("Windows background Zellij creation escapes the OpenSSH process job", () => {
  const script = windowsDetachedZellijLaunchScript("hn-main-pc-handoff-claude-1234");
  assert.match(script, /Win32_ProcessStartup/);
  assert.match(script, /CreateFlags = \[uint32\]16777216/);
  assert.match(script, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/);
  assert.match(script, /EnvironmentVariables/);
  assert.match(script, /Detached Zellij launcher ran as/);
});
