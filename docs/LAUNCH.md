# Handoff launch brief

Working document for the 0.2.0 launch. Everything here is checked against
`README.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`,
`docs/KNOWN_ISSUES.md`, and the commit history. The claim list at the bottom is
the part to reread before writing any copy.

---

## 1. Positioning

**One line.** Your files and your Git stay on your laptop. Your compute happens
somewhere else.

**One paragraph.** Handoff is a local-first remote execution layer. It
synchronizes a workspace you choose to any SSH-reachable machine and drops you
into a real shell in the matching directory. Coding agents, builds, tests, dev
servers, and GPU work run on the other machine. Your editor, your working tree,
and your `.git` never move.

**The wedge.** Every existing answer moves something you did not want to move.
A remote IDE moves the editor. A dev container moves the environment. A cloud
workspace moves the repository. `git push` to move unfinished work moves your
history. Handoff moves only the execution.

**The proof of taste.** `.git` never synchronizes. That single decision is why
remote edits arrive as ordinary local Git changes and why there is no second
repository to reconcile. Lead with it.

### Target developer

A developer on a light laptop who owns a heavier machine and wants to point
coding agents at it. Concretely:

- edits locally in a real editor and will not give that up;
- has a desktop, a GPU laptop, a workstation, or a VM they already SSH into;
- runs Claude or Codex and wants those runs off the laptop;
- wants local Git to stay authoritative;
- does not want a hosted development environment to become mandatory.

The reference setup is a macOS controller and a native Windows worker. That is
the pairing most tools handle worst, which makes it the sharpest demo.

### Not the audience

Teams wanting a shared hosted workspace. Anyone who wants Handoff to provision
machines. Anyone looking for a remote desktop.

### Competitive framing

Name the category, not competitors. "Remote execution, not a remote IDE" does
the work. If pushed on VS Code Remote or a dev container: those put the editor
or the environment on the other side. Handoff puts only the command there.

---

## 2. Feature hierarchy

Lead with the first tier. The second tier is what convinces someone who already
believes the first. The third tier only comes up in a docs deep-dive.

**Tier 1, the reason to care**

1. `hn pc` opens a native shell in the matching remote directory, already synced.
2. `.git` stays on the controller. Remote edits appear as ordinary Git changes.
3. Native Windows workers with no WSL.

**Tier 2, the reason to trust it**

4. A safety gate refuses to start remote work on a conflicted or unhealthy sync.
5. `hn access` tells you whether a given path is shared, and why not if it is not.
6. Credentials, MCP auth, plugin state, and history never leave the controller.
7. Handoff installs its own pinned, checksum-verified Mutagen and Herdr.

**Tier 3, the reason to stay**

8. `-p` opens a persistent desk of every synchronized project on that machine.
9. `hn profile enable claude` gives the worker's Claude your portable setup.
10. The worker's Claude renders your own statusline.
11. `hn port 5173` brings a remote dev server to local localhost.

---

## 3. Diagram storyboard

Four diagrams, in this order. Keep them faithful to `docs/ARCHITECTURE.md`. No
cloud stock art, no isometric servers.

**D1. What moves and what does not.** The README's existing ASCII block is
already correct and should stay. A rendered SVG version is the single highest
value asset: two boxes, one arrow of files going right, one arrow of localhost
coming back, and `.git` drawn firmly inside the left box. If only one image gets
made, make this one.

**D2. Path mapping.** `~/GitHub/Palmier` on the left, `~/hn/main/GitHub/Palmier`
on the right, `hn pc` as the arrow between them. This is the whole product in one
picture and it needs no words.

**D3. The trust boundary.** Two columns under the worker: **synchronized**
(workspace roots, project files, portable skill trees for trusted targets) and
**never sent** (credentials, `settings.json`, MCP auth, plugin state, history,
sessions, caches). Source of truth is `src/profile.js` and PRD section 10.
Verify the exact roots there before publishing.

**D4. The desk.** One sidebar, four projects, per-agent state chips. Only ship
this once there is a real screenshot. Do not draw a mock of a TUI that exists.

---

## 4. Demo plan

One capture, ninety seconds, no cuts, real machines. The Mac on the left, the
Windows laptop on the right, both visible.

```text
0:00  cd ~/GitHub/Palmier          local project, local editor open
0:05  hn pc                        sync, then a PowerShell prompt in the mapped dir
0:12  node -e "console.log(process.platform, process.arch)"   -> win32 x64
0:18  claude                       Claude opens, with the local statusline
0:30  ask it to edit one file
0:45  cmd-tab to the Mac           the edit is already in the editor
0:52  git diff                     an ordinary local diff, no remote repo
1:05  npm run dev                  on the worker
1:12  hn port 5173                 open localhost:5173 on the Mac
1:25  close the terminal mid-run
1:30  hn pc -p                     the desk comes back to the same processes
```

