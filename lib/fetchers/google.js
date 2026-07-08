/**
 * Google Jobs Fetcher
 *
 * Fetches jobs from Google's career portal via WIZ framework HTML extraction.
 * No authentication required. GET request returns HTML with embedded JSON data.
 *
 * URL: https://www.google.com/about/careers/applications/jobs/results/
 * Params: location, company, q, employment_type, page
 * Extraction: AF_initDataCallback with key 'ds:1' contains job data array
 *
 * Each job entry: [id, title, url, [null, description_html], level, ...]
 * Total count and page size at end of data array.
 *
 * DETAIL PAGE FETCH (AGG-FETCH-9, C62):
 * After extracting listings, fetches each job's detail page to get full
 * qualifications (Minimum + Preferred). The listing page only has responsibilities;
 * the detail page has "Minimum qualifications" (degree + years) and
 * "Preferred qualifications" (specific skills) in the ds:0 WIZ block.
 *
 * PROGRESSIVE SIDECAR (AGG-FETCH-13):
 * Each detail page is appended to the sidecar file immediately after fetch.
 * If the fetcher times out, already-fetched pages survive in the sidecar.
 * Next run finds them in cache and skips them — progressive saturation.
 *
 * API confirmed live 2026-04-27. robots.txt disallows the path — mitigated by rate limiting.
 * 500ms delay between pages (Google is more sensitive). 1.25 MB per page.
 * MAX_ROUTINE_PAGES caps routine runs to avoid excessive bandwidth.
 *
 * Queries (5): Software Engineer (broad, 739), new grad software engineer (entry-level, 1034),
 *   University Graduate (high-precision, 12), Early Career (PhD, 79), internship (SUP-INTERN-1).
 *   The "new grad" query surfaces entry-level job IDs that don't appear on page 1 of the
 *   "Software Engineer" query — cross-query dedup ensures no duplicates in output.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getHtml, delay } = require('./http-client');

const BASE_URL = 'https://www.google.com/about/careers/applications/jobs/results/';
const PAGE_SIZE = 20;
const DELAY_MS = 500;
const DETAIL_DELAY_MS = 450;
const MAX_PAGES = 60;
const MAX_ROUTINE_PAGES = 50;

const COMPANIES = ['Google', 'DeepMind', 'YouTube'];

const QUERIES = [
  { q: 'Software Engineer' },
  { q: 'new grad software engineer' },
  { q: 'University Graduate' },
  { q: 'Early Career' },
  { q: 'internship' },
];

const HEADERS = {
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};


function normalizeGoogleDescriptionText(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = text
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized || null;
}
/**
 * Extract job data from Google's WIZ framework HTML.
 * Finds AF_initDataCallback with key 'ds:1' and parses the data array.
 */
