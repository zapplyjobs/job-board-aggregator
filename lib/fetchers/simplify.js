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
 * Only ingests jobs from companies in TARGET_COMPANIES via exact upstream
 * company_name match after lowercasing/trim.
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
  'ByteDance',      // AGG-SURVIVE-1 A151: preserve current upstream brand spelling exactly
  'Tesla', 'SentinelOne',
  'Goldman Sachs', 'Shopify',
  'Citadel Securities',  // F87: Fixed name mismatch (was 'Citadel', SimplifyJs uses 'Citadel Securities')
  'Qualcomm',
  'Meta', 'Bank of America','Charles Schwab',
  'Boston Scientific',
  'L3Harris Technologies',
  'Peraton',
  // F87: Removed 'Canon' — 0 SimplifyJs listings. 'Canonical' (matched) is a different company.
  'Seagate Technology',  // F87: Added from CSV pending-add. 2 active US listings (firmware/PM).
  'eBay',                // F87: Added from CSV pending-add. 3 seasonal listings.
  'John Deere',                 // 12 US tech internships — manufacturing (SWE/data)
  'BAE Systems',                // 10 US tech internships — defense (SWE)
  'Rolls Royce',                // 12 US tech internships — aerospace (data/analytics)
  'General Dynamics Mission Systems', // 8 US tech internships — defense (SWE)
  'W.R. Berkley',               // 7 US tech internships — insurance (data analytics)
  'X Development',              // 8 US tech internships — Alphabet moonshots (ML/AI)
  'Trane Technologies',         // 6 US tech internships — HVAC (SWE)
  'LMI',                                 // 6 US tech — defense contractor (SWE/data/AI)
  'Gelber Group',                        // 5 US tech — SWE/trading (Chicago/Boston)
  'Cotiviti',                          // 4 US — GenAI/Agentic AI research intern, remote
  'Axos Bank',                         // 5 US — SWE/data science interns, San Diego CA
  'Kaiser Permanente',                 // 5 US — process improvement/data interns, CA/OR
  'TripleRing',                        // 3 US — embedded SWE/data scientist interns, Boston/Newark
  'BeOne',                             // 3 US — data/BI interns, San Carlos CA/remote
  'Tower Research Capital',     // 3 US tech internships — quant researcher/trader (NYC)
  'Starz',                      // 3 US tech internships — SWE intern, streaming (Remote US)
  'ACI Worldwide',              // 3 US tech internships — payments SWE intern (Omaha NE)
  'APEX Analytix',              // 4 US tech internships — automation/data intern (Greensboro NC)
  'Paccar',                     // 36 US tech — truck manufacturer (Bellevue WA)
  'Westinghouse Electric Company', // 18 US tech — nuclear energy (Cranberry Township PA)
  'Dover',                      // 15 US tech — industrial conglomerate (Downers Grove IL)
  'SAS',                        // 13 US tech — analytics software (Cary NC). NOT the GH security company.
  'NextEra Energy',             // 12 US tech — energy (Juno Beach FL)
  'Skyworks',                   // 12 US tech — semiconductor (Irvine CA)
  'EquipmentShare',             // 12 US tech — construction tech (Columbia MO)
  'ASSA ABLOY',                 // 12 US tech — access solutions/security (New Haven CT)
  'HERE Technologies',          // 12 US tech — maps/location tech (Chicago IL)
  'Paramount Global', 'Vanderlande Industries', 'ALSO',
  'Voyager Technologies','Corning', 'Barry-Wehmiller','Harris Computer','Stifel','Dow Chemical Company',
  'Cencora', 'Xcel Energy', 'Berkshire Grey',
  'Faith Technologies','Innovative Defense Technologies','Airbus', 'FMC Corporation','JM Family', 'NinjaTrader','Stoke Space', 'Advanced Energy','Ryan', 'ID.me','Global Partners', 'TWG Global','Cambridge Associates','Guidewire', 'EBSCO', 'Cambridge Mobile Telematics',];



const HEADERS = {
  'User-Agent': 'ZJP-Pipeline/1.0',
  'Accept': 'application/json',
};

function buildTargetCompanySet(targetCompanies = TARGET_COMPANIES) {
  return new Set(targetCompanies.map(c => c.toLowerCase().trim()));
}

function isTargetCompanyName(name, targetSet = buildTargetCompanySet()) {
  return targetSet.has((name || '').toLowerCase().trim());
}

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

  const targetSet = buildTargetCompanySet();
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

    const targetListings = active.filter(l => isTargetCompanyName(l.company_name, targetSet));

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

module.exports = { fetchAllSimplifyJobs, TARGET_COMPANIES, buildTargetCompanySet, isTargetCompanyName };
