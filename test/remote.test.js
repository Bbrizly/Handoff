import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import * as remote from "../src/remote.js";

function decodedPowerShell(args) {
  const encodedIndex = args.indexOf("-EncodedCommand");
  assert.notEqual(encodedIndex, -1, "interactive Windows invocation must use encoded PowerShell");
  const script = Buffer.from(args[encodedIndex + 1], "base64").toString("utf16le");
  const compressed = script.match(/\$hnPayload = '([^']+)'/);
  return compressed
    ? gunzipSync(Buffer.from(compressed[1], "base64")).toString("utf8")
    : script;
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
  assert.match(script, /Set-PSReadLineKeyHandler -Chord 'Alt\+Backspace' -Function BackwardKillWord/);
  assert.match(script, /Get-Module -ListAvailable -Name PSReadLine/);
});

test("interactive Windows shell wraps agents with every auxiliary workspace directory", () => {
  const args = remote.interactivePowerShellArgs(
    "hn/main/GitHub/Handoff",
    [],
    { agentDirs: ["../../Obsidian", "../../files"], claudeSettings: "__HN_CLAUDE_SETTINGS__" },
  );
  const script = decodedPowerShell(args);

  assert.match(script, /function global:claude/);
  assert.match(script, /function global:codex/);
  assert.match(script, /Remove-Item Alias:claude/);
  assert.match(script, /Remove-Item Alias:codex/);
  assert.match(script, /\.\.\/\.\.\/Obsidian/);
  assert.match(script, /\.\.\/\.\.\/files/);
  assert.match(script, /--add-dir/);
  assert.match(script, /hnClaudeSettings/);
  assert.match(script, /--settings/);
  assert.match(script, /claude-settings\.json/);
  assert.ok(args[args.indexOf("-EncodedCommand") + 1].length <= 6000);
});

test("Herdr's Windows pane shell reuses the scoped PSReadLine bootstrap", () => {
  const command = remote.windowsPowerShellBootstrapCommand();
  const script = remote.windowsShellBootstrapScript();
  assert.match(command, /^@echo off/);
  assert.match(command, /powershell\.exe -NoLogo -NoExit -File/);
  assert.match(script, /Get-Module -ListAvailable -Name PSReadLine/);
  assert.match(script, /Set-PSReadLineKeyHandler -Chord 'Alt\+Backspace' -Function BackwardKillWord/);
  assert.match(script, /function global:claude/);
  assert.match(script, /function global:codex/);
  assert.doesNotMatch(script, /profile|Set-PSReadLineOption|HKCU|HKLM/i);
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

// A remote program's exit code is its own. Only a dead connection earns a
// Handoff message, so 255 gets a cheap probe before it is called a link failure.
test("an ordinary remote failure never touches the connection", () => {
  let probed = 0;
  const probe = () => { probed += 1; return { code: 0 }; };
  const worker = { target: "me@pc" };
  assert.equal(remote.sshTransportFailed(worker, 0, probe), false);
  assert.equal(remote.sshTransportFailed(worker, 1, probe), false);
  assert.equal(remote.sshTransportFailed(worker, 130, probe), false);
  assert.equal(probed, 0);
});

test("a remote program that exits 255 on a live link is not a transport failure", () => {
  const probe = () => ({ code: 0, stdout: "hn-ok\n" });
  assert.equal(remote.sshTransportFailed({ target: "me@pc" }, 255, probe), false);
});

test("255 on a dead link is reported as a transport failure", () => {
  const probe = () => ({ code: 255, stdout: "", stderr: "connection refused" });
  assert.equal(remote.sshTransportFailed({ target: "me@pc" }, 255, probe), true);
});