function extractJobsFromHtml(html) {
  if (!html) return { jobs: [], total: 0 };

  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let dataStr = null;

  while ((match = scriptRegex.exec(html)) !== null) {
    const scriptContent = match[1];
    const dataMatch = scriptContent.match(
      /AF_initDataCallback\(\{key:\s*['"]ds:1['"]\s*,\s*hash:\s*['"][^"']*['"]\s*,\s*data:(\[[\s\S]+?\])\s*,\s*sideChannel:/
    );
    if (dataMatch) {
      dataStr = dataMatch[1];
      break;
    }
  }

  if (!dataStr) return { jobs: [], total: 0 };

  const decoded = dataStr
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u003d/g, '=')
    .replace(/\\u0026/g, '&')
    .replace(/\\u0027/g, "'");

  const totalMatch = decoded.match(/null,(\d+),(\d+)\]$/);
  const total = totalMatch ? parseInt(totalMatch[1]) : 0;

  const jobPattern = /\["(\d{15,25})","([^"]+?)","(https:\/\/www\.google\.com\/about\/careers\/[^"]+?)"/g;
  const jobs = [];

  let jobMatch;
  while ((jobMatch = jobPattern.exec(decoded)) !== null) {
    const jobId = jobMatch[1];
    const title = jobMatch[2];
    let url = jobMatch[3];

    url = url.replace(/&amp;/g, '&');

    const descStart = jobMatch.index + jobMatch[0].length;
    const afterUrl = decoded.substring(descStart, descStart + 2000);

    let description = null;
    const descMatch = afterUrl.match(/^,?\s*\[null,"(<[^"]{10,})"/);
    if (descMatch) {
      description = normalizeGoogleDescriptionText(
        descMatch[1]
          .replace(/<\/?(?:ul|ol|li|h[1-6]|p|div|br|strong|em|a|span)[^>]*>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
      );
    }

    jobs.push({ jobId, title, url, description });
  }

  return { jobs, total };
}

/**
 * Fetch a single Google job detail page and extract qualifications.
 * The detail page has ds:0 WIZ block with "Minimum qualifications" and
 * "Preferred qualifications" sections that the listing page lacks.
 *
 * @param {string} jobId - Google job ID (numeric string)
 * @returns {Promise<{minimumQualifications: string, preferredQualifications: string}|null>}
 */
async function fetchJobDetail(jobId) {
  const url = `${BASE_URL}${jobId}`;
  try {
    const result = await getHtml(url, { headers: HEADERS, timeout: 15000 });
    if (!result || result.status !== 200 || !result.html) return null;

    // Check for redirect to search page (expired job)
    const titleMatch = result.html.match(/<title>(.*?)<\/title>/);
    if (titleMatch && titleMatch[1].trim() === 'Jobs search') return null;

    // Extract qualifications from HTML directly (more reliable than parsing WIZ for detail pages)
    const minQualMatch = result.html.match(
      /Minimum qualifications:<\/h3>\s*<ul>([\s\S]*?)<\/ul>/
    );
    const prefQualMatch = result.html.match(
      /Preferred qualifications:<\/h3>\s*<ul>([\s\S]*?)<\/ul>/
    );

    const stripHtml = (html) =>
      normalizeGoogleDescriptionText(
        html
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/li>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
      ) || '';

    const minimumQualifications = minQualMatch ? stripHtml(minQualMatch[1]) : '';
    const preferredQualifications = prefQualMatch ? stripHtml(prefQualMatch[1]) : '';

    if (!minimumQualifications && !preferredQualifications) return null;

    return { minimumQualifications, preferredQualifications };
  } catch (e) {
    return null;
  }
}

/**
 * Build a full description from listing responsibilities + detail page qualifications.
 * Format: [Responsibilities] + [Minimum Qualifications] + [Preferred Qualifications]
 */
function buildFullDescription(listingDescription, qualifications) {
  const parts = [];

  if (listingDescription) {
    parts.push(listingDescription);
  }

  if (qualifications) {
    if (qualifications.minimumQualifications) {
      parts.push(`Minimum Qualifications:\n${qualifications.minimumQualifications}`);
    }
    if (qualifications.preferredQualifications) {
      parts.push(`Preferred Qualifications:\n${qualifications.preferredQualifications}`);
    }
  }

  return normalizeGoogleDescriptionText(parts.join('\n\n'));
}

/**
 * Normalize a Google job entry to the shared schema.
 */
function normalizeGoogleJob(job) {
  const applyUrl = `https://www.google.com/about/careers/applications/jobs/results/${job.jobId}`;

  return {
    id: `google-${job.jobId}`,
    source: 'google',
    source_id: job.jobId,

    title: (job.title || '').trim() || null,
    company_name: 'Google',
    company_slug: 'google',

    location: 'United States',
    locations: ['United States'],
    job_city: '',
    job_state: '',

    url: applyUrl,
    apply_url: applyUrl,

    departments: [],
    employment_type: null,

    posted_at: new Date().toISOString(),
    fetched_at: new Date().toISOString(),

    description: job.description,
  };
}

/**
 * Fetch all Google jobs for a single query.
 * @param {Object} query - { q, employment_type }
 * @param {number} maxPages - Max pages to fetch
 * @returns {Promise<Array>} normalized jobs
 */
async function fetchQueryJobs(query, maxPages) {
  const jobs = [];
  const seenIds = new Set();
  let page = 1;
  let total = 0;

  while (page <= maxPages) {
    const params = new URLSearchParams({
      location: 'United States',
      q: query.q,
      page: String(page),
    });
    if (query.employment_type) {
      params.set('employment_type', query.employment_type);
    }
    for (const c of COMPANIES) {
      params.append('company', c);
    }

    const url = `${BASE_URL}?${params.toString()}`;
    const result = await getHtml(url, { headers: HEADERS, timeout: 20000 });

    if (!result || result.status !== 200) {
      console.log(`  Page ${page}: HTTP ${result?.status || 'null'}, stopping`);
      break;
    }

    const extracted = extractJobsFromHtml(result.html);
    if (page === 1) {
      total = extracted.total;
      console.log(`  Total results: ${total}`);
    }

    const newJobs = extracted.jobs.filter(j => !seenIds.has(j.jobId));
    for (const j of newJobs) seenIds.add(j.jobId);

    jobs.push(...newJobs);
    console.log(`  Page ${page}: ${extracted.jobs.length} extracted, ${newJobs.length} new (running total: ${jobs.length})`);

    if (extracted.jobs.length < PAGE_SIZE) break;
    if (page * PAGE_SIZE >= total) break;

    page++;
    await delay(DELAY_MS);
  }

  return jobs;
}

/**
 * Append a single enriched description to the sidecar file (AGG-FETCH-13).
 * Progressive write: each detail page is persisted immediately, surviving timeout.
 * @param {string} dataDir - Path to data directory for sidecar files
 * @param {string} jobId - Job ID (e.g. "google-12345")
 * @param {string} description - Full description with qualifications
 */
function appendToSidecar(dataDir, jobId, description) {
  if (!dataDir) return;
  const normalizedDescription = normalizeGoogleDescriptionText(description);
  if (!normalizedDescription) return;
  const sidecarPath = path.join(dataDir, 'descriptions-google.jsonl');
  const entry = JSON.stringify({ id: jobId, description_text: normalizedDescription }) + '\n';
  fs.appendFileSync(sidecarPath, entry, 'utf8');
}

function rewriteGoogleSidecar(dataDir, jobs) {
  if (!dataDir) return;
  const sidecarPath = path.join(dataDir, 'descriptions-google.jsonl');
  const entries = jobs
    .map(job => ({
      id: job.id,
      description_text: normalizeGoogleDescriptionText(job.description),
    }))
    .filter(entry => entry.id && entry.description_text);
  const content = entries.length
    ? entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
    : '';
  fs.writeFileSync(sidecarPath, content, 'utf8');
}


/**
 * Fetch detail pages for jobs that need richer descriptions.
 * Progressive sidecar write (AGG-FETCH-13): each enriched page is appended
 * to the sidecar immediately, so a timeout only loses unfetched pages.
 *
 * @param {Array} jobs - Jobs from listing extraction
 * @param {Set<string>} [cachedIds] - Job IDs already in sidecar (skip fetch)
 * @param {string} [dataDir] - Data directory for progressive sidecar writes
 * @returns {Promise<Array>} Jobs with enriched descriptions
 */
async function fetchDetailPages(jobs, cachedIds, dataDir) {
  const MAX_DETAIL_PER_RUN = 200; // AGG-SLOWLANE-SPEED-1: cap per-run to prevent timeout on cold-start
  const toFetchRaw = cachedIds
    ? jobs.filter(j => !cachedIds.has(`google-${j.jobId}`))
    : jobs;
  const toFetch = toFetchRaw.slice(0, MAX_DETAIL_PER_RUN);
  const deferred = toFetchRaw.length - toFetch.length;
  const cachedCount = jobs.length - toFetchRaw.length;

  if (cachedCount > 0) {
    console.log(`  Cache: ${cachedCount}/${jobs.length} already in sidecar, ${toFetchRaw.length} need fetching${deferred > 0 ? ` (capping at ${MAX_DETAIL_PER_RUN}/run, deferring ${deferred})` : ''}`);
  }
  console.log(`\n  📄 Fetching detail pages for ${toFetch.length} Google jobs...`);

  // AGG-SLOW-LANE-1: Concurrent detail fetch (concurrency=3, Google rate-limits aggressively).
  // Sequential was ~12min for 1029 jobs (450ms delay × 1029). Concurrent: ~3min.
  // Batch of 3 → parallel fetch → sequential sidecar write → delay → next batch.
  const CONCURRENCY = 3;
  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < toFetch.length; i += CONCURRENCY) {
    const slice = toFetch.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map(async (job) => {
      const qualifications = await fetchJobDetail(job.jobId);
      return { job, qualifications };
    }));

    for (const { job, qualifications } of results) {
      if (qualifications) {
        job.description = buildFullDescription(job.description, qualifications);
        enriched++;
        appendToSidecar(dataDir, `google-${job.jobId}`, job.description);
      } else if (job.description && job.description.length > 200) {
        skipped++;
      } else {
        failed++;
      }
    }

    if ((i + CONCURRENCY) % 50 < CONCURRENCY) {
      console.log(`    Detail fetch: ${Math.min(i + CONCURRENCY, toFetch.length)}/${toFetch.length} (${enriched} enriched, ${failed} failed, ${skipped} skipped)`);
    }

    await delay(DETAIL_DELAY_MS);
  }

  console.log(`  Detail fetch complete: ${enriched} enriched, ${failed} failed, ${skipped} skipped out of ${toFetch.length}`);
  return jobs;
}

