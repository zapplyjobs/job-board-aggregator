/**
 * Microsoft PCSX Jobs API Client
 *
 * Fetches jobs from Microsoft's public PCSX REST API.
 * No authentication required.
 *
 * Search: GET /api/pcsx/search?domain=microsoft.com&start={offset}
 * Detail: GET /api/pcsx/position_details?domain=microsoft.com&position_id={id}
 *
 * Search returns 10 positions/page with metadata but no descriptions.
 * Detail returns full jobDescription (HTML, ~6-8KB) plus all metadata.
 *
 * Rate limit: 429 if detail calls are too rapid. Sequential fetch with 300ms delay + exponential backoff.
 * API confirmed live 2026-04-30. ~1,868 total positions.
 *
 * AGG-SPEED-4: cachedDescriptionIds filters out positions already in the sidecar,
 * so the MAX_DETAIL_FETCHES cap targets only genuinely new positions.
 */

'use strict';

const { getJson, delay } = require('./http-client');

const BASE_URL = 'https://apply.careers.microsoft.com';
const SEARCH_PATH = '/api/pcsx/search';
const DETAIL_PATH = '/api/pcsx/position_details';
const DOMAIN = 'microsoft.com';
const PAGE_SIZE = 10;
const MAX_ROUTINE_PAGES = 50;
const DETAIL_BATCH_SIZE = 3;
const MAX_DETAIL_FETCHES = 150;
const DELAY_MS = 300;
const DETAIL_DELAY_MS = 2000;

function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim() || null;
}

function parseLocation(locations, standardizedLocations) {
  if (!locations || locations.length === 0) return { location: null, job_city: null, job_state: null };

  const raw = locations[0];
  const parts = raw.split(',').map(s => s.trim());

  let country = parts[0] || '';
  let state = parts[1] || '';
  let city = parts[2] || '';

  if (standardizedLocations && standardizedLocations.length > 0) {
    const std = standardizedLocations[0];
    if (std.length === 2 && std === std.toUpperCase()) {
      country = 'United States';
      state = '';
      city = '';
    }
  }

  const isUS = country === 'United States';
  const location = [city, state, country].filter(Boolean).join(', ');

  return {
    location: location || raw,
    job_city: city || null,
    job_state: isUS && state ? state : null,
  };
}

function normalizePosition(searchJob, detail) {
  const loc = parseLocation(searchJob.locations, searchJob.standardizedLocations);
  const publicUrl = (detail && detail.publicUrl) || searchJob.publicUrl
    || `https://apply.careers.microsoft.com/careers/job/${searchJob.id}`;

  const employmentType = (detail && detail.efcustomTextEmploymentType && detail.efcustomTextEmploymentType[0])
    || searchJob.efcustomTextEmploymentType && searchJob.efcustomTextEmploymentType[0]
    || null;

  const description = detail ? stripHtml(detail.jobDescription) : null;

  const postedAt = searchJob.postedTs
    ? new Date(searchJob.postedTs * 1000).toISOString()
    : null;

  return {
    id: `microsoft-${searchJob.displayJobId || searchJob.id}`,
    source: 'microsoft',
    source_id: String(searchJob.displayJobId || searchJob.id),

    title: (searchJob.name || '').trim() || null,
    company_name: 'Microsoft',
    company_slug: 'microsoft',

    location: loc.location,
    locations: loc.location ? [loc.location] : [],
    job_city: loc.job_city,
    job_state: loc.job_state,

    url: publicUrl,
    apply_url: publicUrl,

    departments: searchJob.department ? [searchJob.department] : [],
    employment_type: employmentType,

    posted_at: postedAt,
    fetched_at: new Date().toISOString(),

    description,
  };
}

async function fetchSearchPages(maxPages) {
  const positions = [];
  let start = 0;
  let pages = 0;

  while (pages < maxPages) {
    const url = `${BASE_URL}${SEARCH_PATH}?domain=${DOMAIN}&start=${start}&sort_by=post_date`;
    const result = await getJson(url);

    if (!result || result.status !== 200 || !result.data?.data?.positions) {
      console.log(`  Search page ${pages + 1}: status=${result?.status || 'null'}, stopping`);
      break;
    }

    const page = result.data.data.positions;
    const totalCount = result.data.data.count;
    if (pages === 0) console.log(`  Total positions reported: ${totalCount}`);

    positions.push(...page);
    pages++;

    if (page.length < PAGE_SIZE) break;

    start += PAGE_SIZE;
    if (pages < maxPages) await delay(DELAY_MS);
  }

  return positions;
}

