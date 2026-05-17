#!/usr/bin/env node

/**
 * Tag Engine Dry-Run — TAG-DRYRUN-1 (S229)
 *
 * Compares current tags in all_jobs.json against what the tag engine would
 * produce if re-run now. Outputs a diff report showing jobs that would
 * gain or lose domain tags.
 *
 * Usage:
 *   node tools/tag-dryrun.js [path-to-all-jobs.json]
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

const allJobsPath = process.argv[2] ||
  path.resolve(__dirname, '..', '..', '..', '..', 'jobs-data-2026', '.github', 'data', 'all_jobs.json');

if (!fs.existsSync(allJobsPath)) {
  console.error(`File not found: ${allJobsPath}`);
  process.exit(1);
}

console.log(`Reading: ${allJobsPath}`);
const lines = fs.readFileSync(allJobsPath, 'utf8').trim().split('\n').filter(Boolean);
console.log(`Jobs: ${lines.length}`);

const gained = {};   // domain → [{company, title}]
const lost = {};     // domain → [{company, title}]
const unchanged = {};
let totalChanged = 0;

for (const line of lines) {
  let job;
  try { job = JSON.parse(line); } catch { continue; }

  const currentDomains = new Set(job.tags?.domains || []);
  const newDomains = new Set(tagDomains(job));

  // Find gains (in new but not current)
  for (const d of newDomains) {
    if (!currentDomains.has(d)) {
      if (!gained[d]) gained[d] = [];
      gained[d].push({ company: job.company_name, title: job.title, id: job.id });
    }
  }

  // Find losses (in current but not new)
  for (const d of currentDomains) {
    if (!newDomains.has(d)) {
      if (!lost[d]) lost[d] = [];
      lost[d].push({ company: job.company_name, title: job.title, id: job.id });
    }
  }

  // Unchanged
  const same = [...currentDomains].every(d => newDomains.has(d)) &&
               [...newDomains].every(d => currentDomains.has(d));
  if (!same) totalChanged++;
}

// Summary
console.log('\n=== DOMAIN TAG DRY-RUN REPORT ===\n');
console.log(`Total jobs changed: ${totalChanged}\n`);

const allDomains = new Set([...Object.keys(gained), ...Object.keys(lost)]);
for (const d of [...allDomains].sort()) {
  const g = (gained[d] || []).length;
  const l = (lost[d] || []).length;
  console.log(`  ${d}: +${g} gained, -${l} lost`);
}

// Details
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
