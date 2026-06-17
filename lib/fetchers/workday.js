/**
 * Workday Job Board API Client
 *
 * Fetches jobs from Workday's public career site API.
 * No authentication required — this is the same endpoint career site browsers call.
 *
 * URL pattern: https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
 * Method: POST
 * Body: { "limit": 20, "offset": 0 }
 * Response: { "total": N, "jobPostings": [...], "facets": [...] }
 *
 * Each job in jobPostings has: title, externalPath, locationsText, postedOn, bulletFields
 * Apply URL: https://{tenant}.wd{N}.myworkdayjobs.com{externalPath}
 *
 * Schema verified 2026-02-28 against Salesforce (1,311 jobs) and CrowdStrike (627 jobs).
 * Note: facet IDs (workerSubType, country) differ per tenant — do not hardcode.
 */

'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const PAGE_SIZE = 20;
const MAX_JOBS = 500;  // Cap per tenant to avoid runaway pagination
const UNCHANGED_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UNCHANGED_REFRESH_BATCH_SIZE = 25;

/**
 * Make a POST request to a Workday jobs endpoint.
 * @param {string} url
 * @param {Object} body
 * @returns {Promise<{status: number, data: Object}|null>}
 */
function postJson(url, body) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'User-Agent': 'Mozilla/5.0 (compatible; job-board-bot/1.0)',
            }
        };

        const req = https.request(url, options, (res) => {
            let d = '';
            res.on('data', chunk => d += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(d) });
                } catch (_) {
                    resolve({ status: res.statusCode, data: null });
                }
            });
        });

        req.setTimeout(15000, () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(payload);
        req.end();
    });
}

// US state abbreviations set — used by slug-based US detection
const US_STATE_ABBRS = new Set([
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY',
    'LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND',
    'OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
]);

// State abbreviations that collide with ISO 3166-1 alpha-2 country codes.
// When matched, require additional US evidence (US city, state name, or US keyword).
// AGG-WD-1: IN=India/Indiana, DE=Germany/Delaware.
const AMBIGUOUS_STATE_ABBRS = new Set(['IN', 'DE']);

// Full state names (lowercase, hyphenated as they appear in URL slugs)
const US_STATE_NAMES_SLUG = new Set([
    'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware',
    'florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky',
    'louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi',
    'missouri','montana','nebraska','nevada','new-hampshire','new-jersey','new-mexico',
    'new-york','north-carolina','north-dakota','ohio','oklahoma','oregon','pennsylvania',
    'rhode-island','south-carolina','south-dakota','tennessee','texas','utah','vermont',
    'virginia','washington','west-virginia','wisconsin','wyoming','district-of-columbia',
]);

// Known US cities as they appear in Workday URL slugs (lowercase, hyphenated)
const US_CITIES_SLUG = new Set([
    // Major metros
    'new-york','los-angeles','chicago','houston','phoenix','philadelphia','san-antonio',
    'san-diego','dallas','san-jose','austin','jacksonville','fort-worth','columbus',
    'charlotte','indianapolis','seattle','denver','boston','nashville','portland',
    'las-vegas','memphis','louisville','baltimore','milwaukee','albuquerque','tucson',
    'fresno','sacramento','mesa','kansas-city','atlanta','omaha','colorado-springs',
    'raleigh','long-beach','virginia-beach','minneapolis','tampa','new-orleans','arlington',
    'wichita','bakersfield','aurora','anaheim','santa-ana','corpus-christi','riverside',
    'st-louis','lexington','pittsburgh','anchorage','stockton','cincinnati','st-paul',
    'greensboro','toledo','newark','plano','henderson','lincoln','buffalo','fort-wayne',
    'jersey-city','chula-vista','orlando','st-petersburg','norfolk','chandler','laredo',
    'madison','durham','lubbock','winston-salem','garland','glendale','hialeah','reno',
    'baton-rouge','irvine','chesapeake','scottsdale','north-las-vegas','fremont','gilbert',
    'san-bernardino','birmingham','rochester','richmond','spokane','des-moines','montgomery',
    // Tech hubs / defense corridors
    'mclean','tysons','bethesda','herndon','reston','redmond','bellevue','mountain-view',
    'sunnyvale','santa-clara','cupertino','menlo-park','palo-alto','san-francisco',
    'brooklyn','manhattan','cambridge','ann-arbor','boulder','salt-lake-city',
    'san-ramon','foster-city','santa-monica','el-segundo','torrance','thousand-oaks',
    'princeton','parsippany','florham-park','hackensack','morristown',
    // Additional cities seen in Workday slugs for current tenants
    'lehi','waltham','peoria','mossville','lafayette','hopkinsville','franklin',
    'lebanon','providence','bonita','spring','woodlands','plano','irving',
    'kirkwood','saint-louis','fenton','chesterfield',
    // GE Aerospace multi-location postings expose these US cities without state.
    'dayton','evendale','grand-rapids',
]);

// URL keywords that confirm US location
const US_SLUG_KEYWORDS = ['teleworker', 'telework', 'remote-us', 'remote---us', 'usa'];

/**
 * Detect US location from a Workday job URL slug.
 * Used when locationsText is "N Locations" (multi-location posting).
 *
 * Strategy: US-positive only — tag `us` only when positive evidence found.
 * Never tag ambiguous slugs; leave them untagged (correct for bare "Remote", foreign cities, etc.)
 *
 * @param {string} applyUrl - Full Workday job URL
 * @returns {boolean} true if URL slug contains positive US evidence
 */
