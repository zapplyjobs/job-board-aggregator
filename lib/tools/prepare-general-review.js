#!/usr/bin/env node

/**
 * Prepare General Review — TAG Adaptive Classifier data prep tool (S238)
 *
 * Loads pipeline data, analyzes the US general pool, and outputs a structured
 * report for Claude Code to read in-session and propose classification filters.
 *
 * Usage:
 *   node tools/prepare-general-review.js [path-to-all-jobs.json]
 *   node tools/prepare-general-review.js --check-keyword "phrase" domain [path]
 *   node tools/prepare-general-review.js --check-phrase "phrase" domain [path]
 *   node tools/prepare-general-review.js --company "CompanyName" [path]
 *   node tools/prepare-general-review.js --sample N [path]
 *   node tools/prepare-general-review.js --tenant-default-candidates [path]
 * Default path: looks for all_jobs.json in standard locations (see resolveDataDir).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { tagDomains } = require(path.join(__dirname, '..', 'processors', 'tag-engine'));

// ─── Config ──────────────────────────────────────────────────────────────────

const DESC_EXCERPT_LEN = 200;   // chars for report samples
const COMPANY_SAMPLE_TITLES = 3; // titles per company in summary
const TOP_COMPANIES = 30;        // companies in main report

// ─── Data Loading ────────────────────────────────────────────────────────────

function resolveDataDir(argPath) {
  if (argPath && fs.existsSync(argPath)) {
    return path.dirname(argPath);
  }
  // Try standard locations relative to shared/
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', '..', 'jobs-data-2026', '.github', 'data'),
    '/tmp',
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'all_jobs.json'))) return dir;
  }
  return null;
}

function loadJobs(filePath) {
  console.error(`Loading: ${filePath}`);
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const jobs = [];
  for (const line of lines) {
    try { jobs.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  console.error(`Loaded: ${jobs.length} jobs`);
  return jobs;
}

function loadDescriptions(dataDir) {
  const descMap = new Map();
  const sidecarFiles = fs.readdirSync(dataDir)
    .filter(f => f.startsWith('descriptions-') && f.endsWith('.jsonl'));
  for (const fname of sidecarFiles) {
    const fpath = path.join(dataDir, fname);
    const lines = fs.readFileSync(fpath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.id && (j.description_text || '').length > 50) {
          descMap.set(j.id, j.description_text);
        }
      } catch { /* skip */ }
    }
  }
  console.error(`Descriptions loaded: ${descMap.size} from ${sidecarFiles.length} sidecar files`);
  return descMap;
}

function injectDescriptions(jobs, descMap) {
  let injected = 0;
  for (const job of jobs) {
    if (!job.description && descMap.has(job.id)) {
      job.description = descMap.get(job.id);
      injected++;
    }
  }
  console.error(`Descriptions injected: ${injected}`);
  return injected;
}

function cleanDesc(desc) {
  return (desc || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Analysis ────────────────────────────────────────────────────────────────

const TECH_DOMAINS = new Set(['software', 'data_science', 'hardware', 'ai']);

function analyzePool(jobs) {
  const usJobs = [];
  const usGeneral = [];
  const usClassified = [];

  for (const job of jobs) {
    const isUS = (job.tags?.locations || []).includes('us');
    if (!isUS) continue;
    if (job.tags?.employment === 'senior') continue; // G1 measures entry-level audience only
    usJobs.push(job);

    // Re-tag with local engine (includes descriptions if injected)
    const domains = tagDomains(job);
    const isGeneral = domains.length === 1 && domains[0] === 'general';

    if (isGeneral) {
      usGeneral.push(job);
    } else {
      job._localDomains = domains;
      usClassified.push(job);
    }
  }

  return { usJobs, usGeneral, usClassified };
}

function companyAnalysis(usGeneral, usClassified) {
  // General by company
  const genByCompany = {};
  for (const j of usGeneral) {
    const co = j.company_name || 'unknown';
    if (!genByCompany[co]) genByCompany[co] = { count: 0, titles: [], hasDesc: 0, source: j.source };
    genByCompany[co].count++;
    if (genByCompany[co].titles.length < 5) genByCompany[co].titles.push(j.title);
    if (j.description && j.description.length > 100) genByCompany[co].hasDesc++;
  }

  // Classified distribution by company
  const classifiedByCompany = {};
  for (const j of usClassified) {
    const co = j.company_name || 'unknown';
    if (!classifiedByCompany[co]) classifiedByCompany[co] = { total: 0, domains: {} };
    classifiedByCompany[co].total++;
    for (const d of (j._localDomains || j.tags?.domains || [])) {
      classifiedByCompany[co].domains[d] = (classifiedByCompany[co].domains[d] || 0) + 1;
    }
  }

  // Merge and sort
  const companies = Object.entries(genByCompany)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, gen]) => {
      const cl = classifiedByCompany[name] || { total: 0, domains: {} };
      const domainsSorted = Object.entries(cl.domains)
        .sort((a, b) => b[1] - a[1])
        .map(([d, c]) => `${Math.round(c / cl.total * 100)}% ${d}`)
        .slice(0, 4);
      return {
        name, generalCount: gen.count, classifiedCount: cl.total,
        domainDist: domainsSorted.join(', '),
        sampleTitles: gen.titles.slice(0, COMPANY_SAMPLE_TITLES),
        hasDescPct: gen.count > 0 ? Math.round(gen.hasDesc / gen.count * 100) : 0,
        source: gen.source,
      };
    });

  return companies;
}

