/**
 * Senior Filter — NO-OP (I-41: Career Level Expansion)
 *
 * This module was the pipeline's senior-level job filter (Step 4).
 * As of 2026-05-20, ZJP serves all career levels (entry, mid, senior).
 * The filter is now a pass-through — all jobs are kept.
 *
 * Employment classification still happens in tag-engine.js (tagEmployment).
 * That classification is metadata only — NOT used for filtering.
 */

/**
 * Check if a job is senior-level. Always returns false — no jobs are filtered.
 */
function isSeniorJob() {
    return false;
}

function hasSeniorTitle() {
    return false;
}

function requiresSeniorExperience() {
    return false;
}

/**
 * Pass-through: returns ALL jobs as entryLevel, zero senior.
 */
function filterSeniorJobs(jobs) {
    return {
        entryLevelJobs: jobs,
        seniorJobs: [],
        metrics: {
            total_input: jobs.length,
            entry_level_count: jobs.length,
            senior_count: 0,
            internship_count: jobs.filter(j =>
                (j.tags && j.tags.employment === 'internship') ||
                /intern/i.test(j.title || '')
            ).length,
            senior_reasons: { title_only: 0, experience_only: 0, both: 0 },
            override_applied: 0,
        }
    };
}

function printSeniorFilterSummary(metrics) {
    console.log(`  🎯 Senior filter: DISABLED (I-41 — all career levels included)`);
    console.log(`     Total jobs: ${metrics.total_input}`);
}

function buildCompanyOverrideMap() {
    return new Map();
}

function checkCompanyOverride() {
    return null;
}

module.exports = {
    isSeniorJob,
    hasSeniorTitle,
    requiresSeniorExperience,
    filterSeniorJobs,
    printSeniorFilterSummary,
    buildCompanyOverrideMap,
    checkCompanyOverride,

    // Export for testing (preserved for backward compat)
    SENIOR_KEYWORDS: [],
    SENIOR_MANAGER_RE: /$^/,
    MIN_SENIOR_YEARS: 99,
    MIN_SENIOR_YEARS_DESC: 99
};
