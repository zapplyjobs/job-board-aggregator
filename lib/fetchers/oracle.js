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
 * Detail API: GET /hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
 * Params: onlyData=true, finder=ById;Id="<jobId>",siteNumber=<site>
 *
 * No authentication required. Backward compat: called without args, uses Oracle Corp.
 */

'use strict';

const { getJson, delay } = require('./http-client');

const PAGE_SIZE = 25;
const DELAY_MS = 300;
const DETAIL_DELAY_MS = 300;
const MAX_DETAIL_FETCHES = 100;
const DETAIL_CONCURRENCY = 4;
const DETAIL_TITLE_WEIGHTS = [
  [/\b(software|developer|programming)\b/i, 90],
  [/\b(ai|automation|cloud|data|database|linux|network|python|rpa|security|systems?)\b/i, 70],
  [/\b(analog|circuit|controls?|electrical|hardware|mechanical|mixed signal|plc|test)\b/i, 60],
  [/\b(engineer(?:ing)?|information technology|it|technical|technology)\b/i, 50],
  [/\b(analytics?|facilities|materials)\b/i, 30],
];
const LOW_DETAIL_TITLE_RE = /\b(chaplain|clinician|medical|nurse|nursing|phlebotomist|physician|registered nurse|therapist)\b/i;

function oracleDetailPriorityScore(target) {
  const title = String(target.job?.Title || '');
  const location = String(target.job?.PrimaryLocation || '');
  let score = 0;
  for (const [pattern, weight] of DETAIL_TITLE_WEIGHTS) {
    if (pattern.test(title)) score += weight;
  }
  if (/\bintern(ship)?\b/i.test(title)) score += 20;
  if (/United States|, [A-Z]{2}, US\b/i.test(location)) score += 10;
  if (LOW_DETAIL_TITLE_RE.test(title)) score -= 100;
  return score;
}


function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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

function buildDescription(baseJob, detailJob) {
  const src = detailJob || baseJob;
  const parts = [];

  const shortDesc = stripHtml(src.ShortDescriptionStr || baseJob.ShortDescriptionStr || '');
  if (shortDesc) parts.push(shortDesc);

  const responsibilities = stripHtml(src.ExternalResponsibilitiesStr || '');
  if (responsibilities) parts.push('Responsibilities:\n' + responsibilities);

  const qualifications = stripHtml(src.ExternalQualificationsStr || '');
  if (qualifications) parts.push('Qualifications:\n' + qualifications);

  return parts.length ? parts.join('\n\n') : null;
}

function normalizeOracleJob(job, company, detailJob = null) {
  const src = detailJob || job;
  const loc = parseLocation(src.PrimaryLocation || job.PrimaryLocation);
  const jobId = String(job.Id);
  const jobUrl = `${company.base_url}/hcmUI/CandidateExperience/en/sites/${company.site_number}/job/${jobId}`;

  const postedAt = (src.PostedDate || job.PostedDate)
    ? new Date((src.PostedDate || job.PostedDate) + 'T00:00:00Z').toISOString()
    : null;

  return {
    id: `oracle-${company.slug}-${jobId}`,
    source: 'oracle',
    source_id: jobId,

    title: (src.Title || job.Title || '').trim() || null,
    company_name: company.name,
    company_slug: company.slug,

    location: loc.location,
    locations: loc.location ? [loc.location] : [],
    job_city: loc.job_city,
    job_state: loc.job_state,

    url: jobUrl,
    apply_url: jobUrl,

    departments: [],
    employment_type: src.WorkerType || job.WorkerType || null,

    posted_at: postedAt,
    fetched_at: new Date().toISOString(),

    description: buildDescription(job, detailJob),
  };
}

async function fetchJobDetail(company, jobId) {
  const baseUrl = company.base_url.replace(/\/$/, '');
  const apiPath = '/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails';
  const finderParam = `ById;Id="${jobId}",siteNumber=${company.site_number}`;
  const url = `${baseUrl}${apiPath}?expand=all&onlyData=true&finder=${encodeURIComponent(finderParam)}`;
  const result = await getJson(url);
  if (!result || result.status !== 200 || !Array.isArray(result.data?.items) || result.data.items.length === 0) {
    return null;
  }
  return result.data.items[0];
}

