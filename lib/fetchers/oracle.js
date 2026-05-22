/**
 * Oracle HCM Cloud Jobs Fetcher (Multi-Company)
 *
 * Fetches jobs from Oracle HCM Cloud public REST API for multiple companies.
 * Each company has its own Oracle HCM instance (base_url) and site_number.
 *
 * API: GET /hcmRestApi/resources/latest/recruitingCEJobRequisitions
 * Params: onlyData=true, finder=findReqs;siteNumber=X,expand=requisitionList
 * Pagination: offset/limit inside finder param. 25/page.
 *
 * No authentication required. Backward compat: called without args, uses Oracle Corp.
 */

'use strict';

const { getJson, delay } = require('./http-client');

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

function normalizeOracleJob(job, company) {
  const loc = parseLocation(job.PrimaryLocation);
  const jobId = String(job.Id);
  const jobUrl = `${company.base_url}/hcmUI/CandidateExperience/en/sites/${company.site_number}/job/${jobId}`;

  const postedAt = job.PostedDate
    ? new Date(job.PostedDate + 'T00:00:00Z').toISOString()
    : null;

  const descParts = [];
  if (job.ShortDescriptionStr) descParts.push(job.ShortDescriptionStr.trim());
  if (job.ExternalQualificationsStr) descParts.push('Qualifications:\n' + job.ExternalQualificationsStr.trim());
  if (job.ExternalResponsibilitiesStr) descParts.push('Responsibilities:\n' + job.ExternalResponsibilitiesStr.trim());

  return {
    id: `oracle-${company.slug}-${jobId}`,
    source: 'oracle',
    source_id: jobId,

    title: (job.Title || '').trim() || null,
    company_name: company.name,
    company_slug: company.slug,

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

async function fetchCompanyJobs(company) {
  const baseUrl = company.base_url.replace(/\/$/, '');
  const apiPath = '/hcmRestApi/resources/latest/recruitingCEJobRequisitions';
  const jobs = [];
  let offset = 0;
  let pages = 0;

  while (true) {
    const finderParam = `findReqs;siteNumber=${company.site_number},offset=${offset},limit=${PAGE_SIZE}`;
    const url = `${baseUrl}${apiPath}?onlyData=true&finder=${encodeURIComponent(finderParam)}&expand=requisitionList`;

    const result = await getJson(url);
    if (!result || result.status !== 200 || !result.data?.items) {
      if (pages === 0) {
        console.log(`  ⚠️ ${company.name}: API error (status=${result?.status || 'null'})`);
      }
      break;
    }

    const items = result.data.items;
    if (items.length === 0) break;

    if (pages === 0) {
      const total = items[0].TotalJobsCount || 0;
      console.log(`  ${company.name}: ${total} total positions`);
    }

    const reqs = items[0].requisitionList || [];
    if (reqs.length === 0) break;

    jobs.push(...reqs.map(j => normalizeOracleJob(j, company)));
    pages++;

    if (reqs.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
    if (pages < 100) await delay(DELAY_MS);
  }

  const withDesc = jobs.filter(j => j.description).length;
  console.log(`  ${company.name}: ${jobs.length} jobs fetched (${withDesc} with descriptions, ${pages} pages)`);

  return jobs;
}

async function fetchAllOracleJobs(companies) {
  if (!companies || companies.length === 0) {
    companies = [{
      name: 'Oracle',
      slug: 'oracle',
      base_url: 'https://eeho.fa.us2.oraclecloud.com',
      site_number: 'CX_45001',
    }];
  }

  console.log(`\n🏛️ Fetching from Oracle HCM Cloud (${companies.length} companies)...`);
  console.log('━'.repeat(60));

  const allJobs = [];
  const CONCURRENCY = 4;

  for (let i = 0; i < companies.length; i += CONCURRENCY) {
    const batch = companies.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(c => fetchCompanyJobs(c).catch(err => {
      console.log(`  ❌ ${c.name}: ${err.message}`);
      return [];
    })));
    for (const r of results) {
      if (r.status === 'fulfilled') allJobs.push(...r.value);
    }
  }

  console.log(`  Oracle HCM total: ${allJobs.length} jobs from ${companies.length} companies (concurrency ${CONCURRENCY})`);

  return allJobs;
}

module.exports = { fetchAllOracleJobs };