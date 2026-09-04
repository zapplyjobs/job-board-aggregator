/**
 * Oracle HCM Cloud Jobs Fetcher (Multi-Company)
 *
 * Fetches jobs from Oracle HCM Cloud public REST API for multiple companies.
 * Each company has its own Oracle HCM instance (base_url) and site_number.
 *
 * API: GET /hcmRestApi/resources/latest/recruitingCEJobRequisitions
 * Params: onlyData=true, finder=findReqs;siteNumber=X,expand=requisitionList
 * Pagination: offset/limit inside finder param. 25/page.
 *
 * Detail API: GET /hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
 * Params: onlyData=true, finder=ById;Id="<jobId>",siteNumber=<site>
 *
 * No authentication required. Backward compat: called without args, uses Oracle Corp.
 */

'use strict';

const { getJson, delay } = require('./http-client');

const PAGE_SIZE = 200;
const DELAY_MS = 100;
const DETAIL_DELAY_MS = 100;
// AGG-ORACLE-DEPT: raised from 100. The detail fetch is the only source of Oracle Category
// (the LIST API returns NULL for Department/JobFamily), so the cap also bounds department
// capture. Combined with the pipeline's department-aware sidecar cache (skip jobs whose
// department is already captured), 250 lets US Oracle generals be reached progressively
// (~33s/run at concurrency 4) without re-fetching already-captured jobs. See normalizeOracleJob.
const MAX_DETAIL_FETCHES = 1500;     // AGG-ORACLE-DESC-TRUNCATION-1 (2026-08-02): raised from 750 — ENR check-34 found 62% of oracle descriptions are truncated (<200 chars, median 131). LIST API returns only ShortDescriptionStr (187 chars); DETAIL API returns 23K+ chars (ShortDesc + Responsibilities + Qualifications). At 750/run, only ~11% of 6900 jobs get full desc per cycle → 62% stuck with truncated list-only desc. At 1500: ~22%/cycle. STALE-MATH WARNING (2026-09-02, P3.3 dry run): the 'backlog clears in ~3 runs' estimate was written at 6.9K positions — at 42K+ uncached the cap binds EVERY run (3.6% coverage); see lib/metadata/ENR co-review + allocateOracleDetails. Runtime ~198s. Previous: 100→250→750→1500.
const DETAIL_CONCURRENCY = 8;        // AGG-ORACLE-DESC-TRUNCATION-1: raised from 6→8 to keep runtime under 5min target despite 1500 fetches.
const DETAIL_TITLE_WEIGHTS = [
  [/\b(software|developer|programming)\b/i, 90],
  [/\b(ai|automation|cloud|data|database|linux|network|python|rpa|security|systems?)\b/i, 70],
  [/\b(analog|circuit|controls?|electrical|hardware|mechanical|mixed signal|plc|test)\b/i, 60],
  [/\b(engineer(?:ing)?|information technology|it|technical|technology)\b/i, 50],
  [/\b(analytics?|facilities|materials)\b/i, 30],
];
const LOW_DETAIL_TITLE_RE = /\b(chaplain|clinician|medical|nurse|nursing|phlebotomist|physician|registered nurse|therapist)\b/i;

function oracleDetailPriorityScore(target) {
  const title = String(target.job?.Title || '');
  const location = String(target.job?.PrimaryLocation || '');
  let score = 0;
  for (const [pattern, weight] of DETAIL_TITLE_WEIGHTS) {
    if (pattern.test(title)) score += weight;
  }
  if (/\bintern(ship)?\b/i.test(title)) score += 20;
  if (/United States|, [A-Z]{2}, US\b/i.test(location)) score += 10;
  if (LOW_DETAIL_TITLE_RE.test(title)) score -= 100;
  return score;
}


// AGG-DEEPPASS-P3-EXEC-1 P3.3 v2.1 (2026-09-02): detail allocation = floor + weighted remainder
// + monopoly cap. Co-reviewed with ENR (ENR-ORACLE-DETAIL-DEFICIT-COREVIEW-1, closed): conditions —
// (a) floor slices take TOP-SCORED rows per tenant, never iteration order; (b) the short-desc
// skip class (persist the 187-char LIST short-description, skip the detail fetch) must EXCLUDE
// any row with a tech-title signal (DETAIL_TITLE_WEIGHTS match). Live context: 42K uncached
// targets vs 1500/run — allocation fairness is the design, not total coverage.
const DETAIL_FLOOR_PER_TENANT = 30;   // every tenant's top-scored rows get details each run
const DETAIL_MONOPOLY_CAP = 300;      // no tenant consumes more than this share of the budget

