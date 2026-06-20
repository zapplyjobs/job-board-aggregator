#!/usr/bin/env node
// r2-delete.test.js — AGG-R2-SINGLEFILE-1: r2-client.deleteObjects (batch prune).
// Mocks the S3 client + command; verifies prefix application, count, and empty-list no-op.
'use strict';
process.env.R2_BUCKET_NAME = 'test-bucket';
const { createR2Client } = require('../storage/r2-client');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error(`  ✗ ${m}`); } };

class FakeDeleteCmd { constructor(input) { this.input = input; } }
const sentKeys = [];
const fakeClient = {
  send: async (cmd) => {
    const keys = (cmd.input.Delete.Objects || []).map(o => o.Key);
    keys.forEach(k => sentKeys.push(k));
    return { Deleted: keys.map(k => ({ Key: k })) };
  },
};

(async () => {
  const r2 = createR2Client({
    prefix: 'data/',
    client: fakeClient,
    commands: { DeleteObjectsCommand: FakeDeleteCmd },
  });

  const n = await r2.deleteObjects(['descriptions-greenhouse.jsonl', 'descriptions-greenhouse-3.jsonl']);
  ok(n === 2, `deleteObjects returns count deleted (got ${n})`);
  ok(sentKeys.length === 2, `sent 2 delete keys (got ${sentKeys.length})`);
  ok(sentKeys.includes('data/descriptions-greenhouse.jsonl'), 'prefix data/ applied to key');
  ok(sentKeys.includes('data/descriptions-greenhouse-3.jsonl'), 'second key prefixed');

  const before = sentKeys.length;
  const empty = await r2.deleteObjects([]);
  ok(empty === 0, `empty list returns 0 (got ${empty})`);
  ok(sentKeys.length === before, 'empty list makes no send calls');

  console.log(`\nr2-delete: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(2); });
