/**
 * SimplifyJobs Listings Fetcher
 *
 * Fetches jobs from SimplifyJobs/New-Grad-Positions and Summer2026-Internships
 * public GitHub repos. Parses listings.json for companies NOT on fetchable ATS
 * platforms (iCIMS, Taleo, Avature, proprietary portals).
 * Microsoft, Oracle, AMD removed — now have direct custom fetchers.
 *
 * Data source: Public GitHub JSON — zero ToS risk, no auth, no API quota.
 * Updated every 30 min by Simplify's backend.
 *
 * SUP-FETCHER-3: Fallback for unfetchable companies (tier 2 after direct fetchers).
 * Only ingests jobs from companies that have no direct fetcher in the pipeline.
 * Company matching: exact match against company-list.json company names.
 *
 * Listings structure per entry:
 *   { source, category, company_name, id, title, active, date_updated,
 *     date_posted, url, locations[], company_url, is_visible, sponsorship, degrees[] }
 *
 * No job descriptions available — SimplifyJobs provides title + URL only.
 * Jobs enter pipeline as T0 (no description). Acceptable for companies with
 * zero other pipeline representation.
 */

'use strict';

const https = require('https');

const REPOS = [
  {
    name: 'New-Grad-Positions',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json'
  },
  {
    name: 'Summer2026-Internships',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json'
  }
];

