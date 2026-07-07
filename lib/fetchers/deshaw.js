/**
 * D. E. Shaw Jobs Fetcher
 *
 * The D. E. Shaw group runs a CUSTOM, server-rendered careers portal at
 * deshaw.com (Next.js, no JSON API). It is NOT on Greenhouse / Lever / Ashby /
 * SmartRecruiters / Workday, so it needs a dedicated HTML scraper.
 *
 * How the portal works (canonical-source check, live-verified 2026-06-28):
 *   - One page lists every open role: https://www.deshaw.com/careers
 *     (both the experienced "Choose Your Path" list and the internships list
 *      are server-rendered as HTML cards on the same response).
 *   - Each card exposes:
 *       <p class="category">Category</p>            e.g. "Technology"
 *       <span class="location">Office</span>          e.g. "New York"
 *       <a id="job-description-a-tag" href="/careers/<slug>-<id>">
 *         <span class="job-display-name">Title</span>
 *         <span>: short description...</span>
 *   - A role may carry several categories joined by " / "
 *     (e.g. "Quantitative Strategies / Technology").
 *   - Offices: New York, Denver (US), India, London. US = {New York, Denver}.
 *   - Job URL form: /careers/<slug>-<numeric-id>, e.g. .../cross-platform-software-engineer-5850
 *   - Full description lives on the detail page (/careers/<slug>) inside
 *     <div class="JobDescription_wrapper__..."> as <p class="...PageTextBlockParagraph"> blocks.
 *
 * Scope (tech roles at US offices): categories intersecting
 *   {Software Development, Quantitative Strategies, Technology}
 *   AND location in {New York, Denver}.
 *
 * robots.txt: GREEN — User-agent: * Disallow list does NOT include /careers or
 *   /careers/<slug> (only /careers/open-roles is disallowed). 300ms delay between
 *   detail-page fetches (~25 requests => ~8s), bot UA via shared http-client.
 *
 * Live-verified 2026-06-28: 24 US tech roles (experienced + interns).
 */

'use strict';

const { getHtml, delay } = require('./http-client');

const BASE_URL = 'https://www.deshaw.com';
const LIST_URL = `${BASE_URL}/careers`;

// Tech categories whose roles we ingest. A card qualifies if ANY of its
// (possibly multi-) categories matches — D. E. Shaw tags cross-functional
// roles like "Applied AI Engineer" as "Quantitative Strategies / Technology".
const TECH_CATEGORIES = new Set([
  'Software Development',
  'Quantitative Strategies',
  'Technology',
]);

// US offices. The portal's other offices (India, London) are non-US.
const US_LOCATIONS = new Set(['New York', 'Denver']);

// Office name → US state, so downstream US routing/dedup has a real job_state.
// (New York = NYC HQ at Two Manhattan West; Denver = Denver, CO.)
const OFFICE_STATE = { 'New York': 'NY', 'Denver': 'CO' };

const DESC_DELAY_MS = 300;

/**
 * Decode the HTML entities D. E. Shaw's copy uses in titles/descriptions.
 */
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

/**
 * Pull the trailing numeric id from a D. E. Shaw job slug.
 * "cross-platform-software-engineer-5850" -> "5850"
 */
function extractJobId(slug) {
  if (!slug) return null;
  const m = slug.match(/(\d+)$/);
  return m ? m[1] : null;
}

/**
 * Parse every job card from the server-rendered careers listing.
 *
 * The card markup repeats as: category <p> + location <span> + the
 * job-description anchor (with job-display-name + a short-description span).
 * The gaps between these three are bounded so a malformed card can't swallow
 * its neighbour — if any one piece is missing the card simply isn't emitted.
 *
 * @param {string} html - raw HTML of https://www.deshaw.com/careers
 * @returns {Array<Object>} raw cards { category, location, slug, title, shortDesc }
 */
function parseJobCards(html) {
  if (!html) return [];

  const re = /<p class="category">([\s\S]*?)<\/p>[\s\S]{0,80}?<span class="location">([\s\S]*?)<\/span>[\s\S]{0,2000}?id="job-description-a-tag" href="\/careers\/([^"]+)"[\s\S]{0,3000}?<span class="job-display-name">([\s\S]*?)<\/span>(?:[\s\S]{0,500}?<span>([\s\S]*?)<\/span>)?/g;

  const cards = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const category = decodeEntities(m[1]).trim();
    const location = decodeEntities(m[2]).trim();
    const slug = m[3].trim();
    const title = decodeEntities(m[4]).trim();
    if (!slug || !title) continue; // malformed card — skip rather than emit junk

    // shortDesc is the ": The D. E. Shaw group seeks..." span; strip leading colon.
    let shortDesc = m[5] ? decodeEntities(m[5]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    shortDesc = shortDesc.replace(/^:\s*/, '');

    cards.push({ category, location, slug, title, shortDesc });
  }

  return cards;
}

/**
 * Extract the full description from a job detail page.
 *
 * Inside the JobDescription wrapper (ending at the EEO disclaimer) the body
 * copy is: intro <p> paragraphs, <h2>/<h3> section headers, and <li> bullet
 * items (responsibilities / qualifications / tech stack). We capture all three
 * shapes in document order, with two guards so the in-page nav menu and footer
 * never leak in:
 *   1. The nav lives in a <ul class="...subNavigation..."> — we strip that
 *      block first so its <li> can't be collected as bullets.
 *   2. The pageTextBoxBody <p> is a structural *container* that wraps the <ul>;
 *      its own text is just the bullets repeated. We skip any <p> that contains
 *      a <ul> so the bullets aren't double-counted.
 * Bullets render as "- " lines, matching the microsoft/oracle fetchers' list
 * convention.
 *
 * @param {string} html - raw HTML of https://www.deshaw.com/careers/<slug>
 * @returns {string|null} cleaned description text, or null if nothing found
 */
