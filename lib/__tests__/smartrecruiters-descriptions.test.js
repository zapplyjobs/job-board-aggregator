#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchSRDescriptions } = require('../fetchers/smartrecruiters-descriptions');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-desc-'));
  const jobs = Array.from({ length: 6 }, (_, i) => ({
    id: `sr-testco-${1000 + i}`,
    company_slug: 'testco',
    source_id: String(1000 + i),
  }));
  const calls = [];
  const active = { current: 0, peak: 0 };
  const fetchJson = async (url) => {
    calls.push(url);
    active.current += 1;
    active.peak = Math.max(active.peak, active.current);
    await new Promise(r => setTimeout(r, 5));
    active.current -= 1;
    const id = Number(url.split('/').pop());
    return {
      jobAd: { sections: { jobDescription: { text: `<p>Desc ${id}</p>` } } }
    };
  };

  const map = await fetchSRDescriptions(jobs, dir, { maxPerRun: 6, concurrency: 3, delayMs: 0, fetchJson });
  assert.strictEqual(map.size, 6);
  assert.ok(active.peak <= 3, `peak concurrency ${active.peak} should not exceed limit`);
  assert.strictEqual(calls.length, 6);
  const saved = fs.readFileSync(path.join(dir, 'descriptions-smartrecruiters.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(saved.length, 6);
  assert.ok(saved[0].includes('Desc 1000'));

  const secondCalls = [];
  const second = await fetchSRDescriptions(jobs, dir, {
    maxPerRun: 6,
    concurrency: 3,
    delayMs: 0,
    fetchJson: async (url) => { secondCalls.push(url); return null; }
  });
  assert.strictEqual(second.size, 6);
  assert.strictEqual(secondCalls.length, 0, 'cached jobs should not refetch');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS smartrecruiters descriptions concurrency');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