function extractUSFromWorkdaySlug(applyUrl) {
    if (!applyUrl) return false;

    // Extract slug: /job/{slug}/Title_ID
    const slugMatch = applyUrl.match(/\/job\/([^/]+)\//);
    if (!slugMatch) return false;

    const slug = slugMatch[1];
    const slugLower = slug.toLowerCase();

    // 1. State abbreviation pattern: -XX- or -XX at end (e.g. "McLean-VA", "Space-Coast-FL")
    // AGG-WD-1: Ambiguous codes (IN=India, DE=Germany) are country codes when they are
    // the FIRST segment of the slug (e.g. "IN-TG-HYDERABAD", "DE-BY-MUNICH").
    // When they appear after other content (e.g. "Wilmington-DE"), they're US state abbreviations.
    const firstSegment = slug.split('-')[0];
    const stateAbbrMatches = slug.match(/-([A-Z]{2})(?:-|$)/g) || [];
    for (const m of stateAbbrMatches) {
        const abbr = m.replace(/-/g, '');
        if (US_STATE_ABBRS.has(abbr)) {
            if (AMBIGUOUS_STATE_ABBRS.has(abbr) && abbr === firstSegment) continue;
            return true;
        }
    }

    // 2. Embedded state abbr without separator (e.g. "GloucesterMA", "Home--MobileTX-001")
    const embeddedMatch = slug.match(/[a-z]([A-Z]{2})(?:\d|$|-)/);
    if (embeddedMatch && US_STATE_ABBRS.has(embeddedMatch[1])) {
        // Embedded match is preceded by lowercase — can't be a leading country code
        return true;
    }

    // 3. Full state name (hyphenated, e.g. "Mossville-Illinois", "Irving-Texas")
    for (const stateName of US_STATE_NAMES_SLUG) {
        if (slugLower.includes(stateName)) return true;
    }

    // 4. Known US city (e.g. "San-Jose", "Waltham", "Lehi")
    for (const city of US_CITIES_SLUG) {
        if (slugLower.includes(city)) return true;
    }

    // 5. US keywords (e.g. "RemoteTeleworker-US", "USAMOKirkwood")
    for (const kw of US_SLUG_KEYWORDS) {
        if (slugLower.includes(kw)) return true;
    }

    return false;
}

// US state name → 2-letter abbreviation map (used by location parser below)
const US_STATE_ABBR = {
    'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR',
    'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
    'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID',
    'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS',
    'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
    'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS',
    'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV',
    'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
    'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK',
    'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
    'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT',
    'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV',
    'Wisconsin': 'WI', 'Wyoming': 'WY', 'District of Columbia': 'DC',
};

/**
 * Parse a Workday locationsText into structured city/state fields.
 *
 * Formats seen in the wild (verified 2026-02-28):
 *   "California - San Francisco"   (Salesforce) → state dash city
 *   "USA - New York, NY"           (CrowdStrike) → USA prefix + City, ST
 *   "USA - Sunnyvale, CA"          (CrowdStrike) → same
 *   "London, United Kingdom"       (Zendesk) → city comma country
 *   "Remote, United Kingdom"       (Zendesk) → remote comma country
 *   "India - Bangalore"            → non-US dash format
 *   "3 Locations"                  → multi-location, no specific city
 *   "Remote"                       → fully remote
 *
 * @param {string} locationsText
 * @param {string} [applyUrl] - Job URL used to extract US location from slug when N Locations
 * @returns {{ job_city: string, job_state: string, location: string, is_us_only?: boolean }}
 */
function parseWorkdayLocation(locationsText, applyUrl) {
    if (!locationsText) return { job_city: '', job_state: '', location: '' };

    // Strip Workday site-code suffix e.g. "Allen, TX (TX139)" → "Allen, TX" (WD-F8)
    const raw = locationsText.trim().replace(/\s*\([^)]+\)\s*$/, '').trim();

    // Pipe-delimited address formats (Saint Luke's Health System):
    //   4-seg: "FacilityName | StreetAddress | City | ST" → city[2], state[3]
    //   3-seg: "County | City | ST"                       → city[1], state[2] (only if state is 2-letter abbr)
    const pipeSegments = raw.split(/\s*\|\s*/);
    if (pipeSegments.length === 4) {
        const city = pipeSegments[2].trim();
        const state = pipeSegments[3].trim();
        return { job_city: city, job_state: state, location: raw };
    }
    if (pipeSegments.length === 3 && /^[A-Z]{2}$/.test(pipeSegments[2].trim())) {
        const city = pipeSegments[1].trim();
        const state = pipeSegments[2].trim();
        return { job_city: city, job_state: state, location: raw };
    }

    // "N Locations" — multiple offices. Extract primary city from URL path.
    // WD URL structure: .../job/{City-State-or-Descriptor}/{slug}
    // S262: instead of showing "4 Locations", show "City, ST + N more"
    if (/^\d+ locations?$/i.test(raw)) {
        const isUs = applyUrl ? extractUSFromWorkdaySlug(applyUrl) : false;
        let city = '', state = '';
        if (applyUrl) {
            const jobPathMatch = applyUrl.match(/\/job\/([^/]+)\//);
            if (jobPathMatch) {
                const pathLoc = jobPathMatch[1].replace(/-/g, ' ').trim();
                // Try to extract "City StateAbbr" from path like "USA   Berkeley MO" or "San Antonio Home Office I"
                // Remove common non-location words
                const cleaned = pathLoc
                    .replace(/\b(USA|Home Office|Remote|Office|HQ|Corporate|Campus)\b/gi, '')
                    .replace(/\b[IVX]+$/i, '')  // Roman numeral suffixes
                    .replace(/\s+/g, ' ').trim();
                // Check if ends with 2-letter state abbr
                const stateMatch = cleaned.match(/^(.+?)\s+([A-Z]{2})$/);
                const validAbbrs = new Set(Object.values(US_STATE_ABBR));
                if (stateMatch && validAbbrs.has(stateMatch[2])) {
                    city = stateMatch[1].trim();
                    state = stateMatch[2];
                } else if (cleaned.length > 2 && cleaned.length < 30) {
                    city = cleaned;
                }
            }
        }
        const locNum = parseInt(raw);
        const displayLoc = city ? `${city}${state ? ', ' + state : ''} + ${locNum - 1} more` : raw;
        return { job_city: city, job_state: state, location: displayLoc, ...(isUs && { is_us_only: true }) };
    }

    // "Remote" (bare) — fully remote, no city
    if (/^remote$/i.test(raw)) {
        return { job_city: '', job_state: '', location: 'Remote' };
    }

    // "USA - City, ST" format (e.g. CrowdStrike: "USA - New York, NY", "USA - Sunnyvale, CA")
    const usaDashMatch = raw.match(/^USA\s*-\s*(.+)$/i);
    if (usaDashMatch) {
        const rest = usaDashMatch[1].trim();
        // "City, ST" → split on last comma
        const commaIdx = rest.lastIndexOf(',');
        if (commaIdx !== -1) {
            const city = rest.slice(0, commaIdx).trim();
            const stateRaw = rest.slice(commaIdx + 1).trim();
            // stateRaw should be a 2-letter abbr already (e.g. "NY", "CA")
            if (/^[A-Z]{2}$/.test(stateRaw)) {
                return { job_city: city, job_state: stateRaw, location: raw };
            }
        }
        // No comma — just a city name after USA -
        return { job_city: rest, job_state: '', location: raw };
    }

    // S268A: "ST-CITY[-CODE|, Fullname]" format — RTX/Raytheon/Arrow WD internal codes.
    // Examples: "MD-FULTON-8170", "MA-WOBURN-WB1", "TX-HOUSTON-575 N. Dairy Ashford",
    //           "AZ-Phoenix, Arizona" (full state name suffix), "DC-Washington"
    // First segment: 2-letter state abbr. Second: city name.
    // Suffix variants (all discarded): site code, address, full state name.
    const stCityMatch = raw.match(/^([A-Z]{2})-([A-Za-z][A-Za-z .'-]*?)(?:,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*|-[A-Z0-9]+(?:\s.*)?|\s+\d.*|\s*$)/);
    if (stCityMatch && US_STATE_ABBRS.has(stCityMatch[1])) {
        const stateAbbr = stCityMatch[1];
        let city = stCityMatch[2].trim();
        // Title Case uppercase cities, preserve mixed case (e.g. "Middleburg Hts.")
        if (city === city.toUpperCase()) {
            city = city.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
        }
        // Handle "REMOTE" as city → just state-level remote
        if (city.toLowerCase() === 'remote') {
            return { job_city: '', job_state: stateAbbr, location: `Remote, ${stateAbbr}` };
        }
        return { job_city: city, job_state: stateAbbr, location: `${city}, ${stateAbbr}` };
    }

    // AGG-LOC-5: Street address with city,state+zip — Target, Walmart, etc.
    // "875 Beta Dr SW, Albany,OR 97321-3714" → city=Albany, state=OR
    // "16600 Highlands Center BLVD, Bristol, VA 24202-4301" → city=Bristol, state=VA
    const addrMatch = raw.match(/,\s*([A-Za-z][A-Za-z\s.]+?)\s*,\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\s*$/);
    if (addrMatch && US_STATE_ABBRS.has(addrMatch[2])) {
        const city = addrMatch[1].trim();
        const state = addrMatch[2];
        return { job_city: city, job_state: state, location: `${city}, ${state}` };
    }

    // "State - City" format (e.g. Salesforce: "California - San Francisco")
    const dashMatch = raw.match(/^([^-]+?)\s*-\s*(.+)$/);
    if (dashMatch) {
        const statePart = dashMatch[1].trim();
        const cityPart = dashMatch[2].trim();

        const stateAbbr = US_STATE_ABBR[statePart];
        if (stateAbbr) {
            // Strip "Metro - Remote", "- Remote", "CW Only" suffixes from city
            let city = cityPart.replace(/\s*[-–]\s*(remote|metro.*|cw only.*)$/i, '').trim();
            // S262: Clean WD internal format ("DULLES-760 ~ 22260 Pacific Blvd ~ BLDG 60" → "Dulles")
            if (city.includes('~')) {
                city = city.split('~')[0].trim()
                    .replace(/-\d+$/, '').trim()  // remove site code suffix ("DULLES-760" → "DULLES")
                    .toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); // Title Case each word
            }
            return { job_city: city, job_state: stateAbbr, location: raw };
        }

        // Non-US: "India - Bangalore", "Japan - Tokyo" → city only, no state
        return { job_city: cityPart, job_state: '', location: raw };
    }

    // "City, Country" format (e.g. Zendesk: "London, United Kingdom", "Lisbon, Portugal")
    // Also "Remote, Country" — treat city as empty for remote
    const commaMatch = raw.match(/^(.+?),\s*(.+)$/);
    if (commaMatch) {
        const cityPart = commaMatch[1].trim();
        if (/^remote$/i.test(cityPart)) {
            return { job_city: '', job_state: '', location: raw };
        }
        return { job_city: cityPart, job_state: '', location: raw };
    }

    return { job_city: '', job_state: '', location: raw };
}

/**
 * Normalize a raw Workday jobPosting to common job schema.
 * @param {Object} posting - Raw jobPosting from Workday API
 * @param {string} baseUrl - e.g. "https://salesforce.wd12.myworkdayjobs.com"
 * @param {string} tenantName - Human name e.g. "Salesforce"
 * @returns {Object} Normalized job object
 */
function normalizeWorkdayJob(posting, baseUrl, tenantName, site) {
    // Workday's externalPath is like "/job/California---San-Francisco/Software-Engineer_JR12345"
    // The career page URL requires /{site} between the base and externalPath.
    // Without it, Workday returns 404 — the site segment is mandatory in the public URL.
    const applyUrl = posting.externalPath ? `${baseUrl}/${site}${posting.externalPath}` : null;

    const { job_city, job_state, location, is_us_only: slugUsOnly } = parseWorkdayLocation(posting.locationsText, applyUrl);

    // Extract requisition ID: use bulletFields[0] if it looks like a real req ID,
    // otherwise fall back to URL extraction (always reliable) — WD-ID-BUG fix
    const rawReqId = (posting.bulletFields && posting.bulletFields[0]) || null;
    const reqId = isValidReqId(rawReqId)
        ? rawReqId
        : extractReqIdFromExternalPath(posting.externalPath);

    // Build a stable ID: workday-{tenantKey}-{reqId or slugged title}
    const tenantKey = tenantName.toLowerCase().replace(/\s+/g, '-');
    const idSuffix = reqId || slugify(posting.title || 'unknown');
    const jobId = `workday-${tenantKey}-${idSuffix}`;

    // postedOn values: "Posted Today", "Posted N Days Ago", "Posted + 30 Days Ago"
    const postedAt = parsePostedOn(posting.postedOn);

    return {
        // Core fields
        id: jobId,
        source: 'workday',
        source_url: baseUrl,
        source_id: reqId || idSuffix,

        // Job details
        title: posting.title ? posting.title.replace(/\|/g, ' ').trim() : null,
        company_name: tenantName,
        company_slug: tenantKey,

        // Location
        location: location,
        locations: [location],
        job_city,
        job_state,
        // slug-based US detection for N-Locations postings (WD-F6/F7)
        ...(slugUsOnly && { is_us_only: true }),

        // URL
        url: applyUrl,
        apply_url: applyUrl,
        wd_path: posting.externalPath || null,

        // Metadata
        departments: [],
        employment_type: null,  // not in listing response — tag-engine infers downstream

        // Dates — if postedOn was unrecognized (null), use fetched_at as fallback
        // so the job gets a natural TTL expiry instead of being immortal.
        posted_at: postedAt || new Date().toISOString(),
        fetched_at: new Date().toISOString(),

        // Description fetched separately — see workday-descriptions.js
        description: null,

        _raw: {
            source: 'workday',
            externalPath: posting.externalPath,
            baseUrl,
            site,
            reqId,
        }
    };
}

function slugify(str) {
    return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

/**
 * Check if a value from bulletFields[0] looks like a real Workday req ID.
 * Some tenants return facet indices, employment type labels, or location strings instead.
 * @param {string|null} val
 * @returns {boolean}
 */
function isValidReqId(val) {
    if (!val) return false;
    // Single or double digit = workerSubType facet index (F5 returns '0', '1')
    if (/^\d{1,2}$/.test(val)) return false;
    // Employment type labels (Sharp Healthcare returns these)
    if (['Regular', 'Per Diem', 'Full Time', 'Part Time', 'Intern', 'Contractor', 'Temporary'].includes(val)) return false;
    // Location strings contain comma or parenthesis (Motorola returns these)
    if (val.includes(',') || val.includes('(')) return false;
    // AGG-11b: Location strings contain spaces (Motorola "Brazil Remote Work",
    // Intel "Spotlight Job", Corpay "Malta Avenue 77"). Real req IDs are
    // alphanumeric codes (R0118991, JR-02457707) — never have spaces.
    if (val.includes(' ')) return false;
    return true;
}

/**
 * Extract requisition ID from Workday externalPath URL.
 * Pattern: /{site}/job/{location}/{title}_{REQID}[-N]
 * The req ID is always after the last underscore in the final path segment.
 * Trailing -1 or -2 version suffix is stripped (1-2 digits only — NOT R-100959 style).
 * @param {string|null} externalPath
 * @returns {string|null}
 */
function extractReqIdFromExternalPath(externalPath) {
    if (!externalPath) return null;
    const tail = externalPath.split('/').pop();
    const idx = tail.lastIndexOf('_');
    if (idx === -1) return null;
    const reqPart = tail.slice(idx + 1).replace(/-\d{1,2}$/, '');
    return reqPart || null;
}

/**
 * Recover Workday externalPath from a stored apply URL.
 * Handles locale-prefixed paths like /en-US/{site}/job/... and plain /{site}/job/...
 * @param {string|null} applyUrl
 * @returns {string|null}
 */
function deriveExternalPathFromApplyUrl(applyUrl) {
    if (!applyUrl) return null;
    try {
        const parsed = new URL(applyUrl);
        const parts = parsed.pathname.split('/').filter(Boolean);
        const jobIdx = parts.indexOf('job');
        if (jobIdx === -1) return null;
        const start = (jobIdx > 0 && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(parts[jobIdx - 1])) ? jobIdx - 1 : jobIdx;
        return '/' + parts.slice(start).join('/');
    } catch (_) {
        return null;
    }
}


/**
 * Parse Workday's relative date strings into ISO dates.
 * "Posted Today" → today, "Posted 3 Days Ago" → 3 days ago, "Posted + 30 Days Ago" → 30+ days ago
 */
function parseWorkdayUrlConfig(rawUrl, site, explicitTenant) {
    const url = rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`;
    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const localePrefix = parts.length > 0 && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(parts[0]) ? `/${parts[0]}` : '';
    const tenantSlug = explicitTenant || (parsed.hostname.includes('myworkdaysite.com') ? null : parsed.hostname.split('.')[0]);
    const apiEndpoint = tenantSlug ? `${origin}/wday/cxs/${tenantSlug}/${site}/jobs` : null;
    const publicBaseUrl = `${origin}${localePrefix}`;
    return { url, origin, localePrefix, tenantSlug, apiEndpoint, publicBaseUrl };
}

function parsePostedOn(postedOn) {
    if (!postedOn) return null;
    const now = new Date();

    const todayMatch = postedOn.match(/today/i);
    if (todayMatch) return now.toISOString();

    // "Posted 3 Days Ago" or "Posted 30+ Days Ago" — the \+? handles the trailing + variant
    const daysMatch = postedOn.match(/(\d+)\+?\s*days?\s*ago/i);
    if (daysMatch) {
        const days = parseInt(daysMatch[1], 10);
        const date = new Date(now);
        date.setDate(date.getDate() - days);
        return date.toISOString();
    }

    // Unrecognized format — return null so formatTimeAgo displays 'Recently'
    return null;
}

/**
 * Fetch all jobs from a single Workday tenant.
 * Paginates until all jobs fetched or MAX_JOBS cap reached.
 *
 * @param {Object} tenant - { name, url, site, us_only?, tenant? } — e.g. { name: "Salesforce", url: "https://salesforce.wd12.myworkdayjobs.com", site: "External_Career_Site" }
 *   us_only: if true, stamps is_us_only=true on all jobs (for tenants with campus-name-only locations)
 *   tenant: explicit tenant override (required for myworkdaysite.com where hostname has no tenant prefix)
 * @returns {Promise<Array>} Normalized job objects
 */
async function fetchWorkdayJobs(tenant) {
    const { name, url: rawUrl, site } = tenant;
    const { url, tenantSlug, apiEndpoint, publicBaseUrl } = parseWorkdayUrlConfig(rawUrl, site, tenant.tenant);
    if (!tenantSlug || !apiEndpoint) {
        console.log(`   ⚠️ Workday: missing tenant for ${name} (myworkdaysite.com requires explicit tenant field) — skipping`);
        return { jobs: [], total: 0 };
    }
    const endpoint = apiEndpoint;

    let offset = 0;
    let total = null;
    const allPostings = [];

    while (true) {
        const result = await postJson(endpoint, { limit: PAGE_SIZE, offset });

        if (!result) {
            console.log(`   ⚠️ Workday network error: ${name}`);
            break;
        }

        if (result.status === 401 || result.status === 403) {
            console.log(`   ⚠️ Workday auth required (${result.status}): ${name} — skipping`);
            break;
        }

        if (result.status === 422) {
            console.log(`   ⚠️ Workday 422 (wrong site alias?): ${name} endpoint: ${endpoint}`);
            break;
        }

        if (result.status !== 200 || !result.data) {
            console.log(`   ⚠️ Workday error ${result.status}: ${name}`);
            break;
        }

        const postings = result.data.jobPostings || [];
        if (total === null) total = result.data.total || 0;

        allPostings.push(...postings);

        if (allPostings.length >= total || allPostings.length >= MAX_JOBS || postings.length < PAGE_SIZE) {
            break;
        }

        offset += PAGE_SIZE;

        // Polite delay between pages
        await new Promise(r => setTimeout(r, 100));
    }

    const jobs = allPostings.map(p => normalizeWorkdayJob(p, url, name, site));

    // If tenant is explicitly US-only (e.g. hospital systems with campus-name-only locations),
    // stamp is_us_only so tag-engine tags these as 'us' regardless of location string.
    if (tenant.us_only === true) {
        jobs.forEach(j => { j.is_us_only = true; });
    }

    return { jobs, total: total || 0 };
}

/**
 * Probe a WD tenant to get the current job total without full pagination.
 * AGG-SPEED-2: Sends limit=1 to get the `total` field — ~100ms per tenant.
 * @param {Object} tenant - { name, url, site, tenant? }
 * @returns {Promise<number|null>} Total job count, or null on error
 */
async function probeWorkdayTotal(tenant) {
    const { tenantSlug, apiEndpoint } = parseWorkdayUrlConfig(tenant.url, tenant.site, tenant.tenant);
    if (!tenantSlug || !apiEndpoint) return null;
    const endpoint = apiEndpoint;

    const result = await postJson(endpoint, { limit: 1, offset: 0 });
    if (!result || result.status !== 200 || !result.data) return null;
    return result.data.total || 0;
}

/**
 * Returns facet array with {id, descriptor, count} per family, [] when the
 * endpoint is healthy but exposes no jobFamilyGroup facet, or null on failure.
 * AGG-WD-DEPT-1 / AGG-PIPE-19
 */
async function getFamilyFacets(endpoint) {
    const result = await postJson(endpoint, { limit: 1, offset: 0 });
    if (!result || result.status !== 200 || !result.data) return null;
    const jfg = (result.data.facets || []).find(f => f.facetParameter === 'jobFamilyGroup');
    return jfg ? (jfg.values || []) : [];
}

/**
 * Build externalPath → familyName mapping via per-family facet queries.
 * Paginates each family to collect all externalPaths. Sequential per family,
 * but callers parallelize across tenants.
 * AGG-WD-DEPT-1
 */
async function buildFamilyPathMap(endpoint, families, deadlineMs = Infinity) {
    const pathMap = new Map();
    if (!families) return pathMap;
    for (const fam of families) {
        if (Date.now() >= deadlineMs) break;
        if (!fam.count) continue;
        let offset = 0;
        while (offset < fam.count && Date.now() < deadlineMs) {
            const result = await postJson(endpoint, {
                limit: 20, offset,
                appliedFacets: { jobFamilyGroup: [fam.id] },
            });
            if (!result || result.status !== 200 || !result.data) break;
            for (const p of (result.data.jobPostings || [])) {
                if (p.externalPath) pathMap.set(p.externalPath, fam.descriptor);
            }
            if ((result.data.jobPostings || []).length < 20) break;
            offset += 20;
        }
    }
    return pathMap;
}

/**
 * Fetch jobs from all Workday tenants.
 * AGG-SPEED-2: Incremental fetch — probes tenant totals first, skips unchanged tenants.
 * AGG-WD-DEPT-1: Post-fetch family mapping annotates departments via facet queries.
 * @param {Array<{name, url, site}>} tenants
 * @param {Object} options
 * @param {number} options.delayMs - Delay between tenants (default: 800ms)
 * @param {Object} [options.previousTotals] - { tenantName: total } from prior run (AGG-SPEED-2)
 * @returns {Promise<{jobs: Array, currentTotals: Object}>} Jobs + updated totals map
 */
async function fetchAllWorkdayJobs(tenants, options = {}) {
    const { concurrency = 15, delayMs = 200, previousTotals = null } = options;
    const allJobs = [];
    const currentTotals = {};

    const hasCache = previousTotals && Object.keys(previousTotals).length > 0;

    console.log(`::group::🔷 Workday (${tenants.length} tenants${hasCache ? ', incremental' : ', full'})`);
    console.log(`🔷 Fetching from ${tenants.length} Workday tenants (concurrency: ${concurrency})...`);

    // AGG-SPEED-2 Phase 1: Probe all tenants to get current totals
    let skippedCount = 0;
    let changedTenants = tenants;
    if (hasCache) {
        const probeStart = Date.now();
        const tenantTotals = {};
        for (let i = 0; i < tenants.length; i += concurrency) {
            const batch = tenants.slice(i, i + concurrency);
            const probes = await Promise.all(batch.map(async tenant => {
                const total = await probeWorkdayTotal(tenant);
                return { tenant, total };
            }));
            for (const { tenant, total } of probes) {
                tenantTotals[tenant.name] = total;
            }
        }
        const probeMs = Date.now() - probeStart;
        console.log(`   🔍 Probe: ${tenants.length} tenants in ${(probeMs / 1000).toFixed(1)}s`);

        // Compare with cache — always rotate a bounded batch of unchanged tenants through full fetch.
        // Total-only skipping can hide churn (one job closes, one opens, same count). We keep the
        // runtime savings of incremental mode while guaranteeing every unchanged tenant gets a fresh
        // full fetch within a bounded number of cycles.
        const refreshableUnchanged = [];
        changedTenants = [];
        const nowIso = new Date().toISOString();
        for (const t of tenants) {
            const prevEntry = previousTotals[t.name];
            const prevTotal = typeof prevEntry === 'number' ? prevEntry : prevEntry?.total;
            const prevFullFetchAt = typeof prevEntry === 'number' ? null : prevEntry?.last_full_fetch_at;
            const curr = tenantTotals[t.name];
            if (curr === null) {
                changedTenants.push(t); // probe failed — safe to full fetch
                continue;
            }
            currentTotals[t.name] = { total: curr, last_full_fetch_at: prevFullFetchAt || null };
            if (prevTotal === undefined || prevTotal !== curr) {
                changedTenants.push(t);
                continue;
            }
            refreshableUnchanged.push(t);
        }

        refreshableUnchanged.sort((a, b) => a.name.localeCompare(b.name));
        const staleRefreshTenants = [];
        if (refreshableUnchanged.length > 0) {
            const rotateBucket = Math.floor(Date.now() / (15 * 60 * 1000));
            const batchSize = Math.min(UNCHANGED_REFRESH_BATCH_SIZE, refreshableUnchanged.length);
            const startIndex = (rotateBucket * UNCHANGED_REFRESH_BATCH_SIZE) % refreshableUnchanged.length;
            for (let i = 0; i < batchSize; i++) {
                staleRefreshTenants.push(refreshableUnchanged[(startIndex + i) % refreshableUnchanged.length]);
            }
            changedTenants.push(...staleRefreshTenants);
            skippedCount = refreshableUnchanged.length - staleRefreshTenants.length;
        }

        console.log(`   ⏩ Skipped ${skippedCount} unchanged tenants, refreshing ${staleRefreshTenants.length} rotated unchanged tenants, fetching ${changedTenants.length}`);
    }

    // Phase 2: Full fetch for changed/uncached tenants
    for (let i = 0; i < changedTenants.length; i += concurrency) {
        const batch = changedTenants.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async tenant => {
            const t0 = Date.now();
            try {
                const result = await fetchWorkdayJobs(tenant);
                const ms = Date.now() - t0;
                if (result.jobs.length > 0) console.log(`   ✅ ${tenant.name}: ${result.jobs.length} jobs (${ms}ms)`);
                else console.log(`   ○ ${tenant.name}: 0 jobs (${ms}ms)`);
                currentTotals[tenant.name] = {
                    total: result.total,
                    last_full_fetch_at: new Date().toISOString(),
                };
                return result.jobs;
            } catch (err) {
                const ms = Date.now() - t0;
                console.error(`   ❌ ${tenant.name}: ${err.message} (${ms}ms)`);
                return [];
            }
        }));
        for (const jobs of results) allJobs.push(...jobs);
        if (delayMs > 0 && i + concurrency < changedTenants.length) {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }

    console.log(`   📊 Workday total: ${allJobs.length} jobs (skipped ${skippedCount}/${tenants.length} tenants)`);

    console.log('::endgroup::');
    return { jobs: allJobs, currentTotals };
}

/**
 * Annotate WD jobs with department from jobFamilyGroup facet mapping.
 * AGG-WD-DEPT-1: Extracted from fetchAllWorkdayJobs so it runs outside the ATS timeout envelope.
 * @param {Array} jobs - All WD jobs from this run
 * @param {Array} tenants - Tenant config array (for endpoint resolution)
 * @param {number} [concurrency=15] - Max parallel tenant queries (family queries capped at 5)
 * @returns {Promise<{annotated: number, total: number, durationMs: number}>}
 */
async function annotateFamilyDepartments(jobs, tenants, concurrency = 15) {
    const wdJobs = jobs.filter(j => j.source === 'workday');
    if (wdJobs.length === 0) return { annotated: 0, total: 0, durationMs: 0 };

    const familyStart = Date.now();
    const tenantMap = new Map();
    for (const t of tenants) tenantMap.set(t.name, t);

    const jobsByTenant = new Map();
    for (const job of wdJobs) {
        const key = job.company_name;
        if (!jobsByTenant.has(key)) jobsByTenant.set(key, []);
        jobsByTenant.get(key).push(job);
    }

    let annotated = 0;
    const tenantNames = [...jobsByTenant.keys()];
    const famConcurrency = Math.min(concurrency, 5);

    for (let i = 0; i < tenantNames.length; i += famConcurrency) {
        const batch = tenantNames.slice(i, i + famConcurrency);
        const results = await Promise.all(batch.map(async name => {
            const tenant = tenantMap.get(name);
            if (!tenant) return 0;

            const { tenantSlug, apiEndpoint } = parseWorkdayUrlConfig(tenant.url, tenant.site, tenant.tenant);
            if (!tenantSlug || !apiEndpoint) return 0;
            const endpoint = apiEndpoint;

            try {
                const families = await getFamilyFacets(endpoint);
                if (!families || families.length === 0) return 0;
                const pathMap = await buildFamilyPathMap(endpoint, families);

                const tenantJobs = jobsByTenant.get(name) || [];
                let count = 0;
                for (const job of tenantJobs) {
                    const rawPath = job.wd_path || deriveExternalPathFromApplyUrl(job.url) || job._raw?.externalPath;
                    if (rawPath && !job.wd_path) job.wd_path = rawPath;
                    if (rawPath && pathMap.has(rawPath)) {
                        job.departments = [pathMap.get(rawPath)];
                        count++;
                    }
                }
                return count;
            } catch (_) {
                return 0;
            }
        }));
        for (const c of results) annotated += c;
    }

    const familyMs = Date.now() - familyStart;
    console.log(`   🏷️ Family mapping: ${annotated}/${wdJobs.length} jobs in ${(familyMs / 1000).toFixed(1)}s`);
    return { annotated, total: wdJobs.length, durationMs: familyMs };
}

/**
 * Apply cached family→department mappings to WD jobs (no HTTP requests).
 * AGG-SPEED-10: Reads pre-built cache from wd-family-cache.json.
 * Falls back to live annotateFamilyDepartments if cache is missing or stale.
 * @param {Array} jobs - All jobs from this run
 * @param {Array} tenants - Tenant config array
 * @param {string} cacheDir - Directory containing wd-family-cache.json
 * @returns {Promise<{annotated: number, total: number, durationMs: number, fromCache: boolean}>}
 */
async function applyFamilyCache(jobs, tenants, cacheDir) {
    const wdJobs = jobs.filter(j => j.source === 'workday');
    if (wdJobs.length === 0) return { annotated: 0, total: 0, durationMs: 0, fromCache: false };

    const start = Date.now();
    const cachePath = path.join(cacheDir, 'wd-family-cache.json');
    const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — families change slowly

    let cache = null;
    try {
        if (fs.existsSync(cachePath)) {
            const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            const age = Date.now() - new Date(raw.generated_at).getTime();
            if (age < CACHE_TTL_MS) {
                cache = raw;
            } else {
                console.log(`   📦 Family cache expired (${(age / 3600000).toFixed(1)}h old, TTL: 6h)`);
            }
        }
    } catch (e) {
        console.log(`   📦 Family cache read error: ${e.message}`);
    }

    if (!cache || !cache.tenants) {
        console.log('   📦 No valid family cache — skipping annotation (cache will be built at Step 9c)');
        return { annotated: 0, total: wdJobs.length, durationMs: Date.now() - start, fromCache: false };
    }

    // Build tenant lookup
    const tenantMap = new Map();
    for (const t of tenants) tenantMap.set(t.name, t);

    // Group WD jobs by tenant
    const jobsByTenant = new Map();
    for (const job of wdJobs) {
        const key = job.company_name;
        if (!jobsByTenant.has(key)) jobsByTenant.set(key, []);
        jobsByTenant.get(key).push(job);
    }

    let annotated = 0;
    let tenantsFromCache = 0;
    let tenantsMissing = 0;

    for (const [tenantName, tenantJobs] of jobsByTenant) {
        const cached = cache.tenants[tenantName];
        if (!cached || !cached.pathMap) {
            tenantsMissing++;
            continue;
        }
        tenantsFromCache++;
        const pathMap = cached.pathMap;
        for (const job of tenantJobs) {
            const rawPath = job.wd_path || deriveExternalPathFromApplyUrl(job.url) || job._raw?.externalPath;
            if (rawPath && !job.wd_path) job.wd_path = rawPath;
            if (rawPath && pathMap[rawPath]) {
                job.departments = [pathMap[rawPath]];
                annotated++;
            }
        }
    }

    const durationMs = Date.now() - start;
    console.log(`   📦 Family cache: ${annotated}/${wdJobs.length} annotated from cache (${tenantsFromCache} tenants, ${tenantsMissing} not cached) in ${(durationMs / 1000).toFixed(1)}s`);
    return { annotated, total: wdJobs.length, durationMs, fromCache: true };
}

/**
 * Build or refresh the WD family→department cache file.
 * AGG-SPEED-10: Makes HTTP requests to build pathMap per tenant, saves to wd-family-cache.json.
 * Called from enrichment pipeline or a separate cache-refresh step.
 * @param {Array} tenants - Tenant config array
 * @param {string} cacheDir - Directory to write wd-family-cache.json
 * @returns {Promise<{tenants: number, annotated: number, durationMs: number}>}
 */
async function buildFamilyCache(tenants, cacheDir, options = {}) {
    const start = Date.now();
    const MAX_DURATION_MS = options.maxDurationMs ?? 15 * 60 * 1000; // partial cache is better than timeout
    const cache = {
        generated_at: new Date().toISOString(),
        tenants: {},
    };

    // Load existing cache to preserve tenants that haven't changed
    const cachePath = path.join(cacheDir, 'wd-family-cache.json');
    let existingCache = null;
    try {
        if (fs.existsSync(cachePath)) {
            existingCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        }
    } catch (_) {}

    const famConcurrency = 5;
    const deadlineMs = start + MAX_DURATION_MS;
    let totalAnnotated = 0;
    let timedOut = false;

    // Prioritize tenants with current live job headroom first when the caller
    // supplies scores, then uncached tenants, then older cached tenants. This
    // keeps bounded post-publish refresh time pointed at downstream value.
    const tenantPriorityScores = options.tenantPriorityScores || {};
    const orderedTenants = [...tenants].sort((a, b) => {
        const scoreDelta = (tenantPriorityScores[b.name] || 0) - (tenantPriorityScores[a.name] || 0);
        if (scoreDelta !== 0) return scoreDelta;
        const aCached = existingCache?.tenants?.[a.name];
        const bCached = existingCache?.tenants?.[b.name];
        if (!aCached && bCached) return -1;
        if (aCached && !bCached) return 1;
        const aFetched = aCached?.fetched_at ? new Date(aCached.fetched_at).getTime() : 0;
        const bFetched = bCached?.fetched_at ? new Date(bCached.fetched_at).getTime() : 0;
        return aFetched - bFetched || a.name.localeCompare(b.name);
    });

    for (let i = 0; i < orderedTenants.length; i += famConcurrency) {
        if (Date.now() - start > MAX_DURATION_MS) {
            console.log(`   ⏱️ Family cache time budget exceeded (${((Date.now() - start) / 60000).toFixed(1)} min) — saving partial results (${Object.keys(cache.tenants).length}/${tenants.length} tenants)`);
            timedOut = true;
            break;
        }
        const batch = orderedTenants.slice(i, i + famConcurrency);
        const results = await Promise.all(batch.map(async tenant => {
            const { tenantSlug, apiEndpoint } = parseWorkdayUrlConfig(tenant.url, tenant.site, tenant.tenant);
            if (!tenantSlug || !apiEndpoint) return null;

            const endpoint = apiEndpoint;
            try {
                const families = await getFamilyFacets(endpoint);
                if (!families || Date.now() >= deadlineMs) return null;

                if (families.length === 0) {
                    return {
                        name: tenant.name,
                        data: {
                            familyCount: 0,
                            pathMap: {},
                            pathCount: 0,
                            fetched_at: new Date().toISOString(),
                        },
                    };
                }

                const pathMapObj = await buildFamilyPathMap(endpoint, families, deadlineMs);

                // Convert Map to plain object for JSON serialization
                const pathMap = {};
                for (const [k, v] of pathMapObj) pathMap[k] = v;

                const existingTenant = existingCache?.tenants?.[tenant.name];
                const deadlineReached = Date.now() >= deadlineMs;
                const useExistingPathMap = deadlineReached
                    && existingTenant?.pathMap
                    && existingTenant.pathCount > pathMapObj.size;
                const mergedPathMap = useExistingPathMap
                    ? { ...existingTenant.pathMap, ...pathMap }
                    : pathMap;

                return {
                    name: tenant.name,
                    data: {
                        familyCount: families.length,
                        pathMap: mergedPathMap,
                        pathCount: Object.keys(mergedPathMap).length,
                        fetched_at: useExistingPathMap ? existingTenant.fetched_at : new Date().toISOString(),
                    },
                };
            } catch (_) {
                return null;
            }
        }));

        for (const r of results) {
            if (r) {
                cache.tenants[r.name] = r.data;
                totalAnnotated += r.data.pathCount;
            }
        }
    }

    // Preserve tenants from existing cache that weren't re-fetched
    if (existingCache?.tenants) {
        for (const [name, data] of Object.entries(existingCache.tenants)) {
            if (!cache.tenants[name]) {
                cache.tenants[name] = data;
            }
        }
    }

    // Write cache (partial is OK — better than nothing)
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache));

    const durationMs = Date.now() - start;
    const tenantCount = Object.keys(cache.tenants).length;
    if (timedOut) {
        console.log(`   💾 Family cache PARTIAL: ${tenantCount} tenants, ${totalAnnotated} paths in ${(durationMs / 1000).toFixed(1)}s — will continue next run`);
    } else {
        console.log(`   💾 Family cache built: ${tenantCount} tenants, ${totalAnnotated} paths in ${(durationMs / 1000).toFixed(1)}s`);
    }
    return { tenants: tenantCount, annotated: totalAnnotated, durationMs, partial: timedOut };
}

module.exports = {
    fetchWorkdayJobs,
    fetchAllWorkdayJobs,
    annotateFamilyDepartments,
    applyFamilyCache,
    buildFamilyCache,
    normalizeWorkdayJob,
    parseWorkdayLocation,
    getFamilyFacets,
    buildFamilyPathMap,
};