function atsAnalysis(usGeneral, usJobs) {
  const bySource = {};
  for (const j of usJobs) {
    const src = j.source || 'unknown';
    if (!bySource[src]) bySource[src] = { total: 0, general: 0, topCompanies: {} };
    bySource[src].total++;
  }
  for (const j of usGeneral) {
    const src = j.source || 'unknown';
    if (!bySource[src]) bySource[src] = { total: 0, general: 0, topCompanies: {} };
    bySource[src].general++;
    const co = j.company_name || 'unknown';
    bySource[src].topCompanies[co] = (bySource[src].topCompanies[co] || 0) + 1;
  }

  return Object.entries(bySource)
    .sort((a, b) => b[1].general - a[1].general)
    .map(([source, data]) => {
      const topCos = Object.entries(data.topCompanies)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([co, n]) => `${co} (${n})`)
        .join(', ');
      return {
        source, total: data.total, general: data.general,
        pct: (data.general / data.total * 100).toFixed(1),
        topCompanies: topCos,
      };
    });
}

function titlePatterns(usGeneral) {
  // Normalize titles and count
  const normalized = {};
  for (const j of usGeneral) {
    const t = (j.title || '').toLowerCase()
      .replace(/\(.*?\)/g, '')                        // strip parentheticals
      .replace(/\b(i+|iv|v|1st|2nd|3rd|summer|fall|spring|2026|2025|2027)\b/gi, '')
      .replace(/\s*[-–—]\s*(remote|hybrid|onsite).*$/i, '')  // strip location suffix
      .replace(/\s+/g, ' ').trim();
    if (t.length < 3) continue;
    if (!normalized[t]) normalized[t] = { count: 0, companies: new Set(), original: j.title };
    normalized[t].count++;
    normalized[t].companies.add(j.company_name);
  }

  return Object.entries(normalized)
    .filter(([, v]) => v.count >= 3)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([title, data]) => ({
      title, count: data.count,
      companies: data.companies.size,
      original: data.original,
    }));
}

function descriptionAnalysis(usGeneral) {
  let withDesc = 0, withoutDesc = 0;
  for (const j of usGeneral) {
    if (j.description && j.description.length > 100) withDesc++;
    else withoutDesc++;
  }
  return { withDesc, withoutDesc };
}

// ─── Check Keyword Mode ──────────────────────────────────────────────────────

