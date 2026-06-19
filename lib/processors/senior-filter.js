/**
 * Senior Job Filter
 *
 * Filters out senior-level jobs to focus on entry-level and new-grad positions.
 * Based on Phase 1 architecture requirements.
 *
 * Filtering criteria:
 * 1. Experience level: >5 years experience required
 * 2. Job titles: Contains senior-level keywords
 * 3. Conservative approach: When in doubt, include the job
 */

/**
 * Senior job title keywords
 * These indicate a senior-level position
 */
const SENIOR_KEYWORDS = [
    'senior',
    'sr.',
    'sr ',
    'lead',
    'principal',
    'staff',
    'director',
    'vp',
    'vice president',
    'chief',
    // 'cto' removed — substring matched "Director", "Inspector", "Contractor", "Factory",
    // "Account", "Postdoctoral" causing ~460 FP filtered jobs/run. Checked via regex below.
    'cio',
    'ceo',
    'head of',
    'superintendent',  // construction/manufacturing/utilities site lead (2026-06-19: all 15 US rows per-job verified as skilled-trade leads — Granite Construction/KBR/Eversource/Baxter/SpaceX/Vertiv — none new-grad-appropriate)
    'foreman',  // skilled-trade crew lead (construction/utility/manufacturing shop foreman) — not new-grad; substring-safe (no benign superstring)
    'architect',  // Solution Architect, Enterprise Architect typically senior
    'distinguished'  // Distinguished Engineer (Capital One, NVIDIA) is senior
];

// Word-boundary match for CTO — avoids false positives from "Director", "Inspector",
// "Contractor", "Factory", "Account", "Postdoctoral" (AGG-CTO-FP-1).
const CTO_WORD_RE = /\bcto\b/i;

// TAG-KEYWORD-7: Senior management patterns for engineering/technical leadership.
// "manager" was removed from SENIOR_KEYWORDS because 37.5% of filtered jobs were FPs
// (~9K jobs/run). "Account Manager", "Product Manager", "Project Manager" etc. are
// NOT inherently senior. Only people-managers of engineering teams are senior here.
// "Manager I" titles (junior) are excluded by requiring no "I" suffix.
const SENIOR_MANAGER_RE = /\b(engineering\s+manager|software\s+engineering\s+manager|ml\s+manager|machine\s+learning\s+manager|manager,?\s+(?:software\s+)?engineering|data\s+engineering\s+manager|solution\s+engineering\s+manager|sales\s+engineering\s+manager)\b(?!.*\bI\b)/i;

// Senior industry-management patterns — clearly mid/senior professional manager roles
// that are NOT new-grad-appropriate (unlike Product/Program/Project/Account/Associate Manager).
// Added 2026-06-19 (manager-pool fix): ~506 industry-manager rows were leaking into the
// New-Grad pool (Store/Tax/Operations/Risk/Finance/Marketing/HR Manager, GM, Plant/Warehouse/
// Facilities/Procurement Manager). This does NOT reverse AGG-SENIOR-FP-1 (generic "manager"
// stays unfiltered) — it targets a different, clearly-senior category by full title phrase.
// Guarded by ENTRY_LEVEL_GUARDS (assistant/associate/junior/trainee) + ROTATIONAL_GUARD below.
const SENIOR_INDUSTRY_MANAGER_RE = /\b(general manager|store manager|retail manager|tax manager|accounting manager|finance manager|risk manager|plant manager|warehouse manager|facilities manager|procurement manager|supply chain manager|operations manager|marketing manager|hr manager|human resources manager|compensation manager|benefits manager)\b/i;

// Senior industrial-supervisor patterns — manufacturing/ops line leads (Production/
// Manufacturing/Warehouse/Maintenance/Quality/Distribution/Safety Supervisor) that are
// skilled-trade leads, not new-grad. Added 2026-06-19 (per-category research: RTX, Medtronic,
// Cardinal Health, HPE, KBR, Curtiss-Wright, Veritiv, Oshkosh, Veolia — all line leads).
// "operations supervisor" deliberately EXCLUDED for now (borderline retail/venue ops).
// Either word order within 30 chars (handles "Supervisor, Production"). Associate/Assistant
// variants are preserved by ENTRY_LEVEL_GUARDS.
const SENIOR_INDUSTRY_SUPERVISOR_RE = /\b(production|manufacturing|warehouse|maintenance|quality|distribution|safety)\b.{0,30}\bsupervisor\b|\bsupervisor\b.{0,30}\b(production|manufacturing|warehouse|maintenance|quality|distribution|safety)\b/i;

/**
 * Experience patterns indicating senior level
 * Regex patterns for detecting years of experience
 */