The beat that lands is 0:45 to 0:52. Everything before it is setup and everything
after it is proof.

Rules for the capture: real output only, no re-recorded terminal text, no sped-up
sync that hides how long a first seed takes. If the first seed is slow, say so on
screen. A demo that hides the seed cost will be the first complaint.

---

## 5. Release highlights for 0.2.0

Grounded in `CHANGELOG.md` and the merge history (PRs #10 through #17). Ordered
for a reader, not chronologically.

1. **The mapped terminal is the product.** Target aliases open a synchronized,
   path-mapped, native interactive PTY (#14).
2. **Native Windows without WSL.** One elevated command pairs a worker; shim
   resolution and stdin streaming fix the two failures that actually bite (#10).
3. **A persistent desk on `-p`.** Herdr-backed, installs on first use, survives
   disconnects, reuses the agent already running (#17).
4. **Your Claude, on their machine.** Portable skills and subagents to trusted
   targets, plus the controller's own statusline (#16, worker-claude-parity).
5. **It says what it shares.** `hn access`, trusted-target gating, and a doctor
   that reports MCP health from Claude rather than guessing.
6. **One persistence story.** The unproven Zellij surface was deleted rather than
   shipped alongside the desk.

Internal hardening not worth a headline: bootstrap split, duplicate sync repair,
sync policy fingerprinting, detach reporting, managed-asset repair.

---

## 6. Launch assets

**Where.** Hacker News Show HN, r/commandline, r/ClaudeAI, lobste.rs, and the
repo's own release page. Not Product Hunt; the audience is wrong.

**Show HN title.** "Show HN: Handoff, run coding agents on another machine while
your files and Git stay local". Plain, no adjectives.

**Show HN body.** Four short paragraphs: the problem in the author's own setup, the
one decision (`.git` never syncs), what is proven on real hardware, what is not.
Close with the honest limits. On this audience the limits section is what buys
credibility, so do not trim it.

**Repo social preview.** D1 rendered, product name, one line. No screenshot of
code.

**The README is the landing page.** There is no website and does not need to be
one for 0.2.0. If a site happens later it should be the README with D1 and D2
rendered, nothing more.

---

## 7. Discovery terms

Target the problem, not the buzzwords. Real phrasing people search:

- run Claude Code on another machine
- remote compute for local projects
- Mac to Windows development workflow
- SSH development workflow without a remote IDE
- keep git local, run builds remotely
- persistent coding agent sessions over SSH
- sync a workspace to a remote machine
- remote dev server on localhost
- native Windows dev worker without WSL

Do not stuff "AI agent orchestration", "agentic infrastructure", or "cloud
development platform" into copy. None of them describe what this does, and the
audience punishes them.

Repo topics: `ssh`, `remote-development`, `mutagen`, `developer-tools`,
`claude-code`, `windows`, `cli`, `file-sync`.

---

## 8. Claims that must not appear as shipped

Reread this before publishing anything. Each line is sourced.

**Never proven, do not claim**

- Worker reboot recovery. Nobody has rebooted the worker and run `hn pc -p`
  after. Arbitrary processes do not come back (`KNOWN_ISSUES.md` 18).
- The desk being lived in. Every mechanical step passes; an afternoon of real use
  has not happened (`KNOWN_ISSUES.md` 18).
- Controllers other than macOS. The managed Mutagen bootstrap is
  controller-platform-limited (`KNOWN_ISSUES.md` 13).
- Any platform outside the reference macOS controller plus native Windows worker.
  Linux and macOS workers are supported by architecture, not by a live test.

**Removed, do not mention as features**

- `hn session`, `hn new`, `hn attach`, `hn sessions`, and Zellij. Gone in 0.2.0
  (HN-076). If they surface in an old screenshot, retake it.

**Deferred, do not describe as coming**

- Remote Git bridge (HN-005), automatic port discovery (HN-045), toolchain
  installation (HN-029), MCP bridge (HN-048), first-class conflict resolution
  (HN-021), workspace root removal (HN-054), cloud provisioning (HN-046).

**Security phrasing that must stay exact**

- Say "credentials and auth state are never sent", not "everything is encrypted".
  The accurate claim is about what is excluded, not about transport.
- Profile roots reach trusted targets only. Never imply all targets.
- Persistent mode inspects pane output on the worker. That is how agent state is
  known. Say it plainly; it stays on the worker and nothing is uploaded
  (`KNOWN_ISSUES.md` 19). Do not let a privacy claim imply no inspection happens.
- Handoff verifies checksums for the binaries it installs. It does not audit
  Mutagen or Herdr themselves.

**Honesty about cost**

- The first workspace seed can be tens of thousands of files and multiple
  gigabytes (PRD 12.4). Any demo or copy that implies instant setup is a lie the
  first user will catch.