function detailWeightMatches(target) {
  const title = String(target.job?.Title || '');
  return DETAIL_TITLE_WEIGHTS.some(([pattern]) => pattern.test(title));
}

function isShortDescOnlyTarget(target) {
  // ENR condition (b): skip class = LOW_DETAIL rows with NO tech-title signal.
  // Those persist the LIST short-description instead of fetching 23K-char detail.
  return LOW_DETAIL_TITLE_RE.test(String(target.job?.Title || '')) && !detailWeightMatches(target);
}

/**
 * Allocate `targets` across `budget` detail fetches.
 * Pure: returns { fetch, shortDescOnly } — caller persists short-desc for shortDescOnly.
 * Order: floor pass (top-scored per tenant, ENR condition a) -> weighted remainder
 * -> monopoly cap per tenant.
 */
function allocateOracleDetails(targets, budget = MAX_DETAIL_FETCHES) {
  const shortDescOnly = targets.filter(isShortDescOnlyTarget);
  const eligible = targets.filter(t => !isShortDescOnlyTarget(t));
  const scored = eligible
    .map(t => ({ t, score: oracleDetailPriorityScore(t) }))
    .sort((a, b) => b.score - a.score);

  const byTenant = new Map();
  for (const s of scored) {
    const key = s.t.company.slug || s.t.company.name || 'unknown';
    if (!byTenant.has(key)) byTenant.set(key, []);
    byTenant.get(key).push(s);
  }

  const chosen = new Set();
  let used = 0;
  // Floor pass: round-robin level-by-level so every tenant's floor is honored
  // fairly even when total floor demand exceeds the budget (top-scored first
  // within each tenant — ENR condition (a): never iteration order).
  // Tenant visit order for the floor = best tenant score first, so a starved
  // budget still lands floors on the highest-value tenants (fairness ACROSS
  // levels, quality WITHIN the order). Deterministic tie-break by slug.
  const tenantLists = [...byTenant.entries()]
    .sort((a, b) => (b[1][0]?.score || 0) - (a[1][0]?.score || 0) || a[0].localeCompare(b[0]))
    .map(([, list]) => list);
  for (let level = 0; level < DETAIL_FLOOR_PER_TENANT && used < budget; level++) {
    for (const list of tenantLists) {
      if (used >= budget) break;
      if (level < list.length) { chosen.add(list[level].t); used++; }
    }
  }
  // Weighted remainder with monopoly cap
  const perTenantUsed = new Map();
  for (const t of chosen) {
    const key = t.company.slug || t.company.name || 'unknown';
    perTenantUsed.set(key, (perTenantUsed.get(key) || 0) + 1);
  }
  for (const s of scored) {
    if (used >= budget) break;
    if (chosen.has(s.t)) continue;
    const key = s.t.company.slug || s.t.company.name || 'unknown';
    if ((perTenantUsed.get(key) || 0) >= DETAIL_MONOPOLY_CAP) continue;
    chosen.add(s.t);
    perTenantUsed.set(key, (perTenantUsed.get(key) || 0) + 1);
    used++;
  }
  const fetch = scored.map(s => s.t).filter(t => chosen.has(t));
  return { fetch, shortDescOnly };
}

function listFloorCount(list, chosenSet) {
  let n = 0;
  for (const s of list) if (chosenSet.has(s.t)) n++;
  return n;
}

function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseLocation(locStr) {
  if (!locStr) return { location: null, job_city: null, job_state: null, country: null };

  const parts = locStr.split(',').map(s => s.trim());

  if (parts.length >= 3) {
    const city = parts[0];
    const state = parts[1];
    const country = parts[2];
    return {
      location: `${city}, ${state}, ${country}`,
      job_city: city,
      job_state: (country === 'United States' || country === 'Canada') ? state : null,
      country,
    };
  }

  if (parts.length === 2) {
    const state = parts[0];
    const country = parts[1];
    return {
      location: locStr,
      job_city: null,
      job_state: country === 'United States' ? state : null,
      country,
    };
  }

  return { location: locStr, job_city: null, job_state: null, country: parts[0] };
}

