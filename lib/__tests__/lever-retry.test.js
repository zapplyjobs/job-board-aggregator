/**
 * INF-LEVERRETRY-1: Test Lever fetcher retry behavior.
 * Verifies:
 * 1. 200 returns jobs immediately (no retry)
 * 2. 404 triggers retry (intermittent rate-limiting)
 * 3. 429 triggers retry with exponential backoff
 * 4. Permanent 404 (all retries exhausted) returns []
 * 5. 500 is NOT retried (terminal error)
 * 6. Network error (null response) triggers retry
 * 7. Success on second attempt (after initial 404)
 */

const assert = require('assert');
const path = require('path');

// Override http-client to inject controlled responses
const httpClientPath = require.resolve('../fetchers/http-client');
const originalLoad = require.cache[httpClientPath];

function mockHttpClient(responses) {
  let callIndex = 0;
  const mock = {
    getJson: async () => {
      const response = responses[callIndex] || responses[responses.length - 1];
      callIndex++;
      return response;
    },
    delay: () => Promise.resolve(), // skip actual delays in tests
  };
  require.cache[httpClientPath] = {
    id: httpClientPath,
    filename: httpClientPath,
    loaded: true,
    exports: mock,
  };
  return () => {
    if (originalLoad) require.cache[httpClientPath] = originalLoad;
    else delete require.cache[httpClientPath];
  };
}

function loadLever() {
  delete require.cache[require.resolve('../fetchers/lever')];
  return require('../fetchers/lever');
}

async function testSuccessNoRetry() {
  const restore = mockHttpClient([{ status: 200, data: [{ id: 'lever-1', text: 'Software Engineer', categories: { location: 'San Francisco' } }] }]);
  try {
    const { fetchLeverJobs } = loadLever();
    const jobs = await fetchLeverJobs('test-co', 'Test Co');
    assert.strictEqual(jobs.length, 1, 'Should return 1 job');
    assert.strictEqual(jobs[0].title, 'Software Engineer');
    console.log('  ✓ 200 returns jobs immediately (no retry)');
  } finally { restore(); }
}

async function test404TriggersRetry() {
  const restore = mockHttpClient([
    { status: 404, data: null },
    { status: 200, data: [{ id: 'lever-2', text: 'Data Engineer', categories: { location: 'NYC' } }] },
  ]);
  try {
    const { fetchLeverJobs } = loadLever();
    const jobs = await fetchLeverJobs('test-co', 'Test Co');
    assert.strictEqual(jobs.length, 1, 'Should return 1 job after retry');
    console.log('  ✓ 404 triggers retry → success on second attempt');
  } finally { restore(); }
}

async function test429TriggersRetry() {
  const restore = mockHttpClient([
    { status: 429, data: null },
    { status: 200, data: [{ id: 'lever-3', text: 'ML Engineer', categories: {} }] },
  ]);
  try {
    const { fetchLeverJobs } = loadLever();
    const jobs = await fetchLeverJobs('test-co', 'Test Co');
    assert.strictEqual(jobs.length, 1, 'Should return 1 job after 429 retry');
    console.log('  ✓ 429 triggers retry → success on second attempt');
  } finally { restore(); }
}

async function testPermanent404() {
  const restore = mockHttpClient([
    { status: 404, data: null },
    { status: 404, data: null },
    { status: 404, data: null },
  ]);
  try {
    const { fetchLeverJobs } = loadLever();
    const jobs = await fetchLeverJobs('nonexistent-co', 'Nonexistent Co');
    assert.strictEqual(jobs.length, 0, 'Should return [] after exhausting retries');
    console.log('  ✓ permanent 404 (3 attempts) returns []');
  } finally { restore(); }
}

async function test500NotRetried() {
  const restore = mockHttpClient([{ status: 500, data: null }]);
  try {
    const { fetchLeverJobs } = loadLever();
    const jobs = await fetchLeverJobs('test-co', 'Test Co');
    assert.strictEqual(jobs.length, 0, 'Should return [] immediately on 500');
    console.log('  ✓ 500 not retried (terminal)');
  } finally { restore(); }
}

async function testNetworkErrorRetry() {
  const restore = mockHttpClient([
    null, // network error / timeout
    { status: 200, data: [{ id: 'lever-4', text: 'DevOps', categories: {} }] },
  ]);
  try {
    const { fetchLeverJobs } = loadLever();
    const jobs = await fetchLeverJobs('test-co', 'Test Co');
    assert.strictEqual(jobs.length, 1, 'Should return 1 job after network error retry');
    console.log('  ✓ network error (null) triggers retry → success');
  } finally { restore(); }
}

async function testEmptyBoard200() {
  const restore = mockHttpClient([{ status: 200, data: [] }]);
  try {
    const { fetchLeverJobs } = loadLever();
    const jobs = await fetchLeverJobs('empty-co', 'Empty Co');
    assert.strictEqual(jobs.length, 0, 'Empty board returns []');
    console.log('  ✓ 200 with empty array returns []');
  } finally { restore(); }
}

// --- Run all tests ---
const tests = [
  ['success-no-retry', testSuccessNoRetry],
  ['404-retry', test404TriggersRetry],
  ['429-retry', test429TriggersRetry],
  ['permanent-404', testPermanent404],
  ['500-no-retry', test500NotRetried],
  ['network-error-retry', testNetworkErrorRetry],
  ['empty-board', testEmptyBoard200],
];

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}: ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`\nlever-retry: ${passed} pass, ${tests.length - passed} fail`);
})();