function checkKeyword(keyword, domain, jobs, descMap) {
  const kw = keyword.toLowerCase();
  const genMatches = [];
  const fpMatches = [];

  for (const job of jobs) {
    const isUS = (job.tags?.locations || []).includes('us');
    if (!isUS) continue;

    // Inject desc for local re-tag
    if (!job.description && descMap.has(job.id)) {
      job.description = descMap.get(job.id);
    }
    const domains = tagDomains(job);
    const isGeneral = domains.length === 1 && domains[0] === 'general';
    const titleMatch = job.title.toLowerCase().includes(kw);

    if (!titleMatch) continue;

    if (isGeneral) {
      // Extract ATS category if available
      let atsCategory = null;
      if (job.description) {
        const cd = cleanDesc(job.description);
        const catMatch = cd.match(/Job Category:\s*([A-Za-z &\/]+?)\s*(?:Time Type|$)/i)
          || cd.match(/Job Family\s*:\s*([A-Za-z &\/()]+?)\s*(?:Travel Required|Clearance|$)/i);
        if (catMatch) atsCategory = catMatch[1].trim();
      }
      genMatches.push({ company: job.company_name, title: job.title, id: job.id, atsCategory });
    } else if (!domains.includes(domain)) {
      fpMatches.push({ company: job.company_name, title: job.title, domains, id: job.id });
    }
  }

  console.log(`Checking: "${keyword}" → ${domain}\n`);
  console.log(`General pool matches: ${genMatches.length} jobs`);
  for (const m of genMatches.slice(0, 20)) {
    const catStr = m.atsCategory ? ` [ATS: ${m.atsCategory}]` : '';
    console.log(`  ${m.company}: ${m.title}${catStr}`);
  }
  // Warn if any ATS categories conflict with proposed domain
  const catConflicts = genMatches.filter(m => m.atsCategory).length;
  if (catConflicts > 0) {
    console.log(`  (${catConflicts} jobs have ATS categories — verify alignment with "${domain}")`);
  }
  console.log(`\nClassified pool FPs (in other domains): ${fpMatches.length}`);
  for (const m of fpMatches.slice(0, 10)) {
    console.log(`  ${m.company}: ${m.title} [${m.domains.join(',')}]`);
  }
  const fpDomains = {};
  for (const m of fpMatches) { for (const d of m.domains) fpDomains[d] = (fpDomains[d] || 0) + 1; }
  if (fpMatches.length > 0) {
    console.log(`  FP domains: ${Object.entries(fpDomains).map(([d,c]) => d+':'+c).join(', ')}`);
  }
  console.log(`\nRESULT: ${fpMatches.length === 0 ? 'SAFE' : 'RISKY'} — ${fpMatches.length} FPs, +${genMatches.length} general → ${domain}`);
}

// ─── Check Phrase Mode ───────────────────────────────────────────────────────

function checkPhrase(phrase, domain, jobs, descMap) {
  const p = phrase.toLowerCase();
  const genMatches = [];
  const fpMatches = [];

  for (const job of jobs) {
    const isUS = (job.tags?.locations || []).includes('us');
    if (!isUS) continue;

    if (!job.description && descMap.has(job.id)) {
      job.description = descMap.get(job.id);
    }
    if (!job.description || job.description.length < 100) continue;

    const domains = tagDomains(job);
    const isGeneral = domains.length === 1 && domains[0] === 'general';
    const desc = cleanDesc(job.description).toLowerCase();
    if (!desc.includes(p)) continue;

    if (isGeneral) {
      genMatches.push({ company: job.company_name, title: job.title });
    } else if (!domains.includes(domain)) {
      fpMatches.push({ company: job.company_name, title: job.title, domains });
    }
  }

  console.log(`Checking desc phrase: "${phrase}" → ${domain}\n`);
  console.log(`General with phrase: ${genMatches.length} jobs`);
  for (const m of genMatches.slice(0, 15)) {
    console.log(`  ${m.company}: ${m.title}`);
  }
  console.log(`\nClassified FPs: ${fpMatches.length}`);
  for (const m of fpMatches.slice(0, 10)) {
    console.log(`  ${m.company}: ${m.title} [${m.domains.join(',')}]`);
  }
  console.log(`\nRESULT: ${fpMatches.length === 0 ? 'SAFE' : 'RISKY'} — ${fpMatches.length} FPs, +${genMatches.length} general → ${domain}`);
}

// ─── Company Deep Dive Mode ──────────────────────────────────────────────────

