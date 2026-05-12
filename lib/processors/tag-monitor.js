#!/usr/bin/env node

/**
 * Tag Monitor - Accuracy tracking for tag engine
 *
 * Monitors tag distribution and generates accuracy reports.
 * Target: >85% accuracy (validated manually in Phase 3)
 *
 * Usage:
 *   const monitor = require('./processors/tag-monitor');
 *   const report = monitor.generateAccuracyReport(jobs);
 */

const fs = require('fs');
const path = require('path');

// Tag accuracy monitoring file
const MONITOR_FILE = path.join(process.cwd(), '.github', 'data', 'tag-monitor.json');

/**
 * Sample jobs for manual accuracy validation
 * @param {Array} jobs - All jobs
 * @param {number} sampleSize - Number of jobs to sample (default: 100)
 * @returns {Array} - Sampled jobs
 */
function sampleJobsForValidation(jobs, sampleSize = 100) {
  if (jobs.length === 0) return [];

  // Stratified sampling: ensure representation from each domain
  const sampled = [];
  const domains = ['software', 'data_science', 'hardware', 'healthcare', 'ai', 'finance', 'sales', 'operations', 'product', 'retail', 'manufacturing', 'logistics', 'marketing', 'legal', 'hr', 'general'];
  const samplesPerDomain = Math.ceil(sampleSize / domains.length);

  for (const domain of domains) {
    const domainJobs = jobs.filter(job =>
      job.tags && job.tags.domains && job.tags.domains.includes(domain)
    );

    // Random sample from this domain
    const shuffled = domainJobs.sort(() => 0.5 - Math.random());
    sampled.push(...shuffled.slice(0, samplesPerDomain));
  }

  // If we have more than needed, trim down
  return sampled.slice(0, sampleSize);
}

/**
 * Generate accuracy report with sampled jobs
 * @param {Array} jobs - All jobs
 * @returns {Object} - Accuracy report
 */
function generateAccuracyReport(jobs) {
  const sampledJobs = sampleJobsForValidation(jobs, 100);

  return {
    timestamp: new Date().toISOString(),
    total_jobs: jobs.length,
    sampled_count: sampledJobs.length,
    status: 'pending_validation', // Requires manual review
    target_accuracy: 0.85, // 85%
    samples: sampledJobs.map(job => ({
      id: job.id,
      title: job.title,
      company: job.company,
      tags: job.tags,
      // Manual validation fields (to be filled)
      validated: false,
      correct_tags: null,
      issues: []
    }))
  };
}

/**
 * Load previous monitoring data
 * @returns {Object} - Monitor data
 */
function loadMonitorData() {
  try {
    if (fs.existsSync(MONITOR_FILE)) {
      return JSON.parse(fs.readFileSync(MONITOR_FILE, 'utf8'));
    }
  } catch (error) {
    console.warn('⚠️ Error loading monitor data:', error.message);
  }

  return {
    created_at: new Date().toISOString(),
    reports: []
  };
}

/**
 * Save monitoring data
 * @param {Object} data - Monitor data
 */
