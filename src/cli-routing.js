// Target-level argument parsing.
//
// `hn pc -p` is a Handoff flag; `hn pc npm run dev -- --persist` is not. Flags
// are only read while they sit in front of the remote command.

const PERSIST_FLAGS = new Set(["-p", "--p", "--persist"]);

export function isPersistFlag(value) {
  return PERSIST_FLAGS.has(String(value ?? ""));
}

export function parseModeArgs(args = []) {
  const rest = [...args];
  let mode = "interactive";
  while (rest.length && isPersistFlag(rest[0])) {
    mode = "persistent";
    rest.shift();
  }
  if (rest[0] === "--") rest.shift();
  return { mode, commandArgs: rest };
}

export function parseTargetInvocation(config, command, args = []) {
  const targetName = String(command ?? "").toLowerCase();
  if (!config.workers?.[targetName]) return null;
  return { targetName, ...parseModeArgs(args) };
}