function companyDeepDive(companyName, jobs, descMap) {
  const cn = companyName.toLowerCase();
  const companyJobs = [];
  const classifiedDomains = {};
  let classifiedCount = 0;

  for (const job of jobs) {
    const isUS = (job.tags?.locations || []).includes('us');
    if (!isUS) continue;
    if (!(job.company_name || '').toLowerCase().includes(cn)) continue;

    if (!job.description && descMap.has(job.id)) {
      job.description = descMap.get(job.id);
    }
    const domains = tagDomains(job);
    const isGeneral = domains.length === 1 && domains[0] === 'general';

    if (isGeneral) {
      companyJobs.push(job);
    } else {
      classifiedCount++;
      for (const d of domains) classifiedDomains[d] = (classifiedDomains[d] || 0) + 1;
    }
  }

  const domainDist = Object.entries(classifiedDomains)
    .sort((a, b) => b[1] - a[1])
    .map(([d, c]) => `${Math.round(c / classifiedCount * 100)}% ${d} (${c})`)
    .join(', ');

  console.log(`${companyJobs[0]?.company_name || companyName}: ${companyJobs.length} general / ${classifiedCount} classified`);
  console.log(`  Classified: ${domainDist}\n`);
  console.log(`All ${companyJobs.length} general titles:`);
  for (let i = 0; i < companyJobs.length; i++) {
    const j = companyJobs[i];
    const descLen = (j.description || '').length;
    // Extract ATS category if available
    let catStr = '';
    if (j.description) {
      const cd = cleanDesc(j.description);
      const catMatch = cd.match(/Job Category:\s*([A-Za-z &\/]+?)\s*(?:Time Type|$)/i)
        || cd.match(/Job Family\s*:\s*([A-Za-z &\/()]+?)\s*(?:Travel Required|Clearance|$)/i);
      if (catMatch) catStr = ` [ATS: ${catMatch[1].trim()}]`;
    }
    console.log(`  [${i + 1}] ${j.title} (${j.source}, desc: ${descLen > 0 ? descLen + ' chars' : 'none'})${catStr}`);
  }

  console.log(`\nDescription excerpts:`);
  for (let i = 0; i < companyJobs.length; i++) {
    const j = companyJobs[i];
    if (j.description && j.description.length > 100) {
      const excerpt = cleanDesc(j.description).slice(0, 300);
      console.log(`  [${i + 1}] ${excerpt}`);
    }
  }
}

// ─── Sample Mode ─────────────────────────────────────────────────────────────

function sampleGeneral(n, usGeneral) {
  // Seeded shuffle for reproducibility
  const seed = new Date().toISOString().slice(0, 10);
  const shuffled = [...usGeneral].sort(() => 0.5 - Math.random());
  const sample = shuffled.slice(0, n);

  console.log(`Random sample: ${sample.length} US general jobs (date: ${seed})\n`);
  for (let i = 0; i < sample.length; i++) {
    const j = sample[i];
    const dept = j.departments?.[0] || j.team || 'none';
    console.log(`[${i + 1}] ${j.company_name} | ${j.title} | ${j.source} | dept: ${dept}`);
    if (j.description && j.description.length > 100) {
      console.log(`  Desc (${DESC_EXCERPT_LEN} chars): ${cleanDesc(j.description).slice(0, DESC_EXCERPT_LEN)}`);
    } else {
      console.log(`  Desc: [no description]`);
    }
    console.log();
  }
}

// ─── Core Analysis (shared by text and JSON modes) ──────────────────────────

function buildAnalysis(jobs, usJobs, usGeneral, usClassified) {
  const usTech = usClassified.filter(j => {
    const domains = j._localDomains || j.tags?.domains || [];
    return domains.some(d => TECH_DOMAINS.has(d));
  }).length;
  const techPool = usTech + usGeneral.length;
  return {
    summary: {
      generated: new Date().toISOString(),
      pool_total: jobs.length,
      us_total: usJobs.length,
      us_general: usGeneral.length,
      us_general_rate: parseFloat((usGeneral.length / usJobs.length * 100).toFixed(1)),
      tech_us_total: usTech,
      tech_us_general_rate: techPool > 0 ? parseFloat((usGeneral.length / techPool * 100).toFixed(1)) : null,
    },
    companies: companyAnalysis(usGeneral, usClassified),
    ats: atsAnalysis(usGeneral, usJobs),
    title_patterns: titlePatterns(usGeneral),
    descriptions: descriptionAnalysis(usGeneral),
  };
}

// ─── JSON Output Mode ────────────────────────────────────────────────────────

