/**
 * Country Resolver — AGG-NONUS-REFACTOR-1 Tier 1
 *
 * Single source of truth: maps canonical ISO country codes to each ATS family's
 * native query/filter value. Each fetcher calls resolveCountry(atsFamily, country)
 * instead of hardcoding 'United States' / 'us' / etc.
 *
 * US parity: resolveCountry(atsFamily, 'US') returns each fetcher's EXACT current
 * hardcoded value — byte-identical queries, zero behavior change for US.
 *
 * Adding a new country: add the column to RESOLVER_TABLE + add any ATS-specific
 * handling. No fetcher code changes needed.
 */

// Canonical: { atsFamily: { 'US': currentValue, 'CA': canadaValue, ... } }
const RESOLVER_TABLE = {
  // Server-side query filter (URL param)
  smartrecruiters: { 'US': 'us', 'CA': 'ca' },

  // Server-side query filter (loc_query param)
  amazon:           { 'US': 'United States', 'CA': 'Canada' },

  // Server-side query filter (location param)
  google:           { 'US': 'United States', 'CA': 'Canada' },
  netflix:          { 'US': 'United States', 'CA': 'Canada' },
  amd:              { 'US': 'United States', 'CA': 'Canada' },

  // Client-side post-fetch filter (countryName comparison)
  uber:             { 'US': 'United States', 'CA': 'Canada' },

  // Boolean flag (stamp is_us_only)
  workday:          { 'US': true, 'CA': false },
};

// Country code filter values (for client-side filtering like amazon's country_code)
const COUNTRY_CODE_MAP = {
  amazon: { 'US': 'USA', 'CA': 'CAN' },
};

/**
 * Resolve a canonical country code to the ATS-native query value.
 * @param {string} atsFamily - ATS family name (must match RESOLVER_TABLE keys)
 * @param {string} country - Canonical ISO country code ('US', 'CA', ...)
 * @returns {string|boolean} The ATS-native value, or the US default if unknown
 */
function resolveCountry(atsFamily, country = 'US') {
  const family = RESOLVER_TABLE[atsFamily];
  if (!family) return country; // Unknown ATS — pass through
  return family[country] !== undefined ? family[country] : family['US'];
}

/**
 * Resolve country to a country_code filter value (for client-side post-fetch filtering).
 * @param {string} atsFamily - ATS family name
 * @param {string} country - Canonical ISO country code
 * @returns {string} The ATS-native country code
 */
function resolveCountryCode(atsFamily, country = 'US') {
  const map = COUNTRY_CODE_MAP[atsFamily];
  if (!map) return country;
  return map[country] !== undefined ? map[country] : map['US'];
}

module.exports = { resolveCountry, resolveCountryCode, RESOLVER_TABLE, COUNTRY_CODE_MAP };
