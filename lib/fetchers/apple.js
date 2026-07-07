/**
 * Apple Jobs Fetcher
 *
 * Fetches jobs from Apple's careers site via HTML JSON extraction.
 * Apple embeds React SSR hydration data in the page HTML containing
 * structured job listings — no API key or authentication needed.
 *
 * URL: https://jobs.apple.com/en-us/search
 * Method: GET
 * Params: sort=newest, page=N, location=united-states-USA
 * Response: HTML with embedded JSON in window.__staticRouterHydrationData
 *
 * Extraction: regex → JSON.parse → navigate loaderData.search.searchResults
 * Per job: postingTitle, locations[0].name, postingDate/postDateInGMT,
 *          positionId, reqId, jobSummary, transformedPostingTitle
 *
 * DETAIL PAGE FETCH (AGG-FETCH-9, C62):
 * After extracting listings, fetches each job's detail page to get full
 * qualifications. The listing page only has jobSummary (brief marketing text).
 * The detail page has minimumQualifications, preferredQualifications, and
 * keyQualifications as structured JSON fields in the hydration data.
 *
 * PROGRESSIVE SIDECAR (AGG-FETCH-13):
 * Each detail page is appended to the sidecar file immediately after fetch.
 * If the fetcher times out, already-fetched pages survive in the sidecar.
 * Next run finds them in cache and skips them — progressive saturation.
 *
 * Pagination (SUP-FETCHER-3 + first-run detection):
 * - First run (no previous Apple jobs in pool): fetches ALL pages (~251).
 * - Routine runs: caps at MAX_ROUTINE_PAGES (50 pages = 1,000 most recent).
 * - Jobs leaving the cap range caught by 7-day TTL.
 * - Incremental (AGG-SPEED-6): if previousJobIds provided and page-1 IDs all match,
 *   skips remaining pages. Carry-forward preserves existing Apple jobs in pool.
 *
 * Internship supplement (SUP-INTERN-2):
 * - After main fetch, queries ?search=internship&sort=relevance for aggregate postings.
 * - Apple posts 10 internship categories (SWE, HW, ML/AI, EPM, etc.) as single listings.
 * - Only page 1 needed. Strict title filter (/intern/i) prevents false matches.
 * - Adds ~10 aggregate postings per run with descriptions for enrichment.
 *
 * robots.txt: GREEN — no restrictions on jobs.apple.com.
 * Live-verified 2026-05-03.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getHtml, delay } = require('./http-client');

const BASE_URL = 'https://jobs.apple.com';
const SEARCH_PATH = '/en-us/search';
const PAGE_SIZE = 20;
const DELAY_MS = 1000;
const DETAIL_DELAY_MS = 500;
const MAX_PAGES = 300;
const MAX_ROUTINE_PAGES = 50;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function extractJobsFromHtml(html) {
  const match = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\);/s);
  if (!match) return null;

  try {
    const jsonString = JSON.parse(match[1]);
    const data = JSON.parse(jsonString);

    const searchData = data.loaderData?.search;
    if (!searchData) return null;

    return {
      jobs: searchData.searchResults || [],
      totalRecords: searchData.totalRecords || 0,
      page: searchData.page || 1,
    };
  } catch (e) {
    return null;
  }
}

function parseDate(job) {
  if (job.postDateInGMT) {
    return new Date(job.postDateInGMT).toISOString();
  }
  if (job.postingDate) {
    const d = new Date(job.postingDate);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function normalizeAppleJob(job) {
  const loc = (job.locations && job.locations[0]) || {};
  const location = (loc.name || '').trim();

  const slug = (job.transformedPostingTitle || '').trim();
  const positionId = String(job.positionId || '');
  const applyUrl = positionId && slug
    ? `${BASE_URL}/en-us/details/${positionId}/${slug}`
    : null;

  return {
    id: `apple-${positionId || job.reqId}`,
    source: 'apple',
    source_id: positionId || job.reqId,

    title: (job.postingTitle || '').trim() || null,
    company_name: 'Apple',
    company_slug: 'apple',

    location,
    locations: location ? [location] : [],
    job_city: (loc.city || '').trim(),
    job_state: (loc.stateProvince || '').trim(),

    url: applyUrl,
    apply_url: applyUrl,

    departments: job.team ? [job.team.teamName] : [],
    employment_type: null,

    posted_at: parseDate(job),
    fetched_at: new Date().toISOString(),

    description: (job.jobSummary || '').trim() || null,
  };
}

/**
 * Fetch a single Apple job detail page and extract qualifications.
 * The detail page has structured data in the hydration JSON:
 * - minimumQualifications (string with bullet points)
 * - preferredQualifications (string with bullet points)
 * - keyQualifications (array of strings)
 *
 * @param {string} positionId - Apple position ID
 * @param {string} slug - URL slug from transformedPostingTitle
 * @returns {Promise<{minimumQualifications: string, preferredQualifications: string}|null>}
 */