/**
 * Fetch all Google jobs across queries.
 * @param {Object} options - { previousJobCount, cachedDescriptionIds, dataDir }
 * @returns {Promise<Array>} normalized jobs (may contain duplicates across queries)
 */
async function fetchAllGoogleJobs(options = {}) {
  console.log('\n🔍 Fetching from Google Careers...');
  console.log('━'.repeat(60));

  const { previousJobCount = 0, previousJobIds, cachedDescriptionIds, dataDir } = options;
  const maxPages = previousJobCount < 100 ? MAX_PAGES : MAX_ROUTINE_PAGES;

  const allJobs = [];
  const seenIds = new Set();

  for (const query of QUERIES) {
    console.log(`\n  Query: "${query.q}" (max ${maxPages} pages)`);
    const jobs = await fetchQueryJobs(query, maxPages);

    // AGG-SLOWLANE-FRAGILITY-1 Point 4: page-1 incremental skip (same as Apple).
    if (previousJobIds && previousJobIds.size > 0 && jobs.length > 0) {
      const allKnown = jobs.every(j => previousJobIds.has(`google-${j.jobId}`));
      if (allKnown) {
        console.log(`  ⚡ Skip: page 1 all-known — skipping remaining ${maxPages - 1} pages`);
        const newJobs = jobs.filter(j => !seenIds.has(j.jobId));
        for (const j of newJobs) seenIds.add(j.jobId);
        allJobs.push(...newJobs);
        console.log(`  Query total: ${jobs.length} extracted, ${newJobs.length} new (skipped ${maxPages - 1} pages)`);
        await delay(DELAY_MS);
        continue;
      }
    }

    const newJobs = jobs.filter(j => !seenIds.has(j.jobId));
    for (const j of newJobs) seenIds.add(j.jobId);

    allJobs.push(...newJobs);
    console.log(`  Query total: ${jobs.length} extracted, ${newJobs.length} new after dedup`);

    await delay(DELAY_MS);
  }

  // Fetch detail pages for qualifications (AGG-FETCH-9, cached with AGG-FETCH-10, progressive AGG-FETCH-13)
  await fetchDetailPages(allJobs, cachedDescriptionIds, dataDir);

  const normalized = allJobs.map(normalizeGoogleJob);
  rewriteGoogleSidecar(dataDir, normalized);
  console.log(`\n  Total unique jobs: ${normalized.length}`);
  return normalized;
}