const EXPERIENCE_RANGE_SEP = '(?:-|–|—)';
const DESCRIPTION_EXPERIENCE_CONTEXT = String.raw`(?:\s+of)?(?:\s+[A-Za-z][A-Za-z/-]*){0,3}\s+experience\b`;
const TITLE_EXPERIENCE_PATTERNS = [
    new RegExp(String.raw`(\d+)\s*${EXPERIENCE_RANGE_SEP}\s*(\d+)\s*(?:years?|yrs?)\b`, 'i'),
    /(\d+)\+?\s*(?:years?|yrs?)\b/i,
    /minimum\s+(\d+)\s*(?:years?|yrs?)\b/i,
    /at least\s+(\d+)\s*(?:years?|yrs?)\b/i
];
const DESCRIPTION_EXPERIENCE_PATTERNS = [
    new RegExp(String.raw`(\d+)\s*${EXPERIENCE_RANGE_SEP}\s*(\d+)\s*(?:years?|yrs?)\b${DESCRIPTION_EXPERIENCE_CONTEXT}`, 'i'),
    new RegExp(String.raw`minimum\s+(\d+)\+?\s*(?:years?|yrs?)\b${DESCRIPTION_EXPERIENCE_CONTEXT}`, 'i'),
    new RegExp(String.raw`at least\s+(\d+)\+?\s*(?:years?|yrs?)\b${DESCRIPTION_EXPERIENCE_CONTEXT}`, 'i'),
    new RegExp(String.raw`(\d+)\+?\s*(?:years?|yrs?)\b${DESCRIPTION_EXPERIENCE_CONTEXT}`, 'i')
];

const MIN_SENIOR_YEARS = 5; // Jobs requiring 5+ years in TITLE are considered senior
const MIN_SENIOR_YEARS_DESC = 7; // Description threshold higher — ATS "preferred" experience is aspirational

// P2: Roman numeral suffix REMOVED (AGG-SENIOR-FP-1 Phase 2).
//     II/III/IV are level indicators (Software Engineer II, Technician III), not seniority markers.
//     Tag-engine correctly classifies II/III as mid_level. Genuinely senior roman-numeral jobs
//     (e.g., "Senior Engineer II") are caught by the "senior" keyword.
//     Removing this recovers ~129 FPs/run (blue-collar + mid-level ICs).

// P3: Job-level suffix "L5"–"L9" as a standalone token (DeepMind L5, Snap L5).
//     Requires non-alphanumeric/slash on both sides to avoid matching "L2/L3" networking protocols
//     (Cisco titles) or "ACL3" type strings.
const SENIOR_LLEVEL_PATTERN = /(?:[^/\w])L[5-9](?:[^/\w]|$)/;

// AGG-7: Entry-level guards for ambiguous keywords.
// These patterns, when matched, override a senior keyword match and let the job through.
// Same approach as ENTRY_LOCK_RE in tag-engine.js — exemptions are cheaper than removing keywords.
//
// Data: 15 GH companies (2,099 jobs) + Oshkosh WD (200 jobs) sampled S230.
// FP rate without guards: ~1-3% on GH (tech), ~5-10% on WD (manufacturing/retail).
// FPs: "Associate Manager", "Manager Trainee", "Staffing Coordinator", "Shift Lead",
//       "Lead Generation", "Team Lead" (manufacturing).
const ENTRY_LEVEL_GUARDS = [
    /\b(associate|assistant|junior|entry[- ]level|trainee)\b/i,
    /\bstaffing\b/i,                       // "Staffing Coordinator" — not "Staff Engineer"
    /\blead\s+generation\b/i,              // marketing role, not leadership
    /\bshift\s+lead\b/i,                   // hourly production roles (shift lead, not "Senior Lead")
    /\bteam\s+lead\b(?!.*(?:engineer|software|developer|architect))/i,  // mfg/retail team leads, but not "Team Lead - Software"
    /\b(solution|solutions|business|sales|presales|pre-sales)\s+architect\b/i,  // Pre-sales/consulting roles — not senior engineering
    /\barchitect\b.*\b(solution|solutions|business|sales|presales|pre-sales)\b/i,  // "Architect, Solutions" variant
];

// Rotational/development/leadership programs ARE new-grad even with a senior-sounding
// industry-manager title (e.g., "Operations Manager, Rotational Program").
// Added 2026-06-19 alongside SENIOR_INDUSTRY_MANAGER_RE.
const ROTATIONAL_GUARD = /\b(rotational|development program|leadership program|graduate program|management trainee|early career|new grad|recent grad)\b/i;

/**
 * AGG-36: Build per-company override map from company-list.json.
 * Returns Map<companyName_lowercase, { patterns: RegExp[], result: string }>
 * Called once at pipeline startup, passed to filterSeniorJobs.
 */
