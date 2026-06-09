#!/usr/bin/env node

/**
 * Tag Engine Dry-Run — TAG-DRYRUN-1 (S229), R2 support added B77
 *
 * Compares current tags in all_jobs.json against what the tag engine would
 * produce if re-run now. Outputs a diff report showing jobs that would
 * gain or lose domain tags.
 *
 * Usage:
 *   node tools/tag-dryrun.js [path-to-all-jobs.json]
 *   node tools/tag-dryrun.js --remote   (loads from private R2)
 *
 * Default path: ../../jobs-data-2026/.github/data/all_jobs.json (relative to shared/)
 *
 * Output:
 *   - Summary: counts of gained/lost/unchanged per domain
 *   - Details: first 20 gains and 20 losses with company + title
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Load tag engine from parent directory
const { tagDomains } = require(path.join(__dirname, '..', 'processors', 'tag-engine'));

// Resolve r2-loader — try pipeline path first, then sibling shared clone path
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

async function loadRemoteJobs() {
  if (!r2Loader) {
    console.error('FATAL: r2-loader not found; private R2 access is required');
    process.exit(1);
  }

  try {
    const records = await r2Loader.loadJsonFromR2('all_jobs.json');
    console.error(`  Loaded ${records.length} jobs from private R2`);
    return records.map(r => JSON.stringify(r)).join('\n');
  } catch (e) {
    console.error(`FATAL: private R2 load failed: ${e.message}`);
    process.exit(1);
  }
}

function analyzeJobs(allJobsText) {
  const lines = allJobsText.trim().split('\n').filter(Boolean);
  console.log(`Jobs: ${lines.length}`);

  const gained = {};
  const lost = {};
  let totalChanged = 0;

  for (const line of lines) {
    let job;
    try { job = JSON.parse(line); } catch { continue; }

    const currentDomains = new Set(job.tags?.domains || []);
    const newDomains = new Set(tagDomains(job));

    for (const d of newDomains) {
      if (!currentDomains.has(d)) {
        if (!gained[d]) gained[d] = [];
        gained[d].push({ company: job.company_name, title: job.title, id: job.id });
      }
    }

    for (const d of currentDomains) {
      if (!newDomains.has(d)) {
        if (!lost[d]) lost[d] = [];
        lost[d].push({ company: job.company_name, title: job.title, id: job.id });
      }
    }

    const same = [...currentDomains].every(d => newDomains.has(d)) &&
                 [...newDomains].every(d => currentDomains.has(d));
    if (!same) totalChanged++;
  }

  return { gained, lost, totalChanged };
}

function printReport({ gained, lost, totalChanged }) {
  console.log('\n=== DOMAIN TAG DRY-RUN REPORT ===\n');
  console.log(`Total jobs changed: ${totalChanged}\n`);

  const allDomains = new Set([...Object.keys(gained), ...Object.keys(lost)]);
  for (const d of [...allDomains].sort()) {
    const g = (gained[d] || []).length;
    const l = (lost[d] || []).length;
    console.log(`  ${d}: +${g} gained, -${l} lost`);
  }

  for (const d of [...allDomains].sort()) {
    if ((gained[d] || []).length > 0) {
      console.log(`\n--- ${d}: GAINED (first 20) ---`);
      for (const j of (gained[d] || []).slice(0, 20)) {
        console.log(`  + ${j.company}: ${j.title}`);
      }
    }
    if ((lost[d] || []).length > 0) {
      console.log(`\n--- ${d}: LOST (first 20) ---`);
      for (const j of (lost[d] || []).slice(0, 20)) {
        console.log(`  - ${j.company}: ${j.title}`);
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const remoteMode = args.includes('--remote');
  const filePath = args.find(a => !a.startsWith('--'));

  let allJobsText;

  if (remoteMode) {
    console.log('Reading from private R2...');
    allJobsText = await loadRemoteJobs();
  } else {
    const allJobsPath = filePath ||
      path.resolve(__dirname, '..', '..', '..', '..', 'jobs-data-2026', '.github', 'data', 'all_jobs.json');
    if (!fs.existsSync(allJobsPath)) {
      console.error(`File not found: ${allJobsPath}`);
      console.error('Use --remote to load from R2, or provide a path to all_jobs.json');
      process.exit(1);
    }
    console.log(`Reading: ${allJobsPath}`);
    allJobsText = fs.readFileSync(allJobsPath, 'utf8');
  }

  const result = analyzeJobs(allJobsText);
  printReport(result);
}

main().catch(e => { console.error(e); process.exit(1); });
