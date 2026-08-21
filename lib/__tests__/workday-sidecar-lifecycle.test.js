/**
 * AGG-WD-SIDECAR-LIFECYCLE-1 regression tests.
 * Covers the four lifecycle invariants added to workday-descriptions.js:
 *   1. Dedupe-on-write: duplicate null failure lines collapse to ONE line per ID
 *      (legacy appendDescriptions re-appended a null line per failed retry).
 *   2. Failure backoff: an ID with fail_count >= 3 and last_fail_at within 24h is
 *      excluded from the pending batch (stops blocked tenants burning MAX_PER_RUN).
 *   3. Pool prune: records whose IDs left the live pool are dropped; prune never
 *      fires without a pool ID set; in-pool entries always survive.
 *   4. 40MB chunking: byte-consistent splits, no empty trailing chunks, superseded
 *      local files (single<->chunked transitions) removed.
 * Plus: success clears failure metadata; SR merge preserves schema_version.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  fetchWorkdayDescriptions,
  loadDescriptionRecords,
  loadDescriptionRecordsStreaming,
  writeSidecarCompacted,
  FAIL_BACKOFF_THRESHOLD,
} = require('../fetchers/workday-descriptions');
const { fetchSRDescriptions } = require('../fetchers/smartrecruiters-descriptions');

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wd-lifecycle-'));
}
function writeLines(dir, fname, records) {
  fs.writeFileSync(path.join(dir, fname), records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function readAll(dir, source) {
  const re = new RegExp(`^descriptions-${source}(-\\d+)?\\.jsonl$`);
  const out = [];
  for (const f of fs.readdirSync(dir).filter(f => re.test(f)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)) {
      out.push(JSON.parse(line));
    }
  }
  return out;
}

// A no-network fetch: every attempt fails (null description), mimicking a blocked tenant.
function failingInputs() {
  return {
    getJson: async () => null,
    getHtml: async () => null,
  };
}

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; console.log(`  ✓ ${msg}`); }

(async () => {

{
  const dir = tmpDataDir();
  // Seed with the legacy pathology: same null ID appended 5 times + a good entry.
  writeLines(dir, 'descriptions-workday.jsonl', [
    { id: 'workday-idexx-J-1', description_text: null },
    { id: 'workday-idexx-J-1', description_text: null },
    { id: 'workday-idexx-J-1', description_text: null },
    { id: 'workday-idexx-J-1', description_text: null },
    { id: 'workday-idexx-J-1', description_text: null },
    { id: 'workday-good-J-2', description_text: 'A real description' },
  ]);
  const jobs = [{ id: 'workday-idexx-J-1', location: 'New York, NY', _raw: { externalPath: '/job/x', baseUrl: 'https://idexx.wd1.myworkdayjobs.com', site: 'site' } }];
  // fetchWorkdayDescriptions with backoff: seeded fail lines have NO fail_count (legacy),
  // so the ID stays eligible; the failing fetch must produce ONE null line with fail_count.
  const m = await fetchWorkdayDescriptions(jobs, dir, { ...failingInputs(), concurrency: 1, delayMs: 0, keepAll: true });
  ok(m.get('workday-good-J-2') === 'A real description', 'nonnull entry survives the fetch');
  const lines = readAll(dir, 'workday');
  const nulls = lines.filter(l => l.id === 'workday-idexx-J-1');
  ok(lines.length === 2, `exactly one line per ID (got ${lines.length})`);
  ok(nulls.length === 1 && nulls[0].description_text === null, 'failed ID has a single null line');
  ok(nulls[0].fail_count === 1 && nulls[0].last_fail_at, 'failure line carries fail_count + last_fail_at');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 1b. Duplicate nulls with nonnull appended after (order resilience) ---
{
  const dir = tmpDataDir();
  writeLines(dir, 'descriptions-workday.jsonl', [
    { id: 'wd-a', description_text: null },
    { id: 'wd-a', description_text: 'recovered text' },
    { id: 'wd-a', description_text: null }, // legacy dup appended after recovery
  ]);
  const records = loadDescriptionRecords(path.join(dir, 'descriptions-workday.jsonl'));
  ok(records.size === 1 && records.get('wd-a').description_text === 'recovered text',
    'loadDescriptionRecords: nonnull wins over later null dup');
  const streamed = await loadDescriptionRecordsStreaming(path.join(dir, 'descriptions-workday.jsonl'));
  ok(streamed.size === 1 && streamed.get('wd-a').description_text === 'recovered text',
    'loadDescriptionRecordsStreaming: nonnull wins over later null dup');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 1c. Large sidecars use streaming load/write paths ---
{
  const dir = tmpDataDir();
  const filePath = path.join(dir, 'descriptions-workday.jsonl');
  const fd = fs.openSync(filePath, 'w');
  for (let i = 0; i < 12000; i++) {
    fs.writeSync(fd, JSON.stringify({
      id: `wd-large-${i}`,
      description_text: 'description '.repeat(40),
    }) + '\n');
  }
  fs.closeSync(fd);
  const descriptions = await fetchWorkdayDescriptions([], dir, {
    keepAll: true,
    chunkLimit: 1024 * 1024,
  });
  ok(descriptions.size === 12000, 'large sidecar round-trips through streaming paths');
  ok(fs.readdirSync(dir).filter(f => /^descriptions-workday(-\d+)?\.jsonl$/.test(f)).length > 1,
    'large sidecar writes bounded chunks without an in-memory join');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 2. Failure backoff ---
{
  const dir = tmpDataDir();
  const recent = new Date().toISOString();
  writeLines(dir, 'descriptions-workday.jsonl', [
    { id: 'wd-blocked', description_text: null, fail_count: FAIL_BACKOFF_THRESHOLD, last_fail_at: recent },
    { id: 'wd-fresh', description_text: null, fail_count: 1, last_fail_at: recent },
  ]);
  const jobs = [
    { id: 'wd-blocked', location: 'US', _raw: { externalPath: '/job/b', baseUrl: 'https://x.wd1.myworkdayjobs.com', site: 's' } },
    { id: 'wd-fresh', location: 'US', _raw: { externalPath: '/job/f', baseUrl: 'https://x.wd1.myworkdayjobs.com', site: 's' } },
  ];
  let attempts = [];
  const inputs = {
    getJson: async (url) => { attempts.push(url); return null; },
    getHtml: async () => null,
  };
  await fetchWorkdayDescriptions(jobs, dir, { ...inputs, concurrency: 1, delayMs: 0, keepAll: true });
  ok(!attempts.some(u => u.includes('/job/b')), 'backed-off ID (fail_count>=3, recent) not attempted');
  ok(attempts.some(u => u.includes('/job/f')), 'low-fail ID still attempted');
  const lines = readAll(dir, 'workday');
  const blocked = lines.find(l => l.id === 'wd-blocked');
  ok(blocked.fail_count === FAIL_BACKOFF_THRESHOLD, 'backed-off ID fail_count not incremented (no attempt)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 2b. Backoff expiry: old last_fail_at re-attempts ---
{
  const dir = tmpDataDir();
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  writeLines(dir, 'descriptions-workday.jsonl', [
    { id: 'wd-stale', description_text: null, fail_count: 10, last_fail_at: stale },
  ]);
  const jobs = [{ id: 'wd-stale', location: 'US', _raw: { externalPath: '/job/s', baseUrl: 'https://x.wd1.myworkdayjobs.com', site: 's' } }];
  let attempted = false;
  await fetchWorkdayDescriptions(jobs, dir, {
    getJson: async () => { attempted = true; return null; },
    getHtml: async () => null,
    concurrency: 1, delayMs: 0, keepAll: true,
  });
  ok(attempted, 'fail older than 24h re-attempts (self-healing for transient blocks)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 3. Pool prune with churn grace ---
{
  const dir = tmpDataDir();
  const oldStamp = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // > 7d grace
  writeLines(dir, 'descriptions-workday.jsonl', [
    { id: 'wd-in-pool', description_text: 'keep me' },
    { id: 'wd-gone-recent', description_text: 'churn tolerance' },                 // legacy: no in_pool_at
    { id: 'wd-gone-stale', description_text: 'real dead weight', in_pool_at: oldStamp },
  ]);
  const poolIds = new Set(['wd-in-pool', 'wd-new']);
  const r = writeSidecarCompacted('workday', loadDescriptionRecords(path.join(dir, 'descriptions-workday.jsonl')), dir, { poolIds });
  const lines = readAll(dir, 'workday');
  const ids = lines.map(l => l.id);
  ok(r.pruned === 1, 'only >7d-absent entry pruned');
  ok(ids.includes('wd-in-pool'), 'in-pool entry survives');
  ok(ids.includes('wd-gone-recent'), 'legacy absent entry kept (grace stamped, never mass-evicted)');
  ok(!ids.includes('wd-gone-stale'), '>7d-absent entry evicted');
  const recent = lines.find(l => l.id === 'wd-gone-recent');
  ok(!!recent.in_pool_at, 'absent entry stamped with in_pool_at');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 3z. Pool oscillation: absent this cycle but inside grace keeps the entry ---
{
  const dir = tmpDataDir();
  const lastCycle = new Date(Date.now() - 60 * 1000).toISOString();
  writeLines(dir, 'descriptions-workday.jsonl', [
    { id: 'wd-osc', description_text: 'rotation churn', in_pool_at: lastCycle },
  ]);
  // wd-osc NOT in this cycle's pool (segment rotation) — must survive the grace window
  const r = writeSidecarCompacted('workday', loadDescriptionRecords(path.join(dir, 'descriptions-workday.jsonl')), dir, { poolIds: new Set(['wd-other']) });
  const lines = readAll(dir, 'workday');
  ok(r.pruned === 0 && lines.length === 1 && lines[0].id === 'wd-osc',
    'entry absent ONE cycle (recent in_pool_at) survives — no AGG-DESC-SPEED-1 oscillation');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 3b. No pool set => no prune (never prune on missing seed) ---
{
  const dir = tmpDataDir();
  writeLines(dir, 'descriptions-workday.jsonl', [
    { id: 'wd-a', description_text: 'x' },
    { id: 'wd-b', description_text: null },
  ]);
  const r = writeSidecarCompacted('workday', loadDescriptionRecords(path.join(dir, 'descriptions-workday.jsonl')), dir, {});
  ok(r.pruned === 0 && r.entries === 2, 'no poolIds => full retention');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 3c. Empty records never delete the file ---
{
  const dir = tmpDataDir();
  writeLines(dir, 'descriptions-workday.jsonl', [{ id: 'wd-a', description_text: 'x' }]);
  const r = writeSidecarCompacted('workday', new Map(), dir, {});
  ok(r.entries === 0 && fs.existsSync(path.join(dir, 'descriptions-workday.jsonl')),
    'empty record set preserves existing file (seed-failure safe)');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 4. Chunking + superseded-file cleanup ---
{
  const dir = tmpDataDir();
  // Pre-existing chunked layout that will shrink back to a single file.
  writeLines(dir, 'descriptions-workday-1.jsonl', [{ id: 'wd-a', description_text: 'x' }]);
  writeLines(dir, 'descriptions-workday-2.jsonl', [{ id: 'wd-b', description_text: 'y' }]);
  const records = new Map([
    ['wd-a', { id: 'wd-a', description_text: 'x' }],
    ['wd-b', { id: 'wd-b', description_text: 'y' }],
  ]);
  const r = writeSidecarCompacted('workday', records, dir, { chunkLimit: 200 });
  ok(fs.existsSync(path.join(dir, 'descriptions-workday.jsonl')), 'single file written (fits limit)');
  ok(!fs.existsSync(path.join(dir, 'descriptions-workday-1.jsonl')) &&
     !fs.existsSync(path.join(dir, 'descriptions-workday-2.jsonl')),
    'superseded chunk files removed (chunk->single transition)');
  ok(r.removedFiles.has('descriptions-workday-1.jsonl'), 'removedFiles reports the stale chunk (R2-prune manifest)');

  // Now grow past the limit -> must chunk with no empty trailing files.
  const big = new Map();
  for (let i = 0; i < 6; i++) big.set('wd-big-' + i, { id: 'wd-big-' + i, description_text: 'z'.repeat(150) });
  const r2 = writeSidecarCompacted('workday', big, dir, { chunkLimit: 200 });
  const chunkFiles = fs.readdirSync(dir).filter(f => /^descriptions-workday(-\d+)?\.jsonl$/.test(f));
  const empties = chunkFiles.filter(f => fs.readFileSync(path.join(dir, f), 'utf8').trim() === '');
  ok(r2.writtenFiles.size > 1, `oversized set chunked (${r2.writtenFiles.size} files)`);
  ok(empties.length === 0, 'no empty trailing chunks (AGG-DESCGAP-1 math)');
  ok(!fs.existsSync(path.join(dir, 'descriptions-workday.jsonl')) || r2.writtenFiles.has('descriptions-workday.jsonl'),
    'single file removed when transitioning to chunked');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 5. Success clears failure metadata ---
{
  const dir = tmpDataDir();
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  writeLines(dir, 'descriptions-workday.jsonl', [
    { id: 'wd-recover', description_text: null, fail_count: 9, last_fail_at: stale },
  ]);
  const jobs = [{ id: 'wd-recover', location: 'US', _raw: { externalPath: '/job/r', baseUrl: 'https://x.wd1.myworkdayjobs.com', site: 's' } }];
  await fetchWorkdayDescriptions(jobs, dir, {
    getJson: async () => ({ jobPostingInfo: { jobDescription: '<p>Recovered!</p>' } }),
    getHtml: async () => null,
    concurrency: 1, delayMs: 0, keepAll: true,
  });
  const lines = readAll(dir, 'workday');
  const rec = lines.find(l => l.id === 'wd-recover');
  ok(rec.description_text === 'Recovered!' && rec.fail_count === undefined && rec.last_fail_at === undefined,
    'successful fetch clears fail_count/last_fail_at');
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- 6. SR: schema_version survives the compacted merge ---
{
  const dir = tmpDataDir();
  writeLines(dir, 'descriptions-smartrecruiters.jsonl', [
    { id: 'sr-a', description_text: 'old v1 text', schema_version: 1 },
    { id: 'sr-null', description_text: null, schema_version: 2 },
    { id: 'sr-null', description_text: null, schema_version: 2 }, // legacy dup
  ]);
  const jobs = [
    { id: 'sr-a', company_slug: 'acme', source_id: '111' },
    { id: 'sr-null', company_slug: 'acme', source_id: '222' },
  ];
  const m = await fetchSRDescriptions(jobs, dir, {
    fetchJson: async () => ({ jobAd: { sections: { jobDescription: { text: '<p>v2 text</p>' } } } }),
    delayMs: 0, concurrency: 1, keepAll: true,
  });
  const lines = readAll(dir, 'smartrecruiters');
  const a = lines.find(l => l.id === 'sr-a');
  const n = lines.find(l => l.id === 'sr-null');
  ok(lines.length === 2, `SR dedupe-on-write: one line per ID (got ${lines.length})`);
  ok(a && a.description_text === 'v2 text' && a.schema_version === 2, 'SR schema upgrade re-fetch written');
  ok(n && n.description_text === 'v2 text', 'SR null entry recovered on retry');
  fs.rmSync(dir, { recursive: true, force: true });
}

})().then(() => console.log(`\nworkday-sidecar-lifecycle.test.js: ${passed} assertions passed`))
 .catch(e => { console.error(e); process.exit(1); });

// --- 7. buildDescUrl origin hardening (AGG-WD-DESC-URL-BASE-1) ---
{
  const { buildDescUrl } = require('../fetchers/workday-descriptions');
  const clean = buildDescUrl('https://idexx.wd1.myworkdayjobs.com', 'IDEXX', '/job/x/R123');
  ok(clean === 'https://idexx.wd1.myworkdayjobs.com/wday/cxs/idexx/IDEXX/job/x/R123',
    'host-only baseUrl produces the CXS URL unchanged');
  const pathy = buildDescUrl('https://wf.wd1.myworkdayjobs.com/en-US/careers', 'External', '/job/y/REQ1');
  ok(pathy === 'https://wf.wd1.myworkdayjobs.com/wday/cxs/wf/External/job/y/REQ1',
    'path-bearing baseUrl is normalized to origin (no path leaks into the CXS URL)');
  ok(buildDescUrl('not a url', 's', '/p') === null, 'unparseable baseUrl returns null');
}
