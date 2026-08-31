#!/usr/bin/env bash
set -euo pipefail

BRANCH="${HN_CODEX_DOGFOOD_BRANCH:-feat/codex-thin-client}"
REPO="${HN_HANDOFF_REPO:-$HOME/Documents/GitHub/Handoff}"
DOGFOOD="${HN_CODEX_DOGFOOD_DIR:-$HOME/.hn/dogfood/Handoff-codex-thin}"
PROJECT_CWD="${HN_CODEX_PROJECT_CWD:-$PWD}"

fail() {
  printf 'dogfood: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required"
command -v node >/dev/null 2>&1 || fail "node is required"
command -v codex >/dev/null 2>&1 || fail "Codex CLI is required on the Mac"
[ -d "$REPO/.git" ] || fail "Handoff repo not found at $REPO (override with HN_HANDOFF_REPO)"
[ -d "$PROJECT_CWD" ] || fail "project cwd does not exist: $PROJECT_CWD"

printf '\n== Handoff Codex thin dogfood ==\n'
printf 'project:  %s\n' "$PROJECT_CWD"
printf 'source:   %s\n' "$REPO"
printf 'dogfood:  %s\n\n' "$DOGFOOD"

git -C "$REPO" fetch origin "$BRANCH"
HEAD_SHA="$(git -C "$REPO" rev-parse "origin/$BRANCH")"

if [ -d "$DOGFOOD/.git" ] || git -C "$DOGFOOD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$DOGFOOD" fetch origin "$BRANCH"
  git -C "$DOGFOOD" checkout --detach "$HEAD_SHA"
else
  mkdir -p "$(dirname "$DOGFOOD")"
  git -C "$REPO" worktree add --detach "$DOGFOOD" "$HEAD_SHA"
fi

ACTUAL_SHA="$(git -C "$DOGFOOD" rev-parse HEAD)"
[ "$ACTUAL_SHA" = "$HEAD_SHA" ] || fail "dogfood checkout is not at branch head"

printf 'branch:   %s\n' "$BRANCH"
printf 'head:     %s\n' "$ACTUAL_SHA"
printf 'mac codex: '
codex --version
printf '\n'

cd "$PROJECT_CWD"

printf 'Preflight: Handoff will require the Windows worker Codex to expose remote/app-server support and match the Mac Codex version exactly.\n'
printf 'Launching strict mode now. Any compatibility or worker-side failure will fail closed instead of silently using the legacy remote terminal.\n\n'

HN_CODEX_TRANSPORT=app-server node "$DOGFOOD/src/index.js" codex
RESULT=$?

printf '\n== Local TUI exited ==\n'
printf 'The Windows app-server should still be alive. Checking it now:\n'
node "$DOGFOOD/src/index.js" codex-server status || true

printf '\nRe-open the same thin client with:\n'
printf '  cd %q && HN_CODEX_TRANSPORT=app-server node %q codex\n' "$PROJECT_CWD" "$DOGFOOD/src/index.js"
printf '\nStop the persistent backend only when you intentionally want to with:\n'
printf '  node %q codex-server stop\n' "$DOGFOOD/src/index.js"

exit "$RESULT"
