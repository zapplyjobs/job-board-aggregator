/**
 * Amazon Jobs API Client
 *
 * Fetches jobs from Amazon's public search API.
 * No authentication required.
 *
 * URL: https://www.amazon.jobs/en/search.json
 * Method: GET
 * Params: base_query, loc_query, country, offset, result_limit
 * Response: { hits: N, jobs: [...] }
 *
 * Each job has: id, title, company_name, city, state, country_code,
 *   posted_date ("February 24, 2026"), description, job_path
 * Apply URL: https://www.amazon.jobs{job_path}
 *
 * API confirmed live 2026-03-01. No rate limit published; 300ms delay used.
 * result_limit=100 accepted. US filter: country_code === 'USA'.
 */

'use strict';
const { resolveCountry, resolveCountryCode } = require('./country-resolver');

const { getJson, delay } = require('./http-client');

const BASE_URL = 'https://www.amazon.jobs';
const SEARCH_PATH = '/en/search.json';
const PAGE_SIZE = 100;
const MAX_JOBS_PER_QUERY = 500;
const DELAY_MS = 300;

// Queries targeting new-grad/entry-level roles across domains.
// Amazon's search does full-text match against title + description.
// Queries ordered by expected yield (SWE first for priority dedup).
const QUERIES = [
  'software development engineer',
  'data engineer',
  'machine learning',
  'systems engineer',
  'hardware engineer',
  'data scientist',
  'internship',
];

/**
 * Parse Amazon's "February 24, 2026" date string to ISO.
 * Returns null if unparseable — better null than wrong date.
 */
function parsePostedDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Normalize one Amazon job record to the shared schema.
 */
function normalizeAmazonJob(job) {
  const city = (job.city || '').trim();
  const state = (job.state || '').trim();
  const location = [city, state].filter(Boolean).join(', ');

  const applyUrl = job.job_path
    ? `${BASE_URL}${job.job_path}`
    : null;

  return {
    // Core fields
    id: `amazon-${job.id}`,
    source: 'amazon',
    source_id: String(job.id),

    // Job details
    title: (job.title || '').trim() || null,
    company_name: (job.company_name || 'Amazon').trim(),
    company_slug: 'amazon',

    // Location
    location,
    locations: location ? [location] : [],
    job_city: city,
    job_state: state,

    // URL
    url: applyUrl,
    apply_url: applyUrl,

    // Metadata
    departments: [],
    employment_type: null,

    // Dates
    posted_at: parsePostedDate(job.posted_date),
    fetched_at: new Date().toISOString(),

    // Description + qualifications from listing response (unlike Workday)
    // ENR-18: Amazon API returns basic_qualifications and preferred_qualifications
    // as separate fields containing degree requirements and detailed skill requirements.
    // S268A: Add section headers so enricher can find preferred_qualifications boundary
    // (was 0% nice_to_have_skills for 419 Amazon jobs — Session B finding).
    description: (() => {
      const parts = [];
      if (job.description) parts.push(job.description.trim());
      if (job.basic_qualifications) parts.push('Basic Qualifications:\n' + job.basic_qualifications.trim());
      if (job.preferred_qualifications) parts.push('Preferred Qualifications:\n' + job.preferred_qualifications.trim());
      return parts.length ? parts.join('\n\n') : null;
    })(),
  };
}

/**
 * Fetch jobs for a single query + country, up to MAX_JOBS_PER_QUERY.
 * AGG-GIANTCANADA-1: parameterized to support Canada alongside US.
 * @param {string} query - Search term
 * @param {string} locQuery - Location query (e.g. 'United States', 'Canada')
 * @param {string} countryCode - Filter (e.g. 'USA', 'CAN')
 * @returns {Promise<Array>} normalized jobs
 */
async function fetchQueryJobs(query, locQuery = resolveCountry('amazon', 'US'), countryCode = resolveCountryCode('amazon', 'US')) {
  const jobs = [];
  let offset = 0;

  while (offset < MAX_JOBS_PER_QUERY) {
    const params = new URLSearchParams({
      base_query: query,
      loc_query: locQuery,
      country: countryCode,
      offset: String(offset),
      result_limit: String(PAGE_SIZE),
    });
    const url = `${BASE_URL}${SEARCH_PATH}?${params}`;

    const result = await getJson(url);
    if (!result || result.status !== 200 || !result.data?.jobs) break;

    const page = result.data.jobs;
    if (page.length === 0) break;

    const countryJobs = page.filter(j => j.country_code === countryCode);
    jobs.push(...countryJobs.map(normalizeAmazonJob));

    if (page.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
    if (offset < MAX_JOBS_PER_QUERY) await delay(DELAY_MS);
  }

  return jobs;
}

/**
 * Fetch jobs from all Amazon queries (US + Canada).
 * @returns {Promise<Array>} normalized jobs (may contain duplicates across queries — deduped downstream)
 */
async function fetchAllAmazonJobs() {
  console.log('\n🛒 Fetching from Amazon Jobs...');
  console.log('━'.repeat(60));

  const allJobs = [];
  let usTotal = 0, caTotal = 0;

  for (const query of QUERIES) {
    // US
    const usJobs = await fetchQueryJobs(query, 'United States', 'USA');
    usTotal += usJobs.length;
    allJobs.push(...usJobs);

    // Canada (AGG-GIANTCANADA-1)
    await delay(DELAY_MS);
    const caJobs = await fetchQueryJobs(query, 'Canada', 'CAN');
    caTotal += caJobs.length;
    allJobs.push(...caJobs);

    console.log(`  "${query}": ${usJobs.length} US + ${caJobs.length} CA`);
    await delay(DELAY_MS);
  }

  console.log(`  Total (pre-dedup): ${allJobs.length} (${usTotal} US + ${caTotal} CA)`);
  return allJobs;
}

module.exports = { fetchAllAmazonJobs };
