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

const PAGE_SIZE = 20;
const MAX_JOBS = 500;  // Cap per tenant to avoid runaway pagination

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
 * Parse Workday's relative date strings into ISO dates.
 * "Posted Today" → today, "Posted 3 Days Ago" → 3 days ago, "Posted + 30 Days Ago" → 30+ days ago
 */
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
    const { name, url, site } = tenant;
    // For myworkdaysite.com: hostname is like "wd1.myworkdaysite.com" — no tenant prefix.
    // Tenant must be provided explicitly in the config (e.g. "snapchat" for Snap).
    // For myworkdayjobs.com: hostname is like "salesforce.wd12.myworkdayjobs.com" — tenant is first segment.
    const hostname = new URL(url).hostname;
    const tenantSlug = tenant.tenant || (hostname.includes('myworkdaysite.com') ? null : hostname.split('.')[0]);
    if (!tenantSlug) {
        console.log(`   ⚠️ Workday: missing tenant for ${name} (myworkdaysite.com requires explicit tenant field) — skipping`);
        return { jobs: [], total: 0 };
    }
    const endpoint = `${url}/wday/cxs/${tenantSlug}/${site}/jobs`;

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
    const hostname = new URL(tenant.url).hostname;
    const tenantSlug = tenant.tenant || (hostname.includes('myworkdaysite.com') ? null : hostname.split('.')[0]);
    if (!tenantSlug) return null;
    const endpoint = `${tenant.url}/wday/cxs/${tenantSlug}/${tenant.site}/jobs`;

    const result = await postJson(endpoint, { limit: 1, offset: 0 });
    if (!result || result.status !== 200 || !result.data) return null;
    return result.data.total || 0;
}

/**
 * Fetch jobs from all Workday tenants.
 * AGG-SPEED-2: Incremental fetch — probes tenant totals first, skips unchanged tenants.
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

        // Compare with cache — only fetch tenants where total changed or probe failed
        changedTenants = tenants.filter(t => {
            const prev = previousTotals[t.name];
            const curr = tenantTotals[t.name];
            if (curr === null) return true; // probe failed — safe to full fetch
            currentTotals[t.name] = curr;
            if (prev === undefined || prev !== curr) return true;
            skippedCount++;
            return false;
        });

        console.log(`   ⏩ Skipped ${skippedCount} unchanged tenants, fetching ${changedTenants.length}`);

        // For unchanged tenants, carry forward their total
        for (const t of tenants) {
            if (currentTotals[t.name] === undefined) {
                currentTotals[t.name] = tenantTotals[t.name] ?? previousTotals[t.name];
            }
        }
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
                currentTotals[tenant.name] = result.total;
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

module.exports = {
    fetchWorkdayJobs,
    fetchAllWorkdayJobs,
    normalizeWorkdayJob,
    parseWorkdayLocation,
};