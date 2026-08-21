/**
 * Workday Description Fetcher (DESC-1)
 *
 * Incrementally fetches job descriptions for new Workday jobs.
 * Stores results in a sidecar JSONL file: .github/data/descriptions-workday.jsonl
 * Each line: { id, description_text }
 *
 * Description URL: {baseUrl}/wday/cxs/{tenant}/{site}{externalPath}
 * Response: { jobPostingInfo: { jobDescription: "<HTML>..." } }
 * No auth required — same endpoint as the public career site.
 *
 * Per-run cost: only NEW job IDs not yet in descriptions-workday.jsonl are fetched.
 * In steady state ~3 new Workday jobs/run × 0.4s = ~1s overhead.
 * Initial backfill: ~8000 jobs × 0.4s + 300ms delay ≈ 70 min — done ONCE.
 *
 * Called from index.js after ATS fetch, before writing all_jobs.json.
 */

'use strict';

const https = require('https');
const fs = require('fs');
const readline = require('readline');
const path = require('path');

const DELAY_MS = 150;          // AGG-DESC-SPEED-1: reduced from 300ms (requests go to different tenant subdomains)
const TIMEOUT_MS = 10000;
const MAX_PER_RUN = 2500;      // REVERTED from 3000 (AGG-MISSINGQUEUE-1): 3000 caused desc-backfill runs to time out (>8min, cancelled). The timeout scaling is NOT linear — rate-limit retries + slower tenants add disproportionate time. Back to safe 2500 (runs ~3-4min).
const CONCURRENCY = 20;        // AGG-RUNTIME-ALERT-1: raised from 10
const WD_FETCH_PROXY = process.env.WD_FETCH_PROXY || '';  // AGG-WD-PROXY-ROUTE-1: CF Worker proxy bypasses GHA IP block

// HTML entity map for common entities — no external dep needed
const HTML_ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&nbsp;': ' ', '&ndash;': '–', '&mdash;': '—',
  '&lsquo;': "'", '&rsquo;': "'", '&ldquo;': '"', '&rdquo;': '"',
  '&bull;': '•', '&hellip;': '…',
};

/**
 * Strip HTML tags and decode entities from a description string.
 * Preserves newlines at block element boundaries for readability.
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    // Block elements → newline before stripping
    .replace(/<\/?(p|div|li|br|h[1-6]|ul|ol|section|article)[^>]*>/gi, '\n')
    // Strip all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode named entities
    .replace(/&[a-z]+;/gi, match => HTML_ENTITIES[match] || match)
    // Decode numeric entities &#NNN; and &#xHHH;
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    // Collapse whitespace: multiple spaces → one, multiple blank lines → one
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Build the Workday description URL from stored _raw fields.
 * Pattern: {baseUrl}/wday/cxs/{tenant}/{site}{externalPath}
 * tenant = subdomain of baseUrl (e.g. "ochsner" from "ochsner.wd1.myworkdayjobs.com")
 */
function buildDescUrl(baseUrl, site, externalPath) {
  try {
    const u = new URL(baseUrl);                           // e.g. "ochsner.wd1.myworkdayjobs.com"
    const tenant = u.hostname.split('.')[0];              // e.g. "ochsner"
    // AGG-WD-DESC-URL-BASE-1 hardening: use the ORIGIN, never the raw baseUrl — some
    // tenant sources carry a path-bearing baseUrl and the CXS endpoint is host-rooted.
    // (Live-probed 2026-08-15: current queue baseUrls are host-only; WF 406 / idexx 422
    // are WAF blocks, not malformed URLs — this guards the future shape, not a live bug.)
    return `${u.origin}/wday/cxs/${tenant}/${site}${externalPath}`;
  } catch (_) {
    return null;
  }
}

/**
 * Fetch one URL, return parsed JSON or null on any error/timeout.
 */
