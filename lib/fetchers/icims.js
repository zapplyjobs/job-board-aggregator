'use strict';

const { getHtml } = require('./http-client');

const USER_AGENT = 'Mozilla/5.0 (compatible; job-board-bot/1.0)';
const DEFAULT_MAX_PAGES = 15;
const DEFAULT_MAX_ROWS_PER_TENANT = 300;
const DEFAULT_LISTING_TIMEOUT_MS = 20000;
const DEFAULT_DETAIL_TIMEOUT_MS = 15000;

function decodeHtmlEntities(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  );
}

function normalizeTenantKey(host) {
  return String(host || '').toLowerCase().replace(/\.icims\.com$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildListingUrl(host, pageIndex) {
  if (pageIndex <= 0) return `https://${host}/jobs/search?ss=1&in_iframe=1`;
  return `https://${host}/jobs/search?pr=${pageIndex}&in_iframe=1`;
}

function buildCookStaleUrl(jobId, slug) {
  return `https://americas-cookmedical.icims.com/jobs/${jobId}/${slug}/job`;
}

function parsePageCount(html) {
  const text = stripHtml(html);
  const match = text.match(/Search Results Page\s+(\d+)\s+of\s+(\d+)/i);
  if (match) return { currentPage: Number(match[1]), totalPages: Number(match[2]) };
  const pageMatches = [...String(html || '').matchAll(/\/jobs\/search\?pr=(\d+)/gi)]
    .map(m => Number(m[1]))
    .filter(Number.isFinite);
  if (!pageMatches.length) return null;
  return { currentPage: 1, totalPages: Math.max(...pageMatches) + 1 };
}

function parseListingCards(html) {
  const cards = [];
  const seen = new Set();
  const regex = /<a\s+href="([^"]*\/jobs\/(\d+)\/[^"?#]+\/job\?in_iframe=1[^"]*)"[^>]*title="(\d+)\s*-\s*([^"]+)"[^>]*>[\s\S]*?<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    const jid = String(match[2]);
    if (seen.has(jid)) continue;
    seen.add(jid);
    cards.push({
      jid,
      href,
      title: decodeHtmlEntities(match[4]).trim(),
    });
  }
  return cards;
}

function parseCanonical(html) {
  const match = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i);
  return match ? decodeHtmlEntities(match[1]).trim() : null;
}

function parseMetaDescription(html) {
  const og = html.match(/<meta\s+property="og:description"\s+content="([\s\S]*?)"\s*\/?>/i);
  if (og) return decodeHtmlEntities(og[1]).replace(/\s+/g, ' ').trim();
  const prop = html.match(/<meta\s+property="description"\s+content="([\s\S]*?)"\s*\/?>/i);
  if (prop) return decodeHtmlEntities(prop[1]).replace(/\s+/g, ' ').trim();
  const name = html.match(/<meta\s+name="description"\s+content="([\s\S]*?)"\s*\/?>/i);
  return name ? decodeHtmlEntities(name[1]).replace(/\s+/g, ' ').trim() : null;
}

