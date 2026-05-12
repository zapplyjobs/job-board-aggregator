/**
 * Workday Description Fetcher (DESC-1)
 *
 * Incrementally fetches job descriptions for new Workday jobs.
 * Stores results in a sidecar JSONL file: .github/data/descriptions.jsonl
 * Each line: { id, description_text }
 *
 * Description URL: {baseUrl}/wday/cxs/{tenant}/{site}{externalPath}
 * Response: { jobPostingInfo: { jobDescription: "<HTML>..." } }
 * No auth required — same endpoint as the public career site.
 *
 * Per-run cost: only NEW job IDs not yet in descriptions.jsonl are fetched.
 * In steady state ~3 new Workday jobs/run × 0.4s = ~1s overhead.
 * Initial backfill: ~8000 jobs × 0.4s + 300ms delay ≈ 70 min — done ONCE.
 *
 * Called from index.js after ATS fetch, before writing all_jobs.json.
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const DELAY_MS = 300;
const TIMEOUT_MS = 10000;
const MAX_PER_RUN = 200; // Cap per run: ~200 × 0.4s ≈ 80s. Prevents timeout on initial backfill.

// HTML entity map for common entities — no external dep needed
const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—',
  '&lsquo;': "'", '&rsquo;': "'", '&ldquo;': '"', '&rdquo;': '"',
  '&bull;': '•', '&hellip;': '…',
};

/**
 * Strip HTML tags and decode entities from a description string.
 * Preserves newlines at block element boundaries for readability.
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    // Block elements → newline before stripping
    .replace(/<\/?(p|div|li|br|h[1-6]|ul|ol|section|article)[^>]*>/gi, '\n')
    // Strip all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode named entities
    .replace(/&[a-z]+;/gi, match => HTML_ENTITIES[match] || match)
    // Decode numeric entities &#NNN; and &#xHHH;
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    // Collapse whitespace: multiple spaces → one, multiple blank lines → one
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build the Workday description URL from stored _raw fields.
 * Pattern: {baseUrl}/wday/cxs/{tenant}/{site}{externalPath}
 * tenant = subdomain of baseUrl (e.g. "ochsner" from "ochsner.wd1.myworkdayjobs.com")
 */
function buildDescUrl(baseUrl, site, externalPath) {
  try {
    const hostname = new URL(baseUrl).hostname;          // e.g. "ochsner.wd1.myworkdayjobs.com"
    const tenant = hostname.split('.')[0];               // e.g. "ochsner"
    return `${baseUrl}/wday/cxs/${tenant}/${site}${externalPath}`;
  } catch (_) {
    return null;
  }
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

/**
 * Load existing descriptions.jsonl → Map<id, description_text>
 */
function loadDescriptions(filePath) {
  const map = new Map();
  if (!fs.existsSync(filePath)) return map;
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const { id, description_text } = JSON.parse(line);
      if (id) map.set(id, description_text);
    } catch (_) { /* skip malformed */ }
  }
  return map;
}

/**
 * Append new descriptions to the JSONL file.
 */
function appendDescriptions(filePath, entries) {
  if (entries.length === 0) return;
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf8');
}

/**
 * Fetch descriptions for new Workday jobs not yet in descriptions.jsonl.
 *
 * @param {Array} workdayJobs - Normalized Workday job objects (with _raw.baseUrl, _raw.site, _raw.externalPath)
 * @param {string} dataDir - Path to .github/data/
 * @returns {Promise<Map<string,string>>} Full id→description_text map (existing + newly fetched)
 */
async function fetchWorkdayDescriptions(workdayJobs, dataDir) {
  const filePath = path.join(dataDir, 'descriptions.jsonl');
  const existing = loadDescriptions(filePath);

  // Find jobs not yet described
  const pending = workdayJobs.filter(j => {
    const raw = j._raw || {};
    return !existing.has(j.id) && raw.externalPath && raw.baseUrl && raw.site;
  });

  if (pending.length === 0) {
    console.log(`📄 Workday descriptions: ${existing.size} cached, 0 new to fetch`);
    return existing;
  }

  // DESC-PRIORITY-1: Fetch US jobs first — they're enrichable, non-US are dead weight in sidecar.
  // At Step 1b, tags don't exist yet. Multiple heuristics to catch US jobs:
  //   1. job_state (set by parseWorkdayLocation for "City, ST" format)
  //   2. is_us_only flag (set for tenants with campus-only locations)
  //   3. "United States" in location text
  //   4. ", XX" at end of location where XX is a 2-letter state abbreviation
  //   5. Common US city names in location text
  const US_ABBRS = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);
  const US_CITY_RE = /\b(new york|los angeles|chicago|houston|phoenix|philadelphia|san antonio|san diego|dallas|san jose|austin|seattle|denver|boston|nashville|portland|atlanta|minneapolis|tampa|orlando|raleigh|charlotte|columbus|pittsburgh|detroit|salt lake|san francisco|washington)\b/i;
  const isLikelyUS = (j) => {
    if (j.job_state || j.is_us_only) return true;
    const loc = j.location || '';
    if (loc.includes('United States') || /^US\s*[-–—]/.test(loc)) return true;
    const m = loc.match(/,\s*([A-Z]{2})\s*$/);
    if (m && US_ABBRS.has(m[1])) return true;
    if (US_CITY_RE.test(loc)) return true;
    // Check URL slug for US state names (catches "N Locations" postings)
    const url = j.url || '';
    if (/\/(california|texas|new-york|florida|illinois|pennsylvania|ohio|georgia|north-carolina|michigan|virginia|washington|arizona|massachusetts|colorado|minnesota|maryland|oregon|indiana|tennessee|missouri|connecticut|utah|iowa|kentucky|alabama|louisiana|south-carolina|oklahoma|wisconsin|nevada|arkansas|mississippi|kansas|nebraska|idaho|new-jersey|new-mexico|west-virginia|hawaii|montana|delaware|rhode-island|south-dakota|north-dakota|alaska|wyoming|maine|vermont|new-hampshire|district-of-columbia)[\/\-]/i.test(url)) return true;
    return false;
  };
  pending.sort((a, b) => (isLikelyUS(b) ? 1 : 0) - (isLikelyUS(a) ? 1 : 0));

  // Cap to MAX_PER_RUN — remainder is deferred to next run (incremental backfill)
  const batch = pending.slice(0, MAX_PER_RUN);
  const deferred = pending.length - batch.length;
  console.log(`📄 Workday descriptions: ${existing.size} cached, ${pending.length} new (fetching ${batch.length}${deferred > 0 ? `, deferring ${deferred}` : ''})...`);

  const newEntries = [];
  let fetched = 0;
  let failed = 0;

  for (const job of batch) {
    const { baseUrl, site, externalPath } = job._raw;
    const url = buildDescUrl(baseUrl, site, externalPath);
    if (!url) { failed++; continue; }

    const data = await getJson(url);
    const rawHtml = data?.jobPostingInfo?.jobDescription || null;
    const description_text = rawHtml ? stripHtml(rawHtml) : null;

    if (description_text) {
      newEntries.push({ id: job.id, description_text });
      existing.set(job.id, description_text);
      fetched++;
    } else {
      // Store null so we don't retry every run (job may have no description)
      newEntries.push({ id: job.id, description_text: null });
      existing.set(job.id, null);
      failed++;
    }

    await delay(DELAY_MS);
  }

  appendDescriptions(filePath, newEntries);
  console.log(`📄 Workday descriptions: fetched ${fetched}, failed/empty ${failed}`);

  return existing;
}

module.exports = { fetchWorkdayDescriptions, stripHtml, loadDescriptions, appendDescriptions };
