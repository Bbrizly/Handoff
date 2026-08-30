---
name: product-marketing
description: Use when preparing Handoff launch messaging, README visuals, diagrams, release notes, website copy, social graphics, demos, or developer-product positioning.
---

# Handoff product marketing

Handoff is developer infrastructure, not an App Store product. Do not force consumer-store marketing patterns onto it.

## Read first

- `README.md` for current product behavior.
- `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/CLI.md`, `docs/KNOWN_ISSUES.md`, and `docs/ROADMAP.md` before making claims.
- Recent commits and merged PRs before release marketing.

The strongest product story is continuity: local authoritative files and Git, compute/agents anywhere, with transparent remote shells and optional persistent workspaces.

## Hard rules

1. **Do not market roadmap items as current.** The docs explicitly separate proven, experimental, deferred, and known-broken behavior.
2. **Platform claims need proof.** Windows/Linux/macOS support must match current tested paths.
3. **Security/trust claims must match architecture.** Do not imply credentials, MCP auth, or private state are synchronized when the product intentionally excludes them.
4. **No fake terminal screenshots.** Use real commands/output or carefully labeled diagrams.
5. **Do not hide complexity with magic language.** Explain what Handoff actually does: SSH, synchronization, path mapping, agent/tool portability, and persistence.

## Visual strategy

Prefer technical visuals that explain the product in seconds:

- controller → worker architecture diagram;
- local files / remote compute flow;
- side-by-side local Zed + remote agent workflow;
- terminal demo of `hn pc`, `hn pc -p`, or profile sync;
- persistent desk screenshot when the real UI is available;
- trust/access diagram showing what is and is not synchronized.

Keep diagrams faithful to `docs/ARCHITECTURE.md`. Avoid generic cloud/server stock art.

## Launch/release workflow

1. Find the previous release/tag.
2. Read merged PRs and commits since it.
3. Separate user-facing improvements from internal hardening.
4. Group release notes by outcome: setup, reliability, persistence, portability, security, developer UX.
5. Capture only workflows changed enough to justify new visuals.
6. Call experimental behavior experimental when the docs do.

## Search/discovery

For GitHub/site SEO, target the real problem space: remote coding, remote compute for local projects, persistent coding agents, Mac-to-Windows development, SSH developer workflow, synchronized workspaces. Do not stuff unrelated AI-agent buzzwords into copy.

## Skill portability context

Handoff already synchronizes portable agent skill trees, including `.agents/skills` and Codex skill locations, to trusted workers. When marketing this feature, explain that credentials/settings/auth remain worker-local and verify the exact current paths in `src/profile.js` before publishing.

## Output contract

Produce:

- positioning and target developer;
- concise feature hierarchy;
- README/website diagram storyboard;
- real demo script/terminal capture plan;
- release highlights grounded in commits/docs;
- social/launch asset brief;
- SEO/discovery terms grounded in the actual use case;
- a separate list of experimental/blocked claims that must not appear as shipped features.