function getJson(url) {
  const fetchUrl = WD_FETCH_PROXY ? `${WD_FETCH_PROXY}/?url=${encodeURIComponent(url)}` : url;
  return new Promise((resolve) => {
    const req = https.get(fetchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-board-bot/1.0)', 'X-Proxy-Token': process.env.DATA_PROXY_TOKEN || '' }
    }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        try { resolve(res.statusCode === 200 ? JSON.parse(d) : null); }
        catch (_) { resolve(null); }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * AGG-WORKDAY-DESC-1: Fetch one URL, return HTML string or null.
 * Used as fallback when the CXS detail API returns empty for certain tenants.
 */
function getHtml(url) {
  const fetchUrl = WD_FETCH_PROXY ? `${WD_FETCH_PROXY}/?url=${encodeURIComponent(url)}` : url;
  return new Promise((resolve) => {
    const req = https.get(fetchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-board-bot/1.0)', 'X-Proxy-Token': process.env.DATA_PROXY_TOKEN || '' }
    }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => {
        resolve(res.statusCode === 200 ? d : null);
      });
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * AGG-WORKDAY-DESC-1: Extract job description from WD page HTML meta tag.
 * WD pages include an og:description meta tag with a job summary (~200 chars).
 * Better than null when the CXS detail API returns empty for certain tenants.
 */
function extractMetaDescription(html) {
  if (!html) return null;
  const m = html.match(/<meta\s+name=["']description["']\s+(?:property=["']og:description["']\s+)?content=["']([\s\S]*?)["']/i);
  if (m && m[1] && m[1].length > 50) return m[1];
  return null;
}

/**
 * Load existing descriptions-workday.jsonl → Map<id, description_text>
 */
function loadDescriptions(filePath) {
  const map = new Map();
  if (!fs.existsSync(filePath)) return map;
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const { id, description_text } = JSON.parse(line);
      if (id) map.set(id, description_text);
    } catch (_) { /* skip malformed */ }
  }
  return map;
}

/**
 * Append new descriptions to the JSONL file.
 * LEGACY (AGG-WD-SIDECAR-LIFECYCLE-1): kept for back-compat/tests — the fetch path
 * now writes via writeSidecarCompacted (one line per ID). Raw append is what
 * accumulated duplicate null failure lines every retry cycle.
 */
function appendDescriptions(filePath, entries) {
  if (entries.length === 0) return;
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf8');
}

/**
 * Load sidecar records → Map<id, record> preserving extra fields
 * (schema_version, fail_count, last_fail_at). Merge rule on duplicate lines
 * (AGG-WD-SIDECAR-LIFECYCLE-1): a record with non-null description_text wins
 * over one without; null records keep the highest fail_count seen.
 * This replaces line-counting reads: duplicate null lines historically appended
 * by the retry loop (9.6K excess lines observed 2026-08-14) collapse to one record.
 */
function mergeDescriptionRecord(map, rec) {
  const prev = map.get(rec.id);
  if (!prev) {
    map.set(rec.id, rec);
    return;
  }
  const prevHasDesc = !!prev.description_text;
  const recHasDesc = !!rec.description_text;
  if (prevHasDesc && !recHasDesc) {
    if (rec.fail_count && !prev.fail_count) prev.fail_count = rec.fail_count;
    return;
  }
  if (!prevHasDesc && !recHasDesc &&
      (rec.fail_count || 0) <= (prev.fail_count || 0)) return;
  map.set(rec.id, rec);
}
function loadDescriptionRecords(filePath) {
  const map = new Map();
  if (!fs.existsSync(filePath)) return map;
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const rec = JSON.parse(line);
      if (rec && rec.id) mergeDescriptionRecord(map, rec);
    } catch (_) { /* skip malformed */ }
  }
  return map;
}

/**
 * Stream the sidecar into the same compact record map without materializing the
 * whole file as a string plus an array of lines. Production desc-backfill uses
 * this path because the Workday sidecar grows with the pool.
 */
async function loadDescriptionRecordsStreaming(filePath) {
  const map = new Map();
  if (!fs.existsSync(filePath)) return map;
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && rec.id) mergeDescriptionRecord(map, rec);
      } catch (_) { /* skip malformed */ }
    }
  } finally {
    rl.close();
  }
  return map;
}

