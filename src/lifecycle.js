import {
  isSyncBackendInstalled,
  listSyncSessions,
  stopSyncSession,
  syncSessionName,
} from "./sync.js";
import { fail } from "./util.js";

export function matchingRootSyncRecords(config, workspaceName, roots, records) {
  const names = new Set();
  for (const [targetName, worker] of Object.entries(config.workers ?? {})) {
    for (const root of roots) names.add(syncSessionName(workspaceName, targetName, worker, root));
  }
  return records.filter((record) => names.has(record.name));
}

export function terminateRootSyncSessions(config, workspaceName, roots, backend = {}) {
  const installed = backend.isInstalled ?? isSyncBackendInstalled;
  const list = backend.list ?? listSyncSessions;
  const stop = backend.stop ?? stopSyncSession;
  if (!roots.length || !installed()) return [];

  const matches = matchingRootSyncRecords(config, workspaceName, roots, list());
  for (const record of matches) stop(record.identifier);

  const stoppedIds = new Set(matches.map((record) => record.identifier));
  const remaining = list().filter((record) => stoppedIds.has(record.identifier));
  if (remaining.length) {
    fail(`Could not verify shutdown of ${remaining.length} workspace sync session${remaining.length === 1 ? "" : "s"}; configuration was not changed.`);
  }
  return matches;
}

