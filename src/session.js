// Persistent-session backend boundary.
//
// Zellij is the production backend today. Higher-level Handoff orchestration
// imports this contract so a future backend can replace Zellij without changing
// target/workspace logic.

import * as zellij from "./zellij.js";

export const sessionBackend = Object.freeze({
  id: "zellij",
  ensureCommand: zellij.ensurePersistentCommand,
  attach: zellij.attachSession,
  list: zellij.listSessions,
  kill: zellij.killSession,
  nameFor: zellij.sessionNameFor,
  newToken: zellij.newSessionToken,
  shellCommand: zellij.shellCommand,
});

export const ensurePersistentCommand = (...args) => sessionBackend.ensureCommand(...args);
export const attachSession = (...args) => sessionBackend.attach(...args);
export const listSessions = (...args) => sessionBackend.list(...args);
export const killSession = (...args) => sessionBackend.kill(...args);
export const sessionNameFor = (...args) => sessionBackend.nameFor(...args);
export const newSessionToken = (...args) => sessionBackend.newToken(...args);
export const shellCommand = (...args) => sessionBackend.shellCommand(...args);
