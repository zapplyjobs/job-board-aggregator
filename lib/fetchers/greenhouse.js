/**
 * Greenhouse Job Board API Client
 *
 * Fetches jobs from Greenhouse's public API.
 * No authentication required for GET requests.
 *
 * API Docs: https://developers.greenhouse.io/job-board.html
 * Endpoint: https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs
 */

const https = require('https');

const BASE_URL = 'https://boards-api.greenhouse.io/v1/boards';

/**
 * Fetch jobs from a single Greenhouse board
 * @param {string} companySlug - Company's board token (e.g., 'anthropic')
 * @returns {Promise<Array>} Array of normalized job objects
 */
async function fetchGreenhouseJobs(companySlug, companyName) {
    const url = `${BASE_URL}/${companySlug}/jobs?content=true`;

    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';

            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode === 404) {
                        console.log(`   ⚠️ Greenhouse board not found: ${companySlug}`);
                        resolve([]);
                        return;
                    }

                    if (res.statusCode !== 200) {
                        console.log(`   ⚠️ Greenhouse API error for ${companySlug}: ${res.statusCode}`);
                        resolve([]);
                        return;
                    }

                    const response = JSON.parse(data);
                    const jobs = response.jobs || [];

                    // Normalize to common format
                    const normalizedJobs = jobs.map(job => normalizeGreenhouseJob(job, companySlug, companyName));
                    resolve(normalizedJobs);

                } catch (error) {
                    console.error(`   ❌ Error parsing Greenhouse response for ${companySlug}:`, error.message);
                    resolve([]);
                }
            });
        }).on('error', (error) => {
            console.error(`   ❌ Network error fetching ${companySlug}:`, error.message);
            resolve([]);
        });
    });
}

// State name → 2-letter abbreviation (AGG-LOC-1: full state names in GH location strings)
const STATE_NAME_TO_ABBR = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
    'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
    'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
    'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
    'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
    'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
    'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
    'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
    'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
    'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
    'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC',
};

/**
 * Parse a Greenhouse location string into structured fields.
 *
 * Greenhouse returns free-text like "Hybrid - New York", "Remote - US: All locations",
 * "San Francisco, CA", "Costa Mesa, California, United States", "In-Office",
 * "Remote - Cyprus". The tag-engine reads job.location directly, but job_city/job_state
 * are used by Discord location routing and README display.
 *
 * @param {string} locationStr - Raw location string from Greenhouse API
 * @returns {{ job_city: string, job_state: string }}
 */
function parseGreenhouseLocation(locationStr) {
    if (!locationStr) return { job_city: '', job_state: '' };

    // Strip common prefixes: "Hybrid - ", "Remote - ", "In-Office - ", "Remote-Friendly, ",
    // "Remote-Friendly (Travel-Required) - "
    const cleaned = locationStr
        .replace(/^(hybrid|remote-friendly(\s*\([^)]*\))?|remote|in-office)\s*[-–,]\s*/i, '')
        .trim();

    // For pipe-separated multi-location strings, take the first segment only
    const primary = cleaned.split('|')[0].trim();

    // Skip non-geographic strings (including "Remote-Friendly (...)" when it's the whole primary)
    // S268A: Added "in-office", "hybrid", "onsite" (Session B finding: 32 jobs with "In-Office" as city)
    if (!primary || /^(us|usa|remote|remote-friendly|in-office|hybrid|onsite|all locations|select locations)/i.test(primary)) {
        return { job_city: '', job_state: '' };
    }

    // "San Francisco, CA" or "Bay Area, CA, United States of America" → city + state
    // Take first two comma-parts only, ignoring country/extra parts
    const parts = primary.split(',').map(p => p.trim());

    // Path A: "City, ST" where parts[1] is a 2-letter state abbreviation
    if (parts[0] && parts[1] && /^[A-Z]{2}$/.test(parts[1])) {
        return { job_city: parts[0], job_state: parts[1] };
    }

    // AGG-LOC-1: "City, FullStateName, ..." or "FullStateName, United States"
    if (parts.length >= 2) {
        // "Costa Mesa, California, United States" → parts[1] is state name
        const abbrFromSecond = STATE_NAME_TO_ABBR[parts[1].toLowerCase()];
        if (abbrFromSecond) {
            return { job_city: parts[0], job_state: abbrFromSecond };
        }
        // "Washington, United States" or "Texas, USA" → parts[0] is state name
        const abbrFromFirst = STATE_NAME_TO_ABBR[parts[0].toLowerCase()];
        if (abbrFromFirst && /^(united states|usa|us)$/i.test(parts[1])) {
            return { job_city: '', job_state: abbrFromFirst };
        }
    }

    // Single part — check if it's a full state name (e.g. after prefix strip leaves just state)
    if (parts.length === 1) {
        const abbr = STATE_NAME_TO_ABBR[parts[0].toLowerCase()];
        if (abbr) {
            return { job_city: '', job_state: abbr };
        }
    }

    // "New York" with no state — city only (single part)
    return { job_city: parts[0], job_state: '' };
}

