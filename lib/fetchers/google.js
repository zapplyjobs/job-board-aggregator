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

const { getHtml, delay } = require('./http-client');

const BASE_URL = 'https://www.google.com/about/careers/applications/jobs/results/';
const PAGE_SIZE = 20;
const DELAY_MS = 500;
const DETAIL_DELAY_MS = 500;
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
      description = descMatch[1]
        .replace(/<\/?(?:ul|ol|li|h[1-6]|p|div|br|strong|em|a|span)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n\s*\n/g, '\n')
        .trim() || null;
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
      html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\n\s*\n/g, '\n')
        .trim();

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

  return parts.join('\n\n') || null;
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
 * Fetch detail pages for jobs that need richer descriptions.
 * Runs after listing extraction to get qualifications (degree, years, skills).
 *
 * @param {Array} jobs - Jobs from listing extraction
 * @returns {Promise<Array>} Jobs with enriched descriptions
 */
async function fetchDetailPages(jobs) {
  console.log(`\n  📄 Fetching detail pages for ${jobs.length} Google jobs...`);

  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];

    const qualifications = await fetchJobDetail(job.jobId);

    if (qualifications) {
      job.description = buildFullDescription(job.description, qualifications);
      enriched++;
    } else if (job.description && job.description.length > 200) {
      // Job has a reasonable listing description — no detail page needed or expired
      skipped++;
    } else {
      failed++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`    Detail fetch: ${i + 1}/${jobs.length} (${enriched} enriched, ${failed} failed, ${skipped} skipped)`);
    }

    await delay(DETAIL_DELAY_MS);
  }

  console.log(`  Detail fetch complete: ${enriched} enriched, ${failed} failed, ${skipped} skipped out of ${jobs.length}`);
  return jobs;
}

/**
 * Fetch all Google jobs across queries.
 * @param {Object} options - { previousJobCount }
 * @returns {Promise<Array>} normalized jobs (may contain duplicates across queries)
 */
async function fetchAllGoogleJobs(options = {}) {
  console.log('\n🔍 Fetching from Google Careers...');
  console.log('━'.repeat(60));

  const { previousJobCount = 0 } = options;
  const maxPages = previousJobCount < 100 ? MAX_PAGES : MAX_ROUTINE_PAGES;

  const allJobs = [];
  const seenIds = new Set();

  for (const query of QUERIES) {
    console.log(`\n  Query: "${query.q}" (max ${maxPages} pages)`);
    const jobs = await fetchQueryJobs(query, maxPages);

    const newJobs = jobs.filter(j => !seenIds.has(j.jobId));
    for (const j of newJobs) seenIds.add(j.jobId);

    allJobs.push(...newJobs);
    console.log(`  Query total: ${jobs.length} extracted, ${newJobs.length} new after dedup`);

    await delay(DELAY_MS);
  }

  // Fetch detail pages for qualifications (AGG-FETCH-9)
  await fetchDetailPages(allJobs);

  const normalized = allJobs.map(normalizeGoogleJob);
  console.log(`\n  Total unique jobs: ${normalized.length}`);
  return normalized;
}

module.exports = { fetchAllGoogleJobs };
