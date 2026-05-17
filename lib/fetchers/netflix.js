/**
 * Netflix Jobs API Client
 *
 * Fetches jobs from Netflix's public career site API.
 * No authentication required.
 *
 * URL: https://explore.jobs.netflix.net/api/apply/v2/jobs
 * Method: GET
 * Params: domain, query, location, num, start
 * Response: { count: N, positions: [...] }
 *
 * Each position has: id, name, location, locations[], department,
 *   business_unit, t_create (unix seconds), canonicalPositionUrl
 *
 * API confirmed live 2026-03-14. Returns max 10 results per page regardless
 * of num param — paginate with start offset. US filter via location param.
 *
 * Note: source field is 'eightfold' (not 'netflix') because this fetcher was
 * built on the same API pattern as the generic Eightfold fetcher (now removed).
 * Kept for consistency with historical records in all_jobs.json (AGG-DATA-9).
 */

'use strict';

const { getJson, delay } = require('./http-client');

const BASE_URL = 'https://explore.jobs.netflix.net';
const JOBS_PATH = '/api/apply/v2/jobs';
const PAGE_SIZE = 10; // API maximum — larger num values are silently capped
const MAX_JOBS = 500; // safety cap (Netflix US pool is ~240 as of 2026-03-14)
const DELAY_MS = 300;

/**
 * Parse a Netflix location string into city and state.
 * Format: "Los Gatos,California,United States of America"
 * Returns { city, state, location }
 */
function parseLocation(locationStr) {
  if (!locationStr) return { city: '', state: '', location: '' };
  const parts = locationStr.split(',').map(p => p.trim());
  const city = parts[0] || '';
  const state = parts[1] || '';
  const location = [city, state].filter(Boolean).join(', ');
  return { city, state, location };
}

/**
 * Normalize one Netflix position to the shared schema.
 */
function normalizeNetflixJob(position) {
  const { city, state, location } = parseLocation(position.location);

  // t_create is unix seconds
  const postedAt = position.t_create
    ? new Date(position.t_create * 1000).toISOString()
    : null;

  return {
    // Core fields — source is 'eightfold' (same API as generic EF fetcher, consistent with GH/Lever/Ashby convention)
    id: `eightfold-netflix-${position.id}`,
    source: 'eightfold',
    source_id: String(position.id),

    // Job details
    title: (position.name || position.posting_name || '').trim() || null,
    company_name: 'Netflix',
    company_slug: 'netflix',

    // Location — use first location entry (primary posting location)
    location,
    locations: location ? [location] : [],
    job_city: city,
    job_state: state,

    // URL
    url: position.canonicalPositionUrl || null,
    apply_url: position.canonicalPositionUrl || null,

    // Metadata
    departments: position.department ? [position.department] : [],
    employment_type: null,

    // Dates
    posted_at: postedAt,
    fetched_at: new Date().toISOString(),

    // No description in listing response
    description: null,
  };
}

/**
 * Fetch all US Netflix jobs, paginating until exhausted or MAX_JOBS reached.
 * Then fetches internship-specific listings for SUP-INTERN-1.
 * @returns {Promise<Array>} normalized jobs
 */
async function fetchAllNetflixJobs() {
  console.log('\n🎬 Fetching from Netflix Jobs...');
  console.log('━'.repeat(60));

  const allJobs = [];
  const seenIds = new Set();
  let start = 0;
  let totalReported = null;

  while (allJobs.length < MAX_JOBS) {
    const params = new URLSearchParams({
      domain: 'netflix.com',
      query: '',
      location: 'United States',
      num: String(PAGE_SIZE),
      start: String(start),
    });
    const url = `${BASE_URL}${JOBS_PATH}?${params}`;

    const result = await getJson(url);
    if (!result || result.status !== 200 || !result.data?.positions) {
      console.log(`  ⚠️ Netflix: request failed at start=${start}`);
      break;
    }

    if (totalReported === null) {
      totalReported = result.data.count || 0;
    }

    const page = result.data.positions;
    if (page.length === 0) break;

    for (const pos of page) {
      const job = normalizeNetflixJob(pos);
      if (!seenIds.has(job.id)) { seenIds.add(job.id); allJobs.push(job); }
    }

    if (page.length < PAGE_SIZE) break; // last page
    if (start + PAGE_SIZE >= (totalReported || Infinity)) break;

    start += PAGE_SIZE;
    await delay(DELAY_MS);
  }

  console.log(`  Main fetch: ${allJobs.length} jobs (API reported: ${totalReported})`);

  // SUP-INTERN-1: Fetch internship listings
  let internCount = 0;
  start = 0;
  while (start < MAX_JOBS) {
    const params = new URLSearchParams({
      domain: 'netflix.com',
      query: 'internship',
      location: 'United States',
      num: String(PAGE_SIZE),
      start: String(start),
    });
    const url = `${BASE_URL}${JOBS_PATH}?${params}`;

    const result = await getJson(url);
    if (!result || result.status !== 200 || !result.data?.positions) break;

    const page = result.data.positions;
    if (page.length === 0) break;

    for (const pos of page) {
      const job = normalizeNetflixJob(pos);
      if (!seenIds.has(job.id)) { seenIds.add(job.id); allJobs.push(job); internCount++; }
    }

    if (page.length < PAGE_SIZE) break;
    start += PAGE_SIZE;
    await delay(DELAY_MS);
  }

  if (internCount > 0) console.log(`  Internship query: +${internCount} new jobs`);
  console.log(`  Netflix total: ${allJobs.length} jobs`);

  return allJobs;
}

module.exports = { fetchAllNetflixJobs };