// Companies to fetch from SimplifyJobs — only those NOT on fetchable ATS platforms.
// These are unfetchable via GH/Lever/Ashby/WD/SR or have proprietary portals.
const TARGET_COMPANIES = [
  // Proprietary portals / auth-walled

  'Tesla', 'SentinelOne',
  // Proprietary portals'Goldman Sachs', 'Shopify',
  // API-gated / custom
  'Citadel Securities',  // F87: Fixed name mismatch (was 'Citadel', SimplifyJs uses 'Citadel Securities')
  // Previously rejected/unfetchable with no direct path
  'Fortinet', 'Qualcomm',
  // SUP-EXPAND-1 (F19): Blocked major companies with active SimplifyJobs US listings
  'Meta', 'Bank of America','Stryker', 'Charles Schwab',
  'PNC Financial Services','Boston Scientific', 'CVS Health',
  // F41: Major US bank, 16 active SimplifyJobs listings (6+ US entry-level)
  'JP Morgan Chase',
  // F41: SimplifyJs discovery — 5 companies with active US tech entry-level listings
  'L3Harris Technologies',
  'Peraton',
  // F45: Coinbase migrated from GH (board 404). SimplifyJs fallback (3 US listings).
  'Skydio',        // 8 US tech-EL — autonomy/drone company
  'Cirrus Logic',  // 5 US tech-EL — semiconductor company
  // F87: Removed 'Canon' — 0 SimplifyJs listings. 'Canonical' (matched) is a different company.
  'Seagate Technology',  // F87: Added from CSV pending-add. 2 active US listings (firmware/PM).
  'eBay',                // F87: Added from CSV pending-add. 3 seasonal listings.
  // F51 (SUP-INTERN-3): 12 companies from SUP-INTERN-2 research — not on any fetchable ATS
  'John Deere',                 // 12 US tech internships — manufacturing (SWE/data)
  'Pennsylvania State University', // 11 US tech internships — university (AI/ML research)
  'BAE Systems',                // 10 US tech internships — defense (SWE)
  'Rolls Royce',                // 12 US tech internships — aerospace (data/analytics)
  'General Dynamics Mission Systems', // 8 US tech internships — defense (SWE)
  'W.R. Berkley',               // 7 US tech internships — insurance (data analytics)
  'X Development',              // 8 US tech internships — Alphabet moonshots (ML/AI)
  'Trane Technologies',         // 6 US tech internships — HVAC (SWE)
  // F51 batch 2 (SUP-INTERN-3): Additional SimplifyJs internship companies
  'PennState University',                // 16 US tech — variant name for Penn State
  'LMI',                                 // 6 US tech — defense contractor (SWE/data/AI)
  'Gelber Group',                        // 5 US tech — SWE/trading (Chicago/Boston)
  'Nokia',                               // ~5 US tech — mixed US/Canada/UK
  'Robert Bosch Venture Capital',        // ~5 US tech — Bosch US internships
  // F51 batch 3: Diminishing-returns SimplifyJs internship expansion
  'onsemi',                              // ~3 US tech — semiconductor (AZ/TX)
  'University of Texas at Austin',       // 6 US tech — research assistantships
  'Uncountable',                          // F52: migrated Lever→Ashby (API-gated). 3 new-grad + 2 internship listings
  // F52 (SUP-INTERN-4): HIGH priority — verified US tech internships on SimplifyJs
  'Cotiviti',                          // 4 US — GenAI/Agentic AI research intern, remote
  'Integra FEC',                       // 4 US — data scientist/analyst interns, Austin TX
  // F52 (SUP-INTERN-4): STANDARD priority
  'GM financial',                      // 9 US — SWE/RPA interns, Dallas TX
  'Axos Bank',                         // 5 US — SWE/data science interns, San Diego CA
  'Kaiser Permanente',                 // 5 US — process improvement/data interns, CA/OR
  'TripleRing',                        // 3 US — embedded SWE/data scientist interns, Boston/Newark
  'Tessera Labs',                      // 3 US — SWE frontend/backend interns, San Jose/remote
  'BeOne',                             // 3 US — data/BI interns, San Carlos CA/remote
  // F54 (SUP-INTERN-1 expansion): Unfetchable ATS, verified US tech internships
  'Tower Research Capital',     // 3 US tech internships — quant researcher/trader (NYC)
  'Starz',                      // 3 US tech internships — SWE intern, streaming (Remote US)
  'ACI Worldwide',              // 3 US tech internships — payments SWE intern (Omaha NE)
  'Hunt Oil Company',           // 4 US tech internships — AI/SWE intern (Dallas TX)
  'APEX Analytix',              // 4 US tech internships — automation/data intern (Greensboro NC)
  // F62 (SUP-INTERN-5): Batch 1 — HIGH yield uncovered internship companies
  // All verified: unfetchable ATS, US-based, real tech internship listings on SimplifyJs
  'Paccar',                     // 36 US tech — truck manufacturer (Bellevue WA)
  'The Federal Reserve System', // 23 US tech — US government (multiple cities)
  'Emerson Electric',           // 22 US tech — industrial automation (St. Louis MO)
  'Westinghouse Electric Company', // 18 US tech — nuclear energy (Cranberry Township PA)
  'Teledyne',                   // 17 US tech — aerospace/defense instrumentation (Thousand Oaks CA)
  'Dover',                      // 15 US tech — industrial conglomerate (Downers Grove IL)
  'Hewlett Packard (HP)',       // 15 US tech — PC/printer tech (Houston TX)
  'SAS',                        // 13 US tech — analytics software (Cary NC). NOT the GH security company.
  'NextEra Energy',             // 12 US tech — energy (Juno Beach FL)
  'Skyworks',                   // 12 US tech — semiconductor (Irvine CA)
  'EquipmentShare',             // 12 US tech — construction tech (Columbia MO)
  'ASSA ABLOY',                 // 12 US tech — access solutions/security (New Haven CT)
  'HERE Technologies',          // 12 US tech — maps/location tech (Chicago IL)
  // F62 (SUP-INTERN-5): Batch 2 — STANDARD yield (5-9 US tech internships)
  // All verified: unfetchable ATS, US-based, real tech internship listings on SimplifyJs
  'Paramount Global', 'Crane Co.', 'Vanderlande Industries','Northwestern Mutual','MKS Instruments','Thales', 'ALSO',
  'Woven','Voyager Technologies','Cox', 'Corning', 'Barry-Wehmiller','Harris Computer','McKesson',
  'Stifel','Dow Chemical Company',
  'Cencora', 'Xcel Energy', 'Moderna', 'Stantec', 'Berkshire Grey',
  'Faith Technologies','Innovative Defense Technologies','Airbus', 'FMC Corporation','Relay', 'LexisNexis Risk Solutions','JM Family', 'NinjaTrader','Stoke Space', 'Advanced Energy','Varian','Ryan', 'ID.me','Axiom Space','Global Partners', 'Intapp', 'TWG Global','Air Liquide','Cambridge Associates','Guidewire', 'EBSCO', 'Cambridge Mobile Telematics',];



const HEADERS = {
  'User-Agent': 'ZJP-Pipeline/1.0',
  'Accept': 'application/json',
};

function fetchJson(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: HEADERS }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(d) });
        } catch (e) {
          resolve({ status: res.statusCode, data: null, error: e.message });
        }
      });
    });
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, data: null, error: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, data: null, error: e.message }));
  });
}

/**
 * Parse location string into city/state/country components.
 */