function buildCompanyOverrideMap(companyList) {
    const overrideMap = new Map();
    if (!companyList || typeof companyList !== 'object') return overrideMap;

    for (const [_source, companies] of Object.entries(companyList)) {
        if (!Array.isArray(companies)) continue;
        for (const company of companies) {
            const overrides = company.titleOverrides;
            if (!overrides || !overrides.employment) continue;
            const name = (company.name || '').toLowerCase();
            if (!name) continue;

            const compiled = [];
            for (const rule of overrides.employment) {
                try {
                    compiled.push({ regex: new RegExp(rule.pattern, 'i'), result: rule.result, reason: rule.reason });
                } catch (e) {
                    console.warn(`⚠️ Invalid override regex for ${company.name}: ${rule.pattern} — ${e.message}`);
                }
            }
            if (compiled.length > 0) {
                overrideMap.set(name, compiled);
            }
        }
    }
    return overrideMap;
}

/**
 * AGG-36: Check per-company title override. Returns override result or null.
 */
function checkCompanyOverride(title, companyName, overrideMap) {
    if (!overrideMap || !companyName) return null;
    const rules = overrideMap.get(companyName.toLowerCase());
    if (!rules) return null;

    for (const rule of rules) {
        if (rule.regex.test(title || '')) {
            return rule.result;
        }
    }
    return null;
}

/**
 * Check if job title contains senior-level keywords
 * @param {string} title - Job title
 * @returns {boolean} - True if title indicates senior level
 */
function hasSeniorTitle(title) {
    if (!title || typeof title !== 'string') {
        return false;
    }

    const lowerTitle = title.toLowerCase();

    // Check for senior keywords
    let matchedSenior = false;
    for (const keyword of SENIOR_KEYWORDS) {
        if (lowerTitle.includes(keyword)) {
            matchedSenior = true;
            break;
        }
    }

    // AGG-CTO-FP-1: Word-boundary CTO check (avoids substring FPs)
    if (!matchedSenior) {
        if (CTO_WORD_RE.test(title)) matchedSenior = true;
    }

    // TAG-KEYWORD-7: Senior management patterns (engineering leadership only)
    if (!matchedSenior) {
        if (SENIOR_MANAGER_RE.test(title)) matchedSenior = true;
    }

    // 2026-06-19 industry-manager patterns (Store/Tax/Operations/Risk/Finance/GM etc.)
    if (!matchedSenior) {
        if (SENIOR_INDUSTRY_MANAGER_RE.test(title)) matchedSenior = true;
    }

    // 2026-06-19 industrial-supervisor patterns (Production/Manufacturing/Warehouse/
    // Maintenance/Quality/Distribution/Safety Supervisor) — manufacturing/ops line leads.
    if (!matchedSenior) {
        if (SENIOR_INDUSTRY_SUPERVISOR_RE.test(title)) matchedSenior = true;
    }

    // High job-level suffix (L5+) — only remaining numeric pattern
    if (!matchedSenior) {
        if (SENIOR_LLEVEL_PATTERN.test(title)) matchedSenior = true;
    }

    if (!matchedSenior) return false;

    // AGG-7: Check entry-level guards — if any match, this is NOT a senior title
    for (const guard of ENTRY_LEVEL_GUARDS) {
        if (guard.test(title)) {
            return false;
        }
    }

    // 2026-06-19: rotational/development/leadership programs are new-grad even with a
    // senior-sounding industry-manager title.
    if (ROTATIONAL_GUARD.test(title)) {
        return false;
    }

    return true;
}

/**
 * @param {RegExp[]} patterns - Ordered regex patterns to apply
 * @returns {number|null} - Years of experience required, or null if not found
 */
function extractYearsOfExperience(text, patterns) {
    if (!text || typeof text !== 'string') {
        return null;
    }

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;
        if (match[2]) {
            return parseInt(match[1], 10);
        }
        return parseInt(match[1], 10);
    }

    return null;
}

/**
 * Check if job requires senior-level experience
 * @param {Object} job - Job object
 * @returns {boolean} - True if job requires 5+ years experience
 */
function requiresSeniorExperience(job) {
    const titleYears = extractYearsOfExperience(job.title || '', TITLE_EXPERIENCE_PATTERNS);
    if (titleYears !== null && titleYears >= MIN_SENIOR_YEARS) {
        return true;
    }

    // Check description for experience indicators (threshold: 7 years)
    // Description matches must explicitly mention experience so company blurbs
    // like "best employer for the past 8 years" do not trip the filter.
    // Range matches use the minimum years value; "5–8 years of experience"
    // stays below the senior threshold instead of being misread as 8 years.
    const descYears = extractYearsOfExperience(job.description || '', DESCRIPTION_EXPERIENCE_PATTERNS);
    if (descYears !== null && descYears >= MIN_SENIOR_YEARS_DESC) {
        return true;
    }

    return false;
}

