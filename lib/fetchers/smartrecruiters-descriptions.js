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

const fs = require('fs');
const https = require('https');
const path = require('path');
const { stripHtml, appendDescriptions } = require('./workday-descriptions');

const BASE_URL = 'https://api.smartrecruiters.com/v1/companies';
const DELAY_MS = 100;
const TIMEOUT_MS = 10000;
const MAX_PER_RUN = 500; // AGG-SR-DETAIL-1: backfill stays bounded per run
const CONCURRENCY = 4;   // AGG-RUNTIME-1: bounded concurrency to cut hot-path latency without a family-wide redesign
const SIDECAR_SCHEMA_VERSION = 2;

function loadDescriptionCache(filePath) {
  const map = new Map();
  if (!fs.existsSync(filePath)) return map;
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.id) {
        map.set(entry.id, {
          description_text: entry.description_text ?? null,
          schema_version: entry.schema_version ?? 1,
        });
      }
    } catch (_) { /* skip malformed */ }
  }
  return map;
}

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
function pendingPriority(job) {
  if (job.employment_type === 'internship') return 0;
  if (/\b(intern|internship|co-?op|apprentice|new grad|graduate)\b/i.test(job.title || '')) return 0;
  return 1;
}

function buildDescriptionText(data) {
  const sections = data?.jobAd?.sections || {};
  const rawHtml = [
    sections.jobDescription?.text,
    sections.qualifications?.text,
  ].filter(Boolean).join('\n\n') || sections.companyDescription?.text || null;
  return rawHtml ? stripHtml(rawHtml) : null;
}


async function fetchBatch(batch, { fetchJson = getJson, delayMs = DELAY_MS, concurrency = CONCURRENCY }) {
  const out = [];
  let index = 0;

  async function worker() {
    while (index < batch.length) {
      const current = batch[index++];
      const numericId = current.id.split('-').slice(2).join('-');
      const url = `${BASE_URL}/${current.company_slug}/postings/${numericId}`;
      const data = await fetchJson(url);
      const description_text = buildDescriptionText(data);
      out.push({ id: current.id, description_text, schema_version: SIDECAR_SCHEMA_VERSION });
      if (delayMs > 0) await delay(delayMs);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batch.length || 1)) }, () => worker()));
  return out;
}


/**
 * Fetch descriptions for SR jobs not yet in descriptions-smartrecruiters.jsonl.
 *
 * @param {Array} srJobs - Normalized SR job objects (with company_slug and source_id fields)
 * @param {string} dataDir - Path to .github/data/
 * @returns {Promise<Map<string,string>>} Full id→description_text map (existing + newly fetched)
 */
async function fetchSRDescriptions(srJobs, dataDir, options = {}) {
  const filePath = path.join(dataDir, 'descriptions-smartrecruiters.jsonl');
  const cache = loadDescriptionCache(filePath);
  const existing = new Map(Array.from(cache, ([id, entry]) => [id, entry.description_text]));
  if (options.skipFetch) {
    console.log(`📄 SR descriptions: skipFetch=true — seeded cache only (${existing.size} entries), no new fetch (AGG-RUNTIME-ALERT-1)`);
    return existing;
  }
  const pending = srJobs.filter(j => {
    const entry = cache.get(j.id);
    return !entry || entry.description_text == null || entry.schema_version < SIDECAR_SCHEMA_VERSION;
  }).sort((a, b) => pendingPriority(a) - pendingPriority(b));
  if (pending.length === 0) {
    console.log(`📄 SR descriptions: ${existing.size} cached, 0 new to fetch`);
    return existing;
  }

  const maxPerRun = options.maxPerRun || MAX_PER_RUN;
  const concurrency = options.concurrency || CONCURRENCY;
  const delayMs = options.delayMs ?? DELAY_MS;
  const batch = pending.slice(0, maxPerRun);
  const deferred = pending.length - batch.length;
  console.log(`📄 SR descriptions: ${existing.size} cached, ${pending.length} new (fetching ${batch.length}${deferred > 0 ? `, deferring ${deferred}` : ''}; concurrency ${concurrency})...`);

  const newEntries = await fetchBatch(batch, {
    fetchJson: options.fetchJson || getJson,
    delayMs,
    concurrency,
  });

  let fetched = 0;
  let failed = 0;
  for (const entry of newEntries) {
    if (entry.description_text) {
      fetched++;
      existing.set(entry.id, entry.description_text);
    } else {
      failed++;
      existing.set(entry.id, null);
    }
  }

  appendDescriptions(filePath, newEntries);
  console.log(`📄 SR descriptions: fetched ${fetched}, failed/empty ${failed}`);
  return existing;
}

module.exports = { fetchSRDescriptions, fetchBatch };