async function fetchDetailWithRetry(pid, retries = 1) {
  const url = `${BASE_URL}${DETAIL_PATH}?domain=${DOMAIN}&position_id=${pid}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await getJson(url);
    if (result && result.status === 200 && result.data?.data) {
      return { id: pid, detail: result.data.data, status: 200 };
    }
    if (result?.status === 429 && attempt < retries) {
      const backoff = DETAIL_DELAY_MS * Math.pow(2, attempt);
      console.log(`  Detail ${pid}: HTTP 429, retry ${attempt + 1}/${retries} in ${backoff}ms`);
      await delay(backoff);
      continue;
    }
    return { id: pid, detail: null, status: result?.status || 'null' };
  }
}

async function fetchDetailBatch(positionIds) {
  const results = {};
  const MAX_CONSECUTIVE_429 = 15;
  let consecutive429 = 0;

  for (let i = 0; i < positionIds.length; i += DETAIL_BATCH_SIZE) {
    const batch = positionIds.slice(i, i + DETAIL_BATCH_SIZE);

    // Sequential within batch to avoid 429s
    for (const pid of batch) {
      // Circuit breaker: if too many consecutive 429s, stop trying
      if (consecutive429 >= MAX_CONSECUTIVE_429) {
        console.log(`  Circuit breaker: ${MAX_CONSECUTIVE_429} consecutive 429s, skipping ${positionIds.length - Object.keys(results).length} remaining positions`);
        return results;
      }

      const r = await fetchDetailWithRetry(pid);
      results[r.id] = r.detail;
      if (r.status === 200) {
        consecutive429 = 0;
      } else {
        consecutive429++;
        if (r.status !== 200) {
          console.log(`  Detail ${r.id}: HTTP ${r.status}`);
        }
      }
      await delay(300);
    }

    if (i + DETAIL_BATCH_SIZE < positionIds.length) {
      await delay(DETAIL_DELAY_MS);
    }
  }

  return results;
}

async function fetchAllMicrosoftJobs({ previousJobCount = 0, cachedDescriptionIds } = {}) {
  console.log('\n🖥️  Fetching from Microsoft PCSX...');
  console.log('━'.repeat(60));

  const isInitial = previousJobCount === 0;
  const maxPages = isInitial ? Infinity : MAX_ROUTINE_PAGES;
  const skipDetails = isInitial;

  console.log(`  Phase 1: Search (max ${maxPages === Infinity ? 'all' : maxPages} pages, initial=${isInitial})`);
  const positions = await fetchSearchPages(maxPages);
  console.log(`  Search complete: ${positions.length} positions from ${Math.ceil(positions.length / PAGE_SIZE)} pages`);

  if (positions.length === 0) {
    console.log('  No positions found. Skipping detail fetch.');
    return [];
  }

  let details = {};
  if (!skipDetails) {
    // AGG-SPEED-4: Filter out positions already in the sidecar cache.
    // The sidecar stores entries keyed by `microsoft-{positionId}` format,
    // but position IDs here are the raw API IDs. Map accordingly.
    let positionIds = positions.map(p => p.id);
    const cacheSize = cachedDescriptionIds ? cachedDescriptionIds.size : 0;

    if (cacheSize > 0) {
      // Sidecar keys match normalizePosition: `microsoft-${displayJobId || id}`
      // Build lookup from raw search positions using the same key format
      const uncached = positions.filter(p => {
        const normalizedId = `microsoft-${p.displayJobId || p.id}`;
        return !cachedDescriptionIds.has(normalizedId);
      });
      const cached = positions.length - uncached.length;
      console.log(`  Cache: ${cached}/${positions.length} positions already in sidecar, ${uncached.length} need fetching`);
      positionIds = uncached.map(p => p.id);
    }

    if (positionIds.length > MAX_DETAIL_FETCHES) {
      console.log(`  Capping detail fetch to ${MAX_DETAIL_FETCHES}/${positionIds.length} uncached (API rate-limited)`);
      positionIds = positionIds.sort(() => Math.random() - 0.5).slice(0, MAX_DETAIL_FETCHES);
    }

    if (positionIds.length > 0) {
      console.log(`  Phase 2: Detail fetch (${positionIds.length} positions, batch=${DETAIL_BATCH_SIZE})`);
      details = await fetchDetailBatch(positionIds);
      const detailCount = Object.values(details).filter(Boolean).length;
      console.log(`  Details fetched: ${detailCount}/${positionIds.length}`);
    } else {
      console.log(`  Phase 2: All positions cached — no detail fetch needed`);
    }
  } else {
    console.log(`  Phase 2: Skipped (initial population — details on next run)`);
  }

  const jobs = positions.map(p => normalizePosition(p, details[p.id] || null));

  const withDesc = jobs.filter(j => j.description).length;
  console.log(`  Normalized: ${jobs.length} jobs (${withDesc} with descriptions)`);

  return jobs;
}

module.exports = { fetchAllMicrosoftJobs, normalizePosition, stripHtml, parseLocation };
