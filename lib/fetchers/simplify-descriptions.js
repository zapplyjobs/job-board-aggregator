/**
 * Simplify Description Fetcher
 *
 * Fetches job descriptions from each simplify job's own career-page URL.
 * Simplify provides title+URL only (T0). This fetcher visits the company's
 * actual career page and extracts the description text — so the jobs gain
 * descriptions from the first-party source without depending on simplify for content.
 *
 * AGG-SIMPLIFY-EXIT-1 (2026-07-05): transitional — while simplify companies
 * can't all be replaced with direct fetchers, this at least gives their jobs
 * descriptions so the bridge stops dropping them.
 *
 * Pattern: same as workday-descriptions.js (cache + incremental + bounded).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { getHtml, delay } = require('./http-client');

const MAX_PER_RUN = 50;
const DELAY_MS = 300;
const TIMEOUT_MS = 5000;
const MIN_DESC_LENGTH = 200;

function loadDescriptions(filePath) {
  const existing = new Map();
  if (!fs.existsSync(filePath)) return existing;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      // AGG-SIMPLIFY-EXIT-1 fix: load ALL entries (including misses with empty text)
      // so cached misses aren't re-fetched every run.
      if (entry.id) {
        existing.set(entry.id, entry.description_text || '');
      }
    } catch (e) { /* skip malformed */ }
  }
  return existing;
}

function appendDescriptions(filePath, entries) {
  const data = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(filePath, data, 'utf8');
}

function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractDescription(text) {
  if (!text || text.length < MIN_DESC_LENGTH) return null;

  // Try to find the job description section (common markers)
  const markers = [
    /(?:responsibilit(?:y|ies)|about the role|about this role|job description|what you['']?ll do|what you will do|the role|position summary|overview)\b/i,
    /(?:qualifications?|requirements?|what you need|minimum requirements?|preferred qualifications?|skills?)\b/i,
  ];

  // Find the start of the description content
  let startIdx = -1;
  for (const marker of markers) {
    const m = text.match(marker);
    if (m && m.index > 50 && m.index < text.length * 0.8) {
      startIdx = m.index;
      break;
    }
  }

  // If we found a marker, extract from there to the end (or a reasonable limit)
  if (startIdx >= 0) {
    const desc = text.substring(startIdx, startIdx + 10000).trim();
    return desc.length >= MIN_DESC_LENGTH ? desc : null;
  }

  // Fallback: take the longest paragraph block (the description is usually the biggest text chunk)
  const blocks = text.split(/\n{2,}/).filter(b => b.trim().length >= MIN_DESC_LENGTH);
  if (blocks.length === 0) return null;

  // Combine the largest consecutive blocks (up to 10K chars)
  blocks.sort((a, b) => b.length - a.length);
  let result = blocks[0];
  for (let i = 1; i < blocks.length && result.length < 8000; i++) {
    result += '\n\n' + blocks[i];
  }

  return result.length >= MIN_DESC_LENGTH ? result.slice(0, 10000) : null;
}

async function fetchSimplifyDescriptions(simplifyJobs, dataDir) {
  const filePath = path.join(dataDir, 'descriptions-simplify.jsonl');
  const existing = loadDescriptions(filePath);

  // Find jobs not yet described
  const pending = simplifyJobs.filter(j => !existing.has(j.id) && j.url && j.url.startsWith('http'));

  if (pending.length === 0) {
    console.log(`📄 Simplify descriptions: ${existing.size} cached, 0 new to fetch`);
    return existing;
  }

  // Prioritize US jobs (same heuristic as workday-descriptions)
  const US_ABBRS = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);
  const isLikelyUS = (j) => {
    const loc = j.location || j.job_city || '';
    if (loc.includes('United States') || loc.includes('USA')) return true;
    const m = loc.match(/,\s*([A-Z]{2})\s*$/);
    if (m && US_ABBRS.has(m[1])) return true;
    return /\b(seattle|san francisco|new york|austin|boston|chicago|los angeles|palo alto|mountain view|sunnyvale|san jose|denver|atlanta|dallas|houston|phoenix|portland|washington|remote|remote-us)\b/i.test(loc);
  };

  const usFirst = pending.sort((a, b) => {
    const aUS = isLikelyUS(a) ? 0 : 1;
    const bUS = isLikelyUS(b) ? 0 : 1;
    return aUS - bUS;
  });

  const toFetch = usFirst.slice(0, MAX_PER_RUN);
  const deferred = usFirst.length - toFetch.length;
  console.log(`📄 Simplify descriptions: ${existing.size} cached, ${pending.length} new (fetching ${toFetch.length}, deferring ${deferred})`);

  const newEntries = [];
  let fetched = 0;
  let failed = 0;

  for (const job of toFetch) {
    try {
      const html = await getHtml(job.url, { timeout: TIMEOUT_MS, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml' } });
      if (!html || html.length < 500) {
        newEntries.push({ id: job.id, url: job.url, description_text: '', _reason: html ? 'short:'+html.length : 'null' });
        existing.set(job.id, '');
        failed++; continue;
      }

      const text = stripHtml(html);
      const desc = extractDescription(text);

      if (desc) {
        newEntries.push({ id: job.id, url: job.url, description_text: desc });
        existing.set(job.id, desc);
        fetched++;
      } else {
        // Cache the miss so we don't re-fetch (but mark it as empty)
        newEntries.push({ id: job.id, url: job.url, description_text: '', _miss: true });
        existing.set(job.id, '');
        failed++;
      }
    } catch (e) {
      // Network error, 403, timeout, etc. — cache the miss
      newEntries.push({ id: job.id, url: job.url, description_text: '', _error: e.message });
      existing.set(job.id, '');
      failed++;
    }

    await delay(DELAY_MS);
  }
  // Append to cache + log diagnostics
  if (newEntries.length > 0) {
    appendDescriptions(filePath, newEntries);
    // Diagnostic: confirm the file was written
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    console.log(`  📝 Wrote ${newEntries.length} entries to ${path.basename(filePath)} (file: ${stat ? stat.size + ' bytes' : 'MISSING'})`);
  } else {
    console.log(`  ⚠️ No entries to cache (newEntries empty — all fetches hit continue before push?)`);
  }
  // Diagnostic: show first fetch result for debugging
  if (toFetch.length > 0) {
    const sample = newEntries[0];
    console.log(`  🔍 Sample: url=${(toFetch[0].url||'').slice(0,60)} result=${sample ? (sample.description_text ? 'DESC(' + sample.description_text.length + ' chars)' : 'MISS(' + (sample._reason || sample._error || 'empty') + ')') : 'NOT_IN_ENTRIES'}`);
  }

  console.log(`  fetched ${fetched} descriptions, ${failed} failed/empty (cached to avoid re-fetch)`);
  return existing;
}

module.exports = { fetchSimplifyDescriptions };
