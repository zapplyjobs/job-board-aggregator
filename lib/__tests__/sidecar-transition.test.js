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
  const result = writeSidecars([{ source: 'demo', id: 'd1', description: 'fresh single description here' }], dir);
  ok(fs.existsSync(path.join(dir, 'descriptions-demo.jsonl')), 'single file written');
  ok(!fs.existsSync(path.join(dir, 'descriptions-demo-1.jsonl')), 'stale chunk leftover removed (chunk->single)');
  ok(result.removedFiles && result.removedFiles.has('descriptions-demo-1.jsonl'), 'removedFiles reports the stale file (for R2 prune)');
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

// Case 3: few-but-large entries must NOT create empty trailing chunks (AGG-DESCGAP-1 math fix).
// 2 entries whose combined bytes imply 4 chunks at a 200B limit; old code made -3/-4 empty.
{
  const dir = freshDir();
  const big = 'x'.repeat(350);
  writeSidecars([
    { source: 'big', id: 'b1', description: big },
    { source: 'big', id: 'b2', description: big },
  ], dir, { chunkLimit: 200 });
  const files = fs.readdirSync(dir).filter(f => f.startsWith('descriptions-big'));
  const empties = files.filter(f => fs.readFileSync(path.join(dir, f), 'utf8').trim() === '');
  ok(files.length === 2, `2 entries -> 2 chunk files, got ${files.length} (${files.join(',')})`);
  ok(empties.length === 0, `no empty chunk files, got ${empties.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
}


console.log(`\nsidecar-transition: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
