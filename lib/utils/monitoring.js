#!/usr/bin/env node

/**
 * Pipeline Monitoring — Diagnostic checks and trend persistence (AGG-PIPE-13)
 *
 * Extracted from index.js. Handles 6 diagnostic operations:
 * - TAG-AUDIT-4: Pipeline-code drift detection
 * - TAG-AUDIT-5: Per-domain precision monitoring
 * - TAG-SELF-3: Per-keyword health monitoring
 * - TAG-SELF-9: Cross-domain keyword overlap check
 * - TAG-SELF-2: Tag history persistence + pruning
 * - AGG-COMPANY-2: Override candidate discovery
 *
 * All operations are non-blocking. Errors are logged but never stop the pipeline.
 */

const fs = require('fs');
const path = require('path');

/**
 * Run all tag monitoring diagnostics.
 * @param {Array} publicJobs - Final output jobs (post-filter, post-merge)
 * @param {Object} tagStats - Tag statistics from computeFullPoolTagStats()
 * @param {Object} deps - Injected dependencies
 * @param {string} deps.dataDir - Path to .github/data/
 * @param {Function} deps.checkTagDrift - From tag-monitor
 * @param {Function} deps.printDriftReport - From tag-monitor
 * @param {Function} deps.tagDomainsFn - From tag-engine (tagDomains function)
 * @param {Function} deps.checkDomainPrecision - From tag-monitor
 * @param {Function} deps.printPrecisionReport - From tag-monitor
 * @param {Function} deps.checkKeywordHealth - From tag-monitor
 * @param {Function} deps.checkKeywordOverlap - From tag-monitor
 * @param {Function} deps.getKeywordMap - From tag-engine
 * @param {string} deps.tagEngineVersion - TAG_ENGINE_VERSION constant
 * @param {Array} deps.seniorJobs - Jobs filtered by senior filter (for AGG-COMPANY-2)
 * @param {Map} deps.companyOverrideMap - AGG-36 override map
 * @returns {{ tagDriftReport, tagPrecisionReport, keywordHealthReport, keywordOverlapReport }}
 */
function runTagMonitoring(publicJobs, tagStats, deps) {
  const {
    dataDir,
    checkTagDrift, printDriftReport,
    tagDomainsFn,
    checkDomainPrecision, printPrecisionReport,
    checkKeywordHealth, checkKeywordOverlap,
    getKeywordMap, tagEngineVersion,
    seniorJobs, companyOverrideMap,
  } = deps;

  // TAG-AUDIT-4: Pipeline-code drift detection
  let tagDriftReport = null;
  try {
    tagDriftReport = checkTagDrift(publicJobs, tagDomainsFn, 500);
    printDriftReport(tagDriftReport);
    if (tagDriftReport.warnings.length > 0) {
      console.log('⚠️  TAG DRIFT WARNING — consider re-tagging carry-forward jobs');
    }
  } catch (driftErr) {
    console.warn('⚠️ Drift check failed (non-blocking):', driftErr.message);
  }

  // TAG-AUDIT-5: Per-domain precision monitoring
  let tagPrecisionReport = null;
  try {
    tagPrecisionReport = checkDomainPrecision(publicJobs);
    printPrecisionReport(tagPrecisionReport);
    if (tagPrecisionReport.warnings.length > 0) {
      console.log('⚠️  PRECISION WARNING — FP rate exceeds threshold in one or more domains');
    }
  } catch (precErr) {
    console.warn('⚠️ Precision check failed (non-blocking):', precErr.message);
  }

  // TAG-SELF-3: Per-keyword health monitoring
  let keywordHealthReport = null;
  try {
    const keywordMap = getKeywordMap();
    if (Object.keys(keywordMap).length > 0) {
      keywordHealthReport = checkKeywordHealth(publicJobs, keywordMap);
      if (keywordHealthReport.warnings.length > 0) {
        console.log('⚠️  KEYWORD HEALTH WARNING — keyword over-match detected');
      }
    }
  } catch (kwErr) {
    console.warn('⚠️ Keyword health check failed (non-blocking):', kwErr.message);
  }

  // TAG-SELF-9: Cross-domain keyword overlap check
  let keywordOverlapReport = null;
  try {
    const keywordMap2 = getKeywordMap();
    if (Object.keys(keywordMap2).length > 0) {
      keywordOverlapReport = checkKeywordOverlap(publicJobs, keywordMap2);
      if (keywordOverlapReport.warnings.length > 0) {
        console.log(`⚠️  KEYWORD OVERLAP WARNING — ${keywordOverlapReport.warnings.length} cross-domain overlaps detected`);
      }
    }
  } catch (overlapErr) {
    console.warn('⚠️ Keyword overlap check failed (non-blocking):', overlapErr.message);
  }

  // TAG-SELF-2: Tag history persistence + pruning
  _writeTagHistory(dataDir, tagStats, tagDriftReport, tagPrecisionReport, keywordHealthReport, keywordOverlapReport, tagEngineVersion);

  // AGG-COMPANY-2: Override candidate discovery
  _detectOverrideCandidates(dataDir, seniorJobs, publicJobs, companyOverrideMap);

  return { tagDriftReport, tagPrecisionReport, keywordHealthReport, keywordOverlapReport };
}

