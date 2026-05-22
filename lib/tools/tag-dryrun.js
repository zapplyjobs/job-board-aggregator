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
 *   node tools/tag-dryrun.js --remote   (loads from R2 / live sources)
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
const { execSync } = require('child_process');

// Load tag engine from parent directory
const { tagDomains } = require(path.join(__dirname, '..', 'processors', 'tag-engine'));

// Resolve r2-loader — try pipeline path first, then standalone clone path
let r2Loader = null;
try { r2Loader = require(path.join(__dirname, '..', '..', 'shared', 'tools', 'r2-loader')); } catch {}
if (!r2Loader) try { r2Loader = require(path.join(__dirname, '..', '..', '..', '..', 'job-board-shared', 'tools', 'r2-loader')); } catch {}

async function loadRemoteJobs() {
  // 1. Try r2-loader (S3 client for live data)
  if (r2Loader) {
    try {
      const records = await r2Loader.loadJsonFromR2('all_jobs.json');
      console.error(`  Loaded ${records.length} jobs from R2`);
      return records.map(r => JSON.stringify(r)).join('\n');
    } catch (e) {
      console.error(`  R2 loader failed: ${e.message}`);
    }
  }

  // 2. Fallback: R2 public URL → private repo → public repo
  const sources = [
    ['R2 public (live)', 'https://pub-7c6b1d38c7974dd7a11e3a1e6e46c68b.r2.dev/data/all_jobs.json', []],
    ['private repo (live)', 'https://raw.githubusercontent.com/zapplyjobs/jobs-aggregator-private/main/.github/data/all_jobs.json', ['auth']],
    ['public repo (stale)', 'https://raw.githubusercontent.com/zapplyjobs/jobs-data-2026/main/.github/data/all_jobs.json', []],
  ];
  for (const [label, url, flags] of sources) {
    console.error(`Fetching all_jobs.json from ${label}...`);
    try {
      let headerArgs = '';
      if (flags.includes('auth')) {
        const token = execSync('gh auth token', { encoding: 'utf8' }).trim();
        headerArgs = `-H 'Authorization: token ${token}'`;
      }
      const text = execSync(`curl -sL ${headerArgs} "${url}"`, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024, timeout: 120000 });
      const lineCount = text.split('\n').filter(l => l.trim()).length;
      if (lineCount > 1000) {
        console.error(`  ${lineCount.toLocaleString()} jobs from ${label}`);
        return text;
      }
      console.error(`  Only ${lineCount} jobs from ${label}, trying next...`);
    } catch (e) { console.error(`  Failed: ${e.message.slice(0, 100)}`); }
  }
  console.error('FATAL: Could not fetch all_jobs.json from any source');
  process.exit(1);
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
    console.log('Reading from remote (R2 / live sources)...');
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
