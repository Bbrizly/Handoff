import test from "node:test";
import assert from "node:assert/strict";
import { parseSshTarget, powerShellInvocation } from "../src/ssh.js";

test("parseSshTarget parses user and host", () => {
  assert.deepEqual(parseSshTarget("bassam@100.64.0.10"), {
    target: "bassam@100.64.0.10",
    host: "100.64.0.10",
    user: "bassam",
    port: 22,
  });
});

test("parseSshTarget parses a custom port", () => {
  const result = parseSshTarget("ubuntu@example.com:2222");
  assert.equal(result.target, "ubuntu@example.com");
  assert.equal(result.host, "example.com");
  assert.equal(result.port, 2222);
});

test("parseSshTarget parses bracketed IPv6", () => {
  const result = parseSshTarget("me@[fd7a:115c:a1e0::1]:2200");
  assert.equal(result.target, "me@fd7a:115c:a1e0::1");
  assert.equal(result.host, "fd7a:115c:a1e0::1");
  assert.equal(result.port, 2200);
});

test("short PowerShell scripts stay in EncodedCommand argv", () => {
  const invocation = powerShellInvocation("Write-Output 'ok'");
  assert.ok(invocation.args.includes("-EncodedCommand"));
  assert.equal(invocation.input, null);
});

test("large compressible PowerShell scripts use a short encoded loader", () => {
  const invocation = powerShellInvocation(`Write-Output '${"x".repeat(7000)}'`);
  assert.ok(invocation.args.includes("-EncodedCommand"));
  assert.equal(invocation.input, null);
  assert.ok(invocation.args.at(-1).length <= 6000);
});