function extractDescriptionFromHtml(html) {
  if (!html) return null;

  const start = html.indexOf('JobDescription_wrapper__');
  if (start === -1) return null;

  let end = html.indexOf('JobDescription_specificJobDisclaimer', start);
  if (end === -1) end = html.length;

  // Strip the in-page nav menu (its <ul class="...subNavigation...">) so any
  // nav <li> can't contaminate the bullets below.
  const seg = html.slice(start, end).replace(/<ul[^>]*subNavigation[^>]*>[\s\S]*?<\/ul>/g, '');

  const clean = (s) => decodeEntities(s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());

  // Collect the three content shapes with their source position, then sort so
  // the output reads in document order (intro -> header -> bullets -> ...).
  const items = [];

  for (const m of seg.matchAll(/<h([23])[^>]*>([\s\S]*?)<\/h\1>/g)) {
    const t = clean(m[2]);
    if (t) items.push({ at: m.index, text: t });
  }
  for (const m of seg.matchAll(/<p(\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
    if (/<ul[\s>]/.test(m[2])) continue; // container <p> wrapping a <ul> — skip (its text == the bullets)
    const t = clean(m[2]);
    if (t) items.push({ at: m.index, text: t });
  }
  for (const m of seg.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
    const t = clean(m[1]);
    if (t) items.push({ at: m.index, text: `- ${t}` });
  }

  items.sort((a, b) => a.at - b.at);

  const desc = items.map((it) => it.text).join('\n\n');
  return desc || null;
}

/**
 * Fetch the full description for a single job (one extra request).
 * Returns null on any failure so a flaky detail page never drops a job.
 */
async function fetchJobDescription(slug) {
  if (!slug) return null;
  const result = await getHtml(`${BASE_URL}/careers/${slug}`);
  if (!result || result.status !== 200) return null;
  return extractDescriptionFromHtml(result.html);
}

/**
 * Normalize one D. E. Shaw card to the shared job schema (same shape as the
 * Amazon / Two Sigma / Greenhouse fetchers so the downstream transform,
 * tag-engine, and dedup pipeline accept it unchanged).
 */
function normalizeDeshawJob(card, description) {
  const jobId = extractJobId(card.slug);
  const city = card.location || '';
  const state = OFFICE_STATE[city] || '';

  // "Quantitative Strategies / Technology" -> ["Quantitative Strategies","Technology"]
  const departments = card.category
    ? card.category.split(' / ').map((c) => c.trim()).filter(Boolean)
    : [];

  const location = city;
  const detailUrl = `${BASE_URL}/careers/${card.slug}`;
  const now = new Date().toISOString();

  return {
    // Core fields
    id: `deshaw-${jobId || card.slug}`,
    source: 'deshaw',
    source_url: 'www.deshaw.com',
    source_id: jobId,

    // Job details
    title: card.title || null,
    company_name: 'D. E. Shaw',
    company_slug: 'deshaw',

    // Location — raw office string for tag-engine, structured fields for routing
    location,
    locations: location ? [location] : [],
    job_city: city,
    job_state: state,

    // URL
    url: detailUrl,
    apply_url: detailUrl,

    // Metadata
    departments,
    employment_type: null,

    // Dates — D. E. Shaw exposes neither posted date nor employment type on the
    // listing. posted_at falls back to the fetch/run timestamp (a job discovered
    // now is "fresh") so the row always carries a valid ISO date, which the R2
    // artifact contract requires of every posted_at.
    posted_at: null, // AGG-RESTAMP-1: API has no dates — dedup first-seen handles null
    fetched_at: now,

    // Description (full text from the detail page; card summary as fallback)
    description: description || card.shortDesc || null,
  };
}

/**
 * Fetch all D. E. Shaw US tech roles (Software Development, Quantitative
 * Strategies, Technology) from the careers portal, then enrich each with the
 * full description from its detail page.
 *
 * @returns {Promise<Array>} normalized jobs
 */
async function fetchAllDeshawJobs() {
  console.log('\n🏛️  Fetching from D. E. Shaw...');
  console.log('━'.repeat(60));

  const result = await getHtml(LIST_URL);
  if (!result || result.status !== 200) {
    console.log(`  HTTP ${result?.status || 'error'} — no jobs fetched`);
    return [];
  }

  const cards = parseJobCards(result.html);
  console.log(`  Listing: ${cards.length} total roles on the board`);

  // Scope: tech categories at US offices.
  const techUsCards = cards.filter(
    (c) =>
      c.location &&
      US_LOCATIONS.has(c.location) &&
      c.category.split(' / ').some((cat) => TECH_CATEGORIES.has(cat))
  );
  console.log(`  US tech roles (Software Dev / Quant Strategies / Technology): ${techUsCards.length}`);

  let descCount = 0;
  const jobs = [];
  for (const card of techUsCards) {
    const description = await fetchJobDescription(card.slug);
    if (description) descCount++;
    jobs.push(normalizeDeshawJob(card, description));
    await delay(DESC_DELAY_MS);
  }

  console.log(`  Descriptions: ${descCount}/${techUsCards.length} fetched`);
  console.log(`  D. E. Shaw total: ${jobs.length} jobs`);
  return jobs;
}

module.exports = { fetchAllDeshawJobs };
