#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  DEDUPE_TTL_DAYS,
  DEDUPE_TTL_MS,
  INTERNSHIP_TTL_DAYS,
  INTERNSHIP_TTL_MS,
  isInternshipJob,
  activeWindowTtlMs,
} = require('../processors/deduplicator');

assert.strictEqual(DEDUPE_TTL_DAYS, 14, 'regular TTL must remain 14 days');
assert.strictEqual(INTERNSHIP_TTL_DAYS, 120, 'internship TTL must remain 120 days');
assert.strictEqual(DEDUPE_TTL_MS, DEDUPE_TTL_DAYS * 24 * 60 * 60 * 1000);
assert.strictEqual(INTERNSHIP_TTL_MS, INTERNSHIP_TTL_DAYS * 24 * 60 * 60 * 1000);
assert.ok(INTERNSHIP_TTL_MS > DEDUPE_TTL_MS, 'internship TTL must be wider than regular TTL');

assert.strictEqual(isInternshipJob({ tags: { employment: 'internship' } }), true);
assert.strictEqual(isInternshipJob({ employment_type: 'internship' }), true);
assert.strictEqual(isInternshipJob({ employment_types: ['internship'] }), true);
assert.strictEqual(isInternshipJob({ tags: { employment: 'entry_level' } }), false);
assert.strictEqual(activeWindowTtlMs({ tags: { employment: 'internship' } }), INTERNSHIP_TTL_MS);
assert.strictEqual(activeWindowTtlMs({ tags: { employment: 'entry_level' } }), DEDUPE_TTL_MS);


console.log('PASS deduplicator TTL exports');
