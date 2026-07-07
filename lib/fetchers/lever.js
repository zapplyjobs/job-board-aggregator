/**
 * Lever Postings API Client
 *
 * Fetches jobs from Lever's public API.
 * No authentication required for GET requests.
 *
 * API Docs: https://github.com/lever/postings-api
 * Endpoint: https://api.lever.co/v0/postings/{company}
 *
 * INF-LEVERRETRY-1 (2026-07-06): Added retry on 404/429 + browser-like headers.
 * Lever returns intermittent 404s under rate-limiting, dropping live tenants.
 * Now uses shared http-client.js (User-Agent, timeout) instead of raw https.get.
 */

const { getJson, delay } = require('./http-client');

const BASE_URL = 'https://api.lever.co/v0/postings';
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT = 10000;
const LEVER_HEADERS = {
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Fetch jobs from a single Lever board.
 * Retries on 404 (intermittent under rate-limiting) and 429 (rate-limited).
 * @param {string} companySlug - Company's site name (e.g., 'netflix')
 * @param {string} companyName - Display name for logging
 * @returns {Promise<Array>} Array of normalized job objects
 */
async function fetchLeverJobs(companySlug, companyName) {
    const url = `${BASE_URL}/${companySlug}?mode=json`;
    const options = { headers: LEVER_HEADERS, timeout: REQUEST_TIMEOUT };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const result = await getJson(url, options);

        // Network error / timeout → retry with backoff
        if (!result) {
            if (attempt < MAX_RETRIES) { await delay(1000 * (attempt + 1)); continue; }
            console.log(`   ⚠️ Lever network error for ${companySlug} after ${MAX_RETRIES + 1} attempts`);
            return [];
        }

        // Success
        if (result.status === 200 && Array.isArray(result.data)) {
            return result.data.map(job => normalizeLeverJob(job, companySlug, companyName));
        }

        // 404 — could be intermittent (rate-limiting) or permanent (board doesn't exist)
        if (result.status === 404 && attempt < MAX_RETRIES) {
            await delay(1000 * (attempt + 1));
            continue;
        }

        // 429 — rate-limited, retry with exponential backoff
        if (result.status === 429 && attempt < MAX_RETRIES) {
            const backoff = 2000 * Math.pow(2, attempt);
            console.log(`   ⚠️ Lever 429 for ${companySlug}, retry in ${backoff}ms (${attempt + 1}/${MAX_RETRIES})`);
            await delay(backoff);
            continue;
        }

        // Terminal: 404 after retries, 429 after retries, or other status code
        if (result.status === 404) console.log(`   ⚠️ Lever board not found: ${companySlug}`);
        else console.log(`   ⚠️ Lever API error for ${companySlug}: ${result.status}`);
        return [];
    }

    return [];
}

/**
 * Normalize Lever job to common format
 * @param {Object} job - Raw Lever job object
 * @param {string} companySlug - Company slug for reference
 * @returns {Object} Normalized job object
 */
function normalizeLeverJob(job, companySlug, companyName) {
    // Lever location structure
    const location = job.categories?.location || 'Remote';

    // Extract team/department
    const team = job.categories?.team || null;
    const department = job.categories?.department || null;

    // Workplace type (on-site, remote, hybrid)
    const workplaceType = job.workplaceType || 'unspecified';

    // Salary info (if available)
    const salary = job.salaryRange ? {
        min: job.salaryRange.min,
        max: job.salaryRange.max,
        currency: job.salaryRange.currency,
        interval: job.salaryRange.interval
    } : null;

    return {
        // Core fields
        id: `lever-${companySlug}-${job.id}`,
        source: 'lever',
        source_url: 'api.lever.co',
        source_id: job.id,

        // Job details
        title: (job.text || '').replace(/\|/g, ' ').trim(),
        company_name: (companyName || job.categories?.company || companySlug).replace(/\|/g, ' ').trim(),
        company_slug: companySlug,

        // Location
        location: location,
        locations: [location],
        workplace_type: workplaceType,

        // URL
        url: job.hostedUrl || job.applyUrl,
        apply_url: job.applyUrl,

        // Metadata
        team: team,
        department: department,
        commitment: job.categories?.commitment || null, // Full-time, Part-time, etc.

        // Compensation
        salary: salary,

        // Dates — Lever's createdAt is epoch-ms (number); normalize to ISO string so
        // posted_at/first_published match the cross-source schema (every other fetcher emits
        // ISO). Without this, Date.parse(String(posted_at)) returns NaN downstream (AGG-LEVER-POSTEDAT-1).
        posted_at: job.createdAt ? new Date(job.createdAt).toISOString() : null,
        first_published: job.createdAt ? new Date(job.createdAt).toISOString() : null,
        fetched_at: new Date().toISOString(),

        // Description — include lists[] sections (qualifications, requirements, etc.)
        // ENR-FIX-1: Lever stores structured data in lists[] separate from descriptionPlain.
        // Without lists, enrichment misses skills/requirements for Palantir, Zoox, Spotify etc.
        description: (() => {
            const body = job.descriptionPlain || job.description || '';
            const lists = (job.lists || []).map(l => {
                const header = l.text || '';
                const content = (l.content || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
                return header + '\n' + content;
            }).join('\n');
            return (body + '\n' + lists).trim() || null;
        })(),

        // Original data for debugging
        _raw: {
            source: 'lever',
            original_id: job.id
        }
    };
}

/**
 * Fetch jobs from multiple Lever companies
 * @param {Array<{slug: string, name: string}>} companies - List of companies to fetch
 * @param {Object} options - Options
 * @param {number} options.concurrency - Parallel requests per batch (default: 5)
 * @param {number} options.delayMs - Delay between batches in ms (default: 200ms)
 * @returns {Promise<Array>} All jobs from all companies
 */
async function fetchAllLeverJobs(companies, options = {}) {
    const { concurrency = 5, delayMs = 200 } = options;
    const allJobs = [];

    console.log(`::group::🎯 Lever (${companies.length} boards)`);
    console.log(`🎯 Fetching from ${companies.length} Lever boards (concurrency: ${concurrency})...`);

    for (let i = 0; i < companies.length; i += concurrency) {
        const batch = companies.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async company => {
            const slug = typeof company === 'string' ? company : company.slug;
            const name = typeof company === 'string' ? company : company.name;
            try {
                const jobs = await fetchLeverJobs(slug, name);
                if (jobs.length > 0) console.log(`   ✅ ${name}: ${jobs.length} jobs`);
                else console.log(`   ○ ${name}: 0 jobs`);
                return jobs;
            } catch (error) {
                console.error(`   ❌ ${name}: ${error.message}`);
                return [];
            }
        }));
        for (const jobs of results) allJobs.push(...jobs);
        if (delayMs > 0 && i + concurrency < companies.length) {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }

    console.log(`   📊 Lever total: ${allJobs.length} jobs`);
    console.log('::endgroup::');
    return allJobs;
}

module.exports = {
    fetchLeverJobs,
    fetchAllLeverJobs,
    normalizeLeverJob
};
