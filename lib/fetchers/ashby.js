/**
 * Ashby Job Board API Client
 *
 * Fetches jobs from Ashby's public API.
 * No authentication required.
 *
 * Primary endpoint: https://api.ashbyhq.com/posting-api/job-board/{jobBoardName}
 * Fallback endpoint: https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams
 */

'use strict';

const https = require('https');
const { delay } = require('./http-client');

const BASE_URL = 'https://api.ashbyhq.com/posting-api/job-board';
const MAX_RETRIES = 2;
const GRAPHQL_URL = 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams';
const GRAPHQL_DETAIL_URL = 'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting';
const REQUEST_TIMEOUT_MS = 15000;
const GRAPHQL_DETAIL_CONCURRENCY = 8;
const GRAPHQL_QUERY = `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
  jobBoard: jobBoardWithTeams(
    organizationHostedJobsPageName: $organizationHostedJobsPageName
  ) {
    teams {
      id
      name
      externalName
      parentTeamId
      __typename
    }
    jobPostings {
      id
      title
      teamId
      locationId
      locationName
      workplaceType
      employmentType
      secondaryLocations {
        locationId
        locationName
        __typename
      }
      compensationTierSummary
      __typename
    }
    __typename
  }
}`;

const GRAPHQL_DETAIL_QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(
    organizationHostedJobsPageName: $organizationHostedJobsPageName
    jobPostingId: $jobPostingId
  ) {
    id
    title
    publishedDate
    departmentName
    departmentExternalName
    locationName
    workplaceType
    employmentType
    descriptionHtml
    isListed
    teamNames
    secondaryLocationNames
    compensationTierSummary
  }
}`;

function getJson(url) {
    return new Promise((resolve) => {
        const req = https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = data ? JSON.parse(data) : null;
                    resolve({ status: res.statusCode, data: parsed });
                } catch (error) {
                    resolve({ status: res.statusCode, error });
                }
            });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy();
            resolve({ status: 0, timeout: true });
        });
        req.on('error', (error) => resolve({ status: 0, error }));
    });
}

function postJson(url, payload, headers = {}) {
    return new Promise((resolve) => {
        const body = JSON.stringify(payload);
        const req = https.request(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                'apollographql-client-name': 'frontend_non_user',
                'apollographql-client-version': '0.1.0',
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = data ? JSON.parse(data) : null;
                    resolve({ status: res.statusCode, data: parsed });
                } catch (error) {
                    resolve({ status: res.statusCode, error });
                }
            });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            req.destroy();
            resolve({ status: 0, timeout: true });
        });
        req.on('error', (error) => resolve({ status: 0, error }));
        req.write(body);
        req.end();
    });
}

function buildAshbyGraphQLRequest(companySlug) {
    return {
        operationName: 'ApiJobBoardWithTeams',
        variables: { organizationHostedJobsPageName: companySlug },
        query: GRAPHQL_QUERY
    };
}

function buildAshbyGraphQLDetailRequest(companySlug, jobPostingId) {
    return {
        operationName: 'ApiJobPosting',
        variables: {
            organizationHostedJobsPageName: companySlug,
            jobPostingId
        },
        query: GRAPHQL_DETAIL_QUERY
    };
}

function normalizeAshbyGraphQLDetailJob(job, companySlug, companyName, fetchedAt = new Date().toISOString()) {
    const location = job.locationName || 'Remote';
    const secondaryLocations = Array.isArray(job.secondaryLocationNames)
        ? job.secondaryLocationNames.filter(Boolean)
        : [];
    const department = job.departmentExternalName || job.departmentName || null;
    const team = Array.isArray(job.teamNames) && job.teamNames.length > 0
        ? job.teamNames[job.teamNames.length - 1]
        : department;
    const publishedAt = job.publishedDate ? new Date(`${job.publishedDate}T00:00:00.000Z`).toISOString() : null;

    return {
        id: `ashby-${companySlug}-${job.id}`,
        source: 'ashby',
        source_url: 'jobs.ashbyhq.com',
        source_id: job.id,
        title: (job.title || '').replace(/\|/g, ' ').trim(),
        company_name: (companyName || companySlug).replace(/\|/g, ' ').trim(),
        company_slug: companySlug,
        location,
        locations: [location, ...secondaryLocations],
        is_remote: job.workplaceType === 'Remote',
        url: `https://jobs.ashbyhq.com/${companySlug}/${job.id}`,
        apply_url: null,
        department,
        team,
        employment_type: job.employmentType || null,
        salary: null,
        posted_at: publishedAt,
        first_published: publishedAt,
        fetched_at: fetchedAt,
        description: job.descriptionHtml || null,
        _raw: {
            source: 'ashby_graphql_detail',
            original_id: job.id,
            workplace_type: job.workplaceType || null,
            team_names: Array.isArray(job.teamNames) ? job.teamNames : [],
            compensation_tier_summary: job.compensationTierSummary || null,
            is_listed: job.isListed ?? null
        }
    };
}

