import test from "node:test";
import assert from "node:assert/strict";
import { matchingRootSyncRecords, terminateRootSyncSessions } from "../src/lifecycle.js";
import { syncSessionName } from "../src/sync.js";

const worker = { user: "me", host: "pc", port: 22 };
const root = { local: "/code", remote: "hn/main/code" };
const config = { workers: { pc: worker } };

test("workspace lifecycle matches only the exact root sessions on every target", () => {
  const expected = { name: syncSessionName("main", "pc", worker, root), identifier: "one" };
  const unrelated = { name: "hn-sync-v2-unrelated", identifier: "two" };
  assert.deepEqual(matchingRootSyncRecords(config, "main", [root], [expected, unrelated]), [expected]);
});

test("workspace lifecycle stops and verifies sessions before config mutation", () => {
  const record = { name: syncSessionName("main", "pc", worker, root), identifier: "one" };
  let live = [record];
  const stopped = terminateRootSyncSessions(config, "main", [root], {
    isInstalled: () => true,
    list: () => live,
    stop: (identifier) => { live = live.filter((item) => item.identifier !== identifier); },
  });
  assert.deepEqual(stopped, [record]);
  assert.deepEqual(live, []);
});

test("workspace lifecycle refuses config mutation when shutdown cannot be verified", () => {
  const record = { name: syncSessionName("main", "pc", worker, root), identifier: "one" };
  assert.throws(() => terminateRootSyncSessions(config, "main", [root], {
    isInstalled: () => true,
    list: () => [record],
    stop: () => {},
  }), /configuration was not changed/);
});