/**
 * Determine if job is senior-level
 * @param {Object} job - Job object to check
 * @returns {boolean} - True if job is senior-level (should be filtered)
 */
function isSeniorJob(job) {
    // Check 1: Senior title keywords
    if (hasSeniorTitle(job.title)) {
        return true;
    }

    // Check 2: Experience requirements
    if (requiresSeniorExperience(job)) {
        return true;
    }

    // Default: Not senior (include the job)
    return false;
}

/**
 * Filter senior jobs from a batch
 * @param {Array} jobs - Array of job objects
 * @param {Map} [companyOverrideMap] - AGG-36: Map<companyName, overrideRules> from buildCompanyOverrideMap
 * @returns {Object} - { entryLevelJobs, seniorJobs, metrics }
 */
function filterSeniorJobs(jobs, companyOverrideMap) {
    const entryLevelJobs = [];
    const seniorJobs = [];

    const metrics = {
        total_input: jobs.length,
        entry_level_jobs: 0,
        senior_jobs: 0,
        override_applied: 0,
        senior_reasons: {
            senior_title: 0,
            senior_experience: 0,
            both: 0
        }
    };

    for (const job of jobs) {
        // Internship-tagged jobs are exempt from senior filtering.
        // The pipeline runs senior filter (Step 4) before tagging (Step 5), so we use the
        // pre-tagged employment hint if available, otherwise check title directly.
        // This prevents intern jobs with experience language ("team with 7+ years") from being dropped.
        const isInternship = job._employmentTag === 'internship' ||
            /\b(intern|internship|co-op|coop)\b/i.test(job.title || '');
        if (isInternship) {
            metrics.entry_level_jobs++;
            entryLevelJobs.push(job);
            continue;
        }

        // AGG-36: Check per-company override BEFORE global keyword check.
        // If a company-specific pattern matches, use that result instead of global rules.
        const overrideResult = checkCompanyOverride(job.title, job.company_name, companyOverrideMap);
        if (overrideResult !== null) {
            if (overrideResult === 'entry_level') {
                metrics.entry_level_jobs++;
                metrics.override_applied++;
                entryLevelJobs.push(job);
                continue;
            }
            // If override says 'senior', let it fall through to be filtered below
        }

        const hasSeniorTitleFlag = hasSeniorTitle(job.title);
        const requiresSeniorExp = requiresSeniorExperience(job);

        if (hasSeniorTitleFlag || requiresSeniorExp) {
            // Track reason for filtering
            if (hasSeniorTitleFlag && requiresSeniorExp) {
                metrics.senior_reasons.both++;
            } else if (hasSeniorTitleFlag) {
                metrics.senior_reasons.senior_title++;
            } else {
                metrics.senior_reasons.senior_experience++;
            }

            metrics.senior_jobs++;
            const filterReason = hasSeniorTitleFlag && requiresSeniorExp ? 'both' :
                       hasSeniorTitleFlag ? 'senior_title' : 'senior_experience';
            seniorJobs.push({ ...job, _filter_reason: filterReason });
        } else {
            metrics.entry_level_jobs++;
            entryLevelJobs.push(job);
        }
    }

    return {
        entryLevelJobs,
        seniorJobs,
        metrics
    };
}

/**
 * Print senior filter summary to console
 * @param {Object} metrics - Filter metrics
 */
function printSeniorFilterSummary(metrics) {
    console.log('📊 Senior Filter Summary:');
    console.log('━'.repeat(60));
    console.log(`Input jobs: ${metrics.total_input}`);
    console.log(`Entry-level jobs: ${metrics.entry_level_jobs} (${((metrics.entry_level_jobs / metrics.total_input) * 100).toFixed(1)}%)`);
    console.log(`Senior jobs filtered: ${metrics.senior_jobs} (${((metrics.senior_jobs / metrics.total_input) * 100).toFixed(1)}%)`);
    console.log('');

    if (metrics.senior_jobs > 0) {
        console.log('Senior job breakdown:');
        if (metrics.senior_reasons.senior_title > 0) {
            console.log(`  Senior title keywords: ${metrics.senior_reasons.senior_title}`);
        }
        if (metrics.senior_reasons.senior_experience > 0) {
            console.log(`  Senior experience required: ${metrics.senior_reasons.senior_experience}`);
        }
        if (metrics.senior_reasons.both > 0) {
            console.log(`  Both title + experience: ${metrics.senior_reasons.both}`);
        }
    }
}

module.exports = {
    isSeniorJob,
    hasSeniorTitle,
    requiresSeniorExperience,
    filterSeniorJobs,
    printSeniorFilterSummary,
    buildCompanyOverrideMap,
    checkCompanyOverride,

    // Export for testing
    SENIOR_KEYWORDS,
    SENIOR_MANAGER_RE,
    MIN_SENIOR_YEARS,
    MIN_SENIOR_YEARS_DESC
};