function jsonReport(analysis) {
  const { summary, companies, ats, title_patterns, descriptions } = analysis;

  // Tenant default candidates: top domain >40% AND 20+ generals
  const tenantCandidates = companies
    .filter(co => co.generalCount >= 20 && co.classifiedCount >= 20)
    .map(co => ({
      name: co.name, general: co.generalCount, classified: co.classifiedCount,
      domain_dist: co.domainDist, samples: co.sampleTitles,
    }));

  const output = {
    meta: { generated: summary.generated, version: 1 },
    summary,
    by_company: companies.slice(0, 50).map(co => ({
      name: co.name, general: co.generalCount, classified: co.classifiedCount,
      domain_dist: co.domainDist, has_desc_pct: co.hasDescPct,
      source: co.source, samples: co.sampleTitles,
    })),
    by_ats: ats.map(a => ({
      source: a.source, total: a.total, general: a.general,
      general_pct: parseFloat(a.pct), top_companies: a.topCompanies,
    })),
    title_patterns: title_patterns.slice(0, 50).map(p => ({
      title: p.title, count: p.count, companies: p.companies,
    })),
    descriptions,
    tenant_candidates: tenantCandidates,
  };

  console.log(JSON.stringify(output, null, 2));
}

// ─── Full Text Report Mode ───────────────────────────────────────────────────

function fullReport(analysis) {
  const { summary, companies, ats, title_patterns, descriptions } = analysis;

  console.log('═══ GENERAL POOL REVIEW REPORT ═══');
  console.log(`Generated: ${summary.generated.slice(0, 10)} | Pool: ${summary.pool_total.toLocaleString()} | US: ${summary.us_total.toLocaleString()} | US General: ${summary.us_general.toLocaleString()} (${summary.us_general_rate}% all-US / ${summary.tech_us_general_rate ?? '?'}% tech-US)\n`);

  // By company
  console.log(`── BY COMPANY (top ${TOP_COMPANIES}) ──────────────────────────────────────────`);
  for (const co of companies.slice(0, TOP_COMPANIES)) {
    console.log(`${co.name}: ${co.generalCount} general / ${co.classifiedCount} classified (${co.domainDist}) [${co.hasDescPct}% have desc]`);
    console.log(`  Samples: ${co.sampleTitles.map(t => `"${t}"`).join(', ')}`);
  }
  console.log(`Total companies with generals: ${companies.length}\n`);

  // By ATS
  console.log('── BY ATS SOURCE ────────────────────────────────────────────────');
  for (const a of ats) {
    console.log(`${a.source}: ${a.general} general (${a.pct}% of ${a.total} US). Top: ${a.topCompanies}`);
  }
  console.log();

  // Title patterns
  console.log('── RECURRING TITLE PATTERNS (3+ occurrences) ──────────────────────');
  for (const p of title_patterns.slice(0, 30)) {
    console.log(`"${p.title}" — ${p.count} jobs, ${p.companies} companies`);
  }
  if (title_patterns.length > 30) console.log(`  ... and ${title_patterns.length - 30} more patterns`);
  console.log();

  // Description analysis
  console.log('── DESCRIPTION ANALYSIS ─────────────────────────────────────────');
  console.log(`With description: ${descriptions.withDesc} (${Math.round(descriptions.withDesc / summary.us_general * 100)}%) | Without: ${descriptions.withoutDesc} (${Math.round(descriptions.withoutDesc / summary.us_general * 100)}%)\n`);

  // Tenant default candidates
  console.log('── TENANT DEFAULT CANDIDATES ────────────────────────────────────');
  console.log('Companies where top domain is >40% of classified AND has 20+ generals:');
  for (const co of companies) {
    if (co.generalCount < 20 || co.classifiedCount < 20) continue;
    console.log(`  ${co.name}: ${co.generalCount} general, ${co.classifiedCount} classified (${co.domainDist})`);
  }
  console.log('(Requires reading actual general titles before confirming any default)\n');
}

function loadCurrentTenantDefaults() {
  const companyListPath = path.join(__dirname, '..', 'fetchers', 'company-list.json');
  const defaults = new Set();
  const companyList = JSON.parse(fs.readFileSync(companyListPath, 'utf8'));
  for (const ats of Object.values(companyList)) {
    if (!Array.isArray(ats)) continue;
    for (const entry of ats) {
      if (entry?.name && entry.default_domain) defaults.add(entry.name);
    }
  }
  return defaults;
}

