#!/usr/bin/env node
/**
 * ATS Platform Lookup Tool
 *
 * Probes all 5 ATS platforms (Greenhouse, Lever, Ashby, Workday, SmartRecruiters)
 * for a given company name. Reports which platform(s) host the company's job board
 * and how many jobs are listed.
 *
 * Usage:
 *   node ats-lookup.js "Stripe"
 *   node ats-lookup.js --slug stripe         # skip slug generation, use exact slug
 *   node ats-lookup.js --json "Stripe"        # JSON output
 *
 * Slug generation strategy:
 *   - Greenhouse/Lever/Ashby: lowercase, strip special chars, common alias mappings
 *   - SmartRecruiters: PascalCase (e.g., "BoschGroup")
 *   - Workday: tries {name}.wd5 and {name}.wd1 with common site names
 */

'use strict';

const { getJson, postJson, delay } = require('./http-client');

const ATS_PLATFORMS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday'];

const DELAY_MS = 300;

// Common company name → slug aliases (built from experience with company-list.json)
const SLUG_ALIASES = {
  'google': 'google',
  'alphabet': 'google',
  'meta': 'meta',
  'facebook': 'meta',
  'amazon': 'amazon',
  'apple': 'apple',
  'netflix': 'netflix',
  'microsoft': 'microsoft',
  'tesla': 'tesla',
  'nvidia': 'nvidia',
  'stripe': 'stripe',
  'spotify': 'spotify',
  'airbnb': 'airbnb',
  'uber': 'uber',
  'lyft': 'lyft',
  'square': 'square',
  'block': 'square',
  'twilio': 'twilio',
  'coinbase': 'coinbase',
  'robinhood': 'robinhood',
  'plaid': 'plaid',
  'datadog': 'datadog',
  'snowflake': 'snowflakecomputing',
  'databricks': 'databricks',
  'palantir': 'palantir',
  'anduril': 'anduril',
  'openai': 'openai',
  'anthropic': 'anthropic',
  'scale ai': 'scaleai',
  'scale': 'scaleai',
};

function generateSlugs(companyName) {
  const lower = companyName.toLowerCase().trim();
  const base = lower.replace(/[^a-z0-9]/g, '');

  const slugs = {
    greenhouse: [],
    lever: [],
    ashby: [],
    smartrecruiters: [],
    workday: [],
  };

  // Check aliases first
  if (SLUG_ALIASES[lower]) {
    const alias = SLUG_ALIASES[lower];
    slugs.greenhouse.push(alias);
    slugs.lever.push(alias);
    slugs.ashby.push(alias);
  }

  // Greenhouse/Lever/Ashby: lowercase, no spaces/special chars
  slugs.greenhouse.push(base);
  slugs.lever.push(base);
  slugs.ashby.push(base);

  // Also try with hyphens preserved and stripped variants
  const hyphenated = lower.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  if (hyphenated !== base) {
    slugs.greenhouse.push(hyphenated);
    slugs.ashby.push(hyphenated);
  }

  // SmartRecruiters: PascalCase / various formats
  const pascal = companyName.trim().replace(/[^a-zA-Z0-9\s]/g, '').split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
  slugs.smartrecruiters.push(pascal);
  slugs.smartrecruiters.push(base);

  // Workday: try {tenant}.wd5 / wd1 with common site names
  slugs.workday.push({
    tenant: base,
    wdServers: ['wd5', 'wd1', 'wd3'],
    sites: ['External', base, 'careers', 'external_experienced', 'External_Career_Site', 'Career_Site'],
  });

  return slugs;
}

async function probeGreenhouse(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  const result = await getJson(url, { timeout: 10000 });
  if (!result || result.status !== 200 || !result.data?.jobs) {
    return null;
  }
  return { platform: 'greenhouse', slug, jobCount: result.data.jobs.length };
}

async function probeLever(slug) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const result = await getJson(url, { timeout: 10000 });
  if (!result || result.status !== 200 || !Array.isArray(result.data)) {
    return null;
  }
  return { platform: 'lever', slug, jobCount: result.data.length };
}

async function probeAshby(slug) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  const result = await getJson(url, { timeout: 10000 });
  if (!result || result.status !== 200 || !result.data?.jobs?.length) {
    return null;
  }
  return { platform: 'ashby', slug, jobCount: result.data.jobs.length };
}

async function probeSmartRecruiters(slug) {
  const url = `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1&offset=0`;
  const result = await getJson(url, { timeout: 10000 });
  if (!result || result.status !== 200) {
    return null;
  }
  const total = result.data?.totalFound || 0;
  if (total === 0) return null; // SR returns 200 with 0 for random slugs
  return { platform: 'smartrecruiters', slug, jobCount: total };
}

