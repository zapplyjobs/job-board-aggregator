#!/usr/bin/env sh
# sync-deployment-parity.sh — proactively copy deployment-parity source files to
# their committed .github/scripts/aggregator mirrors so the two stay byte-identical.
#
# AGG-PARITYSYNC-COVERAGE-1 (2026-09-13): the pair list is DERIVED, not hand-listed —
# every file in lib/processors/ is parity-critical (the deployment copy runs the
# pipeline), plus lib/fetchers/company-list.json. Hand-listing is what let
# tag-monitor.js ship diverged twice (B122). The derived list MUST stay aligned
# with lib/__tests__/deployment-parity.test.js, which is the reactive CI backstop
# (fails on drift, including mirror-only extras). INF-CI-7.
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

# Derived: every lib/processors file + the fetcher tenant config.
for f in "$ROOT"/lib/processors/*; do
  base="$(basename "$f")"
  sync_pair "lib/processors/$base" ".github/scripts/aggregator/lib/processors/$base"
done
sync_pair lib/fetchers/company-list.json .github/scripts/aggregator/lib/fetchers/company-list.json

# AGG-MIRROR-PARITY-DECIDE-1 (2026-09-22): any fetcher file ALREADY mirrored is
# parity-synced too (bytedance.js shipped diverged because fetchers sat outside
# the derived scope). Derived from the MIRROR contents - files never mirrored
# stay unmirrored (fetchers are production-only). Kept aligned with
# lib/__tests__/deployment-parity.test.js per the AGG-PARITYSYNC-COVERAGE-1 rule.
if [ -d "$ROOT/.github/scripts/aggregator/lib/fetchers" ]; then
  for f in "$ROOT"/.github/scripts/aggregator/lib/fetchers/*; do
    base="$(basename "$f")"
    sync_pair "lib/fetchers/$base" ".github/scripts/aggregator/lib/fetchers/$base"
  done
fi
