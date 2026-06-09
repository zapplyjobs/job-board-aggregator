#!/usr/bin/env node

/**
 * TAG General Report — live G1 analysis for TAG module health
 *
 * Produces live data replacing stale prose claims in STATE_TAG.md.
 * Shows: US G1 rate, per-ATS breakdown, top general-producing companies,
 * investigation coverage, dry-run comparison, and pipeline comparison.
 *
 * Usage:
 *   node tools/tag-general-report.js [--json] [--dryrun] [--pipeline] [--jobs /path] [--top N]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
};
const jsonOutput = args.includes('--json');
const dryRun = args.includes('--dryrun');
const pipelineCompare = args.includes('--pipeline');
const topN = parseInt(getArg('--top') || '20', 10);

let r2Loader = null;
for (const candidate of [
  path.join(__dirname, '..', '..', 'shared', 'tools', 'r2-loader'),
  path.join(__dirname, '..', '..', '..', 'job-board-shared', 'tools', 'r2-loader'),
]) {
  try {
    r2Loader = require(candidate);
    break;
  } catch {}
}

function findFile(candidates) {
  for (const p of candidates.filter(Boolean)) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function githubContentJson(repo, filePath, ref = 'main') {
  const content = execFileSync(
    'gh',
    ['api', `repos/zapplyjobs/${repo}/contents/${filePath}?ref=${ref}`, '--jq', '.content'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 20 * 1024 * 1024 }
  );
  return JSON.parse(Buffer.from(content, 'base64').toString('utf8'));
}

function loadJobsFile(filePath) {
  const jobs = [];
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { jobs.push(JSON.parse(line)); }
    catch (e) { /* skip malformed */ }
  }
  return jobs;
}

async function loadJobsFromRemote() {
  if (!r2Loader) {
    console.error('FATAL: r2-loader not found; private R2 access is required');
    return null;
  }
  try {
    const records = await r2Loader.loadJsonFromR2('all_jobs.json');
    if (records.length > 1000) return records;
  } catch (e) {
    console.error(`FATAL: private R2 load failed: ${e.message}`);
  }
  return null;
}

function buildCompanyLookup() {
  const companyListFile = findFile([
    path.resolve(__dirname, '..', 'fetchers', 'company-list.json'),
  ]);
  if (!companyListFile) return new Map();

  const companyList = JSON.parse(fs.readFileSync(companyListFile, 'utf8'));
  const lookup = new Map();
  for (const [platform, entries] of Object.entries(companyList)) {
    if (platform === '_meta' || !Array.isArray(entries)) continue;
    for (const e of entries) {
      const name = (e.name || '').toLowerCase().trim();
      if (!name) continue;
      lookup.set(name, {
        platform,
        default_domain: e.default_domain || null,
        general_note: e.general_note || null,
        slug: e.slug || '',
      });
    }
  }
  return lookup;
}

async function loadPipelineMetrics() {
  try {
    return githubContentJson('jobs-data-2026', '.github/data/zjp-metrics.json');
  } catch {
    return null;
  }
}

function computeG1Rate(jobs) {
  const usJobs = jobs.filter(j => {
    const tags = j.tags || {};
    const locs = tags.locations || [];
    return locs.includes('us') && tags.employment !== 'senior';
  });

  const usGeneral = usJobs.filter(j => {
    const domains = j.tags?.domains || [];
    return domains.length === 1 && domains[0] === 'general';
  });

  const rate = usJobs.length > 0
    ? Math.round((usGeneral.length / usJobs.length) * 1000) / 10
    : 0;

  const oneInN = usGeneral.length > 0
    ? Math.round(usJobs.length / usGeneral.length * 10) / 10
    : Infinity;

  return { usJobs, usGeneral, rate, oneInN, usTotal: usJobs.length };
}

