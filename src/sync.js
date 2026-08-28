// Synchronization/forwarding backend boundary.
//
// The CLI and higher-level product model depend on this module, not directly on
// Mutagen. Mutagen is the production backend today; a future Handoff-native sync
// engine can implement the same contract without changing project/target/session
// orchestration.

import * as mutagen from "./mutagen.js";
import {
  listHandoffForwards,
  listHandoffSyncs,
  terminateHandoffForward,
  terminateHandoffSync,
} from "./mutagen-admin.js";

export const syncBackend = Object.freeze({
  id: "mutagen",
  ensureAvailable: mutagen.ensureMutagen,
  isAvailable: mutagen.isMutagenInstalled,
  ensureRoot: mutagen.ensureSyncRoot,
  flush: mutagen.flushSyncSessions,
  status: mutagen.getSyncStatus,
  problems: mutagen.getSyncProblems,
  sessionName: mutagen.syncSessionName,
  showStatus: mutagen.showSyncStatus,
  listOwned: listHandoffSyncs,
  terminateOwned: terminateHandoffSync,
});

export const forwardingBackend = Object.freeze({
  id: "mutagen",
  ensure: mutagen.ensureForward,
  listOwned: listHandoffForwards,
  terminateOwned: terminateHandoffForward,
});

export const ensureSyncRoot = (...args) => syncBackend.ensureRoot(...args);
export const flushSyncSessions = (...args) => syncBackend.flush(...args);
export const assertHealthySync = (...args) => mutagen.assertHealthySync(...args);
export const getSyncStatus = (...args) => syncBackend.status(...args);
export const getSyncProblems = (...args) => syncBackend.problems(...args);
export const isSyncBackendInstalled = () => syncBackend.isAvailable();
export const syncSessionName = (...args) => syncBackend.sessionName(...args);
export const listSyncSessions = () => syncBackend.listOwned();
export const stopSyncSession = (...args) => syncBackend.terminateOwned(...args);
export const ensureForward = (...args) => forwardingBackend.ensure(...args);
export const listForwards = () => forwardingBackend.listOwned();
export const stopForward = (...args) => forwardingBackend.terminateOwned(...args);