function buildDescription(baseJob, detailJob) {
  const src = detailJob || baseJob;
  const parts = [];

  // AGG-ORACLE-DESC-TRUNCATION-1 (2026-08-02): Oracle HCM Cloud companies use
  // DIFFERENT field names for full descriptions. Oracle/Atlantic/Cummins use
  // ExternalResponsibilitiesStr+ExternalQualificationsStr; JPMorgan (6.8K jobs)
  // and most others use ExternalDescriptionStr (4K+ chars). Without this field,
  // 62% of oracle descriptions were truncated to the 101-char ShortDescriptionStr.
  const externalDesc = stripHtml(src.ExternalDescriptionStr || '');
  if (externalDesc) {
    parts.push(externalDesc);
  } else {
    // Fallback to the original field structure (used by Oracle/Atlantic/Cummins)
    const shortDesc = stripHtml(src.ShortDescriptionStr || baseJob.ShortDescriptionStr || '');
    if (shortDesc) parts.push(shortDesc);

    const responsibilities = stripHtml(src.ExternalResponsibilitiesStr || '');
    if (responsibilities) parts.push('Responsibilities:\n' + responsibilities);

    const qualifications = stripHtml(src.ExternalQualificationsStr || '');
    if (qualifications) parts.push('Qualifications:\n' + qualifications);
  }

  return parts.length ? parts.join('\n\n') : null;
}

// AGG-ORACLE-LOCATIONS-MISSING-1: a tenant missing `slug` in company-list.json must
// never leak the literal string "undefined" into ids and company_slug (909 Fortinet
// rows carried oracle-undefined-*). Fall back to a slugified name; ids re-key once
// when this deploys and the old-id copies drain by TTL.
function companySlugOf(company) {
  if (company && company.slug) return company.slug;
  const slug = String((company && company.name) || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unknown';
}

function normalizeOracleJob(job, company, detailJob = null) {
  const src = detailJob || job;
  const loc = parseLocation(src.PrimaryLocation || job.PrimaryLocation);
  const jobId = String(job.Id);
  const jobUrl = `${company.base_url}/hcmUI/CandidateExperience/en/sites/${company.site_number}/job/${jobId}`;

  const postedAt = (src.PostedDate || job.PostedDate)
    ? new Date((src.PostedDate || job.PostedDate) + 'T00:00:00Z').toISOString()
    : null;

  // AGG-ORACLE-DEPT: Oracle's LIST API returns NULL for Department/JobFamily, but the DETAIL
  // API (recruitingCEJobRequisitionDetails, expand=all) populates Category — the company's own
  // broad bucket (e.g. "Product Development", "Sales", "Manufacturing", "Finance & Accounting").
  // Surfacing it as a department lets the tag-engine classify Oracle jobs by domain instead of
  // leaving them "general" (Oracle was ~17% of all US generals). JobFunction is intentionally NOT
  // used: it is NULL for some tenants (onsemi) and a grade level for others (Cummins "Exempt -
  // Specialist (CC01)"). The pipeline persists departments in the description sidecar so they
  // survive the description-cache skip on subsequent runs.
  //
  // Soundness: a few Categories are suppressed because the tag-engine's GLOBAL dept rules would
  // misroute them, and a global guard is not viable (it would break correct classifications for
  // other sources — e.g. 60+ defense/aerospace "Mission Systems Engineering" jobs are legitimately
  // hardware). Suppression is therefore Oracle-scoped here; suppressed jobs stay "general" and
  // fall back to title-based classification (no harm, just no gain):
  //   - "Systems Engineering" WITHOUT a hardware keyword -> hardware rule (Nokia SW/systems roles).
  //     Genuine hardware Categories carry Hardware/Test/Mechanical/Electrical and pass through.
  //   - "Product Dev" abbreviated (NOT "Product Development") -> product rule. At semiconductor
  //     companies (TI) this is chip-design hardware, not product management. "Product Development"
  //     is kept (-> software).
  //   - bare "Information Technology" / "Technology" -> software rule. Too coarse (spans IT ops,
  //     network ops, admin); let the title layer decide instead.
  //   - "Industrial Engineering" -> hardware rule. Often manufacturing/process engineering, not HW.
  let departments = [];
  if (detailJob && detailJob.Category) {
    const category = String(detailJob.Category).trim();
    const hasHardwareKw = /\b(hardware|electrical|mechanical|embedded|firmware|rf|antenna|circuit|analog|mixed signal|test)\b/i.test(category);
    const isAmbiguous =
      (/\bsystems? engineer/i.test(category) && !hasHardwareKw) ||
      /\bproduct dev(?!elopment)/i.test(category) ||
      /^information technology$/i.test(category) ||
      /^technology$/i.test(category) ||
      /\bindustrial engineering/i.test(category);
    if (!isAmbiguous) departments.push(category);
  }

  return {
    id: `oracle-${companySlugOf(company)}-${jobId}`,
    source: 'oracle',
    source_id: jobId,

    title: (src.Title || job.Title || '').trim() || null,
    company_name: company.name,
    company_slug: companySlugOf(company),

    location: loc.location,
    locations: loc.location ? [loc.location] : [],
    job_city: loc.job_city,
    job_state: loc.job_state,

    url: jobUrl,
    apply_url: jobUrl,

    departments,
    employment_type: src.WorkerType || job.WorkerType || null,

    posted_at: postedAt,
    fetched_at: new Date().toISOString(),

    description: buildDescription(job, detailJob),
  };
}

async function fetchJobDetail(company, jobId) {
  const baseUrl = company.base_url.replace(/\/$/, '');
  const apiPath = '/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails';
  const finderParam = `ById;Id="${jobId}",siteNumber=${company.site_number}`;
  const url = `${baseUrl}${apiPath}?expand=all&onlyData=true&finder=${encodeURIComponent(finderParam)}`;
  const result = await getJson(url);
  if (!result || result.status !== 200 || !Array.isArray(result.data?.items) || result.data.items.length === 0) {
    return null;
  }
  return result.data.items[0];
}

async function fetchOracleDetails(detailTargets) {
  const details = new Map();

  for (let i = 0; i < detailTargets.length; i += DETAIL_CONCURRENCY) {
    const batch = detailTargets.slice(i, i + DETAIL_CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async ({ company, jobId, normalizedId }) => {
      const detail = await fetchJobDetail(company, jobId).catch(() => null);
      return { normalizedId, detail };
    }));

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.detail) {
        details.set(result.value.normalizedId, result.value.detail);
      }
    }

    if (i + DETAIL_CONCURRENCY < detailTargets.length) {
      await delay(DETAIL_DELAY_MS);
    }
  }

  return details;
}

