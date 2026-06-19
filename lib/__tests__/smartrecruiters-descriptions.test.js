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
      jobAd: { sections: {
        jobDescription: { text: `<p>Desc ${id}</p>` },
        qualifications: { text: `<p>Minimum Qualifications:</p><ul><li>Bachelor's degree ${id}</li></ul>` },
      } }
    };
  };

  const map = await fetchSRDescriptions(jobs, dir, { maxPerRun: 6, concurrency: 3, delayMs: 0, fetchJson });
  assert.strictEqual(map.size, 6);
  assert.ok(active.peak <= 3, `peak concurrency ${active.peak} should not exceed limit`);
  assert.strictEqual(calls.length, 6);
  const saved = fs.readFileSync(path.join(dir, 'descriptions-smartrecruiters.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(saved.length, 6);
  assert.ok(saved[0].includes("Bachelor's degree 1000"));

  const secondCalls = [];
  const second = await fetchSRDescriptions(jobs, dir, {
    maxPerRun: 6,
    concurrency: 3,
    delayMs: 0,
    fetchJson: async (url) => { secondCalls.push(url); return null; }
  });
  const retryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-desc-retry-'));
  fs.writeFileSync(path.join(retryDir, 'descriptions-smartrecruiters.jsonl'), JSON.stringify({
    id: 'sr-testco-3000',
    description_text: null,
  }) + '\n');
  const retryCalls = [];
  const retried = await fetchSRDescriptions([{ id: 'sr-testco-3000', company_slug: 'testco', source_id: '3000' }], retryDir, {
    maxPerRun: 1,
    concurrency: 1,
    delayMs: 0,
    fetchJson: async (url) => {
      retryCalls.push(url);
      return {
        jobAd: { sections: {
          jobDescription: { text: '' },
          qualifications: { text: '<p>BS in Mechanical Engineering</p>' },
        } }
      };
    }
  });
  assert.strictEqual(retryCalls.length, 1, 'null-cached jobs should refetch');
  assert.strictEqual(retried.get('sr-testco-3000'), 'BS in Mechanical Engineering');
  fs.rmSync(retryDir, { recursive: true, force: true });
  assert.strictEqual(second.size, 6);
  assert.strictEqual(secondCalls.length, 0, 'cached jobs should not refetch');

  const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-desc-fallback-'));
  const fallback = await fetchSRDescriptions([{ id: 'sr-testco-2000', company_slug: 'testco', source_id: '2000' }], fallbackDir, {
    maxPerRun: 1,
    concurrency: 1,
    delayMs: 0,
    fetchJson: async () => ({
      jobAd: { sections: {
        jobDescription: { text: '' },
        qualifications: { text: '' },
        companyDescription: { text: '<p>Company-only controls systems role</p>' },
      } }
    })
  });
  assert.strictEqual(fallback.get('sr-testco-2000'), 'Company-only controls systems role');
  fs.rmSync(fallbackDir, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('PASS smartrecruiters descriptions concurrency');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