function computeAtsBreakdown(usJobs) {
  const bySource = {};
  for (const j of usJobs) {
    const src = (j.source || 'unknown').toLowerCase();
    if (!bySource[src]) bySource[src] = { total: 0, general: 0 };
    bySource[src].total++;
    const domains = (j.tags?.domains || []);
    if (domains.length === 1 && domains[0] === 'general') bySource[src].general++;
  }

  return Object.entries(bySource)
    .map(([source, data]) => ({
      source,
      total: data.total,
      general: data.general,
      g1_rate: data.total > 0 ? Math.round(data.general / data.total * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.general - a.general);
}

function companyAnalysis(usGeneral, companyLookup) {
  const byCompany = {};
  for (const j of usGeneral) {
    const co = (j.company_name || 'unknown').toLowerCase().trim();
    if (!byCompany[co]) {
      byCompany[co] = { count: 0, titles: [], source: j.source || 'unknown' };
    }
    byCompany[co].count++;
    if (byCompany[co].titles.length < 5) byCompany[co].titles.push(j.title);
  }

  const ranked = Object.entries(byCompany)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, topN)
    .map(([name, data]) => {
      const lookup = companyLookup.get(name) || {};
      return {
        name,
        general_count: data.count,
        source: data.source,
        sample_titles: data.titles.slice(0, 3),
        has_default_domain: !!lookup.default_domain,
        default_domain: lookup.default_domain || null,
        investigated: !!lookup.general_note,
        investigation_decision: lookup.general_note?.decision || null,
        investigation_date: lookup.general_note?.date || null,
      };
    });

  let investigatedJobs = 0;
  let uninvestigatedJobs = 0;
  for (const j of usGeneral) {
    const co = (j.company_name || 'unknown').toLowerCase().trim();
    if (companyLookup.get(co)?.general_note) investigatedJobs++;
    else uninvestigatedJobs++;
  }

  return {
    top_companies: ranked,
    total_companies_with_generals: Object.keys(byCompany).length,
    investigation_coverage: {
      investigated_jobs: investigatedJobs,
      uninvestigated_jobs: uninvestigatedJobs,
      investigated_pct: usGeneral.length > 0
        ? Math.round(investigatedJobs / usGeneral.length * 1000) / 10
        : 0,
    },
  };
}

function dryRunComparison(usGeneral, usTotal) {
  let tagEngine;
  try {
    tagEngine = require(path.join(__dirname, '..', 'processors', 'tag-engine'));
  } catch {
    return { error: 'tag-engine.js not found — dry-run unavailable' };
  }

  let reclassified = 0;
  let stillGeneral = 0;
  const byDomain = {};

  for (const j of usGeneral) {
    const result = tagEngine.tagDomains(j, { debug: true });
    const domains = Array.isArray(result) ? result : result.domains;
    const isGeneral = domains.length === 1 && domains[0] === 'general';

    if (isGeneral) {
      stillGeneral++;
    } else {
      reclassified++;
      for (const d of domains) {
        byDomain[d] = (byDomain[d] || 0) + 1;
      }
    }
  }

  const dryrunG1 = usTotal > 0 ? Math.round(stillGeneral / usTotal * 1000) / 10 : 0;

  return {
    current_general: usGeneral.length,
    dryrun_general: stillGeneral,
    reclassified,
    dryrun_g1_pct: dryrunG1,
    by_domain: Object.entries(byDomain).sort((a, b) => b[1] - a[1]),
  };
}

async function main() {
  // 1. Load all_jobs.json
  let jobs = null;
  let dataSource = 'remote';
  const jobsFile = findFile([
    getArg('--jobs'),
    path.resolve(__dirname, '..', '..', '..', 'jobs-data-2026', '.github', 'data', 'all_jobs.json'),
    path.resolve(__dirname, '..', '..', '..', 'jobs-aggregator-private', '.github', 'data', 'all_jobs.json'),
  ]);

  if (jobsFile) {
    jobs = loadJobsFile(jobsFile);
    dataSource = `local (${jobsFile.split('/').slice(-3).join('/')})`;
    if (jobs.length < 40000) {
      console.error(`WARN: Local all_jobs.json has ${jobs.length} jobs. Fetching private R2...`);
      const remote = await loadJobsFromRemote();
      if (remote && remote.length > jobs.length) {
        jobs = remote;
        dataSource = 'private R2 (local was stale)';
      } else {
        console.error('Private R2 unavailable or smaller. Using local. Data may be stale.');
      }
    }
  } else {
    console.error('No local all_jobs.json found. Fetching private R2...');
    jobs = await loadJobsFromRemote();
  }

  if (!jobs || jobs.length === 0) {
    console.error('DATA UNAVAILABLE: No local all_jobs.json and private R2 fetch failed.');
    process.exit(1);
  }

  // 2. Load company-list.json
  const companyLookup = buildCompanyLookup();
  if (companyLookup.size === 0) {
    console.error('WARN: company-list.json not found. All companies will show as uninvestigated.');
  }

  // 3. Compute G1 rate
  const { usJobs, usGeneral, rate, oneInN, usTotal } = computeG1Rate(jobs);

  // 4. Per-ATS breakdown
  const atsBreakdown = computeAtsBreakdown(usJobs);
  // 5. Company analysis
  const companies = companyAnalysis(usGeneral, companyLookup);

  // 6. Dry-run (optional)
  let dryrunResult = null;
  if (dryRun) {
    dryrunResult = dryRunComparison(usGeneral, usTotal);
  }

  // 7. Pipeline comparison (optional)
  let pipelineResult = null;
  if (pipelineCompare) {
    const metrics = await loadPipelineMetrics();
    if (metrics) {
      const pipelineG1 = metrics.pool?.g1_us?.us_general_rate_pct || null;
      if (pipelineG1 !== null) {
        const delta = Math.round((rate - pipelineG1) * 10) / 10;
        pipelineResult = {
          pipeline_g1_pct: pipelineG1,
          local_g1_pct: rate,
          delta_pp: delta,
          warning: Math.abs(delta) > 2 ? `DELTA ${Math.abs(delta)}pp — local data differs significantly from pipeline` : null,
        };
      }
    } else {
      pipelineResult = { error: 'PIPELINE METRICS UNAVAILABLE: Could not fetch zjp-metrics.json' };
    }
  }

  // 8. Build output
  const result = {
    generated_at: new Date().toISOString(),
    data_source: dataSource,
    total_jobs: jobs.length,
    g1_rate: {
      us_total: usTotal,
      us_general: usGeneral.length,
      us_general_rate_pct: rate,
      one_in_n: oneInN,
    },
    ats_breakdown: atsBreakdown,
    companies,
    dryrun: dryrunResult,
    pipeline: pipelineResult,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Console output
  console.log('\n=== TAG GENERAL REPORT ===');
  console.log(`Generated: ${result.generated_at}`);
  console.log(`Data source: ${dataSource} (${jobs.length.toLocaleString()} jobs)`);

  console.log('\n--- US G1 Rate ---');
  console.log(`  US non-senior jobs:  ${usTotal.toLocaleString()}`);
  console.log(`  US general jobs:     ${usGeneral.length.toLocaleString()}`);
  console.log(`  US G1 rate:          ${rate}%`);
  console.log(`  1 in ${oneInN} jobs a user sees in NGJ main repo is unclassified`);

  if (pipelineResult && !pipelineResult.error) {
    console.log('\n--- Pipeline Comparison (from zjp-metrics.json) ---');
    console.log(`  Pipeline G1:   ${pipelineResult.pipeline_g1_pct}%`);
    console.log(`  Local data G1: ${pipelineResult.local_g1_pct}%`);
    const sign = pipelineResult.delta_pp >= 0 ? '+' : '';
    console.log(`  DELTA:          ${sign}${pipelineResult.delta_pp}pp`);
    if (pipelineResult.warning) console.log(`  <<< ${pipelineResult.warning} >>>`);
  } else if (pipelineResult?.error) {
    console.log(`\n--- Pipeline Comparison ---`);
    console.log(`  ${pipelineResult.error}`);
  }

  console.log('\n--- Per-ATS G1 Rate ---');
  console.log(`  ${'Source'.padEnd(18)} ${'Total'.padStart(7)} ${'General'.padStart(8)} ${'G1 Rate'.padStart(8)}`);
  for (const a of atsBreakdown.slice(0, 8)) {
    console.log(`  ${a.source.padEnd(18)} ${String(a.total).padStart(7)} ${String(a.general).padStart(8)} ${(a.g1_rate + '%').padStart(8)}`);
  }

  console.log('\n--- Top General-Producing Companies ---');
  console.log(`  ${'Company'.padEnd(28)} ${'Gen'.padStart(5)} ${'Default?'.padStart(9)} ${'Investigated?'.padStart(14)} ${'Decision'.padStart(14)}`);
  for (const c of companies.top_companies) {
    const def = c.has_default_domain ? c.default_domain : '--';
    const inv = c.investigated ? 'Yes' : 'No';
    const dec = c.investigation_decision || '--';
    console.log(`  ${c.name.padEnd(28)} ${String(c.general_count).padStart(5)} ${def.padStart(9)} ${inv.padStart(14)} ${dec.padStart(14)}`);
  }

  console.log('\n--- Title Samples (top 5 companies) ---');
  for (const c of companies.top_companies.slice(0, 5)) {
    console.log(`  ${c.name} (${c.general_count} gens):`);
    for (const t of c.sample_titles) {
      console.log(`    "${t}"`);
    }
  }

  console.log('\n--- Investigation Coverage ---');
  const ic = companies.investigation_coverage;
  console.log(`  Investigated:    ${ic.investigated_jobs.toLocaleString()} (${ic.investigated_pct}%) — have general_note in company-list.json`);
  console.log(`  Uninvestigated:  ${ic.uninvestigated_jobs.toLocaleString()} (${(100 - ic.investigated_pct).toFixed(1)}%) — no investigation record`);
  console.log(`  Companies investigated: ${companies.top_companies.filter(c => c.investigated).length} of ${companies.total_companies_with_generals} companies in top ${topN}`);

  if (dryrunResult && !dryrunResult.error) {
    console.log('\n--- Dry-Run Comparison (tag-engine re-run) ---');
    console.log(`  Current generals:   ${dryrunResult.current_general.toLocaleString()}`);
    console.log(`  After re-classify:  ${dryrunResult.dryrun_general.toLocaleString()} (-${dryrunResult.reclassified} reclassified)`);
    console.log(`  Dry-run G1:         ${dryrunResult.dryrun_g1_pct}%`);
    if (pipelineResult && !pipelineResult.error) {
      const dd = Math.round((dryrunResult.dryrun_g1_pct - pipelineResult.pipeline_g1_pct) * 10) / 10;
      const ddSign = dd >= 0 ? '+' : '';
      console.log(`  vs pipeline ${pipelineResult.pipeline_g1_pct}%: ${ddSign}${dd}pp`);
      if (Math.abs(dd) > 2) console.log('  <<< DELTA >2pp — investigate >>>');
      else console.log('  Delta <2pp — no action needed');
    }
    console.log('  Reclassified by domain:');
    for (const [d, n] of dryrunResult.by_domain.slice(0, 8)) {
      console.log(`    ${d.padEnd(16)} ${String(n).padStart(5)}`);
    }
  } else if (dryRun && dryrunResult?.error) {
    console.log(`\n--- Dry-Run ---`);
    console.log(`  ${dryrunResult.error}`);
  }

  console.log('');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