async function fetchCompanyJobs(company) {
  const baseUrl = company.base_url.replace(/\/$/, '');
  const apiPath = '/hcmRestApi/resources/latest/recruitingCEJobRequisitions';
  const jobs = [];
  let offset = 0;
  let pages = 0;
  let totalJobsCount = null;

  while (true) {
    const finderParam = `findReqs;siteNumber=${company.site_number},offset=${offset},limit=${PAGE_SIZE}`;
    const url = `${baseUrl}${apiPath}?onlyData=true&finder=${encodeURIComponent(finderParam)}&expand=requisitionList`;

    const result = await getJson(url);
    if (!result || result.status !== 200 || !result.data?.items) {
      if (pages === 0) {
        console.log(`  ⚠️ ${company.name}: API error (status=${result?.status || 'null'})`);
      }
      break;
    }

    const items = result.data.items;
    if (items.length === 0) break;

    if (totalJobsCount === null) {
      totalJobsCount = items[0].TotalJobsCount || 0;
      console.log(`  ${company.name}: ${totalJobsCount} total positions`);
    }

    const reqs = items[0].requisitionList || [];
    if (reqs.length === 0) break;

    jobs.push(...reqs);
    pages++;

    offset += PAGE_SIZE;
    if (totalJobsCount > 0 && offset >= totalJobsCount) break;

    if (pages < 100) await delay(DELAY_MS);
  }

  return { jobs, pages };
}

