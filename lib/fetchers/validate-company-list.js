#!/usr/bin/env node
/**
 * Company List Schema Validator
 *
 * Validates company-list.json structure and content:
 * - Top-level keys: _meta, greenhouse, lever, ashby, workday, smartrecruiters
 * - Per-platform entries have required fields
 * - No duplicate slugs within a platform
 * - No duplicate names across platforms (zero overlap expected)
 * - Workday entries have url + site fields
 * - No empty names or slugs
 *
 * Exit code: 0 = valid, 1 = errors found
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_KEYS = new Set(['_meta', 'greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters']);

const SIMPLE_PLATFORMS = ['greenhouse', 'lever', 'ashby'];

function validate() {
  const filePath = path.join(__dirname, 'company-list.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  let data;

  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error('FAIL: company-list.json is not valid JSON:', e.message);
    process.exit(1);
  }

  const errors = [];
  const warnings = [];

  // 1. Top-level keys
  const actualKeys = new Set(Object.keys(data));
  for (const key of EXPECTED_KEYS) {
    if (!actualKeys.has(key)) {
      errors.push(`Missing top-level key: ${key}`);
    }
  }
  for (const key of actualKeys) {
    if (!EXPECTED_KEYS.has(key)) {
      warnings.push(`Unexpected top-level key: ${key}`);
    }
  }

  // 2. Simple platforms (greenhouse, lever, ashby) — require slug + name
  for (const platform of SIMPLE_PLATFORMS) {
    const entries = data[platform] || [];
    if (!Array.isArray(entries)) {
      errors.push(`${platform} is not an array`);
      continue;
    }

    const slugs = new Set();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e.slug || typeof e.slug !== 'string' || !e.slug.trim()) {
        errors.push(`${platform}[${i}]: missing or empty slug (name: "${e.name || '?'}")`);
      }
      if (!e.name || typeof e.name !== 'string' || !e.name.trim()) {
        errors.push(`${platform}[${i}]: missing or empty name (slug: "${e.slug || '?'}")`);
      }
      if (e.slug && slugs.has(e.slug)) {
        errors.push(`${platform}[${i}]: duplicate slug "${e.slug}"`);
      }
      if (e.slug) slugs.add(e.slug);
    }
  }

  // 3. SmartRecruiters — require slug + name
  {
    const entries = data.smartrecruiters || [];
    if (!Array.isArray(entries)) {
      errors.push('smartrecruiters is not an array');
    } else {
      const slugs = new Set();
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e.slug || typeof e.slug !== 'string' || !e.slug.trim()) {
          errors.push(`smartrecruiters[${i}]: missing or empty slug (name: "${e.name || '?'}")`);
        }
        if (!e.name || typeof e.name !== 'string' || !e.name.trim()) {
          errors.push(`smartrecruiters[${i}]: missing or empty name (slug: "${e.slug || '?'}")`);
        }
        if (e.slug && slugs.has(e.slug)) {
          errors.push(`smartrecruiters[${i}]: duplicate slug "${e.slug}"`);
        }
        if (e.slug) slugs.add(e.slug);
      }
    }
  }

  // 4. Workday — require url + site + name
  {
    const entries = data.workday || [];
    if (!Array.isArray(entries)) {
      errors.push('workday is not an array');
    } else {
      const urlSites = new Set();
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e.name || typeof e.name !== 'string' || !e.name.trim()) {
          errors.push(`workday[${i}]: missing or empty name`);
        }
        if (!e.url || typeof e.url !== 'string' || !e.url.trim()) {
          errors.push(`workday[${i}]: missing or empty url (name: "${e.name || '?'}")`);
        }
        if (!e.site || typeof e.site !== 'string' || !e.site.trim()) {
          errors.push(`workday[${i}]: missing or empty site (name: "${e.name || '?'}")`);
        }
        const key = `${e.url}|${e.site}`;
        if (e.url && e.site && urlSites.has(key)) {
          errors.push(`workday[${i}]: duplicate url+site "${key}"`);
        }
        if (e.url && e.site) urlSites.add(key);
      }
    }
  }

  // 5. Cross-platform duplicate check (names should be unique)
  {
    const allNames = new Map();
    for (const platform of [...SIMPLE_PLATFORMS, 'smartrecruiters', 'workday']) {
      const entries = data[platform] || [];
      for (const e of entries) {
        if (!e.name) continue;
        const key = e.name.toLowerCase().trim();
        if (allNames.has(key)) {
          errors.push(`Duplicate name across platforms: "${e.name}" in ${allNames.get(key)} and ${platform}`);
        }
        allNames.set(key, platform);
      }
    }
  }

  // Report
  for (const w of warnings) {
    console.log(`WARN: ${w}`);
  }
  for (const e of errors) {
    console.error(`FAIL: ${e}`);
  }

  const platformCounts = {};
  for (const p of [...SIMPLE_PLATFORMS, 'smartrecruiters', 'workday']) {
    platformCounts[p] = (data[p] || []).length;
  }
  const total = Object.values(platformCounts).reduce((a, b) => a + b, 0);
  console.log(`\ncompany-list.json: ${total} companies (${Object.entries(platformCounts).map(([k,v]) => `${k}=${v}`).join(', ')})`);

  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s) found. Validation failed.`);
    process.exit(1);
  }

  console.log('Validation passed.');
  process.exit(0);
}

validate();
