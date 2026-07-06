/**
 * TikTok Careers API Client
 *
 * Fetches jobs from TikTok's public career site API at api.lifeattiktok.com.
 * No authentication required.
 *
 * Endpoint: POST https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts
 * Headers: Content-Type: application/json, website-path: tiktok
 * Body: { location_code_list, recruitment_type_id_list, limit, offset }
 * Response: { code: 0, data: { job_post_list: [...], count: N } }
 *
 * Each job has: id, title, description (1.7-3.3K chars), requirement (0.6-1.2K chars),
 *   city_info (nested hierarchy: city -> state -> country with codes)
 *
 * API confirmed live 2026-05-16 (F83). 841 US campus positions (vs 150 from SimplifyJs).
 * Full descriptions + requirements inline - no detail fetch needed.
 *
 * AGG-SURVIVE-1 A151: direct fetcher exists, but Simplify fallback is restored for
 * TikTok/ByteDance parity until the direct path proves stable target-visible survival.
 */

'use strict';

const { postJson, delay } = require('./http-client');

const API_URL = 'https://api.lifeattiktok.com/api/v1/public/supplier/search/job/posts';
const PAGE_SIZE = 100;
const MAX_JOBS = 2000;
const DELAY_MS = 200;
const TIMEOUT_MS = 30000;

const HEADERS = {
  'Content-Type': 'application/json',
  'accept-language': 'en-US',
  'origin': 'https://lifeattiktok.com',
  'website-path': 'tiktok',
};

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

function normalizeTiktokJob(job) {
  const { city, state, location } = buildLocation(job.city_info);
  const desc = [job.description, job.requirement].filter(Boolean).join('\n\n');

  // AGG-TIKTOK-DATE-1: Extract posting date from API (Unix epoch seconds).
  // Without posted_at, all TikTok jobs are stuck as stale-candidate forever
  // (classifyAgeLifecycle returns stale-candidate for null posted_at, and
  // isLifecycleHardRetired returns false for null → never lifecycle-managed).
  const dateTs = job.create_time || job.publish_time || job.update_time;
  const postedAt = dateTs ? new Date(dateTs * 1000).toISOString() : null;

  return {
    id: `tiktok-${job.id}`,
    source: 'tiktok',
    source_id: String(job.id),

    title: (job.title || '').trim() || null,
    company_name: 'TikTok',
    company_slug: 'tiktok',

    location,
    locations: location ? [location] : [],
    job_city: city,
    job_state: state,

    url: job.id ? `https://lifeattiktok.com/position/${job.id}` : null,
    apply_url: job.id ? `https://lifeattiktok.com/position/${job.id}` : null,

    departments: [],
    employment_type: null,

    posted_at: postedAt,
    fetched_at: new Date().toISOString(),

    description: desc || null,
  };
}

async function fetchAllTiktokJobs() {
  console.log('\n\U0001F3B5 Fetching from TikTok Careers...');
  console.log('━'.repeat(60));

  const allJobs = [];
  const seenIds = new Set();
  let offset = 0;
  let totalReported = null;

  while (allJobs.length < MAX_JOBS) {
    const body = {
      location_code_list: US_CITY_CODES,
      recruitment_type_id_list: ['2'],
      limit: PAGE_SIZE,
      offset,
    };

    const result = await postJson(API_URL, body, { headers: HEADERS, timeout: TIMEOUT_MS });

    if (!result || !result.data) {
      console.log(`  ⚠️ TikTok: request failed at offset=${offset}`);
      break;
    }

    const apiResponse = result.data;
    if (apiResponse.code !== 0) {
      console.log(`  ⚠️ TikTok: API error code=${apiResponse.code}, stopping`);
      break;
    }

    const apiData = apiResponse.data;
    if (!apiData) {
      console.log(`  ⚠️ TikTok: no data in response, stopping`);
      break;
    }

    if (totalReported === null) {
      totalReported = apiData.count || 0;
      console.log(`  API reports ${totalReported} US campus positions`);
    }

    const posts = apiData.job_post_list || [];
    if (posts.length === 0) break;

    for (const post of posts) {
      const job = normalizeTiktokJob(post);
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

module.exports = { fetchAllTiktokJobs };
