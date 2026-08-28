import test from "node:test";
import assert from "node:assert/strict";
import { parseMcpList } from "../src/worker.js";

// Real 'claude mcp list' output. The command column can carry a token, so the
// parser must never keep it.
const OUTPUT = `Checking MCP server health...

context7: https://mcp.context7.com/mcp?apiKey=sk-secret (HTTP) - ✓ Connected
ios-simulator: /Users/x/.local/bin/uvx simlens-mcp - ✓ Connected
broken-one: npx -y @scope/thing - ✗ Failed to connect
needs-login: https://example.test/mcp (SSE) - ⚠ Needs authentication
`;

test("mcp inventory comes from Claude's own list and keeps no command text", () => {
  const servers = parseMcpList(OUTPUT);
  assert.deepEqual(servers, [
    { name: "context7", ok: true },
    { name: "ios-simulator", ok: true },
    { name: "broken-one", ok: false },
    { name: "needs-login", ok: false },
  ]);
  const serialized = JSON.stringify(servers);
  assert.doesNotMatch(serialized, /apiKey|sk-secret|npx|https?:/);
});

test("mcp inventory is empty rather than wrong when nothing is configured", () => {
  assert.deepEqual(parseMcpList("No MCP servers configured."), []);
  assert.deepEqual(parseMcpList(""), []);
  assert.deepEqual(parseMcpList(undefined), []);
});