function saveMonitorData(data) {
  try {
    const dir = path.dirname(MONITOR_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(MONITOR_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log('✅ Tag monitor data saved');
  } catch (error) {
    console.error('⚠️ Error saving monitor data:', error.message);
  }
}

/**
 * Add accuracy report to monitoring history
 * @param {Array} jobs - All jobs
 */
function recordAccuracyReport(jobs) {
  const data = loadMonitorData();
  const report = generateAccuracyReport(jobs);

  data.reports.push(report);

  // Keep only last 10 reports
  if (data.reports.length > 10) {
    data.reports = data.reports.slice(-10);
  }

  saveMonitorData(data);

  return report;
}

/**
 * Calculate tag distribution (for monitoring tag health)
 * @param {Array} jobs - All jobs
 * @returns {Object} - Tag distribution statistics
 */
function calculateTagDistribution(jobs) {
  const distribution = {
    employment: {},
    domains: {},
    locations: {},
    experience: {},
    special: {},
    total: jobs.length
  };

  jobs.forEach(job => {
    if (!job.tags) return;

    // Count employment (mutually exclusive)
    if (job.tags.employment) {
      distribution.employment[job.tags.employment] =
        (distribution.employment[job.tags.employment] || 0) + 1;
    }

    // Count domains (multi-select)
    if (job.tags.domains) {
      job.tags.domains.forEach(domain => {
        distribution.domains[domain] =
          (distribution.domains[domain] || 0) + 1;
      });
    }

    // Count locations (multi-select)
    if (job.tags.locations) {
      job.tags.locations.forEach(location => {
        distribution.locations[location] =
          (distribution.locations[location] || 0) + 1;
      });
    }

    // Count experience (mutually exclusive)
    if (job.tags.experience) {
      distribution.experience[job.tags.experience] =
        (distribution.experience[job.tags.experience] || 0) + 1;
    }

    // Count special (multi-select)
    if (job.tags.special) {
      job.tags.special.forEach(tag => {
        distribution.special[tag] =
          (distribution.special[tag] || 0) + 1;
      });
    }
  });

  return distribution;
}

/**
 * Validate tag health (check for anomalies)
 * @param {Object} distribution - Tag distribution from calculateTagDistribution
 * @returns {Array} - List of warnings
 */
function validateTagHealth(distribution) {
  const warnings = [];
  const total = distribution.total;

  // Check for low tag coverage
  const untagged = total - Object.values(distribution.employment).reduce((a, b) => a + b, 0);
  if (untagged > total * 0.05) {
    warnings.push(`${untagged} jobs (${((untagged/total)*100).toFixed(1)}%) missing employment tags`);
  }

  // Check for domain imbalance
  const domainCounts = Object.values(distribution.domains);
  const maxDomain = Math.max(...domainCounts);
  const minDomain = Math.min(...domainCounts);
  if (maxDomain > minDomain * 10) {
    warnings.push(`Domain imbalance: max ${maxDomain} vs min ${minDomain} jobs`);
  }

  // Check for low remote tag coverage
  const remoteJobs = distribution.locations.remote || 0;
  if (remoteJobs < total * 0.1) {
    warnings.push(`Only ${remoteJobs} (${((remoteJobs/total)*100).toFixed(1)}%) jobs tagged as remote`);
  }

  return warnings;
}

/**
 * Print tag distribution summary
 * @param {Array} jobs - All jobs
 */
function printTagDistribution(jobs) {
  const distribution = calculateTagDistribution(jobs);
  const warnings = validateTagHealth(distribution);

  console.log('');
  console.log('📊 Tag Distribution Summary:');
  console.log('━'.repeat(60));

  // Employment tags
  console.log('Employment:');
  for (const [tag, count] of Object.entries(distribution.employment)) {
    const pct = ((count / jobs.length) * 100).toFixed(1);
    console.log(`  ${tag}: ${count} (${pct}%)`);
  }

  // Domain tags
  console.log('Domains:');
  for (const [tag, count] of Object.entries(distribution.domains)) {
    const pct = ((count / jobs.length) * 100).toFixed(1);
    console.log(`  ${tag}: ${count} (${pct}%)`);
  }

  // Location tags
  console.log('Locations:');
  for (const [tag, count] of Object.entries(distribution.locations)) {
    const pct = ((count / jobs.length) * 100).toFixed(1);
    console.log(`  ${tag}: ${count} (${pct}%)`);
  }

  // Warnings
  if (warnings.length > 0) {
    console.log('');
    console.log('⚠️ Health Warnings:');
    warnings.forEach(w => console.log(`  - ${w}`));
  }

  console.log('');
}

/**
 * Check pipeline-code drift for domain tags.
 * Samples US jobs, re-runs tagDomains() on title-only, compares to pipeline tags.
 * Pipeline tags may include carry-forward from description fallback; fresh tags won't.
 * High drift means many jobs have stale tags from prior pipeline runs.
 *
 * TAG-AUDIT-4: Drift detection — flag if >5% drift.
 *
 * @param {Array} jobs - Full pool of tagged jobs (post-merge)
 * @param {Function} tagDomainsFn - tag-engine's tagDomains function
 * @param {number} sampleSize - Jobs to sample (default: 500)
 * @returns {Object} - Drift report
 */
function checkTagDrift(jobs, tagDomainsFn, sampleSize = 500) {
  const usJobs = jobs.filter(j => j.tags && j.tags.locations && j.tags.locations.includes('us'));
  if (usJobs.length === 0) return { drift_rate: 0, sample_size: 0, drifted: 0, warnings: [] };

  // Sample jobs (deterministic shuffle using job id for reproducibility)
  const sorted = [...usJobs].sort((a, b) => (a.id || '').localeCompare(b.id || ''));
  const step = Math.max(1, Math.floor(sorted.length / sampleSize));
  const sampled = [];
  for (let i = 0; i < sorted.length && sampled.length < sampleSize; i += step) {
    sampled.push(sorted[i]);
  }

  let drifted = 0;
  const driftDetails = { domain_changed: 0, employment_changed: 0 };
  const examples = [];

  for (const job of sampled) {
    const freshTags = tagDomainsFn(job);
    const pipelineDomains = (job.tags && job.tags.domains) || [];
    const freshDomains = freshTags || [];

    // Compare domain tags (sorted for stable comparison)
    const pd = [...pipelineDomains].sort().join(',');
    const fd = [...freshDomains].sort().join(',');

    if (pd !== fd) {
      drifted++;
      driftDetails.domain_changed++;
      if (examples.length < 5) {
        examples.push({
          title: (job.title || '').substring(0, 60),
          pipeline: pipelineDomains,
          fresh: freshDomains,
        });
      }
    }
  }

  const driftRate = sampled.length > 0 ? drifted / sampled.length : 0;
  const warnings = [];
  const DRIFT_THRESHOLD = 0.05;
  if (driftRate > DRIFT_THRESHOLD) {
    warnings.push(`Drift rate ${(driftRate * 100).toFixed(1)}% exceeds ${(DRIFT_THRESHOLD * 100)}% threshold (${drifted}/${sampled.length} jobs)`);
  }

  return {
    drift_rate: driftRate,
    drift_pct: (driftRate * 100).toFixed(1) + '%',
    sample_size: sampled.length,
    drifted,
    details: driftDetails,
    examples,
    warnings,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Print drift report to console
 * @param {Object} report - Drift report from checkTagDrift
 */
function printDriftReport(report) {
  console.log('');
  console.log('🔍 Tag Drift Detection (TAG-AUDIT-4):');
  console.log('━'.repeat(60));
  console.log(`  Sample: ${report.sample_size} jobs`);
  console.log(`  Drifted: ${report.drifted} (${report.drift_pct})`);
  console.log(`  Domain changes: ${report.details.domain_changed}`);
  if (report.examples.length > 0) {
    console.log('  Examples:');
    for (const ex of report.examples) {
      console.log(`    "${ex.title}"`);
      console.log(`      Pipeline: ${ex.pipeline.join(', ')} → Fresh: ${ex.fresh.join(', ')}`);
    }
  }
  if (report.warnings.length > 0) {
    console.log('  ⚠️  WARNINGS:');
    for (const w of report.warnings) {
      console.log(`    - ${w}`);
    }
  } else {
    console.log('  ✅ Drift within threshold');
  }
  console.log('');
}

/**
 * Check per-domain precision for consumer-facing domains.
 *
 * TAG-MONITOR-1: Redesigned from pattern-matching to cross-domain exclusion.
 * Previous approach: ~20 hardcoded regex patterns that could only detect known FPs.
 * Result was a tautology — 0.00% FP rate while independent scan found ~11% suspect jobs.
 *
 * New approach: Domain exclusion vocabulary + context-aware overrides.
 * For each consumer domain, defines title terms that indicate the job does NOT belong.
 * Catches novel FPs, not just known patterns. Minimum 50 samples per domain.
 *
 * Output format is backward-compatible with generate-zjp-metrics.js (domains.*.total/fps/fp_rate).
 *
 * @param {Array} jobs - Full pool of tagged jobs (post-merge)
 * @param {number} threshold - FP rate threshold (default: 0.05 = 5%)
 * @returns {Object} - Precision report per domain
 */
function checkDomainPrecision(jobs, threshold = 0.05) {
  // Use tags.locations (country-level: ['us']) not locations (city-level: ['Reston, VA'])
  const usJobs = jobs.filter(j => j.tags && j.tags.locations && j.tags.locations.includes('us'));

  // Domain exclusion vocabularies: terms in a title that suggest the job
  // doesn't belong in this domain. Each entry: { re, reason, unless? }
  // `unless` is an optional regex — if it matches, the exclusion is overridden.
  const domainExclusions = {
    software: [
      // Non-engineering disciplines
      { re: /\bmechanical engineer/i, reason: 'mechanical engineer (not SWE)' },
      { re: /\belectrical engineer/i, reason: 'electrical engineer (not SWE)', unless: /\b(software|firmware|embedded|computer|application)\b/i },
      { re: /\bcivil engineer/i, reason: 'civil engineer (not SWE)' },
      { re: /\bstructural engineer/i, reason: 'structural engineer (not SWE)' },
      { re: /\bgeotechnical engineer/i, reason: 'geotechnical engineer (not SWE)' },
      // Supply chain / logistics
      { re: /\b(supply chain|procurement|warehouse|shipping|receiving|inventory|logistics)\b/i, reason: 'supply chain/logistics role', unless: /\b(software|engineer|developer|platform|technology)\b/i },
      // Sales / account roles
      { re: /\b(sales|account exec|account representative|territory manager|business development)\b/i, reason: 'sales/BD role (not SWE)', unless: /\b(engineer|developer|software)\b/i },
      // Non-SWE IT roles
      { re: /\b(it support|help desk|service desk|desktop support)\b/i, reason: 'IT support (not SWE)' },
      { re: /\bscrum master\b/i, reason: 'scrum master (not SWE)' },
      { re: /\bagile coach\b/i, reason: 'agile coach (not SWE)' },
      { re: /\btechnical writer\b/i, reason: 'technical writer (not SWE)' },
      // Hardware-specific
      { re: /\b(firmware|driver|embedded systems|pcb|circuit|silicon|chip|semiconductor|fpga|asic|vlsi)\b/i, reason: 'hardware-specific role', unless: /\b(software|application|engineer.*software|python|java|full.?stack)\b/i },
      // Operations/manufacturing
      { re: /\b(quality engineer|quality assurance|manufacturing|production|assembly|machining)\b/i, reason: 'manufacturing/quality role', unless: /\b(software|selenium|developer)\b|\bautomation\b/i },
      // Program/project management (non-tech)
      { re: /\b(program manager|project manager)\b/i, reason: 'PM role', unless: /\b(software|engineer|technical|technology|platform|api|developer|swe|cyber|security|cybersecurity|ml|ai|data|video|hardware|chip)\b/i },
      // Finance/banking
      { re: /\b(financial|accountant|auditor|tax|investment banking)\b/i, reason: 'finance role', unless: /\b(software|engineer|developer|technology|platform)\b/i },
      // Design/creative
      { re: /\b(graphic design|ux writer|content design|visual design)\b/i, reason: 'design role (not SWE)', unless: /\b(engineer|developer)\b/i },
    ],
    hardware: [
      // Pure software roles
      { re: /\b(software engineer|software developer|full.?stack|frontend|backend|web developer|java developer|python developer)\b/i, reason: 'pure SWE role (not HW)' },
      // Sales/account roles
      { re: /\b(sales|account exec|account representative|territory manager)\b/i, reason: 'sales role (not HW)' },
      // Finance/banking
      { re: /\b(financial|accountant|auditor|investment)\b/i, reason: 'finance role (not HW)' },
      // Supply chain
      { re: /\b(supply chain|procurement|warehouse|logistics)\b/i, reason: 'supply chain/logistics (not HW)', unless: /\b(engineer|hardware|semiconductor|chip)\b/i },
      // IT support
      { re: /\b(it support|help desk|service desk)\b/i, reason: 'IT support (not HW)' },
      // Embedded in non-tech context
      { re: /\bembedded\b/i, reason: 'embedded in non-HW context', unless: /\b(engineer|hardware|systems|firmware|iot|semiconductor)\b/i },
    ],
    healthcare: [
      // Sales/account roles
      { re: /\b(sales|territory|account manager|account exec)\b/i, reason: 'sales role (not clinical)', unless: /\b(clinical|nurse|pharmacist|physician|doctor|medical|patient)\b/i },
      // Non-clinical research
      { re: /\b(research associate)\b/i, reason: 'research associate (non-clinical)', unless: /\b(clinical|medical|health|pharma|biotech|lab|biology|drug|oncology|biochemist|molecular|cell|genetic|immunolog)\b/i },
      // Finance
      { re: /\b(financial|accountant|auditor)\b/i, reason: 'finance role (not clinical)' },
      // Supply chain
      { re: /\b(supply chain|procurement|warehouse)\b/i, reason: 'supply chain (not clinical)' },
      // IT
      { re: /\b(software engineer|software developer|data scientist)\b/i, reason: 'tech role (not clinical)' },
    ],
    data_science: [
      // Pure SWE roles
      { re: /\b(software engineer|software developer|full.?stack|frontend|backend)\b/i, reason: 'SWE role (not DS)', unless: /\b(data|ml|machine learning|analytics|statistician|scientist)\b/i },
      // Sales
      { re: /\b(sales|account exec|territory manager)\b/i, reason: 'sales role (not DS)' },
      // Mechanical/physical data roles
      { re: /\b(mechanical|materials|physical).*(data|specialist)\b/i, reason: 'non-DS data role' },
      // Data entry
      { re: /\bdata entry\b/i, reason: 'data entry (not DS)' },
      // AI sales
      { re: /\bai\b/i, reason: 'AI keyword in non-DS context', unless: /\b(data|scientist|ml|machine learning|analytics|engineer|researcher|model)\b/i },
    ],
  };

  const consumerDomains = ['software', 'hardware', 'healthcare', 'data_science'];
  const report = { domains: {}, warnings: [], timestamp: new Date().toISOString() };

  for (const domain of consumerDomains) {
    const exclusions = domainExclusions[domain];
    if (!exclusions) continue;

    const domainJobs = usJobs.filter(j => j.tags && j.tags.domains && j.tags.domains.includes(domain));
    const total = domainJobs.length;
    if (total === 0) continue;

    const fps = [];
    for (const job of domainJobs) {
      const title = job.title || '';
      for (const { re, reason, unless } of exclusions) {
        if (re.test(title)) {
          if (unless && unless.test(title)) continue;
          fps.push({ title: title.substring(0, 80), company: job.company_name || job.company || '', reason });
          break;
        }
      }
    }

    const fpRate = fps.length / total;
    const domainReport = {
      total,
      fps: fps.length,
      fp_rate: fpRate,
      fp_pct: (fpRate * 100).toFixed(2) + '%',
      examples: fps.slice(0, 10),
    };

    report.domains[domain] = domainReport;

    if (fpRate > threshold) {
      report.warnings.push(
        `${domain}: ${(fpRate * 100).toFixed(2)}% suspect rate exceeds ${(threshold * 100)}% threshold (${fps.length}/${total} jobs)`
      );
    }
  }

  return report;
}

/**
 * Print precision report to console
 * @param {Object} report - Precision report from checkDomainPrecision
 */
function printPrecisionReport(report) {
  console.log('');
  console.log('🎯 Domain Precision Check (TAG-MONITOR-1):');
  console.log('━'.repeat(60));
  for (const [domain, dr] of Object.entries(report.domains)) {
    const status = parseFloat(dr.fp_pct) > 5 ? '⚠️ ' : '✅';
    console.log(`  ${status} ${domain}: ${dr.fps} suspect / ${dr.total} total (${dr.fp_pct})`);
    if (dr.examples.length > 0) {
      for (const ex of dr.examples.slice(0, 5)) {
        console.log(`     - "${ex.title}" (${ex.company}) — ${ex.reason}`);
      }
    }
  }
  if (report.warnings.length > 0) {
    console.log('  ⚠️  PRECISION WARNINGS:');
    for (const w of report.warnings) {
      console.log(`    - ${w}`);
    }
  }
  console.log('');
}

/**
 * Check per-keyword match health for domain keyword arrays.
 * Counts how many jobs each keyword matches and flags high-volume keywords
 * that may indicate over-matching or keyword drift.
 *
 * @param {Array} jobs - Full pool of tagged jobs
 * @param {Object} domainKeywords - Map of domain name to keyword array (from tag-engine exports)
 * @param {number} volumeThreshold - Flag keywords matching > this fraction of domain jobs (default: 0.15)
 * @returns {Object} - Per-keyword health report
 */
function checkKeywordHealth(jobs, domainKeywords, volumeThreshold = 0.15) {
  const usJobs = jobs.filter(j => j.tags && j.tags.locations && j.tags.locations.includes('us'));

  const report = {
    timestamp: new Date().toISOString(),
    domains: {},
    warnings: [],
  };

  for (const [domain, keywords] of Object.entries(domainKeywords)) {
    if (!Array.isArray(keywords) || keywords.length === 0) continue;

    const domainJobs = usJobs.filter(j =>
      j.tags && j.tags.domains && j.tags.domains.includes(domain)
    );

    if (domainJobs.length === 0) continue;

    const keywordMatches = [];
    for (const kw of keywords) {
      const matched = domainJobs.filter(j =>
        (j.title || '').toLowerCase().includes(kw.toLowerCase())
      );
      keywordMatches.push({
        keyword: kw,
        matches: matched.length,
        rate: matched.length / domainJobs.length,
        rate_pct: (matched.length / domainJobs.length * 100).toFixed(1) + '%',
      });
    }

    keywordMatches.sort((a, b) => b.matches - a.matches);

    const highVolume = keywordMatches.filter(km => km.rate > volumeThreshold);
    const topContributors = keywordMatches.filter(km => km.matches > 0).slice(0, 10);

    report.domains[domain] = {
      total_jobs: domainJobs.length,
      keyword_count: keywords.length,
      keywords_with_matches: keywordMatches.filter(km => km.matches > 0).length,
      top_contributors: topContributors,
      high_volume: highVolume.map(km =>
        `${km.keyword} (${km.matches} jobs, ${km.rate_pct} of domain)`
      ),
    };

    for (const km of highVolume) {
      report.warnings.push(
        `${domain}: keyword "${km.keyword}" matches ${km.matches} jobs (${km.rate_pct} of domain) — potential over-match`
      );
    }
  }

  return report;
}

/**
 * Print keyword health report to console
 * @param {Object} report - Report from checkKeywordHealth
 */
function printKeywordHealthReport(report) {
  console.log('');
  console.log('📋 Keyword Health Check:');
  console.log('━'.repeat(60));
  for (const [domain, dr] of Object.entries(report.domains)) {
    console.log(`  ${domain}: ${dr.keywords_with_matches}/${dr.keyword_count} keywords active (${dr.total_jobs} jobs)`);
    if (dr.top_contributors.length > 0) {
      for (const tc of dr.top_contributors.slice(0, 5)) {
        console.log(`    - "${tc.keyword}": ${tc.matches} matches (${tc.rate_pct})`);
      }
    }
    if (dr.high_volume.length > 0) {
      for (const hv of dr.high_volume) {
        console.log(`    ⚠️  ${hv}`);
      }
    }
  }
  if (report.warnings.length > 0) {
    console.log('  ⚠️  KEYWORD WARNINGS:');
    for (const w of report.warnings) {
      console.log(`    - ${w}`);
    }
  }
  console.log('');
}

/**
 * Check cross-domain keyword overlap for novel FP detection.
 * For each domain, checks whether keywords from OTHER domains also match
 * its jobs. Flags keywords with >5% overlap rate as potential cross-domain leakage.
 *
 * @param {Array} jobs - Full pool of tagged jobs (US only recommended)
 * @param {Object} domainKeywords - Map of domain name to keyword array (from tag-engine exports)
 * @param {number} overlapThreshold - Flag keywords matching > this fraction of domain jobs (default: 0.05)
 * @returns {Object} - Per-domain cross-reference report
 */
function checkKeywordOverlap(jobs, domainKeywords, overlapThreshold = 0.05) {
  const usJobs = jobs.filter(j => j.tags && j.tags.locations && j.tags.locations.includes('us'));

  const report = {
    timestamp: new Date().toISOString(),
    domains: {},
    warnings: [],
  };

  const domainNames = Object.keys(domainKeywords).filter(d => Array.isArray(domainKeywords[d]) && domainKeywords[d].length > 0);

  for (const targetDomain of domainNames) {
    const targetJobs = usJobs.filter(j =>
      j.tags && j.tags.domains && j.tags.domains.includes(targetDomain)
    );
    if (targetJobs.length === 0) continue;

    const foreignOverlaps = [];

    for (const foreignDomain of domainNames) {
      if (foreignDomain === targetDomain) continue;
      const foreignKws = domainKeywords[foreignDomain];
      if (!Array.isArray(foreignKws) || foreignKws.length === 0) continue;

      for (const kw of foreignKws) {
        const kwLower = kw.toLowerCase();
        const matches = targetJobs.filter(j => (j.title || '').toLowerCase().includes(kwLower)).length;
        if (matches === 0) continue;

        const rate = matches / targetJobs.length;
        if (rate >= overlapThreshold) {
          foreignOverlaps.push({
            keyword: kw,
            from_domain: foreignDomain,
            matches,
            rate,
            rate_pct: (rate * 100).toFixed(1) + '%',
          });
        }
      }
    }

    foreignOverlaps.sort((a, b) => b.rate - a.rate);
    const topOverlaps = foreignOverlaps.slice(0, 10);

    report.domains[targetDomain] = {
      total_jobs: targetJobs.length,
      foreign_keyword_overlaps: topOverlaps.length,
      top_overlaps: topOverlaps,
    };

    for (const ov of topOverlaps) {
      report.warnings.push(
        `${targetDomain}: keyword "${ov.keyword}" (from ${ov.from_domain}) matches ${ov.matches} jobs (${ov.rate_pct}) — potential cross-domain leakage`
      );
    }
  }

  return report;
}

/**
 * Print keyword overlap report to console
 * @param {Object} report - Report from checkKeywordOverlap
 */
function printKeywordOverlapReport(report) {
  console.log('');
  console.log('🔀 Cross-Domain Keyword Overlap Check:');
  console.log('━'.repeat(60));
  for (const [domain, dr] of Object.entries(report.domains)) {
    if (dr.foreign_keyword_overlaps === 0) continue;
    console.log(`  ${domain}: ${dr.foreign_keyword_overlaps} foreign keyword overlaps (${dr.total_jobs} jobs)`);
    for (const ov of dr.top_overlaps.slice(0, 3)) {
      console.log(`    - "${ov.keyword}" (${ov.from_domain}): ${ov.matches} matches (${ov.rate_pct})`);
    }
  }
  if (report.warnings.length > 0) {
    console.log(`  ⚠️  ${report.warnings.length} total overlap warnings`);
  } else {
    console.log('  ✅ No significant cross-domain keyword overlap detected');
  }
}

module.exports = {
  sampleJobsForValidation,
  generateAccuracyReport,
  recordAccuracyReport,
  calculateTagDistribution,
  validateTagHealth,
  printTagDistribution,
  loadMonitorData,
  saveMonitorData,
  checkTagDrift,
  printDriftReport,
  checkDomainPrecision,
  printPrecisionReport,
  checkKeywordHealth,
  printKeywordHealthReport,
  checkKeywordOverlap,
  printKeywordOverlapReport,
};