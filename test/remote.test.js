import test from "node:test";
import assert from "node:assert/strict";
import * as remote from "../src/remote.js";

function decodedPowerShell(args) {
  const encodedIndex = args.indexOf("-EncodedCommand");
  assert.notEqual(encodedIndex, -1, "interactive Windows invocation must use encoded PowerShell");
  return Buffer.from(args[encodedIndex + 1], "base64").toString("utf16le");
}

test("interactive Windows shell stays open in the mapped remote directory", () => {
  assert.equal(typeof remote.interactivePowerShellArgs, "function");
  const args = remote.interactivePowerShellArgs("hn/main/GitHub/Handoff", []);
  const script = decodedPowerShell(args);

  assert.ok(args.includes("-NoExit"));
  assert.ok(!args.includes("-NonInteractive"));
  assert.ok(!args.includes("-NoProfile"));
  assert.ok(!args.includes("-ExecutionPolicy"));
  assert.match(script, /Set-Location/);
  assert.match(script, /hn\\main\\GitHub\\Handoff/);
  assert.match(script, /Set-Alias/);
  assert.match(script, /-CommandType Application/);
  assert.match(script, /claude.*codex.*cursor/s);
  assert.match(script, /\.hn\\bin/);
  assert.match(script, /\$env:Path/);
});

test("interactive Windows command runs directly with PTY-capable PowerShell", () => {
  assert.equal(typeof remote.interactivePowerShellArgs, "function");
  const args = remote.interactivePowerShellArgs("hn/main/GitHub/Handoff", ["claude", "--version"]);
  const script = decodedPowerShell(args);

  assert.ok(!args.includes("-NoExit"));
  assert.ok(!args.includes("-NonInteractive"));
  assert.match(script, /Get-Command/);
  assert.match(script, /'claude'/);
  assert.match(script, /'--version'/);
  assert.match(script, /\.hn\\bin/);
  assert.match(script, /\$env:Path/);
});

test("interactive POSIX shell and direct command preserve the mapped cwd", () => {
  assert.equal(typeof remote.interactivePosixScript, "function");
  const shell = remote.interactivePosixScript("hn/main/GitHub/Handoff", []);
  const command = remote.interactivePosixScript("hn/main/GitHub/Handoff", ["npm", "run", "dev"]);

  assert.match(shell, /cd --/);
  assert.match(shell, /\.hn\/bin/);
  assert.match(shell, /PATH/);
  assert.match(shell, /exec \"\$\{SHELL:-sh\}\" -l/);
  assert.match(command, /\.hn\/bin/);
  assert.match(command, /exec 'npm' 'run' 'dev'/);
});
