/**
 * Lever Postings API Client
 *
 * Fetches jobs from Lever's public API.
 * No authentication required for GET requests.
 *
 * API Docs: https://github.com/lever/postings-api
 * Endpoint: https://api.lever.co/v0/postings/{company}
 */

const https = require('https');

const BASE_URL = 'https://api.lever.co/v0/postings';

/**
 * Fetch jobs from a single Lever board
 * @param {string} companySlug - Company's site name (e.g., 'netflix')
 * @returns {Promise<Array>} Array of normalized job objects
 */
async function fetchLeverJobs(companySlug, companyName) {
    const url = `${BASE_URL}/${companySlug}?mode=json`;

    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';

            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode === 404) {
                        console.log(`   ⚠️ Lever board not found: ${companySlug}`);
                        resolve([]);
                        return;
                    }

                    if (res.statusCode !== 200) {
                        console.log(`   ⚠️ Lever API error for ${companySlug}: ${res.statusCode}`);
                        resolve([]);
                        return;
                    }

                    const jobs = JSON.parse(data);

                    // Lever returns array directly (not wrapped in object)
                    if (!Array.isArray(jobs)) {
                        console.log(`   ⚠️ Unexpected Lever response format for ${companySlug}`);
                        resolve([]);
                        return;
                    }

                    // Normalize to common format
                    const normalizedJobs = jobs.map(job => normalizeLeverJob(job, companySlug, companyName));
                    resolve(normalizedJobs);

                } catch (error) {
                    console.error(`   ❌ Error parsing Lever response for ${companySlug}:`, error.message);
                    resolve([]);
                }
            });
        }).on('error', (error) => {
            console.error(`   ❌ Network error fetching ${companySlug}:`, error.message);
            resolve([]);
        });
    });
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

        // Dates
        // FRESHNESS-2: Lever createdAt is never updated on evergreen postings (median age 495d).
        // If the original date is older than 7 days, use fetch time instead — this makes the job
        // visible to the Discord 7-day staleness gate and consistent with deduplicator TTL behavior.
        // Jobs posted within 14d keep their accurate original date.
        posted_at: (() => {
            const createdMs = job.createdAt ? new Date(job.createdAt).getTime() : NaN;
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            return new Date(!isNaN(createdMs) && createdMs > cutoff ? createdMs : Date.now()).toISOString();
        })(),
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
