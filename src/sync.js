// Synchronization/forwarding backend boundary.
//
// The CLI and higher-level product model depend on this module, not directly on
// Mutagen. Mutagen is the production backend today; a future Handoff-native sync
// engine can implement the same contract without changing project/target/session
// orchestration.

import * as mutagen from "./mutagen.js";

export const syncBackend = Object.freeze({
  id: "mutagen",
  ensureAvailable: mutagen.ensureMutagen,
  isAvailable: mutagen.isMutagenInstalled,
  ensureRoot: mutagen.ensureSyncRoot,
  flush: mutagen.flushSyncSessions,
  status: mutagen.getSyncStatus,
  sessionName: mutagen.syncSessionName,
  showStatus: mutagen.showSyncStatus,
  terminate: mutagen.terminateSyncSession,
});

export const forwardingBackend = Object.freeze({
  id: "mutagen",
  ensure: mutagen.ensureForward,
});

export const ensureSyncRoot = (...args) => syncBackend.ensureRoot(...args);
export const flushSyncSessions = (...args) => syncBackend.flush(...args);
export const getSyncStatus = (...args) => syncBackend.status(...args);
export const isSyncBackendInstalled = () => syncBackend.isAvailable();
export const syncSessionName = (...args) => syncBackend.sessionName(...args);
export const terminateSyncSession = (...args) => syncBackend.terminate(...args);
export const ensureForward = (...args) => forwardingBackend.ensure(...args);
