/**
 * SmartRecruiters Description Fetcher
 *
 * Incrementally fetches job descriptions for SR jobs not yet in the sidecar.
 * Stores results in: .github/data/descriptions-smartrecruiters.jsonl
 * Each line: { id, description_text }
 *
 * Detail endpoint: GET https://api.smartrecruiters.com/v1/companies/{slug}/postings/{id}
 * Response: { jobAd: { sections: { jobDescription: { title, text: "<HTML>..." } } } }
 * No auth required — same endpoint as the public career site.
 *
 * Per-run cost: only NEW job IDs not yet in the sidecar are fetched.
 * Initial backfill: ~1,933 SR jobs × 0.3s ≈ 10 min — spread over MAX_PER_RUN batches.
 *
 * Called from index.js after ATS fetch (Step 1c), before Step 2.
 */

'use strict';

const https = require('https');
const path = require('path');
const { stripHtml, loadDescriptions, appendDescriptions } = require('./workday-descriptions');

const BASE_URL = 'https://api.smartrecruiters.com/v1/companies';
const DELAY_MS = 300;
const TIMEOUT_MS = 10000;
const MAX_PER_RUN = 200; // Cap per run — prevents timeout on initial backfill

/**
 * Fetch one URL, return parsed JSON or null on any error/timeout.
 */
function getJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-board-bot/1.0)' }
    }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve(res.statusCode === 200 ? JSON.parse(d) : null); }
        catch (_) { resolve(null); }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch descriptions for SR jobs not yet in descriptions-smartrecruiters.jsonl.
 *
 * @param {Array} srJobs - Normalized SR job objects (with company_slug and source_id fields)
 * @param {string} dataDir - Path to .github/data/
 * @returns {Promise<Map<string,string>>} Full id→description_text map (existing + newly fetched)
 */
async function fetchSRDescriptions(srJobs, dataDir) {
  const filePath = path.join(dataDir, 'descriptions-smartrecruiters.jsonl');
  const existing = loadDescriptions(filePath);

  // Find jobs not yet described
  const pending = srJobs.filter(j => !existing.has(j.id));

  if (pending.length === 0) {
    console.log(`📄 SR descriptions: ${existing.size} cached, 0 new to fetch`);
    return existing;
  }

  // Cap to MAX_PER_RUN — remainder deferred to next run (incremental backfill)
  const batch = pending.slice(0, MAX_PER_RUN);
  const deferred = pending.length - batch.length;
  console.log(`📄 SR descriptions: ${existing.size} cached, ${pending.length} new (fetching ${batch.length}${deferred > 0 ? `, deferring ${deferred}` : ''})...`);

  const newEntries = [];
  let fetched = 0;
  let failed = 0;

  for (const job of batch) {
    // source_id is null on normalized SR jobs; extract numeric ID from composite id field
    // id format: sr-{CompanySlug}-{numericId} (e.g. sr-Intuitive-744000115090677)
    const numericId = job.id.split('-').slice(2).join('-');
    const url = `${BASE_URL}/${job.company_slug}/postings/${numericId}`;
    const data = await getJson(url);
    const rawHtml = data?.jobAd?.sections?.jobDescription?.text || null;
    const description_text = rawHtml ? stripHtml(rawHtml) : null;

    if (description_text) {
      newEntries.push({ id: job.id, description_text });
      existing.set(job.id, description_text);
      fetched++;
    } else {
      // Store null so we don't retry every run
      newEntries.push({ id: job.id, description_text: null });
      existing.set(job.id, null);
      failed++;
    }

    await delay(DELAY_MS);
  }

  appendDescriptions(filePath, newEntries);
  console.log(`📄 SR descriptions: fetched ${fetched}, failed/empty ${failed}`);

  return existing;
}

module.exports = { fetchSRDescriptions };
