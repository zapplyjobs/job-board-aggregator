/**
 * ByteDance Careers API Client
 *
 * Fetches US campus jobs from ByteDance's public careers API at jobs.bytedance.com.
 * No authentication required; browser discovery on 2026-06-18 showed the required
 * website-path and x-tt-env headers used by joinbytedance.com.
 */
'use strict';

const { postJson, delay } = require('./http-client');

const API_URL = 'https://jobs.bytedance.com/api/v1/public/supplier/search/job/posts';
const PAGE_SIZE = 100;
const MAX_JOBS = 2000;
const DELAY_MS = 200;
const TIMEOUT_MS = 30000;

const HEADERS = {
  'Content-Type': 'application/json',
  'accept-language': 'en-US',
  'origin': 'https://joinbytedance.com',
  'referer': 'https://joinbytedance.com/',
  'website-path': 'en',
  'x-tt-env': 'boe_epam_api',
};

// Same US city/location filter family used by the TikTok careers API.
const US_CITY_CODES = [
  'CT_75', 'CT_2001643', 'CT_203', 'CT_1103355', 'MDCY00039300',
  'CT_223', 'MDCY00008115', 'CT_247', 'CT_1103554', 'CT_221',
  'CT_233', 'CT_157', 'CT_94', 'MDCY00038339', 'CT_1000001', 'CT_114',
];

function buildLocation(cityInfo) {
  if (!cityInfo) return { city: '', state: '', location: '' };
  const city = cityInfo.en_name || '';
  const state = cityInfo.parent?.en_name || '';
  return { city, state, location: [city, state].filter(Boolean).join(', ') };
}

function normalizeByteDanceJob(job) {
  const { city, state, location } = buildLocation(job.city_info);
  const desc = [job.description, job.requirement].filter(Boolean).join('\n\n');

  return {
    id: `bytedance-${job.id}`,
    source: 'bytedance',
    source_id: String(job.id),

    title: (job.title || '').trim() || null,
    company_name: 'ByteDance',
    company_slug: 'bytedance',

    location,
    locations: location ? [location] : [],
    job_city: city,
    job_state: state,

    url: job.id ? `https://joinbytedance.com/search/${job.id}` : null,
    apply_url: job.id ? `https://jobs.bytedance.com/en/resume/${job.id}/apply` : null,

    departments: [],
    employment_type: null,

    posted_at: null,
    fetched_at: new Date().toISOString(),

    description: desc || null,
  };
}

async function fetchAllByteDanceJobs() {
  console.log('\n🏢 Fetching from ByteDance Careers...');
  console.log('━'.repeat(60));

  const allJobs = [];
  const seenIds = new Set();
  let offset = 0;
  let totalReported = null;

  while (allJobs.length < MAX_JOBS) {
    const body = {
      recruitment_id_list: ['2'],
      job_category_id_list: [],
      subject_id_list: [],
      location_code_list: US_CITY_CODES,
      limit: PAGE_SIZE,
      offset,
    };

    const result = await postJson(API_URL, body, { headers: HEADERS, timeout: TIMEOUT_MS });
    if (!result || !result.data) {
      console.log(`  ⚠️ ByteDance: request failed at offset=${offset}`);
      break;
    }

    const apiResponse = result.data;
    if (apiResponse.code !== 0) {
      console.log(`  ⚠️ ByteDance: API error code=${apiResponse.code}, stopping`);
      break;
    }

    const apiData = apiResponse.data;
    if (!apiData) {
      console.log('  ⚠️ ByteDance: no data in response, stopping');
      break;
    }

    if (totalReported === null) {
      totalReported = apiData.count || 0;
      console.log(`  API reports ${totalReported} US campus positions`);
    }

    const posts = apiData.job_post_list || [];
    if (posts.length === 0) break;

    for (const post of posts) {
      const job = normalizeByteDanceJob(post);
      if (!seenIds.has(job.id)) {
        seenIds.add(job.id);
        allJobs.push(job);
      }
    }

    if (posts.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;

    if (offset >= (totalReported || Infinity)) break;
    await delay(DELAY_MS);
  }

  const withDesc = allJobs.filter(j => j.description).length;
  console.log(`  Fetched: ${allJobs.length} jobs (${withDesc} with descriptions)`);
  return allJobs;
}

module.exports = { fetchAllByteDanceJobs, normalizeByteDanceJob };