/**
 * Normalize Greenhouse job to common format
 * @param {Object} job - Raw Greenhouse job object
 * @param {string} companySlug - Company slug for reference
 * @returns {Object} Normalized job object
 */
function normalizeGreenhouseJob(job, companySlug, companyName) {
    // Extract location from Greenhouse format
    let location = job.location?.name || 'Remote';

    // AGG-LOC-4: When location is a work-type string (Hybrid, In-Office, etc.),
    // try to extract real location from the offices array.
    // Cloudflare uses "Hybrid"/"In-Office" as location but has city/state in offices.
    // xAI uses "Remote" but offices includes "Palo Alto, CA".
    const WORK_TYPE_RE = /^(remote|in-office|hybrid|distributed|onsite|remote-friendly|hybrid;\s*in-office)$/i;
    if (WORK_TYPE_RE.test(location) && Array.isArray(job.offices) && job.offices.length > 0) {
        // Pick first office that isn't itself a work-type string
        const realOffice = job.offices.find(o => o.name && !WORK_TYPE_RE.test(o.name));
        if (realOffice) {
            location = realOffice.name;
        }
    }

    const { job_city, job_state } = parseGreenhouseLocation(location);

    // Parse departments
    const departments = job.departments?.map(d => d.name) || [];

    return {
        // Core fields
        id: `greenhouse-${companySlug}-${job.id}`,
        source: 'greenhouse',
        source_url: 'boards-api.greenhouse.io',
        source_id: job.id.toString(),

        // Job details
        title: (job.title || '').replace(/\|/g, ' ').trim(),
        company_name: (companyName || job.company_name || companySlug).replace(/\|/g, ' ').trim(),
        company_slug: companySlug,

        // Location — raw string for tag-engine, structured fields for routing
        location: location,
        locations: [location],
        job_city: job_city,
        job_state: job_state,

        // URL
        url: job.absolute_url,

        // Metadata
        departments: departments,
        employment_type: job.employment_type || null,

        // Dates — FRESHNESS-2: GH API has first_published (posting date) and updated_at (edit date).
        // created_at does not exist in the GH API. Use first_published for accurate posting date.
        // If older than 7 days, substitute Date.now() so evergreen postings stay visible
        // (same pattern as Lever/Ashby FRESHNESS-2 — consistent across all sources).
        posted_at: (() => {
            const publishedMs = job.first_published ? new Date(job.first_published).getTime() : NaN;
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            return new Date(!isNaN(publishedMs) && publishedMs > cutoff ? publishedMs : Date.now()).toISOString();
        })(),
        fetched_at: new Date().toISOString(),

        // Description (if content=true was requested)
        description: job.content || null,

        // Original data for debugging
        _raw: {
            source: 'greenhouse',
            original_id: job.id
        }
    };
}

/**
 * Fetch jobs from multiple Greenhouse companies
 * @param {Array<{slug: string, name: string}>} companies - List of companies to fetch
 * @param {Object} options - Options
 * @param {number} options.concurrency - Parallel requests per batch (default: 5)
 * @param {number} options.delayMs - Delay between batches in ms (default: 200ms)
 * @returns {Promise<Array>} All jobs from all companies
 */
async function fetchAllGreenhouseJobs(companies, options = {}) {
    const { concurrency = 5, delayMs = 200 } = options;
    const allJobs = [];

    console.log(`::group::🌿 Greenhouse (${companies.length} boards)`);
    console.log(`🌿 Fetching from ${companies.length} Greenhouse boards (concurrency: ${concurrency})...`);

    for (let i = 0; i < companies.length; i += concurrency) {
        const batch = companies.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async company => {
            const slug = typeof company === 'string' ? company : company.slug;
            const name = typeof company === 'string' ? company : company.name;
            try {
                const jobs = await fetchGreenhouseJobs(slug, name);
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

    console.log(`   📊 Greenhouse total: ${allJobs.length} jobs`);
    console.log('::endgroup::');
    return allJobs;
}

module.exports = {
    fetchGreenhouseJobs,
    fetchAllGreenhouseJobs,
    normalizeGreenhouseJob,
    parseGreenhouseLocation
};