function parseIcimsStructuredData(html) {
  const match = html.match(/var\s+icimsSD\s*=\s*(\{[\s\S]*?\});/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function parseDataLayer(html) {
  const match = html.match(/dataLayer\s*=\s*(\[[\s\S]*?\]);/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed[0] : null;
  } catch {
    return null;
  }
}

function normalizePostedAt(dataLayer) {
  const posted = dataLayer?.job?.postedDate;
  if (!posted) return null;
  const iso = new Date(posted).toISOString();
  return iso === 'Invalid Date' ? null : iso;
}

function normalizeIcimsJob(tenant, listingCard, detailHtml) {
  const icimsSD = parseIcimsStructuredData(detailHtml);
  const dataLayer = parseDataLayer(detailHtml);
  const canonical = parseCanonical(detailHtml);
  const publicUrl = canonical || icimsSD?.job?.jobUrls?.[0]?.url || null;
  const jobId = String(icimsSD?.job?.jid || listingCard.jid || '').trim();
  if (!jobId) return null;
  const title = decodeHtmlEntities(icimsSD?.job?.title || listingCard.title || '').trim() || null;
  const location = decodeHtmlEntities(icimsSD?.job?.location || '').trim() || null;
  const description = parseMetaDescription(detailHtml) || null;
  return {
    id: `icims-${tenant.tenantKey}-${jobId}`,
    source: 'icims',
    source_id: jobId,
    title,
    company_name: tenant.companyName,
    company_slug: tenant.companySlug,
    location,
    url: publicUrl,
    source_url: publicUrl,
    posted_at: normalizePostedAt(dataLayer),
    first_published: normalizePostedAt(dataLayer),
    description,
    fetched_at: new Date().toISOString(),
  };
}

async function fetchTenantPage(host, pageIndex, timeoutMs) {
  const url = buildListingUrl(host, pageIndex);
  const result = await getHtml(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.5' },
    timeout: timeoutMs,
  });
  if (!result) return { status: 'request_failed', url, html: null, cards: [], pageInfo: null };
  if (result.status !== 200 || !result.html) return { status: `http_${result.status}`, url, html: result.html || null, cards: [], pageInfo: null };
  return {
    status: 'ok',
    url,
    html: result.html,
    cards: parseListingCards(result.html),
    pageInfo: parsePageCount(result.html),
  };
}

async function fetchTenantJobs(tenant, options = {}) {
  const {
    maxPages = DEFAULT_MAX_PAGES,
    maxRowsPerTenant = DEFAULT_MAX_ROWS_PER_TENANT,
    listingTimeoutMs = DEFAULT_LISTING_TIMEOUT_MS,
    detailTimeoutMs = DEFAULT_DETAIL_TIMEOUT_MS,
  } = options;
  const jobs = [];
  const seenIds = new Set();
  const stats = {
    host: tenant.host,
    tenant_key: tenant.tenantKey,
    pages_loaded: 0,
    cards_seen: 0,
    details_loaded: 0,
    stale_details: 0,
    skipped_details: 0,
    last_page_seen: null,
  };

  for (let pageIndex = 0; pageIndex < maxPages && jobs.length < maxRowsPerTenant; pageIndex++) {
    const page = await fetchTenantPage(tenant.host, pageIndex, listingTimeoutMs);
    if (page.status !== 'ok') break;
    stats.pages_loaded++;
    if (page.pageInfo?.totalPages) stats.last_page_seen = page.pageInfo.totalPages;
    let newCards = 0;
    for (const card of page.cards) {
      if (seenIds.has(card.jid)) continue;
      seenIds.add(card.jid);
      newCards++;
      stats.cards_seen++;
      const detailUrl = card.href.replace(/\?in_iframe=1.*/, '?mobile=true&needsRedirect=false');
      const detail = await getHtml(detailUrl, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.5' },
        timeout: detailTimeoutMs,
      });
      if (!detail) {
        stats.skipped_details++;
        continue;
      }
      if (detail.status === 404 || detail.status === 410) {
        stats.stale_details++;
        continue;
      }
      if (detail.status !== 200 || !detail.html) {
        stats.skipped_details++;
        continue;
      }
      const normalized = normalizeIcimsJob(tenant, card, detail.html);
      if (!normalized) {
        stats.skipped_details++;
        continue;
      }
      stats.details_loaded++;
      jobs.push(normalized);
      if (jobs.length >= maxRowsPerTenant) break;
    }
    if (newCards === 0) break;
    if (page.pageInfo?.totalPages && pageIndex + 1 >= page.pageInfo.totalPages) break;
  }

  return { jobs, stats };
}

async function checkStaleDetail(detailUrl, timeoutMs = DEFAULT_DETAIL_TIMEOUT_MS) {
  const detail = await getHtml(detailUrl, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.5' },
    timeout: timeoutMs,
  });
  return { url: detailUrl, status: detail?.status || null };
}

async function fetchAllIcimsJobs(tenants, options = {}) {
  console.log('\n🧩 Fetching bounded iCIMS proof...');
  console.log('━'.repeat(60));
  const jobs = [];
  const stats = { tenants: {}, stale_checks: [] };
  for (const tenant of tenants || []) {
    const normalizedTenant = {
      ...tenant,
      tenantKey: tenant.tenantKey || normalizeTenantKey(tenant.host),
    };
    console.log(`  Tenant ${normalizedTenant.tenantKey}: ${normalizedTenant.host}`);
    const result = await fetchTenantJobs(normalizedTenant, options);
    stats.tenants[normalizedTenant.tenantKey] = result.stats;
    jobs.push(...result.jobs);
    console.log(`    pages=${result.stats.pages_loaded} jobs=${result.jobs.length} stale=${result.stats.stale_details} skipped=${result.stats.skipped_details}`);
  }
  for (const stale of options.staleDetails || []) {
    const staleUrl = stale.url || buildCookStaleUrl(stale.jobId, stale.slug);
    const result = await checkStaleDetail(staleUrl, options.detailTimeoutMs || DEFAULT_DETAIL_TIMEOUT_MS);
    stats.stale_checks.push(result);
    console.log(`  Stale probe ${staleUrl} -> HTTP ${result.status ?? 'null'}`);
  }
  return { jobs, stats };
}

module.exports = {
  fetchAllIcimsJobs,
  parseListingCards,
  parsePageCount,
  parseIcimsStructuredData,
  parseDataLayer,
  normalizeIcimsJob,
  normalizeTenantKey,
};