function _writeTagHistory(dataDir, tagStats, tagDriftReport, tagPrecisionReport, keywordHealthReport, keywordOverlapReport, tagEngineVersion) {
  try {
    const HISTORY_FILE = path.join(dataDir, 'tag-history.jsonl');
    const MAX_AGE_DAYS = 30;
    const entry = {
      timestamp: new Date().toISOString(),
      g1: tagStats?.g1 || null,
      drift: tagDriftReport ? {
        drift_rate: tagDriftReport.drift_rate,
        sample_size: tagDriftReport.sample_size,
        drifted: tagDriftReport.drifted,
      } : null,
      precision: tagPrecisionReport ? Object.fromEntries(
        Object.entries(tagPrecisionReport.domains).map(([d, r]) => [d, { total: r.total, fps: r.fps, fp_rate: r.fp_rate }])
      ) : null,
      keyword_health: keywordHealthReport ? Object.fromEntries(
        Object.entries(keywordHealthReport.domains).map(([d, r]) => [d, {
          total_jobs: r.total_jobs,
          keywords_with_matches: r.keywords_with_matches,
          keyword_count: r.keyword_count,
          top_3: r.top_contributors.slice(0, 3).map(tc => ({ keyword: tc.keyword, matches: tc.matches })),
        }])
      ) : null,
      keyword_overlap_warnings: keywordOverlapReport ? keywordOverlapReport.warnings.length : 0,
      tag_engine_version: tagEngineVersion,
    };
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
    // Prune old entries
    try {
      const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
      const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
      const kept = lines.filter(line => {
        try { return new Date(JSON.parse(line).timestamp).getTime() >= cutoff; } catch { return true; }
      });
      if (kept.length < lines.length) {
        fs.writeFileSync(HISTORY_FILE, kept.join('\n') + '\n');
        console.log(`📊 Tag history pruned: ${lines.length} → ${kept.length} entries`);
      }
    } catch (_) {}
  } catch (histErr) {
    console.warn('⚠️ Tag history write failed (non-blocking):', histErr.message);
  }
}

function _detectOverrideCandidates(dataDir, seniorJobs, publicJobs, companyOverrideMap) {
  try {
    const OVERRIDE_CANDIDATES_FILE = path.join(dataDir, 'override-candidates.json');
    const MIN_JOBS_THRESHOLD = 10;
    const HIGH_FILTER_RATE = 0.80;
    const TITLE_FILTER_SHARE = 0.70;

    const companyFiltered = {};
    for (const job of seniorJobs) {
      const c = job.company_name || 'unknown';
      if (!companyFiltered[c]) companyFiltered[c] = { total: 0, senior_title: 0, senior_experience: 0, both: 0 };
      companyFiltered[c].total++;
      const reason = job._filter_reason || 'unknown';
      if (reason === 'senior_title' || reason === 'both') companyFiltered[c].senior_title++;
      if (reason === 'senior_experience' || reason === 'both') companyFiltered[c].senior_experience++;
      if (reason === 'both') companyFiltered[c].both++;
    }

    const companyPool = {};
    for (const job of publicJobs) {
      const c = job.company_name || 'unknown';
      if (!companyPool[c]) companyPool[c] = { total: 0, senior_tagged: 0, mid_tagged: 0, entry_tagged: 0 };
      companyPool[c].total++;
      const emp = job.tags?.employment;
      if (emp === 'senior') companyPool[c].senior_tagged++;
      else if (emp === 'mid_level') companyPool[c].mid_tagged++;
      else if (emp === 'entry_level') companyPool[c].entry_tagged++;
    }

    const candidates = [];
    for (const [company, filtered] of Object.entries(companyFiltered)) {
      const pool = companyPool[company] || { total: 0 };
      const totalForCompany = filtered.total + pool.total;
      if (totalForCompany < MIN_JOBS_THRESHOLD) continue;

      const filterRate = filtered.total / totalForCompany;
      if (filterRate < HIGH_FILTER_RATE) continue;

      const titleShare = filtered.senior_title / (filtered.total || 1);
      if (titleShare < TITLE_FILTER_SHARE) continue;

      const hasOverride = companyOverrideMap.has(company);
      candidates.push({
        company,
        total_fetched: totalForCompany,
        senior_filtered: filtered.total,
        in_pool: pool.total,
        filter_rate: +(filterRate * 100).toFixed(1),
        title_filter_pct: +(titleShare * 100).toFixed(1),
        senior_tagged_in_pool: pool.senior_tagged || 0,
        has_override: hasOverride,
        recommendation: hasOverride ? 'existing_override_check_accuracy' : 'add_override',
      });
    }

    candidates.sort((a, b) => b.senior_filtered - a.senior_filtered);
    fs.writeFileSync(OVERRIDE_CANDIDATES_FILE, JSON.stringify({ generated: new Date().toISOString(), candidates, threshold: { min_jobs: MIN_JOBS_THRESHOLD, filter_rate: HIGH_FILTER_RATE, title_share: TITLE_FILTER_SHARE } }, null, 2), 'utf8');
    console.log(`🔍 AGG-COMPANY-2: ${candidates.length} override candidates → override-candidates.json`);
    if (candidates.length > 0 && candidates.length <= 10) {
      for (const c of candidates) {
        console.log(`   ${c.has_override ? '🔄' : '🆕'} ${c.company}: ${c.senior_filtered}/${c.total_fetched} filtered (${c.filter_rate}%)`);
      }
    }
  } catch (e) {
    console.warn(`⚠️ AGG-COMPANY-2: Diagnostic failed (non-critical): ${e.message}`);
  }
}

module.exports = { runTagMonitoring };