function resolveAshbyTeamPath(teamId, teamsById) {
    if (!teamId || !(teamsById instanceof Map)) return [];

    const path = [];
    const seen = new Set();
    let currentId = teamId;

    while (currentId && !seen.has(currentId)) {
        seen.add(currentId);
        const team = teamsById.get(currentId);
        if (!team) break;
        path.unshift(team.externalName || team.name);
        currentId = team.parentTeamId || null;
    }

    return path.filter(Boolean);
}

function normalizeAshbyJob(job, companySlug, companyName) {
    const location = job.location || 'Remote';
    const department = job.department || null;
    const team = job.team || null;
    const employmentType = job.employmentType || null;
    const compensation = job.compensation ? {
        min: job.compensation.compensationTierSummary?.min,
        max: job.compensation.compensationTierSummary?.max,
        currency: job.compensation.compensationTierSummary?.currency,
        interval: job.compensation.compensationTierSummary?.interval
    } : null;
    const isRemote = job.isRemote || false;

    return {
        id: `ashby-${companySlug}-${job.id}`,
        source: 'ashby',
        source_url: 'api.ashbyhq.com',
        source_id: job.id,
        title: (job.title || '').replace(/\|/g, ' ').trim(),
        company_name: (companyName || job.organizationName || companySlug).replace(/\|/g, ' ').trim(),
        company_slug: companySlug,
        location,
        locations: job.secondaryLocations
            ? [location, ...job.secondaryLocations]
            : [location],
        is_remote: isRemote,
        url: job.jobUrl || `https://jobs.ashbyhq.com/${companySlug}/${job.id}`,
        apply_url: job.applyUrl || null,
        department,
        team,
        employment_type: employmentType,
        salary: compensation,
        posted_at: job.publishedAt || null,
        first_published: job.publishedAt || null,
        fetched_at: new Date().toISOString(),
        description: job.descriptionPlain || job.descriptionHtml || null,
        _raw: {
            source: 'ashby',
            original_id: job.id
        }
    };
}

function normalizeAshbyGraphQLJob(job, companySlug, companyName, teamsById, fetchedAt = new Date().toISOString()) {
    const location = job.locationName || 'Remote';
    const secondaryLocations = Array.isArray(job.secondaryLocations)
        ? job.secondaryLocations.map(loc => loc.locationName).filter(Boolean)
        : [];
    const teamPath = resolveAshbyTeamPath(job.teamId, teamsById);
    const department = teamPath[0] || null;
    const team = teamPath.length > 1 ? teamPath[teamPath.length - 1] : department;
    const compensation = job.compensationTierSummary ? {
        min: job.compensationTierSummary.min,
        max: job.compensationTierSummary.max,
        currency: job.compensationTierSummary.currency,
        interval: job.compensationTierSummary.interval
    } : null;

    return {
        id: `ashby-${companySlug}-${job.id}`,
        source: 'ashby',
        source_url: 'jobs.ashbyhq.com',
        source_id: job.id,
        title: (job.title || '').replace(/\|/g, ' ').trim(),
        company_name: (companyName || companySlug).replace(/\|/g, ' ').trim(),
        company_slug: companySlug,
        location,
        locations: [location, ...secondaryLocations],
        is_remote: job.workplaceType === 'Remote',
        url: `https://jobs.ashbyhq.com/${companySlug}/${job.id}`,
        apply_url: null,
        department,
        team,
        employment_type: job.employmentType || null,
        salary: compensation,
        posted_at: job.publishedDate ? new Date(`${job.publishedDate}T00:00:00.000Z`).toISOString() : null,
        first_published: job.publishedDate ? new Date(`${job.publishedDate}T00:00:00.000Z`).toISOString() : null,
        fetched_at: fetchedAt,
        description: null,
        _raw: {
            source: 'ashby_graphql',
            original_id: job.id,
            workplace_type: job.workplaceType || null,
            team_path: teamPath
        }
    };
}

