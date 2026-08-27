export function targetAliasInvocation(config, command, args = []) {
  const targetName = String(command ?? "").toLowerCase();
  if (!config.workers?.[targetName]) return null;
  return { targetName, commandArgs: [...args] };
}