async function probeWorkday(config) {
  const { tenant, wdServers, sites } = config;

  for (const wd of wdServers) {
    for (const site of sites) {
      const url = `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
      try {
        const result = await postJson(url, { limit: 1, offset: 0 }, { timeout: 10000 });
        if (result && result.status === 200 && result.data?.jobPostings) {
          const total = result.data.total || result.data.jobPostings.length;
          return { platform: 'workday', slug: `${tenant}.${wd}`, site, jobCount: total };
        }
      } catch (_) {
        // Continue to next combo
      }
      await delay(100);
    }
  }

  return null;
}

async function lookupCompany(companyName, options = {}) {
  const { exactSlug = null, jsonOutput = false } = options;

  if (!jsonOutput) {
    console.log(`\nATS Lookup: ${companyName}`);
    console.log('━'.repeat(50));
  }

  const slugs = generateSlugs(companyName);
  const results = [];

  // If exact slug provided, override all generated slugs
  if (exactSlug) {
    slugs.greenhouse = [exactSlug];
    slugs.lever = [exactSlug];
    slugs.ashby = [exactSlug];
    slugs.smartrecruiters = [exactSlug];
    slugs.workday = [{
      tenant: exactSlug,
      wdServers: ['wd5', 'wd1', 'wd3'],
      sites: ['External', exactSlug, 'careers', 'external_experienced', 'External_Career_Site', 'Career_Site'],
    }];
  }

  // Check if already in company-list.json
  const companyList = loadCompanyList();
  const existingEntry = findInCompanyList(companyName, companyList);
  if (existingEntry && !jsonOutput) {
    console.log(`  Already tracked: ${existingEntry.platform} as "${existingEntry.slug}" (${existingEntry.jobCount || '?'} jobs)`);
  }

  // Probe Greenhouse
  for (const slug of slugs.greenhouse) {
    if (!jsonOutput) process.stdout.write(`  Greenhouse (${slug})... `);
    const result = await probeGreenhouse(slug);
    if (result) {
      results.push(result);
      if (!jsonOutput) console.log(`FOUND — ${result.jobCount} jobs`);
      break;
    }
    if (!jsonOutput) console.log('not found');
    await delay(DELAY_MS);
  }

  // Probe Lever
  for (const slug of slugs.lever) {
    if (!jsonOutput) process.stdout.write(`  Lever (${slug})... `);
    const result = await probeLever(slug);
    if (result) {
      results.push(result);
      if (!jsonOutput) console.log(`FOUND — ${result.jobCount} jobs`);
      break;
    }
    if (!jsonOutput) console.log('not found');
    await delay(DELAY_MS);
  }

  // Probe Ashby
  for (const slug of slugs.ashby) {
    if (!jsonOutput) process.stdout.write(`  Ashby (${slug})... `);
    const result = await probeAshby(slug);
    if (result) {
      results.push(result);
      if (!jsonOutput) console.log(`FOUND — ${result.jobCount} jobs`);
      break;
    }
    if (!jsonOutput) console.log('not found');
    await delay(DELAY_MS);
  }

  // Probe SmartRecruiters
  for (const slug of slugs.smartrecruiters) {
    if (!jsonOutput) process.stdout.write(`  SmartRecruiters (${slug})... `);
    const result = await probeSmartRecruiters(slug);
    if (result) {
      results.push(result);
      if (!jsonOutput) console.log(`FOUND — ${result.jobCount} jobs`);
      break;
    }
    if (!jsonOutput) console.log('not found');
    await delay(DELAY_MS);
  }

  // Probe Workday (most complex)
  for (const config of slugs.workday) {
    if (!jsonOutput) process.stdout.write(`  Workday (${config.tenant})... `);
    const result = await probeWorkday(config);
    if (result) {
      results.push(result);
      if (!jsonOutput) console.log(`FOUND — ${result.jobCount} jobs (site: ${result.site})`);
      break;
    }
    if (!jsonOutput) console.log('not found');
    await delay(DELAY_MS);
  }

  if (jsonOutput) {
    return { company: companyName, results, existing: existingEntry };
  }

  // Summary
  if (results.length === 0) {
    console.log('\n  No ATS board found. Try --slug with the exact board token.');
  } else {
    console.log(`\n  Best match: ${results[0].platform} (${results[0].slug}) — ${results[0].jobCount} jobs`);
    if (results.length > 1) {
      console.log(`  Also found on: ${results.slice(1).map(r => `${r.platform} (${r.slug})`).join(', ')}`);
    }
  }

  return { company: companyName, results, existing: existingEntry };
}

function loadCompanyList() {
  try {
    const fs = require('fs');
    const path = require('path');
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'company-list.json'), 'utf8'));
    return data;
  } catch (_) {
    return null;
  }
}

function findInCompanyList(companyName, companyList) {
  if (!companyList) return null;
  const lower = companyName.toLowerCase().trim();

  for (const platform of ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday']) {
    const entries = companyList[platform] || [];
    for (const entry of entries) {
      const entryName = (entry.name || '').toLowerCase();
      const entrySlug = (entry.slug || entry.url || '').toLowerCase();
      if (entryName === lower || entrySlug === lower || entryName.includes(lower) || lower.includes(entryName)) {
        return {
          platform,
          slug: entry.slug || entry.url,
          name: entry.name,
          jobCount: entry.verified_jobs || entry.verified_us_jobs || null,
        };
      }
    }
  }
  return null;
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node ats-lookup.js "Company Name"');
    console.log('       node ats-lookup.js --slug stripe "Stripe"');
    console.log('       node ats-lookup.js --json "Stripe"');
    process.exit(1);
  }

  let exactSlug = null;
  let jsonOutput = false;
  let companyName = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--slug' && args[i + 1]) {
      exactSlug = args[++i];
    } else if (args[i] === '--json') {
      jsonOutput = true;
    } else {
      companyName = args[i];
    }
  }

  if (!companyName) {
    console.error('Error: Company name required');
    process.exit(1);
  }

  const result = await lookupCompany(companyName, { exactSlug, jsonOutput });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
