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
  'TikTok', 'ByteDance',
  'Tesla', 'SentinelOne',
  // Proprietary portals
  'IBM', 'Goldman Sachs', 'Shopify',
  // API-gated / custom
  'Citadel',
  // Previously rejected/unfetchable with no direct path
  'Fortinet', 'Qualcomm',
  'Texas Instruments', 'Equinix',
  'Deloitte',
  // SUP-EXPAND-1 (F19): Blocked major companies with active SimplifyJobs US listings
  'Meta', 'Bank of America', 'Pfizer', 'Stryker', 'Charles Schwab',
  'PNC Financial Services', 'Truist Bank', 'Boston Scientific', 'CVS Health',
  'Wells Fargo',
  // F41: Major US bank, 16 active SimplifyJobs listings (6+ US entry-level)
  'JP Morgan Chase',
  // F41: SimplifyJs discovery — 5 companies with active US tech entry-level listings
  'Veeva Systems',
  'Susquehanna International Group (SIG)',
  'Amentum',
  'L3Harris Technologies',
  'Peraton',
  // F45: Coinbase migrated from GH (board 404). SimplifyJs fallback (3 US listings).
  'Coinbase',
  // F50: SimplifyJs gap analysis — unfetchable ATS, real US tech entry-level yield
  'Skydio',        // 8 US tech-EL — autonomy/drone company
  'Cirrus Logic',  // 5 US tech-EL — semiconductor company
  'Canon',         // 6 US tech-EL — mostly software interns, Irvine CA
  // F51 (SUP-INTERN-3): 12 companies from SUP-INTERN-2 research — not on any fetchable ATS
  'Berkshire Hathaway Energy',  // 14 US tech internships — energy/data science
  'John Deere',                 // 12 US tech internships — manufacturing (SWE/data)
  'Pennsylvania State University', // 11 US tech internships — university (AI/ML research)
  'BAE Systems',                // 10 US tech internships — defense (SWE)
  'KION Group',                 // 8 US tech internships — industrial AI
  'Rolls Royce',                // 12 US tech internships — aerospace (data/analytics)
  'General Dynamics Mission Systems', // 8 US tech internships — defense (SWE)
  'W.R. Berkley',               // 7 US tech internships — insurance (data analytics)
  'X Development',              // 8 US tech internships — Alphabet moonshots (ML/AI)
  'Honeywell',                  // 8 US tech internships — conglomerate (cyber/ML/SWE)
  'Marmon Holdings',            // 7 US tech internships — conglomerate (data/SWE)
  'Trane Technologies',         // 6 US tech internships — HVAC (SWE)
  // F51 batch 2 (SUP-INTERN-3): Additional SimplifyJs internship companies
  'PennState University',                // 16 US tech — variant name for Penn State
  'LMI',                                 // 6 US tech — defense contractor (SWE/data/AI)
  'Actian',                              // 6 US tech — AI/database (remote US)
  'HNTB',                                // 5 US tech — AI/data internships
  'Centific',                            // 5 US tech — AI/ML research (remote US)
  'Gelber Group',                        // 5 US tech — SWE/trading (Chicago/Boston)
  'Zillow',                              // 4 US tech — AI scientist PhD interns
  'Bloom Energy',                        // 4 US tech — SWE/ML (San Jose)
  'Ambarella',                           // 4 US tech — SWE interns (US)
  'Nokia',                               // ~5 US tech — mixed US/Canada/UK
  'Robert Bosch Venture Capital',        // ~5 US tech — Bosch US internships
  // F51 batch 3: Diminishing-returns SimplifyJs internship expansion
  'Kioxia',                              // 4 US tech — semiconductor memory (Santa Clara)
  'Kodiak Robotics',                     // 4 US tech — autonomous driving (ML/AI)
  'd-Matrix',                            // ~3 US tech — AI chips (Santa Clara)
  'onsemi',                              // ~3 US tech — semiconductor (AZ/TX)
  'Dexcom',                              // 3 US tech — medical devices SWE
  'University of Texas at Austin',       // 6 US tech — research assistantships
  'Uncountable',                          // F52: migrated Lever→Ashby (API-gated). 3 new-grad + 2 internship listings
  // F52 (SUP-INTERN-4): HIGH priority — verified US tech internships on SimplifyJs
  'Bose',                              // 4 US — ML/DSP co-ops + research intern, Framingham MA
  'Cotiviti',                          // 4 US — GenAI/Agentic AI research intern, remote
  'Integra FEC',                       // 4 US — data scientist/analyst interns, Austin TX
  // F52 (SUP-INTERN-4): STANDARD priority
  'GM financial',                      // 9 US — SWE/RPA interns, Dallas TX
  'Onto Innovation',                   // 6 US — optical/data analytics interns, Milpitas CA
  'Varda Space',                       // 5 US — mission ops/software interns, El Segundo CA
  'Axos Bank',                         // 5 US — SWE/data science interns, San Diego CA
  'Draper',                            // 5 US — SWE/co-op, Cambridge MA
  'Kaiser Permanente',                 // 5 US — process improvement/data interns, CA/OR
  'XPENG Motors',                      // 4 US — AI/research scientist interns, Santa Clara CA
  'TripleRing',                        // 3 US — embedded SWE/data scientist interns, Boston/Newark
  'Tessera Labs',                      // 3 US — SWE frontend/backend interns, San Jose/remote
  'BillionToOne',                      // 3 US — AI eng/PM interns, Menlo Park CA
  'BeOne',                             // 3 US — data/BI interns, San Carlos CA/remote
  'Vertex Pharmaceuticals',            // 3 US — data eng co-ops, Boston/San Diego
  'Highmark Health',                   // 2 US — SWE interns, Pittsburgh/remote
  'SWBC',                              // 2 US — SWE interns, San Antonio TX
  'Becton Dickinson',                  // 1 US — data analytics intern
  // F54 (SUP-INTERN-1 expansion): Unfetchable ATS, verified US tech internships
  'ABB',                        // 5 US tech internships — Swiss-Swedish industrial/robotics (San Jose CA)
  'CME Group',                  // 4 US tech internships — quant/data science (Chicago)
  'Tower Research Capital',     // 3 US tech internships — quant researcher/trader (NYC)
  'Starz',                      // 3 US tech internships — SWE intern, streaming (Remote US)
  'Schweitzer Engineering Laboratories', // 3 US tech internships — power systems SWE (Moscow ID)
  'ACI Worldwide',              // 3 US tech internships — payments SWE intern (Omaha NE)
  'Hunt Oil Company',           // 4 US tech internships — AI/SWE intern (Dallas TX)
  'APEX Analytix',              // 4 US tech internships — automation/data intern (Greensboro NC)
];



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
