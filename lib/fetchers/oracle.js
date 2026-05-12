/**
 * Oracle HCM Cloud Jobs API Client
 *
 * Fetches jobs from Oracle's public HCM Cloud REST API.
 * No authentication required.
 *
 * Endpoint: GET /hcmRestApi/resources/latest/recruitingCEJobRequisitions
 * Params: onlyData=true, finder=findReqs;siteNumber=CX_45001,location=...,expand=requisitionList
 * Response: { items: [{ requisitionList: [...], TotalJobsCount: N }] }
 *
 * Pagination via offset/limit inside finder param. 25/page.
 * API confirmed live 2026-04-30. ~732 US positions.
 *
 * CAUTION: Top-level 'limit' param controls search results (always 1), NOT job count.
 * Job pagination uses offset/limit INSIDE the finder parameter.
 */

'use strict';

const { getJson, delay } = require('./http-client');

const BASE_URL = 'https://eeho.fa.us2.oraclecloud.com';
const API_PATH = '/hcmRestApi/resources/latest/recruitingCEJobRequisitions';
const SITE_NUMBER = 'CX_45001';
const JOB_URL_BASE = `${BASE_URL}/hcmUI/CandidateExperience/en/sites/${SITE_NUMBER}/job`;
const PAGE_SIZE = 25;
const DELAY_MS = 300;

function parseLocation(locStr) {
  if (!locStr) return { location: null, job_city: null, job_state: null, country: null };

  const parts = locStr.split(',').map(s => s.trim());

  if (parts.length >= 3) {
    const city = parts[0];
    const state = parts[1];
    const country = parts[2];
    return {
      location: `${city}, ${state}, ${country}`,
      job_city: city,
      job_state: country === 'United States' ? state : null,
      country,
    };
  }

  if (parts.length === 2) {
    const state = parts[0];
    const country = parts[1];
    return {
      location: locStr,
      job_city: null,
      job_state: country === 'United States' ? state : null,
      country,
    };
  }

  return { location: locStr, job_city: null, job_state: null, country: parts[0] };
}

function normalizeOracleJob(job) {
  const loc = parseLocation(job.PrimaryLocation);
  const jobId = String(job.Id);
  const jobUrl = `${JOB_URL_BASE}/${jobId}`;

  const postedAt = job.PostedDate
    ? new Date(job.PostedDate + 'T00:00:00Z').toISOString()
    : null;

  const descParts = [];
  if (job.ShortDescriptionStr) descParts.push(job.ShortDescriptionStr.trim());
  if (job.ExternalQualificationsStr) descParts.push('Qualifications:\n' + job.ExternalQualificationsStr.trim());
  if (job.ExternalResponsibilitiesStr) descParts.push('Responsibilities:\n' + job.ExternalResponsibilitiesStr.trim());

  return {
    id: `oracle-${jobId}`,
    source: 'oracle',
    source_id: jobId,

    title: (job.Title || '').trim() || null,
    company_name: 'Oracle',
    company_slug: 'oracle',

    location: loc.location,
    locations: loc.location ? [loc.location] : [],
    job_city: loc.job_city,
    job_state: loc.job_state,

    url: jobUrl,
    apply_url: jobUrl,

    departments: [],
    employment_type: job.WorkerType || null,

    posted_at: postedAt,
    fetched_at: new Date().toISOString(),

    description: descParts.length ? descParts.join('\n\n') : null,
  };
}

async function fetchAllOracleJobs() {
  console.log('\n🏛️ Fetching from Oracle HCM Cloud...');
  console.log('━'.repeat(60));

  const allJobs = [];
  let offset = 0;
  let totalCount = 0;
  let pages = 0;

  while (true) {
    const finderParam = `findReqs;siteNumber=${SITE_NUMBER},location=United+States,offset=${offset},limit=${PAGE_SIZE}`;
    const url = `${BASE_URL}${API_PATH}?onlyData=true&finder=${encodeURIComponent(finderParam)}&expand=requisitionList`;

    const result = await getJson(url);
    if (!result || result.status !== 200 || !result.data?.items) {
      console.log(`  Page ${pages + 1}: status=${result?.status || 'null'}, stopping`);
      break;
    }

    const items = result.data.items;
    if (items.length === 0) break;

    if (pages === 0) {
      totalCount = items[0].TotalJobsCount || 0;
      console.log(`  Total US positions: ${totalCount}`);
    }

    const reqs = items[0].requisitionList || [];
    if (reqs.length === 0) break;

    allJobs.push(...reqs.map(normalizeOracleJob));
    pages++;

    if (reqs.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
    if (pages < 100) await delay(DELAY_MS);
  }

  const withDesc = allJobs.filter(j => j.description).length;
  console.log(`  Fetched: ${allJobs.length} jobs from ${pages} pages (${withDesc} with descriptions)`);

  return allJobs;
}

module.exports = { fetchAllOracleJobs };