async function fetchOracleDetails(detailTargets) {
  const details = new Map();

  for (let i = 0; i < detailTargets.length; i += DETAIL_CONCURRENCY) {
    const batch = detailTargets.slice(i, i + DETAIL_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async ({ company, jobId, normalizedId }) => {
      const detail = await fetchJobDetail(company, jobId).catch(() => null);
      return { normalizedId, detail };
    }));

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.detail) {
        details.set(result.value.normalizedId, result.value.detail);
      }
    }

    if (i + DETAIL_CONCURRENCY < detailTargets.length) {
      await delay(DETAIL_DELAY_MS);
    }
  }

  return details;
}

async function fetchCompanyJobs(company) {
  const baseUrl = company.base_url.replace(/\/$/, '');
  const apiPath = '/hcmRestApi/resources/latest/recruitingCEJobRequisitions';
  const jobs = [];
  let offset = 0;
  let pages = 0;
  let totalJobsCount = null;

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

    if (totalJobsCount === null) {
      totalJobsCount = items[0].TotalJobsCount || 0;
      console.log(`  ${company.name}: ${totalJobsCount} total positions`);
    }

    const reqs = items[0].requisitionList || [];
    if (reqs.length === 0) break;

    jobs.push(...reqs);
    pages++;

    offset += PAGE_SIZE;
    if (totalJobsCount > 0 && offset >= totalJobsCount) break;

    if (pages < 100) await delay(DELAY_MS);
  }

  return { jobs, pages };
}

async function fetchAllOracleJobs(companies, { previousJobCount = 0, cachedDescriptionIds = new Set(), priorityDescriptionIds = new Set() } = {}) {
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

  const rawJobs = [];
  const CONCURRENCY = 4;
  let totalPages = 0;

  for (let i = 0; i < companies.length; i += CONCURRENCY) {
    const batch = companies.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async company => {
      const result = await fetchCompanyJobs(company).catch(err => {
        console.log(`  ❌ ${company.name}: ${err.message}`);
        return { jobs: [], pages: 0 };
      });
      return { company, ...result };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        totalPages += r.value.pages;
        rawJobs.push(...r.value.jobs.map(job => ({ company: r.value.company, job })));
      }
    }
  }

  let detailTargets = rawJobs.map(({ company, job }) => ({
    company,
    job,
    jobId: String(job.Id),
    normalizedId: `oracle-${company.slug}-${job.Id}`,
  }));

  if (cachedDescriptionIds.size > 0) {
    const uncached = detailTargets.filter(t => !cachedDescriptionIds.has(t.normalizedId));
    const cached = detailTargets.length - uncached.length;
    console.log(`  Oracle description cache: ${cached}/${detailTargets.length} positions already in sidecar, ${uncached.length} need fetching`);
    detailTargets = uncached;
  }

  if (priorityDescriptionIds.size > 0 && detailTargets.length > 0) {
    const priority = [];
    const regular = [];
    for (const target of detailTargets) {
      (priorityDescriptionIds.has(target.normalizedId) ? priority : regular).push(target);
    }
    if (priority.length > 0) {
      priority.sort((a, b) => oracleDetailPriorityScore(b) - oracleDetailPriorityScore(a));
      console.log(`  Oracle detail priority: ${priority.length}/${detailTargets.length} short sidecar positions before cap`);
      detailTargets = priority.concat(regular);
    }
  }

  if (detailTargets.length > MAX_DETAIL_FETCHES) {
    console.log(`  Capping Oracle detail fetch to ${MAX_DETAIL_FETCHES}/${detailTargets.length} uncached positions`);
    detailTargets = detailTargets.slice(0, MAX_DETAIL_FETCHES);
  }

  let details = new Map();
  if (detailTargets.length > 0) {
    console.log(`  Phase 2: Oracle detail fetch (${detailTargets.length} positions, batch=${DETAIL_CONCURRENCY})`);
    details = await fetchOracleDetails(detailTargets);
    console.log(`  Oracle details fetched: ${details.size}/${detailTargets.length}`);
  } else if (previousJobCount > 0) {
    console.log('  Phase 2: All Oracle positions cached — no detail fetch needed');
  } else {
    console.log('  Phase 2: No Oracle detail fetch needed on this run');
  }

  const allJobs = rawJobs.map(({ company, job }) => {
    const normalizedId = `oracle-${company.slug}-${job.Id}`;
    return normalizeOracleJob(job, company, details.get(normalizedId) || null);
  });

  const withDesc = allJobs.filter(j => j.description).length;
  console.log(`  Oracle HCM total: ${allJobs.length} jobs from ${companies.length} companies (${withDesc} with descriptions, ${totalPages} pages, detail cache ${cachedDescriptionIds.size})`);
  return allJobs;
}

module.exports = { fetchAllOracleJobs };