const SIDECAR_CHUNK_LIMIT_BYTES = 40 * 1024 * 1024; // AGG Description Sidecar Standard (singular, cross-module)
const FAIL_BACKOFF_THRESHOLD = 3;     // consecutive failures before backing off an ID
const FAIL_BACKOFF_MS = 24 * 60 * 60 * 1000; // re-attempt backed-off IDs after 24h
const POOL_PRUNE_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // AGG-DESC-SPEED-1 pool-churn tolerance (7d, half the TTL window)

/**
 * AGG-WD-SIDECAR-LIFECYCLE-1: compacted, chunked sidecar write (owner helper for the
 * canonical R2 layout of desc-backfill-owned sidecars). Replaces raw append: every write
 * emits ONE line per ID, chunked at 40 MB (same math as lib/utils/sidecar-writer.js —
 * byte-consistent splits, no empty trailing chunks), removes superseded local files
 * (single<->chunked transitions), and optionally prunes records whose IDs are not in the
 * live pool. Returns { writtenFiles, removedFiles, pruned, entries }.
 */
function writeSidecarCompacted(source, records, dataDir, options = {}) {
  const chunkLimit = options.chunkLimit || SIDECAR_CHUNK_LIMIT_BYTES;
  let pruned = 0;
  const now = Date.now();

  // Pool prune with churn grace (AGG-WD-SIDECAR-LIFECYCLE-1, revised after the
  // 2026-08-14 steady-state incident): the WD pool itself oscillates by ~20K jobs
  // per cycle (rotation segments + carry-forward), so evicting every entry absent
  // from ONE cycle's pool reproduced the AGG-DESC-SPEED-1 cache-oscillation bug at
  // pool scale (24,631 -> 4,240 entries in one cycle). Instead: track in_pool_at,
  // refreshed whenever the ID IS in the supplied pool, and evict only entries that
  // have been ABSENT for more than POOL_PRUNE_GRACE_MS (7d, half the TTL window).
  // Only applied when a full-pool ID set is supplied; a missing/empty set (e.g.
  // all_jobs seed failure) means NO prune, never prune-to-empty. Legacy entries
  // without in_pool_at get stamped now, so the upgrade cycle never mass-evicts.
  if (options.poolIds && options.poolIds.size > 0 && !options.keepAll) {
    for (const [id, rec] of records) {
      const inPool = options.poolIds.has(id) || (options.keepIds && options.keepIds.has(id));
      if (inPool) {
        rec.in_pool_at = new Date(now).toISOString();
      } else if (!rec.in_pool_at) {
        rec.in_pool_at = new Date(now).toISOString(); // first observation — grace starts now
      } else if (now - Date.parse(rec.in_pool_at) <= POOL_PRUNE_GRACE_MS) {
        // absent this cycle but inside the grace window — keep (pool churn tolerance)
      } else {
        records.delete(id);
        pruned++;
      }
    }
  }

  if (records.size === 0) {
    // Never write-or-delete an empty sidecar: an empty record set means the seed
    // failed or the source legitimately has no data — preserve whatever exists.
    return { writtenFiles: new Set(), removedFiles: new Set(), pruned: 0, entries: 0 };
  }

  // Stream sorted records into bounded temporary chunks. The prior map+JSON.stringify
  // + join path held a second full object array and a multi-megabyte string in memory.
  const ids = [...records.keys()].sort();
  const tempFiles = [];
  let current = null;
  let fd = null;
  const writtenFiles = new Set();
  try {
    for (const id of ids) {
      const rec = records.get(id);
      const e = { id };
      for (const k of ['description_text', 'schema_version', 'fail_count', 'last_fail_at', 'in_pool_at']) {
        if (rec[k] !== undefined) e[k] = rec[k];
      }
      const line = JSON.stringify(e) + '\n';
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (!current || (current.entries > 0 && current.bytes + lineBytes > chunkLimit)) {
        if (fd !== null) fs.closeSync(fd);
        const tempPath = path.join(dataDir, `.descriptions-${source}-${tempFiles.length + 1}.jsonl.tmp`);
        fd = fs.openSync(tempPath, 'w');
        current = { tempPath, bytes: 0, entries: 0 };
        tempFiles.push(current);
      }
      fs.writeSync(fd, line, null, 'utf8');
      current.bytes += lineBytes;
      current.entries++;
    }
    if (fd !== null) {
      fs.closeSync(fd);
      fd = null;
    }

    for (let i = 0; i < tempFiles.length; i++) {
      const temp = tempFiles[i];
      const fname = tempFiles.length === 1
        ? `descriptions-${source}.jsonl`
        : `descriptions-${source}-${i + 1}.jsonl`;
      fs.renameSync(temp.tempPath, path.join(dataDir, fname));
      writtenFiles.add(fname);
      console.log(`📄 ${fname}: ${temp.entries} entries (${(temp.bytes / 1024 / 1024).toFixed(1)} MB)`);
    }
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    for (const temp of tempFiles) {
      if (fs.existsSync(temp.tempPath)) fs.unlinkSync(temp.tempPath);
    }
    throw error;
  }

  // Remove superseded local files (single<->chunked or chunk-count transitions) so the
  // uploaded set never contains stale leftovers. removedFiles is the R2-prune manifest.
  const removedFiles = new Set();
  const pattern = new RegExp(`^descriptions-${source}(-\\d+)?\\.jsonl$`);
  for (const fname of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) {
    if (!pattern.test(fname)) continue;
    if (writtenFiles.has(fname)) continue;
    fs.unlinkSync(path.join(dataDir, fname));
    removedFiles.add(fname);
    console.log(`🗑️  Removed superseded sidecar file: ${fname}`);
  }
  return { writtenFiles, removedFiles, pruned, entries: records.size };
}