async function fetchJobDetail(positionId, slug) {
  if (!positionId) return null;

  const url = slug
    ? `${BASE_URL}/en-us/details/${positionId}/${slug}`
    : `${BASE_URL}/en-us/details/${positionId}`;

  try {
    const result = await getHtml(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
      maxRetries: 1,
      retryDelay: 5000,
      followRedirects: true,
    });

    if (!result || result.status !== 200 || !result.html) return null;

    const match = result.html.match(
      /window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(("(?:[^"\\]|\\.)*")\);/s
    );
    if (!match) return null;

    const jsonString = JSON.parse(match[1]);
    const data = JSON.parse(jsonString);
    const jobData = data.loaderData?.jobDetails?.jobsData;

    if (!jobData) return null;

    const minimumQualifications = (jobData.minimumQualifications || '').trim();
    const preferredQualifications = (jobData.preferredQualifications || '').trim();

    if (!minimumQualifications && !preferredQualifications) return null;

    return { minimumQualifications, preferredQualifications };
  } catch (e) {
    return null;
  }
}

/**
 * Build a full description from listing summary + detail page qualifications.
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

const FIRST_RUN_THRESHOLD = 200;

async function fetchAppleInternships(existingIds) {
  console.log('\n  🎓 Fetching Apple internship postings...');
  const internJobs = [];

  const url = `${BASE_URL}${SEARCH_PATH}?search=internship&sort=relevance&location=united-states-USA&page=1`;
  const result = await getHtml(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 20000,
    maxRetries: 1,
    retryDelay: 5000,
    followRedirects: true,
  });
  if (!result || result.status !== 200) {
    console.log(`  Internship page: HTTP ${result?.status || 'error'} — skipping`);
    return internJobs;
  }

  const extracted = extractJobsFromHtml(result.html);
  if (!extracted || !extracted.jobs.length) {
    console.log(`  Internship page: ${extracted ? '0 results' : 'parse failed'} — skipping`);
    return internJobs;
  }

  for (const job of extracted.jobs) {
    const title = (job.postingTitle || '').trim();
    if (!/internships?\b/i.test(title)) continue;
    const normalized = normalizeAppleJob(job);
    if (!existingIds.has(normalized.id)) {
      existingIds.add(normalized.id);
// AGG-RESTAMP-1: removed posted_at overwrite — keep the parsed date from parseDate(job)
      internJobs.push(normalized);
    }
  }

  console.log(`  Internship postings: ${internJobs.length} (deduped)`);
  await delay(DELAY_MS);
  return internJobs;
}

/**
 * Append a single enriched description to the sidecar file (AGG-FETCH-13).
 * Progressive write: each detail page is persisted immediately, surviving timeout.
 * @param {string} dataDir - Path to data directory for sidecar files
 * @param {string} jobId - Job ID (e.g. "apple-12345")
 * @param {string} description - Full description with qualifications
 */
function appendToSidecar(dataDir, jobId, description) {
  if (!dataDir) return;
  const sidecarPath = path.join(dataDir, 'descriptions-apple.jsonl');
  const entry = JSON.stringify({ id: jobId, description_text: description }) + '\n';
  fs.appendFileSync(sidecarPath, entry, 'utf8');
}

