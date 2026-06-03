#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  DEDUPE_TTL_DAYS,
  DEDUPE_TTL_MS,
  INTERNSHIP_TTL_DAYS,
  INTERNSHIP_TTL_MS,
} = require('../processors/deduplicator');

assert.strictEqual(DEDUPE_TTL_DAYS, 14, 'regular TTL must remain 14 days');
assert.strictEqual(INTERNSHIP_TTL_DAYS, 120, 'internship TTL must remain 120 days');
assert.strictEqual(DEDUPE_TTL_MS, DEDUPE_TTL_DAYS * 24 * 60 * 60 * 1000);
assert.strictEqual(INTERNSHIP_TTL_MS, INTERNSHIP_TTL_DAYS * 24 * 60 * 60 * 1000);
assert.ok(INTERNSHIP_TTL_MS > DEDUPE_TTL_MS, 'internship TTL must be wider than regular TTL');

console.log('PASS deduplicator TTL exports');
