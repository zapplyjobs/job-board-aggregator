#!/usr/bin/env node
'use strict';
// AGG-STALEUPSTREAM-1 (2026-07-04): workday rotate coverage-invariant test.
// Asserts pickOldestUnchanged selects oldest-first AND guarantees bounded coverage
// (every tenant picked within ceil(N/batchSize) runs). Locks in the fix for the name-bucket
// coverage hole that left ~4,000 workday stale-candidate jobs lingering 4.6 days.
const { pickOldestUnchanged } = require('../fetchers/workday');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; } else { fail++; console.error(`  FAIL: ${name}`); } }

// _lastFullFetchAt semantics: epoch-ms timestamp of the last full fetch.
// LOWER value = fetched longer ago = OLDER = higher refresh priority (sorted first).

// 1. Oldest-first: tenants with the oldest (lowest) _lastFullFetchAt are picked first.
{
  const now = Date.now();
  const ago = (h) => now - h * 3600000; // hours ago -> lower epoch = older
  const tenants = [
    { name: 'A', _lastFullFetchAt: ago(10) },
    { name: 'B', _lastFullFetchAt: ago(2) },
    { name: 'C', _lastFullFetchAt: ago(8) },
    { name: 'D', _lastFullFetchAt: ago(5) },
    { name: 'E', _lastFullFetchAt: ago(1) },
  ];
  const picked = pickOldestUnchanged(tenants, 2);
  check('picks exactly 2', picked.length === 2);
  check('oldest-first (A=10h, C=8h)', picked[0].name === 'A' && picked[1].name === 'C');
  check('does not mutate input order', tenants[0].name === 'A' && tenants[1].name === 'B');
}

// 2. Never-fetched (0 / null / undefined) = highest priority.
{
  const now = Date.now();
  const tenants = [
    { name: 'old', _lastFullFetchAt: now - 100000 },
    { name: 'never1', _lastFullFetchAt: 0 },
    { name: 'never2', _lastFullFetchAt: null },
    { name: 'recent', _lastFullFetchAt: now - 1000 },
  ];
  const picked = pickOldestUnchanged(tenants, 2);
  const names = picked.map(p => p.name);
  check('never-fetched tenants picked first', names.includes('never1') && names.includes('never2'));
}

// 3. BOUNDED COVERAGE INVARIANT — the core guarantee.
// Every tenant is picked within ceil(N/batchSize) simulated runs, because a just-picked
// tenant's _lastFullFetchAt updates to "now" (Phase 2 does this), so it sorts last next run
// and the oldest-unpicked rise to the top. This is exactly what the name-bucket rotate FAILED.
{
  const N = 30, batchSize = 5;
  const tenants = Array.from({ length: N }, (_, i) => ({ name: `t${i}`, _lastFullFetchAt: 0 }));
  const pickedEver = new Set();
  const maxRuns = Math.ceil(N / batchSize); // invariant: coverage within this many runs
  let coveredAll = false;
  for (let run = 0; run < maxRuns; run++) {
    const picked = pickOldestUnchanged(tenants, batchSize);
    for (const t of picked) { pickedEver.add(t.name); t._lastFullFetchAt = (run + 1) * 3600000; }
    if (pickedEver.size === N) { coveredAll = true; break; }
  }
  check(`bounded coverage: all ${N} tenants picked within ${maxRuns} runs (batch ${batchSize})`, coveredAll);
}

// 4. batchSize >= pool returns all (sorted oldest-first = lowest ts first), no error.
{
  const tenants = [{ name: 'a', _lastFullFetchAt: 5 }, { name: 'b', _lastFullFetchAt: 1 }];
  const picked = pickOldestUnchanged(tenants, 10);
  check('batchSize > pool returns all, oldest-first (b=1 is older than a=5)', picked.length === 2 && picked[0].name === 'b');
}

// 5. empty input -> empty output, no error.
{
  check('empty input -> empty', pickOldestUnchanged([], 5).length === 0);
}

console.log(`\nworkday-rotate: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