async function fetchAshbyJobDetailGraphQL(companySlug, companyName, jobPostingId) {
    const payload = buildAshbyGraphQLDetailRequest(companySlug, jobPostingId);
    const result = await postJson(GRAPHQL_DETAIL_URL, payload, {
        origin: 'https://jobs.ashbyhq.com',
        referer: `https://jobs.ashbyhq.com/${companySlug}`
    });

    if (result.timeout || result.status !== 200 || !result.data?.data?.jobPosting) {
        return null;
    }

    return normalizeAshbyGraphQLDetailJob(
        result.data.data.jobPosting,
        companySlug,
        companyName
    );
}

async function fetchAshbyJobsGraphQL(companySlug, companyName) {
    const payload = buildAshbyGraphQLRequest(companySlug);
    const result = await postJson(GRAPHQL_URL, payload, {
        origin: `https://jobs.ashbyhq.com`,
        referer: `https://jobs.ashbyhq.com/${companySlug}`
    });

    if (result.timeout) {
        console.log(`   ⚠️ Ashby GraphQL timeout: ${companySlug} after ${REQUEST_TIMEOUT_MS / 1000}s`);
        return [];
    }

    if (result.status === 404) {
        console.log(`   ⚠️ Ashby GraphQL board not found: ${companySlug}`);
        return [];
    }

    if (result.status !== 200 || !result.data?.data?.jobBoard) {
        console.log(`   ⚠️ Ashby GraphQL error for ${companySlug}: ${result.status || result.error?.message || 'unknown'}`);
        return [];
    }

    const postings = result.data.data.jobBoard.jobPostings || [];
    const detailedJobs = [];

    for (let i = 0; i < postings.length; i += GRAPHQL_DETAIL_CONCURRENCY) {
        const batch = postings.slice(i, i + GRAPHQL_DETAIL_CONCURRENCY);
        const results = await Promise.all(batch.map(job =>
            fetchAshbyJobDetailGraphQL(companySlug, companyName, job.id)
        ));
        for (const job of results) {
            if (job) detailedJobs.push(job);
        }
    }

    return detailedJobs;
}

/**
 * Fetch jobs from a single Ashby board
 * @param {string} companySlug - Company's job board name (e.g., 'linear')
 * @returns {Promise<Array>} Array of normalized job objects
 */
async function fetchAshbyJobs(companySlug, companyName) {
    const url = `${BASE_URL}/${companySlug}?includeCompensation=true`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const result = await getJson(url);

        // Timeout or network error → retry with backoff
        if (result.timeout || result.status === 0) {
            if (attempt < MAX_RETRIES) { await delay(1000 * (attempt + 1)); continue; }
            console.log(`   ⚠️ Ashby timeout/network error: ${companySlug} after ${MAX_RETRIES + 1} attempts`);
            return [];
        }

        // Success
        if (result.status === 200) {
            const jobs = result.data?.jobs || [];
            return jobs.map(job => normalizeAshbyJob(job, companySlug, companyName));
        }

        // 404 — could be transient (rate-limiting) or permanent. Retry first.
        if (result.status === 404) {
            if (attempt < MAX_RETRIES) { await delay(1000 * (attempt + 1)); continue; }
            // Exhausted retries; 404 is permanent
            if (companySlug === 'whatnot') {
                console.log(`   ⚠️ Ashby legacy API 404: ${companySlug} — falling back to GraphQL`);
                return fetchAshbyJobsGraphQL(companySlug, companyName);
            }
            console.log(`   ⚠️ Ashby board not found: ${companySlug}`);
            return [];
        }

        // 429 — rate-limited, retry with backoff
        if (result.status === 429) {
            if (attempt < MAX_RETRIES) { await delay(1000 * (attempt + 1)); continue; }
            console.log(`   ⚠️ Ashby rate-limited: ${companySlug}`);
            return [];
        }

        // Non-retryable error (403, 500, etc.)
        console.log(`   ⚠️ Ashby API error for ${companySlug}: ${result.status || result.error?.message || 'unknown'}`);
        return [];
    }
    return [];
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
    const { concurrency = 15, delayMs = 100 } = options;
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
    fetchAshbyJobDetailGraphQL,
    fetchAshbyJobsGraphQL,
    fetchAllAshbyJobs,
    buildAshbyGraphQLRequest,
    buildAshbyGraphQLDetailRequest,
    normalizeAshbyJob,
    normalizeAshbyGraphQLJob,
    normalizeAshbyGraphQLDetailJob,
    resolveAshbyTeamPath
};