/**
 * AGG-GIANTCANADA-1: Fetch Google Canada jobs.
 * Makes independent requests with location=Canada, uses same extraction logic.
 * Does NOT modify existing functions — adds Canada as a separate export.
 * @param {Object} options - { cachedDescriptionIds, dataDir }
 * @returns {Promise<Array>} normalized Canada jobs
 */
async function fetchGoogleCanadaJobs(options = {}) {
  const { cachedDescriptionIds, dataDir } = options;
  const caJobs = [];
  const seenIds = new Set();
  const maxPages = 20;

  console.log('\n🔍 Fetching Google Canada jobs...');

  for (const query of QUERIES) {
    let page = 1;
    while (page <= maxPages) {
      const params = new URLSearchParams({ location: 'Canada', q: query.q, page: String(page) });
      if (query.employment_type) params.set('employment_type', query.employment_type);
      for (const c of COMPANIES) params.append('company', c);
      const url = `${BASE_URL}?${params}`;

      const result = await getHtml(url, { headers: HEADERS, timeout: 15000 });
      if (!result || result.status !== 200) break;

      const extracted = extractJobsFromHtml(result.html);
      if (page === 1) console.log(`  Canada "${query.q}": ${extracted.total} results`);

      const newJobs = extracted.jobs.filter(j => !seenIds.has(j.jobId));
      for (const j of newJobs) {
        seenIds.add(j.jobId);
        const normalized = normalizeGoogleJob(j);
        normalized.location = 'Canada';
        normalized.locations = ['Canada'];
        caJobs.push(normalized);
      }

      if (extracted.jobs.length < PAGE_SIZE) break;
      if (page * PAGE_SIZE >= extracted.total) break;
      page++;
      await delay(DELAY_MS);
    }
    await delay(DELAY_MS);
  }

  if (caJobs.length > 0 && dataDir) {
    // Write Canada descriptions to the same sidecar (progressive write)
    for (const job of caJobs) {
      if (job.description) appendToSidecar(dataDir, job.id, job.description);
    }
  }

  console.log(`  Canada total: ${caJobs.length} unique jobs`);
  return caJobs;
}

module.exports = { fetchAllGoogleJobs, fetchGoogleCanadaJobs, normalizeGoogleDescriptionText, buildFullDescription, rewriteGoogleSidecar };