function buildTenantDefaultCandidates(usGeneral, usClassified) {
  const existingDefaults = loadCurrentTenantDefaults();
  const generalByCompany = new Map();
  const classifiedByCompany = new Map();

  for (const job of usGeneral) {
    const company = job.company_name || 'unknown';
    if (!generalByCompany.has(company)) {
      generalByCompany.set(company, { source: job.source || 'unknown', jobs: [] });
    }
    generalByCompany.get(company).jobs.push(job);
  }

  for (const job of usClassified) {
    const company = job.company_name || 'unknown';
    if (!classifiedByCompany.has(company)) {
      classifiedByCompany.set(company, { total: 0, domains: {} });
    }
    const row = classifiedByCompany.get(company);
    for (const domain of (job._localDomains || job.tags?.domains || [])) {
      row.total++;
      row.domains[domain] = (row.domains[domain] || 0) + 1;
    }
  }

  const candidates = [];
  for (const [company, generalInfo] of generalByCompany.entries()) {
    if (existingDefaults.has(company)) continue;
    if (generalInfo.source !== 'workday') continue;
    const generalCount = generalInfo.jobs.length;
    const classifiedInfo = classifiedByCompany.get(company);
    if (!classifiedInfo || generalCount < 5 || classifiedInfo.total < 8) continue;

    const rankedDomains = Object.entries(classifiedInfo.domains).sort((a, b) => b[1] - a[1]);
    if (rankedDomains.length === 0) continue;
    const [topDomain, topCount] = rankedDomains[0];
    const topSharePct = Math.round(topCount / classifiedInfo.total * 1000) / 10;
    if (topSharePct < 70) continue;

    candidates.push({
      company,
      source: generalInfo.source,
      general: generalCount,
      classified: classifiedInfo.total,
      top_domain: topDomain,
      top_share_pct: topSharePct,
      domain_breakdown: rankedDomains.map(([domain, count]) => ({ domain, count })),
      sample_titles: generalInfo.jobs.slice(0, 6).map(job => job.title),
    });
  }

  return candidates.sort((a, b) =>
    b.top_share_pct - a.top_share_pct ||
    b.general - a.general ||
    b.classified - a.classified ||
    a.company.localeCompare(b.company)
  );
}

function printTenantDefaultCandidates(candidates, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify({
      meta: { generated: new Date().toISOString(), version: 1 },
      thresholds: { source: 'workday', min_general: 5, min_classified: 8, min_top_share_pct: 70 },
      candidates,
    }, null, 2));
    return;
  }

  console.log('═══ TENANT DEFAULT CANDIDATES ═══');
  console.log('Current filter: workday only, no existing default, 5+ current generals, 8+ classified, top domain ≥70%\n');
  if (candidates.length === 0) {
    console.log('No qualifying candidates.');
    return;
  }
  for (const candidate of candidates) {
    const breakdown = candidate.domain_breakdown
      .slice(0, 5)
      .map(row => `${row.domain}:${row.count}`)
      .join(' | ');
    console.log(`${candidate.company}: ${candidate.general} general / ${candidate.classified} classified → ${candidate.top_domain} (${candidate.top_share_pct}%)`);
    console.log(`  Breakdown: ${breakdown}`);
    console.log(`  Samples: ${candidate.sample_titles.map(title => `"${title}"`).join(', ')}`);
  }
}


// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  const jsonMode = args.includes('--json');
  const checkKwIdx = args.indexOf('--check-keyword');
  const checkPhraseIdx = args.indexOf('--check-phrase');
  const companyIdx = args.indexOf('--company');
  const sampleIdx = args.indexOf('--sample');
  const tenantDefaultsMode = args.includes('--tenant-default-candidates');

  // Find the data path (last arg that's not a flag value)
  let dataPath = null;
  for (let i = args.length - 1; i >= 0; i--) {
    if (!args[i].startsWith('--') && (i === 0 || args[i - 1].startsWith('--') === false || ['--check-keyword', '--check-phrase', '--company', '--sample'].includes(args[i - 1]) === false)) {
      if (fs.existsSync(args[i])) { dataPath = args[i]; break; }
    }
  }

  const dataDir = resolveDataDir(dataPath);
  if (!dataDir) {
    console.error('Cannot find all_jobs.json. Provide path as argument or place in standard location.');
    process.exit(1);
  }
  const allJobsPath = dataPath || path.join(dataDir, 'all_jobs.json');
  const jobs = loadJobs(allJobsPath);
  const descMap = loadDescriptions(dataDir);
  injectDescriptions(jobs, descMap);

  // Route to mode
  if (checkKwIdx !== -1) {
    const keyword = args[checkKwIdx + 1];
    const domain = args[checkKwIdx + 2];
    if (!keyword || !domain) { console.error('Usage: --check-keyword "phrase" domain'); process.exit(1); }
    checkKeyword(keyword, domain, jobs, descMap);
  } else if (checkPhraseIdx !== -1) {
    const phrase = args[checkPhraseIdx + 1];
    const domain = args[checkPhraseIdx + 2];
    if (!phrase || !domain) { console.error('Usage: --check-phrase "phrase" domain'); process.exit(1); }
    checkPhrase(phrase, domain, jobs, descMap);
  } else if (companyIdx !== -1) {
    const name = args[companyIdx + 1];
    if (!name) { console.error('Usage: --company "CompanyName"'); process.exit(1); }
    companyDeepDive(name, jobs, descMap);
  } else if (tenantDefaultsMode) {
    const { usGeneral, usClassified } = analyzePool(jobs);
    printTenantDefaultCandidates(buildTenantDefaultCandidates(usGeneral, usClassified), jsonMode);
  } else if (args.includes('--verify')) {
    // Verify reclassified jobs: show all jobs that pipeline tagged general
    // but local engine now classifies, with descriptions for review
    const byDomain = {};
    let total = 0, withDesc = 0;
    for (const job of jobs) {
      const isUS = (job.tags?.locations || []).includes('us');
      if (!isUS) continue;
      const wasGeneral = job.tags?.domains?.length === 1 && job.tags.domains[0] === 'general';
      if (!wasGeneral) continue;
      const result = tagDomains(job, { debug: true });
      if (result.domains.length === 1 && result.domains[0] === 'general') continue;
      total++;
      const domain = result.domains[0];
      const keyword = result.matches[0]?.keyword || 'unknown';
      const desc = job.description ? cleanDesc(job.description).slice(0, 200) : '[no description]';
      let atsCategory = null;
      if (job.description) {
        const cd = cleanDesc(job.description);
        const catMatch = cd.match(/Job Category:\s*([A-Za-z &\/]+?)\s*(?:Time Type|$)/i)
          || cd.match(/Job Family\s*:\s*([A-Za-z &\/()]+?)\s*(?:Travel Required|Clearance|$)/i);
        if (catMatch) atsCategory = catMatch[1].trim();
      }
      if (job.description && job.description.length > 100) withDesc++;
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push({ company: job.company_name, title: job.title, keyword, desc, atsCategory });
    }
    console.log(`═══ RECLASSIFIED JOBS VERIFICATION ═══`);
    console.log(`Total reclassified: ${total} | With descriptions: ${withDesc} | Without: ${total - withDesc}\n`);
    for (const [domain, jobs2] of Object.entries(byDomain).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`── ${domain} (${jobs2.length} jobs) ──`);
      for (const j of jobs2) {
        const cat = j.atsCategory ? ` [ATS: ${j.atsCategory}]` : '';
        console.log(`  ${j.company}: ${j.title} (kw: ${j.keyword})${cat}`);
        console.log(`    ${j.desc}`);
      }
      console.log();
    }
  } else if (sampleIdx !== -1) {
    const n = parseInt(args[sampleIdx + 1]) || 50;
    const { usGeneral } = analyzePool(jobs);
    sampleGeneral(n, usGeneral);
  } else {
    // Full report (text or JSON)
    const { usJobs, usGeneral, usClassified } = analyzePool(jobs);
    const analysis = buildAnalysis(jobs, usJobs, usGeneral, usClassified);
    if (jsonMode) {
      jsonReport(analysis);
    } else {
      fullReport(analysis);
    }
  }
}

main();