async function fetchAllOracleJobs(companies, { previousJobCount = 0, cachedDescriptionIds = new Set(), priorityDescriptionIds = new Set() } = {}) {
  if (!companies || companies.length === 0) {
    companies = [{
      name: 'Oracle',
      slug: 'oracle',
      base_url: 'https://eeho.fa.us2.oraclecloud.com',
      site_number: 'CX_45001',
    }];
  }

  console.log(`\n🏛️ Fetching from Oracle HCM Cloud (${companies.length} companies)...`);
  console.log('━'.repeat(60));

  const rawJobs = [];
  const CONCURRENCY = 4;
  let totalPages = 0;

  for (let i = 0; i < companies.length; i += CONCURRENCY) {
    const batch = companies.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async company => {
      const result = await fetchCompanyJobs(company).catch(err => {
        console.log(`  ❌ ${company.name}: ${err.message}`);
        return { jobs: [], pages: 0 };
      });
      return { company, ...result };
    }));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        totalPages += r.value.pages;
        rawJobs.push(...r.value.jobs.map(job => ({ company: r.value.company, job })));
      }
    }
  }

  let detailTargets = rawJobs.map(({ company, job }) => ({
    company,
    job,
    jobId: String(job.Id),
    normalizedId: `oracle-${companySlugOf(company)}-${job.Id}`,
  }));

  // AGG-POOL-SCOPE-FILTER-1 (2026-07-20): only detail-fetch US+Canada jobs.
  // Operator directive: "We don't cater to NON-US and non-Canada at all."
  // 36% of oracle jobs are non-US/Canada (India 3K, UK 2.2K, etc.) — wastes detail-fetch budget.
  // Conservative: keeps ambiguous locations (Remote, Multiple, empty) to avoid false positives.
  {
    const before = detailTargets.length;
    detailTargets = detailTargets.filter(t => {
      const parsed = parseLocation(t.job.PrimaryLocation || '');
      const country = (parsed.country || '').trim();
      const state = (parsed.job_state || '').trim();
      if (country === 'United States' || country === 'USA' || country === 'Canada') return true;
      if (state && state.length === 2 && state === state.toUpperCase()) return true;
      if (!country || /^(remote|multiple|various)/i.test(country)) return true;
      return false;
    });
    const dropped = before - detailTargets.length;
    if (dropped > 0) console.log(`  Oracle scope filter: ${dropped}/${before} non-US/Canada jobs excluded from detail fetch`);
  }

  if (cachedDescriptionIds.size > 0) {
    const uncached = detailTargets.filter(t => !cachedDescriptionIds.has(t.normalizedId));
    const cached = detailTargets.length - uncached.length;
    console.log(`  Oracle description cache: ${cached}/${detailTargets.length} positions already in sidecar, ${uncached.length} need fetching`);
    detailTargets = uncached;
  }

  if (priorityDescriptionIds.size > 0 && detailTargets.length > 0) {
    const priority = [];
    const regular = [];
    for (const target of detailTargets) {
      (priorityDescriptionIds.has(target.normalizedId) ? priority : regular).push(target);
    }
    if (priority.length > 0) {
      priority.sort((a, b) => oracleDetailPriorityScore(b) - oracleDetailPriorityScore(a));
      console.log(`  Oracle detail priority: ${priority.length}/${detailTargets.length} short sidecar positions before cap`);
      detailTargets = priority.concat(regular);
    }
  }

  // AGG-DEEPPASS-P3-EXEC-1 P3.3 v2.1: floor + weighted remainder + monopoly cap
  // (ENR co-review conditions (a)/(b) inside allocateOracleDetails).
  const { fetch: allocated, shortDescOnly } = allocateOracleDetails(detailTargets, MAX_DETAIL_FETCHES);
  if (detailTargets.length > MAX_DETAIL_FETCHES) {
    console.log(`  Oracle detail allocation: ${allocated.length}/${detailTargets.length} uncached positions (floor+weighted+cap)`);
    detailTargets = allocated;
  }

  let details = new Map();
  if (detailTargets.length > 0) {
    console.log(`  Phase 2: Oracle detail fetch (${detailTargets.length} positions, batch=${DETAIL_CONCURRENCY})`);
    details = await fetchOracleDetails(detailTargets);
    console.log(`  Oracle details fetched: ${details.size}/${detailTargets.length}`);
  }
  // AGG-DEEPPASS-P3-EXEC-1 P3.3 v2.1 (ENR co-review condition b): LOW_DETAIL non-tech
  // rows persist the LIST short-description instead of a detail fetch — merged AFTER the
  // fetch reassignment so they cannot be wiped.
  if (shortDescOnly.length > 0) {
    console.log(`  Oracle short-desc class: ${shortDescOnly.length} LOW_DETAIL non-tech rows persist LIST short-description (no detail fetch)`);
    for (const t of shortDescOnly) {
      if (!details.has(t.normalizedId)) {
        details.set(t.normalizedId, stripHtml(String(t.job.ShortDescriptionStr || '')));
      }
    }
  } else if (previousJobCount > 0) {
    console.log('  Phase 2: All Oracle positions cached — no detail fetch needed');
  } else {
    console.log('  Phase 2: No Oracle detail fetch needed on this run');
  }

  const allJobs = rawJobs.map(({ company, job }) => {
    const normalizedId = `oracle-${companySlugOf(company)}-${job.Id}`;
    return normalizeOracleJob(job, company, details.get(normalizedId) || null);
  });

  const withDesc = allJobs.filter(j => j.description).length;
  console.log(`  Oracle HCM total: ${allJobs.length} jobs from ${companies.length} companies (${withDesc} with descriptions, ${totalPages} pages, detail cache ${cachedDescriptionIds.size})`);
  return allJobs;
}

// allocateOracleDetails/isShortDescOnlyTarget exported for AGG-DEEPPASS-P3-EXEC-1 P3.3 unit tests
module.exports = { fetchAllOracleJobs, allocateOracleDetails, isShortDescOnlyTarget, companySlugOf };