/**
 * Fetch detail pages for jobs that need richer descriptions.
 * Progressive sidecar write (AGG-FETCH-13): each enriched page is appended
 * to the sidecar immediately, so a timeout only loses unfetched pages.
 *
 * @param {Array} normalizedJobs - Normalized jobs from listing extraction
 * @param {Set<string>} [cachedIds] - Job IDs already in sidecar (skip fetch)
 * @param {string} [dataDir] - Data directory for progressive sidecar writes
 * @returns {Promise<Array>} Jobs with enriched descriptions
 */
async function fetchDetailPages(normalizedJobs, cachedIds, dataDir) {
  const MAX_DETAIL_PER_RUN = 100; // AGG-GIANTCANADA-1: cap per-run to prevent timeout on cold-start
  const toFetchRaw = cachedIds
    ? normalizedJobs.filter(j => !cachedIds.has(j.id))
    : normalizedJobs;
  const toFetch = toFetchRaw.slice(0, MAX_DETAIL_PER_RUN);
  const deferred = toFetchRaw.length - toFetch.length;
  const cachedCount = normalizedJobs.length - toFetchRaw.length;

  if (cachedCount > 0) {
    console.log(`  Cache: ${cachedCount}/${normalizedJobs.length} already in sidecar, ${toFetchRaw.length} need fetching${deferred > 0 ? ` (capping at ${MAX_DETAIL_PER_RUN}/run, deferring ${deferred})` : ''}`);
  }
  console.log(`\n  📄 Fetching detail pages for ${toFetch.length} Apple jobs...`);

  let enriched = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < toFetch.length; i++) {
    const job = toFetch[i];
    const positionId = job.source_id;

    // Extract slug from URL
    const slugMatch = job.url ? job.url.match(/\/details\/\d+\/(.+)$/) : null;
    const slug = slugMatch ? slugMatch[1] : '';

    const qualifications = await fetchJobDetail(positionId, slug);

    if (qualifications) {
      job.description = buildFullDescription(job.description, qualifications);
      enriched++;
      // AGG-FETCH-13: Progressive sidecar write — persists even if fetcher times out
      appendToSidecar(dataDir, job.id, job.description);
    } else if (job.description && job.description.length > 200) {
      skipped++;
    } else {
      failed++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`    Detail fetch: ${i + 1}/${toFetch.length} (${enriched} enriched, ${failed} failed, ${skipped} skipped)`);
    }

    await delay(DETAIL_DELAY_MS);
  }

  console.log(`  Detail fetch complete: ${enriched} enriched, ${failed} failed, ${skipped} skipped out of ${toFetch.length}`);
  return normalizedJobs;
}

