/**
 * Job Validator - Malformed Field Handling
 *
 * Validates and normalizes jobs before processing.
 * Based on Task #2 research (2026-02-15)
 *
 * Strategy: SKIP jobs with missing required fields, AUTO-FIX optional fields
 *
 * Required fields (Tier 1): title, company_name, url
 * Auto-fix fields (Tier 2): job_city, job_state (parse from location)
 * Optional fields (Tier 3): experience_level, employment_type
 */

/**
 * Validate job has all required fields
 * @param {Object} job - Job object to validate
 * @returns {boolean} - True if valid, false if should be skipped
 */
// DATA-QUALITY-1: Reject placeholder/internal/garbage titles
const GARBAGE_TITLE_PATTERNS = [
    /^potentially/i,              // "Potentially a good fit for PTI?"
    /\bgood fit for\b/i,          // internal matching language
    /\bgreat fit for\b/i,
    /^test[,\s]/i,                // "Test, Do not Apply"
    /\bdo not apply\b/i,
    /^tbd\b/i,                    // placeholder
    /^n\/a$/i,
    /^job\s*$/i,
    /^position\s*$/i,
    /^open\s+position\s*$/i,
    /^future\s+opportunity\s*--/i, // "Future Opportunity -- Machine Learning Engineer" (no actual role)
];

function isValidJob(job) {
    // Tier 1: REQUIRED - title
    if (!job.title || typeof job.title !== 'string' || job.title.trim().length < 5) {
        return false;
    }

    // Tier 1b: QUALITY - reject garbage/placeholder titles
    const title = job.title.trim();
    if (GARBAGE_TITLE_PATTERNS.some(p => p.test(title))) {
        return false;
    }

    // Tier 1: REQUIRED - company_name
    if (!job.company_name || typeof job.company_name !== 'string' || job.company_name.trim().length < 2) {
        return false;
    }

    // Tier 1: REQUIRED - url
    if (!job.url || typeof job.url !== 'string' || !job.url.startsWith('http')) {
        return false;
    }

    return true;
}

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
 * Normalize job fields (auto-fix missing data)
 * @param {Object} job - Job object to normalize
 * @returns {Object} - Normalized job object
 */
function normalizeJob(job) {
    // Tier 2: AUTO-FIX - Extract state from location if missing
    if ((!job.job_state || job.job_state === '') && job.location) {
        // Pattern: "San Francisco, CA" → "CA"
        const stateMatch = job.location.match(/,\s*([A-Z]{2})\b/);
        if (stateMatch) {
            job.job_state = stateMatch[1];
        } else {
            // AGG-LOC-1: Full state names — "Costa Mesa, California, United States"
            const cleaned = job.location
                .replace(/^(hybrid|remote-friendly(\s*\([^)]*\))?|remote|in-office)\s*[-–,]\s*/i, '')
                .trim();
            const parts = cleaned.split(',').map(p => p.trim());
            if (parts.length >= 2) {
                const abbrFromSecond = STATE_NAME_TO_ABBR[parts[1].toLowerCase()];
                if (abbrFromSecond) {
                    job.job_state = abbrFromSecond;
                    if (!job.job_city || job.job_city === '') job.job_city = parts[0];
                } else {
                    const abbrFromFirst = STATE_NAME_TO_ABBR[parts[0].toLowerCase()];
                    if (abbrFromFirst && /^(united states|usa|us)$/i.test(parts[1])) {
                        job.job_state = abbrFromFirst;
                    }
                }
            } else if (parts.length === 1) {
                const abbr = STATE_NAME_TO_ABBR[parts[0].toLowerCase()];
                if (abbr) job.job_state = abbr;
            }
        }
    }

    // Tier 2: AUTO-FIX - Extract city from location if missing
    // Skip non-geographic strings (remote/hybrid/work-type descriptors)
    if ((!job.job_city || job.job_city === '') && job.location) {
        const isNonGeographic = /^(remote|hybrid|in-office|on-site|remote-friendly)/i.test(job.location.trim());
        if (!isNonGeographic) {
            const cleaned = job.location
                .replace(/^(hybrid|remote-friendly(\s*\([^)]*\))?|remote|in-office)\s*[-–,]\s*/i, '')
                .trim();
            const cityMatch = cleaned.match(/^([^,]+)/);
            if (cityMatch) {
                job.job_city = cityMatch[1].trim();
            }
        }
    }

    // AGG-DATA-12: Normalize employment type strings to 5 canonical forms.
    // ATS sources use inconsistent formats (FULLTIME/FULL-TIME/FULL_TIME/etc).
    if (job.employment_type && typeof job.employment_type === 'string') {
        const et = job.employment_type.toUpperCase().replace(/[\s\-_]/g, '');
        const EMPLOYMENT_MAP = {
            FULLTIME: 'full_time', FULL: 'full_time',
            PARTTIME: 'part_time', PART: 'part_time',
            INTERN: 'internship', INTERNSHIP: 'internship',
            CONTRACT: 'contract', CONTRACTOR: 'contract',
            TEMPORARY: 'temporary', TEMP: 'temporary',
        };
        if (EMPLOYMENT_MAP[et]) job.employment_type = EMPLOYMENT_MAP[et];
    }

    // Tier 3: OPTIONAL - Don't modify experience_level or employment_type

    return job;
}

