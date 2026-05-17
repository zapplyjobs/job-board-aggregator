/**
 * SmartRecruiters Job Board API Client
 *
 * Fetches jobs from companies using the SmartRecruiters ATS.
 * No authentication required for public listings.
 *
 * Endpoint: GET https://api.smartrecruiters.com/v1/companies/{slug}/postings
 * Params:
 *   country=us   — server-side US filter (works reliably)
 *   limit=100    — max page size
 *   offset=N     — pagination
 *
 * NOTE: typeOfEmployment and experienceLevel filters do NOT work server-side.
 *       Filter client-side after fetching.
 *
 * Apply URL: https://jobs.smartrecruiters.com/{slug}/{id}
 *
 * 17 confirmed slugs verified 2026-03-11 S154:
 *   VeoliaEnvironnementSA(45 interns), BoschGroup(42), AbbVie(33), NBCUniversal3(21),
 *   Sandisk(22), RESPECInc(18), RedBull(18), SmithsGroup2(12), Intuitive(16),
 *   WesternDigital(14), ServiceNow(4), Visa(7), LinkedIn3(3), Experian(1).
 *   Zero interns but US-active: RaytheonTechnologies, EVERSANA1, WellmarkInc.
 */

'use strict';

const https = require('https');

const BASE_URL = 'https://api.smartrecruiters.com/v1/companies';
const PAGE_SIZE = 100;
const MAX_JOBS_PER_COMPANY = 2000;
const DELAY_MS = 300;

/**
 * GET request returning parsed JSON, or null on error/timeout.
 */
function getJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-board-bot/1.0)' }
    }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch (_) { resolve(null); }
      });
    });
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Normalize one SmartRecruiters posting to the shared schema.
 * @param {Object} job - raw posting from API
 * @param {string} slug - e.g. 'BoschGroup'
 * @param {string} companyName - display name, e.g. 'Bosch Group'
 */
function normalizeSmartRecruitersJob(job, slug, companyName) {
  const loc = job.location || {};
  const city    = loc.city    || '';
  const region  = loc.region  || '';
  const country = loc.country || '';
  const isRemote = loc.remote || false;
  const isHybrid = loc.hybrid || false;

  // Build canonical location string
  let locationStr = '';
  if (city && region)       locationStr = `${city}, ${region}`;
  else if (city)            locationStr = city;
  else if (loc.fullLocation) locationStr = loc.fullLocation;
  else if (isRemote)        locationStr = 'Remote';

  // Employment type mapping
  const empTypeId = (job.typeOfEmployment || {}).id || '';
  let employmentType = null;
  if (empTypeId === 'permanent')  employmentType = 'full-time';
  else if (empTypeId === 'contract') employmentType = 'contract';
  else if (empTypeId === 'temporary') employmentType = 'temporary';
  else if (empTypeId === 'parttime') employmentType = 'part-time';
  else if (empTypeId === 'internship') employmentType = 'internship';

  // Experience level
  const expLevelId = (job.experienceLevel || {}).id || '';

  const applyUrl = `https://jobs.smartrecruiters.com/${slug}/${job.id}`;
  const displayName = (job.company || {}).name || companyName;

  return {
    id: `sr-${slug}-${job.id}`,
    source: 'smartrecruiters',
    source_url: 'api.smartrecruiters.com',
    source_id: job.id,

    title: (job.name || '').replace(/\|/g, ' ').trim(),
    company_name: displayName.replace(/\|/g, ' ').trim(),
    company_slug: slug,

    location: locationStr,
    locations: [locationStr],
    is_remote: isRemote,
    is_hybrid: isHybrid,

    url: applyUrl,
    apply_url: applyUrl,

    department: (job.department || {}).label || null,
    employment_type: employmentType,
    experience_level_raw: expLevelId,

    posted_at: job.releasedDate || new Date().toISOString(),
    fetched_at: new Date().toISOString(),

    description: null,  // Not in listing API; available via detail endpoint if needed

    _raw: {
      source: 'smartrecruiters',
      original_id: job.id
    }
  };
}

/**
 * Fetch all US jobs from one SmartRecruiters company (paginates automatically).
 * @param {string} slug - SR company identifier (e.g. 'BoschGroup')
 * @param {string} companyName - display name
 * @returns {Promise<Array>} normalized jobs
 */
async function fetchSmartRecruitersJobs(slug, companyName) {
  const allJobs = [];
  let offset = 0;

  while (allJobs.length < MAX_JOBS_PER_COMPANY) {
    const url = `${BASE_URL}/${slug}/postings?country=us&limit=${PAGE_SIZE}&offset=${offset}`;
    const result = await getJson(url);

    if (!result) {
      console.log(`   ⚠️ SR network error: ${slug} (offset ${offset})`);
      break;
    }

    if (result.status === 404) {
      console.log(`   ⚠️ SR company not found: ${slug}`);
      break;
    }

    if (result.status !== 200) {
      console.log(`   ⚠️ SR API error for ${slug}: HTTP ${result.status}`);
      break;
    }

    const data = result.data;
    const jobs = data.content || [];
    const totalFound = data.totalFound || 0;

    for (const job of jobs) {
      allJobs.push(normalizeSmartRecruitersJob(job, slug, companyName));
    }

    offset += PAGE_SIZE;
    if (offset >= totalFound || jobs.length === 0) break;

    await delay(DELAY_MS);
  }

  return allJobs;
}

/**
 * Fetch jobs from multiple SmartRecruiters companies.
 * @param {Array<{slug: string, name: string}>} companies
 * @param {Object} options
 * @param {number} options.concurrency - parallel requests per batch (default: 3)
 * @param {number} options.delayMs - delay between batches in ms (default: DELAY_MS)
 * @returns {Promise<Array>} all normalized jobs
 */
async function fetchAllSmartRecruitersJobs(companies, options = {}) {
  const { concurrency = 3, delayMs = DELAY_MS } = options;
  const allJobs = [];

  console.log(`::group::🟠 SmartRecruiters (${companies.length} boards)`);
  console.log(`🟠 Fetching from ${companies.length} SmartRecruiters boards (concurrency: ${concurrency})...`);

  for (let i = 0; i < companies.length; i += concurrency) {
    const batch = companies.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (company) => {
      const slug = typeof company === 'string' ? company : (company.slug || company.companyIdentifier);
      const name = typeof company === 'string' ? company : company.name;
      try {
        const jobs = await fetchSmartRecruitersJobs(slug, name);
        if (jobs.length > 0) console.log(`   ✅ ${name}: ${jobs.length} jobs`);
        else console.log(`   ○ ${name}: 0 jobs`);
        return jobs;
      } catch (err) {
        console.error(`   ❌ ${name}: ${err.message}`);
        return [];
      }
    }));
    for (const jobs of results) allJobs.push(...jobs);
    if (delayMs > 0 && i + concurrency < companies.length) {
      await delay(delayMs);
    }
  }

  console.log(`   📊 SmartRecruiters total: ${allJobs.length} jobs`);
  console.log('::endgroup::');
  return allJobs;
}

module.exports = {
  fetchSmartRecruitersJobs,
  fetchAllSmartRecruitersJobs,
  normalizeSmartRecruitersJob
};
