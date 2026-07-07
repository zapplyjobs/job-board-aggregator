#!/usr/bin/env sh
# sync-deployment-parity.sh — proactively copy deployment-parity source files to
# their committed .github/scripts/aggregator mirrors so the two stay byte-identical.
#
# The pair list MUST match lib/__tests__/deployment-parity.test.js PARITY_FILES.
# That test is the reactive backstop (fails CI on drift); this script is the
# proactive sync (keeps drift from happening). INF-CI-7.
#
# Used by .githooks/pre-commit (enable once per clone: git config core.hooksPath .githooks).
set -eu

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

sync_pair() {
  src="$1"
  dst="$2"
  if [ -f "$ROOT/$src" ]; then
    mkdir -p "$(dirname "$ROOT/$dst")"
    cp "$ROOT/$src" "$ROOT/$dst"
    echo "synced $src -> $dst"
  else
    echo "WARN: source missing, skipped: $src" >&2
  fi
}

# Keep these three pairs in sync with lib/__tests__/deployment-parity.test.js PARITY_FILES.
sync_pair lib/processors/tag-engine.js .github/scripts/aggregator/lib/processors/tag-engine.js
sync_pair lib/processors/wd-family-domain-map.json .github/scripts/aggregator/lib/processors/wd-family-domain-map.json
sync_pair lib/fetchers/company-list.json .github/scripts/aggregator/lib/fetchers/company-list.json
