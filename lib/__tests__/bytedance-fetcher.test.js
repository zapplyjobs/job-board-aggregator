'use strict';

const assert = require('assert');
const { normalizeByteDanceJob } = require('../fetchers/bytedance');

function testNormalizesByteDanceJob() {
  const job = normalizeByteDanceJob({
    id: '7539992380817639687',
    title: 'Research Intern (AI/LLM Network) - 2026 Start (PhD)',
    description: 'Responsibilities text',
    requirement: 'Qualifications text',
    city_info: {
      en_name: 'Seattle',
      parent: { en_name: 'Washington' },
    },
  });

  assert.strictEqual(job.id, 'bytedance-7539992380817639687');
  assert.strictEqual(job.source, 'bytedance');
  assert.strictEqual(job.company_name, 'ByteDance');
  assert.strictEqual(job.location, 'Seattle, Washington');
  assert.strictEqual(job.url, 'https://joinbytedance.com/search/7539992380817639687');
  assert.strictEqual(job.apply_url, 'https://jobs.bytedance.com/en/resume/7539992380817639687/apply');
  assert.strictEqual(job.posted_at, null);
  assert(job.description.includes('Responsibilities text'));
  assert(job.description.includes('Qualifications text'));
}

testNormalizesByteDanceJob();
console.log('✅ ByteDance fetcher tests passed');