async function fetchAllAppleJobs({ previousJobCount = 0, previousJobIds, cachedDescriptionIds, dataDir, skipDetails = false } = {}) {
  console.log('\n🍎 Fetching from Apple Jobs...');
  console.log('━'.repeat(60));

  const allJobs = [];
  const seenIds = new Set();
  let page = 1;
  let totalRecords = 0;
  const needsFullFetch = previousJobCount < FIRST_RUN_THRESHOLD;
  const pageLimit = needsFullFetch ? MAX_PAGES : MAX_ROUTINE_PAGES;

  if (needsFullFetch) {
    console.log(`  🔄 Full fetch mode: previous count ${previousJobCount} < ${FIRST_RUN_THRESHOLD} threshold (initial population needed)`);
  }

  while (page <= pageLimit) {
    const url = `${BASE_URL}${SEARCH_PATH}?sort=newest&location=united-states-USA&page=${page}`;

    let result = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      result = await getHtml(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 20000,
        maxRetries: 0,
        followRedirects: true,
      });
      if (result && result.status === 200) break;
      if (result?.status === 429 && attempt < 3) {
        const backoff = (attempt + 1) * 3000;
        console.log(`  Page ${page}: HTTP 429 (attempt ${attempt + 1}/4) — waiting ${backoff}ms`);
        await delay(backoff);
        continue;
      }
      break;
    }

    if (!result || result.status !== 200) {
      console.log(`  Page ${page}: HTTP ${result?.status || 'error'} — stopping`);
      break;
    }

    const extracted = extractJobsFromHtml(result.html);
    if (!extracted || !extracted.jobs.length) {
      console.log(`  Page ${page}: ${extracted ? '0 results' : 'parse failed'} — stopping`);
      break;
    }

    if (page === 1) {
      totalRecords = extracted.totalRecords;
      const totalPages = Math.ceil(totalRecords / PAGE_SIZE);
      console.log(`  Total Apple US jobs: ${totalRecords} (~${totalPages} pages)`);

      if (!needsFullFetch && previousJobIds && previousJobIds.size > 0) {
        const page1Ids = extracted.jobs.map(j => `apple-${j.positionId || j.reqId}`);
        const allKnown = page1Ids.length > 0 && page1Ids.every(id => previousJobIds.has(id));

        if (allKnown) {
          console.log(`  ⚡ Incremental skip: page-1 IDs all known (${page1Ids.length} checked). Skipping ${Math.min(totalPages, pageLimit) - 1} pages.`);
          for (const job of extracted.jobs) {
            const normalized = normalizeAppleJob(job);
            if (!seenIds.has(normalized.id)) { seenIds.add(normalized.id); allJobs.push(normalized); }
          }
          break;
        } else {
          console.log(`  📄 Full fetch needed: new jobs on page 1. Proceeding with ${pageLimit} pages.`);
        }
      }

      if (!needsFullFetch && totalPages > MAX_ROUTINE_PAGES) {
        console.log(`  Capping at ${MAX_ROUTINE_PAGES} pages (${MAX_ROUTINE_PAGES * PAGE_SIZE} most recent)`);
      }
    }

    for (const job of extracted.jobs) {
      const normalized = normalizeAppleJob(job);
      if (!seenIds.has(normalized.id)) {
        seenIds.add(normalized.id);
        allJobs.push(normalized);
      }
    }

    if (page % 20 === 0) {
      console.log(`  Page ${page}/${Math.ceil(totalRecords / PAGE_SIZE)}: ${allJobs.length} jobs fetched`);
    }

    if (allJobs.length >= totalRecords) break;

    page++;
    await delay(DELAY_MS);
  }

  // AGG-GIANTCANADA-1: Fetch Canada jobs alongside US
  let caJobs = 0;
  for (let caPage = 1; caPage <= 5; caPage++) {
    const caUrl = `${BASE_URL}${SEARCH_PATH}?sort=newest&location=canada-CAN&page=${caPage}`;
    const caResult = await getHtml(caUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 20000,
      maxRetries: 1,
      retryDelay: 3000,
      followRedirects: true,
    });
    if (!caResult || caResult.status !== 200) {
      console.log(`  Canada page ${caPage}: HTTP ${caResult?.status || 'error'} — stopping`);
      break;
    }
    const caExtracted = extractJobsFromHtml(caResult.html);
    if (!caExtracted || !caExtracted.jobs.length) break;
    for (const job of caExtracted.jobs) {
      const normalized = normalizeAppleJob(job);
      if (!seenIds.has(normalized.id)) {
        seenIds.add(normalized.id);
        allJobs.push(normalized);
        caJobs++;
      }
    }
    if (caExtracted.jobs.length < PAGE_SIZE) break;
    await delay(DELAY_MS);
  }
  if (caJobs > 0) console.log(`  🇨🇦 Canada: ${caJobs} jobs added`);

  const internJobs = await fetchAppleInternships(seenIds);
  allJobs.push(...internJobs);

  console.log(`  Apple total: ${allJobs.length} jobs (${page} pages${internJobs.length ? ` + ${internJobs.length} internships` : ''}${caJobs ? ` + ${caJobs} Canada` : ''})${needsFullFetch ? ' (full fetch)' : ' (routine cap)'}`);

  // Fetch detail pages for qualifications (AGG-FETCH-9, cached with AGG-FETCH-10, progressive AGG-FETCH-13)
  // AGG-GIANTCANADA-1: skipDetails option for supplemental lane (prevents timeout)
  if (!skipDetails) {
    await fetchDetailPages(allJobs, cachedDescriptionIds, dataDir);
  }

  return allJobs;
}

module.exports = { fetchAllAppleJobs };
