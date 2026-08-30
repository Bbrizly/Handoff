# CLAUDE.md: Handoff

Parent rules live in `../CLAUDE.md`. This file adds what is specific to Handoff.

## What it is

Handoff is a local-first remote execution layer. The CLI is `hn`. It synchronizes
a chosen workspace to an SSH-reachable worker and opens a real shell in the
matching remote directory. The controller keeps the editor, the working tree, and
the only `.git`.

Product name is **Handoff**. CLI is **`hn`**. Config lives in `~/.hn`. The remote
namespace is `~/hn/...`. Do not rename the CLI to `handoff`; that is HN-002.

## Stack

Node 20+, ESM, zero runtime dependencies. Tests use `node --test` only. Handoff
installs its own pinned Mutagen (controller) and Herdr (worker) and verifies both
by checksum.

## Commands

```bash
npm test              # node --test, the whole unit suite
npm run check         # hn --help and hn status, catches CLI wiring breaks
npm run test:integration   # real Mutagen, needs HN_INTEGRATION=1
npm link              # install hn from this checkout
```

Run `npm test` and `npm run check` before any commit. CI runs both on ubuntu,
macos, and windows.

## Docs are the contract

`docs/` is canonical, not decoration:

- `docs/PRD.md` is what the product should be.
- `docs/DECISIONS.md` is the decision ledger. Reversing an accepted decision means
  adding a superseding `HN-0xx` entry, never editing history in place.
- `docs/KNOWN_ISSUES.md` is what real hardware proved, including what failed.
- `docs/LAUNCH.md` is launch positioning, and section 8 lists claims that must not
  be made.

When code and docs disagree, the code describes today and the PRD describes the
intent. Fix both.

## Rules that bite

- **Never claim an unproven path.** The docs separate proven, experimental,
  deferred, and known-broken on purpose. Worker reboot recovery and non-macOS
  controllers are not proven. Do not let a README or a commit message imply they
  are.
- **The transparent terminal must not depend on persistence.** `prepareWorkerCore()`
  proves SSH and stops. The desk runtime installs only on `-p`. A broken desk must
  never break `hn pc`.
- **`.git` never synchronizes.** HN-004 and HN-015. Do not add a remote Git bridge
  to solve a local problem.
- **All Herdr knowledge lives in `src/herdr.js`.** Nothing outside that module
  builds a Herdr command line. Same idea for `src/mutagen.js`.
- **Windows is a real target, not a port.** Test PowerShell paths for quoting,
  execution policy, shim resolution, and command length. `2>NUL` creates a file
  called `NUL`; there is a test asserting it never comes back.
- Diagnostics only claim what Handoff can know. `hn doctor` reports what
  `claude mcp list` says and never reads the command column, which can hold a key.

## Testing on real hardware

The reference setup is a macOS controller and a native Windows worker. Anything
proven there gets a dated entry in `docs/KNOWN_ISSUES.md` with the actual output.
Anything not tested there stays marked unproven, even when the code looks right.
