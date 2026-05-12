/**
 * Ashby Job Board API Client
 *
 * Fetches jobs from Ashby's public API.
 * No authentication required.
 *
 * API Docs: https://developers.ashbyhq.com/docs/public-job-posting-api
 * Endpoint: https://api.ashbyhq.com/posting-api/job-board/{jobBoardName}
 */

const https = require('https');

const BASE_URL = 'https://api.ashbyhq.com/posting-api/job-board';

/**
 * Fetch jobs from a single Ashby board
 * @param {string} companySlug - Company's job board name (e.g., 'linear')
 * @returns {Promise<Array>} Array of normalized job objects
 */
async function fetchAshbyJobs(companySlug, companyName) {
    const url = `${BASE_URL}/${companySlug}?includeCompensation=true`;

    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';

            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode === 404) {
                        console.log(`   ⚠️ Ashby board not found: ${companySlug}`);
                        resolve([]);
                        return;
                    }

                    if (res.statusCode !== 200) {
                        console.log(`   ⚠️ Ashby API error for ${companySlug}: ${res.statusCode}`);
                        resolve([]);
                        return;
                    }

                    const response = JSON.parse(data);

                    // Ashby returns { jobs: [...] }
                    const jobs = response.jobs || [];

                    // Normalize to common format
                    const normalizedJobs = jobs.map(job => normalizeAshbyJob(job, companySlug, companyName));
                    resolve(normalizedJobs);

                } catch (error) {
                    console.error(`   ❌ Error parsing Ashby response for ${companySlug}:`, error.message);
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
 * Normalize Ashby job to common format
 * @param {Object} job - Raw Ashby job object
 * @param {string} companySlug - Company slug for reference
 * @returns {Object} Normalized job object
 */
function normalizeAshbyJob(job, companySlug, companyName) {
    // Ashby location structure
    const location = job.location || 'Remote';

    // Extract department/team
    const department = job.department || null;
    const team = job.team || null;

    // Employment type
    const employmentType = job.employmentType || null;

    // Compensation (if available)
    const compensation = job.compensation ? {
        min: job.compensation.compensationTierSummary?.min,
        max: job.compensation.compensationTierSummary?.max,
        currency: job.compensation.compensationTierSummary?.currency,
        interval: job.compensation.compensationTierSummary?.interval
    } : null;

    // Workplace type
    const isRemote = job.isRemote || false;

    return {
        // Core fields
        id: `ashby-${companySlug}-${job.id}`,
        source: 'ashby',
        source_url: 'api.ashbyhq.com',
        source_id: job.id,

        // Job details
        title: (job.title || '').replace(/\|/g, ' ').trim(),
        company_name: (companyName || job.organizationName || companySlug).replace(/\|/g, ' ').trim(),
        company_slug: companySlug,

        // Location
        location: location,
        locations: job.secondaryLocations
            ? [location, ...job.secondaryLocations]
            : [location],
        is_remote: isRemote,

        // URL
        url: job.jobUrl || `https://jobs.ashbyhq.com/${companySlug}/${job.id}`,
        apply_url: job.applyUrl || null,

        // Metadata
        department: department,
        team: team,
        employment_type: employmentType,

        // Compensation
        salary: compensation,

        // Dates
        // FRESHNESS-2: Ashby publishedAt is never updated on evergreen postings (median age 51d, max 2313d).
        // If the original date is older than 7 days, use fetch time instead — same logic as Lever fix.
        posted_at: (() => {
            const publishedMs = job.publishedAt ? new Date(job.publishedAt).getTime() : NaN;
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            return new Date(!isNaN(publishedMs) && publishedMs > cutoff ? publishedMs : Date.now()).toISOString();
        })(),
        fetched_at: new Date().toISOString(),

        // Description
        description: job.descriptionPlain || job.descriptionHtml || null,

        // Original data for debugging
        _raw: {
            source: 'ashby',
            original_id: job.id
        }
    };
}

/**
 * Fetch jobs from multiple Ashby companies
 * @param {Array<{slug: string, name: string}>} companies - List of companies to fetch
 * @param {Object} options - Options
 * @param {number} options.concurrency - Parallel requests per batch (default: 5)
 * @param {number} options.delayMs - Delay between batches in ms (default: 200ms)
 * @returns {Promise<Array>} All jobs from all companies
 */
async function fetchAllAshbyJobs(companies, options = {}) {
    const { concurrency = 5, delayMs = 200 } = options;
    const allJobs = [];

    console.log(`::group::🔷 Ashby (${companies.length} boards)`);
    console.log(`🔷 Fetching from ${companies.length} Ashby boards (concurrency: ${concurrency})...`);

    for (let i = 0; i < companies.length; i += concurrency) {
        const batch = companies.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async company => {
            const slug = typeof company === 'string' ? company : company.slug;
            const name = typeof company === 'string' ? company : company.name;
            try {
                const jobs = await fetchAshbyJobs(slug, name);
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

    console.log(`   📊 Ashby total: ${allJobs.length} jobs`);
    console.log('::endgroup::');
    return allJobs;
}

module.exports = {
    fetchAshbyJobs,
    fetchAllAshbyJobs,
    normalizeAshbyJob
};
