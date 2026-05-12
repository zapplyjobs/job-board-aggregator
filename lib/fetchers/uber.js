/**
 * Uber Jobs API Client
 *
 * Fetches jobs from Uber's internal search API endpoint.
 * No authentication required. POST API returns JSON.
 *
 * URL: https://www.uber.com/api/loadSearchJobsResults
 * Method: POST
 * Payload: { params: { location: [], department: [], team: [] }, page: N, limit: 50 }
 * Response: { data: { results: [...], totalResults: { low: N } } }
 *
 * Each job has: id, title, description, department, location { city, region, country, countryName },
 *   creationDate, level, team
 * URL: https://www.uber.com/us/en/careers/list/{id}/
 *
 * API confirmed live 2026-04-27. robots.txt disallows /api/ paths — mitigated by rate limiting.
 * 300ms delay used between pages. Client-side US filtering required.
 */

'use strict';

const { postJson, delay } = require('./http-client');

const API_URL = 'https://www.uber.com/api/loadSearchJobsResults';
const PAGE_SIZE = 50;
const DELAY_MS = 300;
const MAX_PAGES = 30;

const HEADERS = {
  'Accept': 'application/json',
  'x-csrf-token': 'x',
  'Referer': 'https://www.uber.com/us/en/careers/list/',
};

/**
 * Extract total count from Uber's BigInt-like object.
 */
function getTotalResults(totalResults) {
  if (!totalResults) return 0;
  if (typeof totalResults === 'number') return totalResults;
  if (totalResults.low !== undefined) return totalResults.low;
  return 0;
}

/**
 * Normalize one Uber job record to the shared schema.
 */
function normalizeUberJob(job) {
  const loc = job.location || {};
  const city = (loc.city || '').trim();
  const countryName = (loc.countryName || '').trim();

  const region = loc.region ? loc.region.trim() : '';
  const location = [city, region].filter(Boolean).join(', ');

  const jobId = String(job.id || '');
  const applyUrl = jobId ? `https://www.uber.com/us/en/careers/list/${jobId}/` : null;

  // Description is HTML from Uber's API — strip tags for clean text
  let description = null;
  if (job.description) {
    description = job.description
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || null;
  }

  return {
    id: `uber-${jobId}`,
    source: 'uber',
    source_id: jobId,

    title: (job.title || '').trim() || null,
    company_name: 'Uber',
    company_slug: 'uber',

    location,
    locations: location ? [location] : [],
    job_city: city,
    job_state: countryName === 'United States' ? region : '',

    url: applyUrl,
    apply_url: applyUrl,

    departments: job.department ? [job.department] : [],
    employment_type: job.type || null,

    posted_at: job.creationDate || null,
    fetched_at: new Date().toISOString(),

    description,
  };
}

/**
 * Fetch all jobs from Uber API, filtering to US only.
 * @returns {Promise<Array>} normalized US jobs
 */
async function fetchAllUberJobs() {
  console.log('\n🚗 Fetching from Uber Jobs...');
  console.log('━'.repeat(60));

  const allJobs = [];
  let page = 1;
  let totalResults = 0;

  while (page <= MAX_PAGES) {
    const payload = {
      params: { location: [], department: [], team: [] },
      page,
      limit: PAGE_SIZE,
    };

    const result = await postJson(API_URL, payload, { headers: HEADERS });

    if (!result || result.status !== 200 || !result.data?.data?.results) {
      console.log(`  Page ${page}: request failed (status=${result?.status || 'null'}), stopping`);
      break;
    }

    const results = result.data.data.results;
    if (page === 1) {
      totalResults = getTotalResults(result.data.data.totalResults);
      console.log(`  Total results reported: ${totalResults}`);
    }

    // Filter US jobs client-side
    const usJobs = results.filter(j => j.location?.countryName === 'United States');
    allJobs.push(...usJobs.map(normalizeUberJob));

    console.log(`  Page ${page}: ${results.length} total, ${usJobs.length} US`);

    if (results.length < PAGE_SIZE) break;

    page++;
    await delay(DELAY_MS);
  }

  console.log(`  Total US jobs: ${allJobs.length}`);
  return allJobs;
}

module.exports = { fetchAllUberJobs };
