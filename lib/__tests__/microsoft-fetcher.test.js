#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { fetchSearchPages, isRetryableSearchStatus, getMicrosoftFetchPlan } = require('../fetchers/microsoft');

function page(ids, count = ids.length) {
  return {
    status: 200,
    data: {
      data: {
        count,
        positions: ids.map(id => ({ id, name: `Job ${id}` })),
      },
    },
  };
}

function clientFromSteps(steps) {
  const urls = [];
  return {
    urls,
    async getJson(url) {
      urls.push(url);
      const step = steps.shift();
      if (!step) return page([]);
      return step;
    },
  };
}

(async () => {
  assert.strictEqual(isRetryableSearchStatus(429), true);
  assert.strictEqual(isRetryableSearchStatus(503), true);
  assert.strictEqual(isRetryableSearchStatus(400), false);

  assert.deepStrictEqual(
    getMicrosoftFetchPlan(0),
    { isInitial: true, maxPages: Infinity, skipDetails: true },
    'initial fetch should keep existing safe behavior by default'
  );
  assert.deepStrictEqual(
    getMicrosoftFetchPlan(0, true),
    { isInitial: true, maxPages: Infinity, skipDetails: false },
    'supplemental lane can fetch details while keeping full-page search'
  );
  assert.deepStrictEqual(
    getMicrosoftFetchPlan(25),
    { isInitial: false, maxPages: 50, skipDetails: false },
    'steady fetch should use routine page limit and fetch details'
  );

  {
    const client = clientFromSteps([
      { status: 429, data: null },
      page(['1', '2', '3'], 3),
    ]);
    let delayCount = 0;
    const positions = await fetchSearchPages(1, {
      getJsonImpl: client.getJson,
      delayImpl: async () => { delayCount++; },
    });

    assert.deepStrictEqual(positions.map(p => p.id), ['1', '2', '3'], '429 search page should retry and keep the page');
    assert.strictEqual(client.urls.length, 2, '429 retry should re-request the same page');
    assert.strictEqual(client.urls[0], client.urls[1], '429 retry should not advance the offset before success');
    assert.strictEqual(delayCount, 1, '429 retry should back off once before success');
  }

  {
    const client = clientFromSteps([
      page(['1','2','3','4','5','6','7','8','9','10'], 12),
      { status: 400, data: null },
    ]);
    const positions = await fetchSearchPages(3, {
      getJsonImpl: client.getJson,
      delayImpl: async () => {},
    });

    assert.strictEqual(positions.length, 10, 'non-retryable search failure should preserve prior fetched pages');
    assert.strictEqual(client.urls.length, 2, 'non-retryable search failure should not retry');
  }

  {
    const client = clientFromSteps([
      page(['1','2','3','4','5','6','7','8','9','10'], 20),
      page(['11'], 20),
    ]);
    let steadyDelays = 0;
    const positions = await fetchSearchPages(5, {
      getJsonImpl: client.getJson,
      delayImpl: async () => { steadyDelays++; },
    });

    assert.strictEqual(positions.length, 11, 'short final page should end search');
    assert.strictEqual(steadyDelays, 1, 'steady page delay should happen between full pages only');
    assert.ok(client.urls[1].includes('start=10'), 'second page should advance by page size after success');
  }

  console.log('PASS microsoft fetcher search retry behavior');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
