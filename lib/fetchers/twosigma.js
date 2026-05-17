/**
 * Two Sigma Jobs Fetcher
 *
 * Fetches jobs from Two Sigma's public RSS/Atom feed (Avature platform).
 * After RSS feed, fetches individual job pages for descriptions.
 * No authentication required.
 *
 * URL: https://careers.twosigma.com/careers/OpenRoles/feed/
 * Method: GET
 * Params: jobRecordsPerPage=100
 * Response: XML RSS feed with <item> elements
 *
 * Per item: title (CDATA), description (location, CDATA), link (full URL),
 *           guid (full URL with job ID), pubDate (RFC 2822)
 *
 * Description fetching (SUP-FETCHER-4): After RSS, fetches each job's detail
 * page. Extracts description from article__content__view__field__value divs.
 * ~20 extra requests at 300ms = ~6s. robots.txt: Allow: /careers.
 *
 * ~20 jobs total. Mostly NY-based quant/research roles.
 * robots.txt: GREEN — explicit Allow: /careers.
 * Live-verified 2026-04-27.
 */

'use strict';

const { getHtml, delay } = require('./http-client');

const FEED_URL = 'https://careers.twosigma.com/careers/OpenRoles/feed/?jobRecordsPerPage=100';
const DESC_DELAY_MS = 300;

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractCdata(block, 'title');
    const description = extractCdata(block, 'description');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    items.push({ title, description, link, pubDate });
  }

  return items;
}

function extractCdata(block, tag) {
  const m = block.match(new RegExp(`<${tag}>[\\s\\S]*?<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>[\\s\\S]*?</${tag}>`));
  return m ? m[1].trim() : '';
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : '';
}

function extractJobId(url) {
  if (!url) return null;
  const parts = url.split('/');
  return parts[parts.length - 1] || null;
}

function parseLocation(desc) {
  if (!desc) return '';
  return desc
    .replace(/^United States\s*/i, '')
    .replace(/^United Kingdom.*?\s+(?=[A-Z])/i, '')
    .trim();
}

/**
 * Fetch description from a Two Sigma job detail page.
 * Extracts text from article__content__view__field__value divs.
 * Skips EEO/disclaimer fields (last 2).
 */
function extractDescriptionFromHtml(html) {
  if (!html) return null;

  const pattern = /<div class="article__content__view__field__value">([\s\S]*?)<\/div>/g;
  const fields = [];
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const text = match[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#\d+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 30) {
      fields.push(text);
    }
  }

  if (fields.length === 0) return null;

  // Take all fields except the last one (typically EEO statement)
  // The second-to-last is usually compensation, which is valuable
  return fields.slice(0, -1).join('\n\n');
}

/**
 * Fetch description for a single job page.
 */
async function fetchJobDescription(url) {
  if (!url) return null;

  const result = await getHtml(url);
  if (!result || result.status !== 200) return null;

  return extractDescriptionFromHtml(result.html);
}

function normalizeTwoSigmaJob(item, description) {
  const jobId = extractJobId(item.link);
  const location = parseLocation(item.description);

  let postedAt = null;
  if (item.pubDate) {
    const d = new Date(item.pubDate);
    if (!isNaN(d.getTime())) postedAt = d.toISOString();
  }

  return {
    id: `twosigma-${jobId || ''}`,
    source: 'twosigma',
    source_id: jobId,

    title: item.title || null,
    company_name: 'Two Sigma',
    company_slug: 'twosigma',

    location,
    locations: location ? [location] : [],
    job_city: location,
    job_state: '',

    url: item.link || null,
    apply_url: item.link || null,

    departments: [],
    employment_type: null,

    posted_at: postedAt,
    fetched_at: new Date().toISOString(),

    description: description || null,
  };
}

/**
 * Fetch all Two Sigma jobs from the RSS feed, then enrich with descriptions.
 * @returns {Promise<Array>} normalized jobs
 */
async function fetchAllTwoSigmaJobs() {
  console.log('\n2️⃣ Fetching from Two Sigma...');
  console.log('━'.repeat(60));

  const result = await getHtml(FEED_URL);
  if (!result || result.status !== 200) {
    console.log(`  HTTP ${result?.status || 'error'} — no jobs fetched`);
    return [];
  }

  const items = parseRssItems(result.html);
  console.log(`  RSS: ${items.length} jobs`);

  // Fetch descriptions from individual job pages
  let descCount = 0;
  const jobs = [];
  for (const item of items) {
    const description = await fetchJobDescription(item.link);
    if (description) descCount++;
    jobs.push(normalizeTwoSigmaJob(item, description));
    await delay(DESC_DELAY_MS);
  }

  console.log(`  Descriptions: ${descCount}/${items.length} fetched`);
  console.log(`  Two Sigma total: ${jobs.length} jobs`);
  return jobs;
}

module.exports = { fetchAllTwoSigmaJobs };
