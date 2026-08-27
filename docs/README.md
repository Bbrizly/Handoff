# Handoff product documentation

This directory is the canonical product and engineering specification for Handoff (`hn`).

The implementation is the source of truth for current behavior. These documents capture the product intent, architecture, accepted decisions, rejected/deferred alternatives, known limitations, and roadmap so that a new engineer or AI agent can continue the project without reconstructing the design from chat history.

## Read in this order

1. [PRD.md](./PRD.md) — product requirements, user experience, scope, success criteria, and non-goals.
2. [ARCHITECTURE.md](./ARCHITECTURE.md) — controller/worker architecture, data flow, synchronization, sessions, Git, networking, configuration, and security boundaries.
3. [DECISIONS.md](./DECISIONS.md) — canonical decision log, including accepted, deferred, rejected, and still-unproven decisions.
4. [CLI.md](./CLI.md) — command/UX contract for `hn`.
5. [KNOWN_ISSUES.md](./KNOWN_ISSUES.md) — issues proven by real hardware testing and the intended fixes.
6. [ROADMAP.md](./ROADMAP.md) — ordered product and engineering roadmap.

## Product in one sentence

> Handoff is a local-first remote execution layer that lets your normal computer use any SSH-reachable machine as invisible development horsepower while your editor, files, Git repository, terminal entry point, and browser remain local.

## Canonical naming

- Product: **Handoff**
- CLI: **`hn`**
- Configuration directory: **`~/.hn`**
- Remote workspace namespace: **`~/hn/...`**

Do not rename the CLI to `handoff`. The short `hn` command is an intentional product decision.

## Documentation rule

When implementation and documentation disagree:

1. Treat current implementation as the description of what ships today.
2. Treat the PRD and accepted decisions as the description of what the product should become.
3. Update both code and docs when an accepted behavior changes.
4. Never silently resurrect an explicitly rejected design from `DECISIONS.md`.
