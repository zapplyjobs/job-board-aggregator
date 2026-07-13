/**
 * Salary normalization helper — AGG-SALARY-EXTRACT-1.
 *
 * Converts ATS-provided compensation data into the flat, annual-normalized
 * { salaryMin, salaryMax, salaryCurrency } shape that downstream consumers
 * (app.zapply.jobs, sjd API, zappy API) expect.
 *
 * Why annual: the Supabase `jobs.salary_min/salary_max` columns + the zappy API
 * `salaryMin/salaryMax` fields are annual USD-equivalent numbers (e.g. 200400).
 * The dev-team Gemini extractor also normalizes to annual (×2080 for hourly).
 * AGG matches that unit so producer truth and inferred truth are comparable.
 *
 * Two input shapes are handled:
 *   1. Structured object { min, max, currency, interval } — ashby compensationTierSummary,
 *      lever salaryRange.
 *   2. Free-text string — ashby detail '$200K - $260K' (a fallback format).
 *
 * The existing nested `salary` field (read by aggregator-consumer.js) is preserved
 * by the callers; this helper only produces the flat consumer-API fields.
 */

// Multipliers to convert a per-period amount to an annual figure.
// Keys are normalized (lowercase, non-alphanumerics stripped) on lookup so both
// 'hourly' and lever's 'per-hour-wage' / ashby's 'YEARLY' resolve correctly.
const INTERVAL_TO_ANNUAL = {
    yearly: 1, annual: 1, annually: 1, year: 1, peryearsalary: 1, peryear: 1,
    monthly: 12, month: 12, permonthsalary: 12, permonth: 12,
    weekly: 52, week: 52, perweek: 52, biweekly: 26, semimonthly: 24,
    daily: 260, day: 260,
    hourly: 2080, hour: 2080, perhourwage: 2080, perhour: 2080,
};

function intervalMultiplier(interval) {
    if (!interval) return 1; // assume annual when unspecified
    const key = String(interval).toLowerCase().replace(/[^a-z0-9]/g, '');
    return INTERVAL_TO_ANNUAL[key] ?? 1;
}

/**
 * Normalize a structured compensation object to flat annual fields.
 * @param {{min?:number,max?:number,currency?:string,interval?:string}|null} comp
 * @returns {{salaryMin:number|null,salaryMax:number|null,salaryCurrency:string|null}}
 */
function fromObject(comp) {
    if (!comp || typeof comp !== 'object') return empties();
    const mult = intervalMultiplier(comp.interval);
    const min = toAnnualNumber(comp.min, mult);
    const max = toAnnualNumber(comp.max, mult);
    // If only one bound is present, mirror it (single-figure salary).
    const salaryMin = min ?? max;
    const salaryMax = max ?? min;
    if (salaryMin == null && salaryMax == null) return empties();
    return {
        salaryMin,
        salaryMax,
        salaryCurrency: normalizeCurrency(comp.currency),
    };
}

/**
 * Parse a free-text salary string (ashby detail fallback) to flat annual fields.
 * Handles: '$200K - $260K', '$100,000 - $120,000', '$50/hr', '$90,000', '€60k-80k'.
 * @param {string|null} text
 * @returns {{salaryMin:number|null,salaryMax:number|null,salaryCurrency:string|null}}
 */
function fromString(text) {
    if (!text || typeof text !== 'string') return empties();
    const currency = detectCurrency(text);
    const hourly = /\/\s*hr\b|per\s+hour/i.test(text);

    // Capture every "<number>[K|M]?" token, tolerating commas and decimals.
    const tokens = text.match(/(\d[\d,]*\.?\d*)\s*([KkMm])?/g);
    if (!tokens || tokens.length === 0) return empties();

    const nums = tokens.map(t => {
        const m = t.match(/([\d,]+(?:\.\d+)?)\s*([KkMm])?/);
        if (!m) return null;
        let n = parseFloat(m[1].replace(/,/g, ''));
        if (!Number.isFinite(n)) return null;
        const suffix = m[2] && m[2].toLowerCase();
        if (suffix === 'k') n *= 1000;
        else if (suffix === 'm') n *= 1000000;
        return n;
    }).filter(Number.isFinite);

    if (nums.length === 0) return empties();

    const mult = hourly ? 2080 : 1;
    const salaryMin = Math.round(Math.min(...nums) * mult);
    const salaryMax = Math.round(Math.max(...nums) * mult);
    if (!Number.isFinite(salaryMin) || !Number.isFinite(salaryMax)) return empties();
    return { salaryMin, salaryMax, salaryCurrency: currency };
}

/**
 * Unified entry point: accept either a structured object or a string.
 * @returns {{salaryMin:number|null,salaryMax:number|null,salaryCurrency:string|null}}
 */
function normalizeSalary(input) {
    if (input == null) return empties();
    if (typeof input === 'string') return fromString(input);
    if (typeof input === 'object') return fromObject(input);
    return empties();
}

function toAnnualNumber(value, mult) {
    const n = typeof value === 'string' ? parseFloat(value.replace(/[^0-9.]/g, '')) : Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * mult);
}

function normalizeCurrency(currency) {
    if (!currency) return null;
    const c = String(currency).trim().toUpperCase();
    if (!c) return null;
    // Map common symbols/codes to ISO 4217.
    if (c === '$' || c === 'USD' || c === 'US$') return 'USD';
    if (c === '€' || c === 'EUR') return 'EUR';
    if (c === '£' || c === 'GBP') return 'GBP';
    if (c === 'C$' || c === 'CAD') return 'CAD';
    if (c.length === 3) return c; // already ISO-like
    return c;
}

function detectCurrency(text) {
    if (/€/.test(text)) return 'EUR';
    if (/£/.test(text)) return 'GBP';
    if (/C\$|CAD/i.test(text)) return 'CAD';
    return 'USD'; // default; ashby/lever are predominantly USD
}

function empties() {
    return { salaryMin: null, salaryMax: null, salaryCurrency: null };
}

module.exports = { normalizeSalary, fromObject, fromString };