/**
 * AGG-DESC-PRUNE-1: Rewrite the JSONL file, keeping only entries whose IDs are in the current pool.
 * Called when cache size exceeds 110% of pool size (periodic, not every run).
 * Bounds the cache to the current pool — descriptions for retired jobs are evicted.
 * (AGG-WD-SIDECAR-LIFECYCLE-1: pool pruning now also runs inside writeSidecarCompacted
 * against the FULL pool id set; this standalone helper remains for external/test use.)
 */
function pruneDescriptions(filePath, existingMap, poolIds) {
  let pruned = 0;
  for (const id of existingMap.keys()) {
    if (!poolIds.has(id)) { existingMap.delete(id); pruned++; }
  }
  if (pruned > 0) {
    const lines = [];
    for (const [id, description_text] of existingMap) {
      lines.push(JSON.stringify({ id, description_text }));
    }
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
    console.log(`📄 Workday descriptions: pruned ${pruned} stale entries (cache now ${existingMap.size})`);
  }
  return pruned;
}

/**
 * Fetch descriptions for new Workday jobs not yet in descriptions-workday.jsonl.
 *
 * @param {Array} workdayJobs - Normalized Workday job objects (with _raw.baseUrl, _raw.site, _raw.externalPath)
 * @param {string} dataDir - Path to .github/data/
 * @returns {Promise<Map<string,string>>} Full id→description_text map (existing + newly fetched)
 */
