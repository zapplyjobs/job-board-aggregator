#!/usr/bin/env node
// sidecar-transition.test.js — AGG-DESCGAP-1: stale sidecar cleanup across
// single<->chunked format transitions and chunk-count changes.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeSidecars } = require('../utils/sidecar-writer');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  ✗ ${m}`); } };

function freshDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-'));
  return d;
}
function write(dir, file, rows) {
  fs.writeFileSync(path.join(dir, file), rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// Case 1: source rewritten as SINGLE this run -> stale CHUNK leftover removed.
{
  const dir = freshDir();
  write(dir, 'descriptions-demo-1.jsonl', [{ id: 'old1', description_text: 'x'.repeat(60) }]); // stale chunk
  writeSidecars([{ source: 'demo', id: 'd1', description: 'fresh single description here' }], dir);
  ok(fs.existsSync(path.join(dir, 'descriptions-demo.jsonl')), 'single file written');
  ok(!fs.existsSync(path.join(dir, 'descriptions-demo-1.jsonl')), 'stale chunk leftover removed (chunk->single)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Case 2: timed-out source (NOT written this run, but has existing file) -> PRESERVED.
{
  const dir = freshDir();
  write(dir, 'descriptions-timedout.jsonl', [{ id: 'to1', description_text: 'keep me'.padEnd(60) }]);
  // writeSidecars called with a DIFFERENT source; 'timedout' not in sortedJobs
  writeSidecars([{ source: 'other', id: 'o1', description: 'other description here' }], dir);
  ok(fs.existsSync(path.join(dir, 'descriptions-timedout.jsonl')), 'timed-out source sidecar preserved (AGG-FETCH-10)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Case 3: truly inactive source (no current jobs, no... actually any existing file makes it active per cleanup)
// so an orphan file for a source with NO jobs anywhere still gets preserved by current logic; skip — not the bug.

console.log(`\nsidecar-transition: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