function parseLocation(locStr) {
  if (!locStr || typeof locStr !== 'string') return { city: '', state: '', country: '' };

  const parts = locStr.split(',').map(s => s.trim());
  if (parts.length === 0) return { city: '', state: '', country: '' };

  const city = parts[0] || '';
  const stateOrRegion = parts[1] || '';

  // Detect US locations: "City, ST" or "City, State"
  const usStateAbbrevs = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR']);
  const upper = stateOrRegion.toUpperCase().replace(/\./g, '');

  if (usStateAbbrevs.has(upper)) {
    return { city, state: upper, country: 'us' };
  }

  // "United States" as city means country-level
  if (city.toLowerCase() === 'united states') {
    return { city: '', state: '', country: 'us' };
  }

  // Common non-US patterns
  const nonUS = new Set(['Canada','UK','United Kingdom','India','Germany','France','Singapore','Australia','Japan','China','Brazil','Netherlands','Ireland','Israel','South Korea','Switzerland','Mexico']);
  if (nonUS.has(stateOrRegion) || nonUS.has(city)) {
    return { city, state: '', country: '' };
  }

  // Default: assume US if it looks like "City, ST"
  if (upper.length === 2 && upper.match(/^[A-Z]{2}$/)) {
    return { city, state: upper, country: 'us' };
  }

  return { city, state: stateOrRegion, country: '' };
}

/**
 * Normalize a SimplifyJobs listing to the shared schema.
 */
function normalizeListing(listing) {
  const locs = (listing.locations || [])
    .map(parseLocation)
    .filter(l => l.country === 'us');

  const primaryLoc = locs[0] || { city: '', state: '', country: 'us' };

  return {
    id: `simplify-${listing.id}`,
    source: 'simplify',
    source_id: listing.id,

    title: (listing.title || '').trim() || null,
    company_name: (listing.company_name || '').trim(),
    company_slug: (listing.company_name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ''),

    location: primaryLoc.city ? `${primaryLoc.city}, ${primaryLoc.state}` : 'United States',
    locations: locs.length > 0 ? locs.map(l => l.country === 'us' ? 'us' : l.country) : ['us'],
    job_city: primaryLoc.city,
    job_state: primaryLoc.state,

    url: listing.url,
    apply_url: listing.url,

    departments: [],
    employment_type: null,

    // FRESHNESS-2: If date_posted is older than 7 days, substitute Date.now().
    // SimplifyJobs internship listings stay active for months but date_posted reflects
    // original posting date. Without override, deduplicator and posted-jobs-manager
    // reject these as expired (>7 day TTL). Same pattern as GH/Lever/Ashby.
    posted_at: (() => {
      const postedMs = listing.date_posted ? listing.date_posted * 1000 : NaN;
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return new Date(!isNaN(postedMs) && postedMs > cutoff ? postedMs : Date.now()).toISOString();
    })(),
    fetched_at: new Date().toISOString(),

    description: null, // SimplifyJobs provides title + URL only — no descriptions
  };
}

/**
 * Fetch all SimplifyJobs listings for target companies.
 * @returns {Promise<Array>} normalized jobs (US-only, active listings)
 */
async function fetchAllSimplifyJobs() {
  console.log('\n📋 Fetching from SimplifyJobs...');
  console.log('━'.repeat(60));

  const targetSet = new Set(TARGET_COMPANIES.map(c => c.toLowerCase()));
  const allJobs = [];
  const seenIds = new Set();
  let totalListings = 0;
  let activeListings = 0;
  let targetActive = 0;

  for (const repo of REPOS) {
    console.log(`  Fetching ${repo.name}...`);
    const result = await fetchJson(repo.url);

    if (!result || result.status !== 200 || !result.data) {
      console.log(`  ${repo.name}: HTTP ${result?.status || 'error'} (${result?.error || 'unknown'}) — skipping`);
      continue;
    }

    const listings = Array.isArray(result.data) ? result.data : [];
    totalListings += listings.length;
    const active = listings.filter(l => l.active !== false);
    activeListings += active.length;

    const targetListings = active.filter(l => {
      const name = (l.company_name || '').toLowerCase().trim();
      return targetSet.has(name);
    });

    for (const listing of targetListings) {
      if (seenIds.has(listing.id)) continue;
      seenIds.add(listing.id);
      targetActive++;

      const normalized = normalizeListing(listing);
      // Filter to US-only
      if (normalized.locations.includes('us') || normalized.job_state) {
        allJobs.push(normalized);
      }
    }

    console.log(`  ${repo.name}: ${listings.length} total, ${active.length} active, ${targetListings.length} target company`);
  }

  console.log(`\n  Total: ${totalListings} listings (${activeListings} active), ${targetActive} from target companies`);
  console.log(`  US jobs after normalization: ${allJobs.length}`);
  return allJobs;
}

module.exports = { fetchAllSimplifyJobs, TARGET_COMPANIES };