async function fetchWorkdayDescriptions(workdayJobs, dataDir, options = {}) {
  const filePath = path.join(dataDir, 'descriptions-workday.jsonl');
  // Stream the sidecar once. The prior path parsed the same growing file twice
  // (full string + split array for each pass), which made memory scale with the
  // entire Workday cache before any requests started.
  const records = await loadDescriptionRecordsStreaming(filePath);
  const toDescriptionMap = () => {
    for (const [id, rec] of records) records.set(id, rec.description_text);
    return records;
  };
  if (options.skipFetch) {
    console.log(`📄 Workday descriptions: skipFetch=true — seeded cache only (${records.size} entries), no new fetch (AGG-RUNTIME-ALERT-1)`);
    return toDescriptionMap();
  }
  // AGG-DESC-SPEED-1: Pruning REMOVED from the fetcher. The pool passed here (workdayJobs)
  // is the CURRENT-RUN fetch output only — it doesn't include carry-forward jobs from
  // tenants not fetched this run. Pruning against this subset was evicting valid descriptions
  // for carry-forward jobs, causing the cache to oscillate (grow +1000, prune -1000 each run).
  // Pool pruning now happens ONLY in writeSidecarCompacted against the FULL pool id set
  // (options.poolIds, supplied by desc-backfill which downloads all_jobs.json).

  // Find jobs not yet described
  let pending = workdayJobs.filter(j => {
    const raw = j._raw || {};
    // AGG-WORKDAY-DESC-1: retry null entries — HTML fallback may succeed where CXS API failed
    const rec = records.get(j.id);
    if (rec?.description_text) return false;
    // AGG-WD-SIDECAR-LIFECYCLE-1: failure backoff — an ID that failed FAIL_BACKOFF_THRESHOLD
    // consecutive attempts within the last FAIL_BACKOFF_MS is skipped this cycle so
    // structurally-blocked tenants stop burning the MAX_PER_RUN budget every run.
    // (Ports ENR 7baf4f5 permanent-only-failCache lesson to the AGG WD path.)
    if (rec && (rec.fail_count || 0) >= FAIL_BACKOFF_THRESHOLD && rec.last_fail_at) {
      const sinceFail = Date.now() - Date.parse(rec.last_fail_at);
      if (isFinite(sinceFail) && sinceFail >= 0 && sinceFail < FAIL_BACKOFF_MS) return false;
    }
    return raw.externalPath && raw.baseUrl && raw.site;
  });

  if (pending.length === 0) {
    console.log(`📄 Workday descriptions: ${records.size} cached, 0 new to fetch`);
    // AGG-WD-SIDECAR-LIFECYCLE-1: still compact — the seeded file may carry duplicate
    // null lines from the legacy append path; an idle cycle is the cheapest time to heal.
    if (records.size > 0) writeSidecarCompacted('workday', records, dataDir, options);
    return toDescriptionMap();
  }

  // DESC-PRIORITY-1: Fetch US jobs first — they're enrichable, non-US are dead weight in sidecar.
  // At Step 1b, tags don't exist yet. Multiple heuristics to catch US jobs:
  //   1. job_state (set by parseWorkdayLocation for "City, ST" format)
  //   2. is_us_only flag (set for tenants with campus-only locations)
  //   3. "United States" in location text
  //   4. ", XX" at end of location where XX is a 2-letter state abbreviation
  //   5. Common US city names in location text
  const US_ABBRS = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);
  const US_CITY_RE = /\b(new york|los angeles|chicago|houston|phoenix|philadelphia|san antonio|san diego|dallas|san jose|austin|seattle|denver|boston|nashville|portland|atlanta|minneapolis|tampa|orlando|raleigh|charlotte|columbus|pittsburgh|detroit|salt lake|san francisco|washington)\b/i;
  const isLikelyUS = (j) => {
    if (j.job_state || j.is_us_only) return true;
    const loc = j.location || '';
    if (loc.includes('United States') || /^US\s*[-–—]/.test(loc)) return true;
    const m = loc.match(/,\s*([A-Z]{2})\s*$/);
    if (m && US_ABBRS.has(m[1])) return true;
    if (US_CITY_RE.test(loc)) return true;
    // Check URL slug for US state names (catches "N Locations" postings)
    const url = j.url || '';
    if (/\/(california|texas|new-york|florida|illinois|pennsylvania|ohio|georgia|north-carolina|michigan|virginia|washington|arizona|massachusetts|colorado|minnesota|maryland|oregon|indiana|tennessee|missouri|connecticut|utah|iowa|kentucky|alabama|louisiana|south-carolina|oklahoma|wisconsin|nevada|arkansas|mississippi|kansas|nebraska|idaho|new-jersey|new-mexico|west-virginia|hawaii|montana|delaware|rhode-island|south-dakota|north-dakota|alaska|wyoming|maine|vermont|new-hampshire|district-of-columbia)[\/\-]/i.test(url)) return true;
    return false;
  };
  pending.sort((a, b) => (isLikelyUS(b) ? 1 : 0) - (isLikelyUS(a) ? 1 : 0));

  // AGG-DESC-SPEED-1: Tenant-interleave the pending list so concurrent requests
  // hit DIFFERENT workday subdomains. Without this, same-tenant jobs cluster
  // (fetched together) and a batch of 10 would hammer one server.
  const tenantOf = (j) => {
    const m = (j._raw?.baseUrl || '').match(/\/\/([^.]+)/);
    return m ? m[1] : 'unknown';
  };
  const usPending = pending.filter(isLikelyUS);
  const nonUsPending = pending.filter(j => !isLikelyUS(j));
  const interleave = (arr) => {
    const groups = new Map();
    for (const job of arr) {
      const t = tenantOf(job);
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(job);
    }
    const out = [];
    while (groups.size > 0) {
      for (const [t, jobs] of groups) {
        out.push(jobs.shift());
        if (jobs.length === 0) groups.delete(t);
      }
    }
    return out;
  };
  pending = [...interleave(usPending), ...interleave(nonUsPending)];

  // Cap to MAX_PER_RUN — remainder is deferred to next run (incremental backfill)
  const batch = pending.slice(0, MAX_PER_RUN);
  const deferred = pending.length - batch.length;
  console.log(`📄 Workday descriptions: ${records.size} cached, ${pending.length} new (fetching ${batch.length}${deferred > 0 ? `, deferring ${deferred}` : ''})...`);

  let fetched = 0;
  let failed = 0;

  // AGG-DESC-SPEED-1: Concurrent fetch (CONCURRENCY parallel requests to different tenants).
  // Each request targets a different workday subdomain — no single-server load.
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const slice = batch.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map(async (job) => {
      const { baseUrl, site, externalPath } = job._raw;
      const url = buildDescUrl(baseUrl, site, externalPath);
      if (!url) return { job, data: null };
      let data = await (options.getJson || getJson)(url);
      // AGG-WORKDAY-DESC-1: HTML fallback when CXS API returns null (Wells Fargo, LabCorp, etc.)
      if (!data) {
        const pageUrl = `${baseUrl}/en-US/${site}${externalPath}`;
        const html = await (options.getHtml || getHtml)(pageUrl);
        const metaDesc = extractMetaDescription(html);
        if (metaDesc) {
          data = { jobPostingInfo: { jobDescription: metaDesc } };
        }
      }
      return { job, data };
    }));

    for (const { job, data } of results) {
      const rawHtml = data?.jobPostingInfo?.jobDescription || null;
      const description_text = rawHtml ? stripHtml(rawHtml) : null;
      if (description_text) {
        records.set(job.id, { id: job.id, description_text });
        fetched++;
      } else {
        // AGG-WD-SIDECAR-LIFECYCLE-1: failure records carry fail_count/last_fail_at so
        // persistently-blocked tenants back off instead of re-appending a null line and
        // burning the MAX_PER_RUN budget every cycle.
        const prevRec = records.get(job.id);
        const failRec = {
          id: job.id,
          description_text: null,
          fail_count: ((prevRec && prevRec.fail_count) || 0) + 1,
          last_fail_at: new Date().toISOString(),
        };
        records.set(job.id, failRec);
        failed++;
      }
    }

    await delay(DELAY_MS);
  }

  // AGG-WD-SIDECAR-LIFECYCLE-1: compacted rewrite — one line per ID, chunked at 40 MB,
  // optional pool prune. Replaces appendDescriptions (which appended a duplicate null
  // line per failed retry: 9.6K excess lines / unbounded growth, observed 2026-08-14).
  writeSidecarCompacted('workday', records, dataDir, options);
  console.log(`📄 Workday descriptions: fetched ${fetched}, failed/empty ${failed}`);

  return toDescriptionMap();
}

module.exports = {
  fetchWorkdayDescriptions,
  buildDescUrl,
  stripHtml,
  loadDescriptions,
  appendDescriptions,
  pruneDescriptions,
  loadDescriptionRecords,
  loadDescriptionRecordsStreaming,
  writeSidecarCompacted,
  FAIL_BACKOFF_THRESHOLD,
  FAIL_BACKOFF_MS,
};