/**
 * Validate and normalize a batch of jobs
 * @param {Array} jobs - Array of job objects
 * @returns {Object} - { validJobs, invalidJobs, metrics }
 */
function validateAndNormalizeJobs(jobs) {
    const validJobs = [];
    const invalidJobs = [];

    const metrics = {
        total_input: jobs.length,
        valid_jobs: 0,
        invalid_jobs: 0,
        invalid_reasons: {
            missing_title: 0,
            missing_company: 0,
            missing_url: 0,
            invalid_title_length: 0,
            invalid_company_length: 0,
            invalid_url_format: 0
        },
        normalized_fields: {
            state_extracted: 0,
            city_extracted: 0
        }
    };

    for (const job of jobs) {
        // Track why job is invalid (for debugging)
        let invalidReason = null;

        // Validate title
        if (!job.title || typeof job.title !== 'string') {
            invalidReason = 'missing_title';
        } else if (job.title.trim().length < 5) {
            invalidReason = 'invalid_title_length';
        } else if (GARBAGE_TITLE_PATTERNS.some(p => p.test(job.title.trim()))) {
            invalidReason = 'garbage_title';
        }
        // Validate company
        else if (!job.company_name || typeof job.company_name !== 'string') {
            invalidReason = 'missing_company';
        } else if (job.company_name.trim().length < 2) {
            invalidReason = 'invalid_company_length';
        }
        // Validate URL
        else if (!job.url || typeof job.url !== 'string') {
            invalidReason = 'missing_url';
        } else if (!job.url.startsWith('http')) {
            invalidReason = 'invalid_url_format';
        }

        // Process based on validation result
        if (invalidReason) {
            metrics.invalid_reasons[invalidReason]++;
            metrics.invalid_jobs++;
            invalidJobs.push({
                job: job,
                reason: invalidReason
            });
        } else {
            // Track state before normalization
            const hadState = job.job_state && job.job_state !== '';
            const hadCity = job.job_city && job.job_city !== '';

            // Normalize the job
            const normalizedJob = normalizeJob(job);

            // Track what was normalized
            if (!hadState && normalizedJob.job_state) {
                metrics.normalized_fields.state_extracted++;
            }
            if (!hadCity && normalizedJob.job_city) {
                metrics.normalized_fields.city_extracted++;
            }

            metrics.valid_jobs++;
            validJobs.push(normalizedJob);
        }
    }

    return {
        validJobs,
        invalidJobs,
        metrics
    };
}

/**
 * Print validation summary to console
 * @param {Object} metrics - Validation metrics
 */
function printValidationSummary(metrics) {
    console.log('📊 Validation Summary:');
    console.log('━'.repeat(60));
    console.log(`Input jobs: ${metrics.total_input}`);
    console.log(`Valid jobs: ${metrics.valid_jobs} (${((metrics.valid_jobs / metrics.total_input) * 100).toFixed(1)}%)`);
    console.log(`Invalid jobs: ${metrics.invalid_jobs} (${((metrics.invalid_jobs / metrics.total_input) * 100).toFixed(1)}%)`);
    console.log('');

    if (metrics.invalid_jobs > 0) {
        console.log('Invalid job breakdown:');
        for (const [reason, count] of Object.entries(metrics.invalid_reasons)) {
            if (count > 0) {
                console.log(`  ${reason}: ${count}`);
            }
        }
        console.log('');
    }

    const totalNormalized = metrics.normalized_fields.state_extracted + metrics.normalized_fields.city_extracted;
    if (totalNormalized > 0) {
        console.log('Fields auto-fixed:');
        if (metrics.normalized_fields.state_extracted > 0) {
            console.log(`  State extracted from location: ${metrics.normalized_fields.state_extracted}`);
        }
        if (metrics.normalized_fields.city_extracted > 0) {
            console.log(`  City extracted from location: ${metrics.normalized_fields.city_extracted}`);
        }
    }
}

module.exports = {
    isValidJob,
    normalizeJob,
    validateAndNormalizeJobs,
    printValidationSummary
};
