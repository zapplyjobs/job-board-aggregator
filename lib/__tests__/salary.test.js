#!/usr/bin/env node
'use strict';

// AGG-SALARY-EXTRACT-1 — unit tests for the salary normalization helper.
// The helper converts ATS compensation (structured object OR free-text string)
// into flat, annual-normalized { salaryMin, salaryMax, salaryCurrency } fields.

const assert = require('assert');
const { normalizeSalary, fromObject, fromString } = require('../fetchers/salary');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✖ ${name}`); throw e; }
}

const EMPTIES = { salaryMin: null, salaryMax: null, salaryCurrency: null };

console.log('salary helper tests:');

test('structured object — annual passes through', () => {
  assert.deepStrictEqual(
    fromObject({ min: 100000, max: 120000, currency: 'USD', interval: 'YEARLY' }),
    { salaryMin: 100000, salaryMax: 120000, salaryCurrency: 'USD' }
  );
});

test('structured object — hourly converted to annual (x2080)', () => {
  const r = fromObject({ min: 50, max: 60, currency: 'USD', interval: 'HOURLY' });
  assert.strictEqual(r.salaryMin, 104000);
  assert.strictEqual(r.salaryMax, 124800);
});

test('structured object — monthly converted to annual (x12)', () => {
  assert.strictEqual(fromObject({ min: 8000, max: 10000, interval: 'MONTHLY' }).salaryMin, 96000);
});

test('structured object — single bound mirrors to both min and max', () => {
  const r = fromObject({ min: 90000, currency: 'USD', interval: 'YEARLY' });
  assert.strictEqual(r.salaryMin, 90000);
  assert.strictEqual(r.salaryMax, 90000);
});

test('structured object — null returns empties', () => {
  assert.deepStrictEqual(fromObject(null), EMPTIES);
});

test('string — "$200K - $260K" parses to annual', () => {
  const r = fromString('$200K - $260K');
  assert.strictEqual(r.salaryMin, 200000);
  assert.strictEqual(r.salaryMax, 260000);
  assert.strictEqual(r.salaryCurrency, 'USD');
});

test('string — "$100,000 - $120,000" tolerates commas', () => {
  assert.strictEqual(fromString('$100,000 - $120,000').salaryMin, 100000);
});

test('string — "$50/hr" converts hourly to annual', () => {
  assert.strictEqual(fromString('$50/hr').salaryMin, 104000);
});

test('string — single figure "$90,000" mirrors to both bounds', () => {
  const r = fromString('$90,000');
  assert.strictEqual(r.salaryMin, 90000);
  assert.strictEqual(r.salaryMax, 90000);
});

test('string — currency detection (EUR)', () => {
  assert.strictEqual(fromString('€60k - 80k').salaryCurrency, 'EUR');
});

test('string — null returns empties', () => {
  assert.deepStrictEqual(fromString(null), EMPTIES);
});

test('normalizeSalary dispatches object vs string vs null', () => {
  assert.strictEqual(normalizeSalary({ min: 1, max: 2, interval: 'YEARLY' }).salaryMin, 1);
  assert.strictEqual(normalizeSalary('$90,000').salaryMin, 90000);
  assert.deepStrictEqual(normalizeSalary(undefined), EMPTIES);
  assert.deepStrictEqual(normalizeSalary(42), EMPTIES); // unknown type
});

test('interval multiplier defaults to annual when unspecified', () => {
  // No interval field → treated as annual (multiplier 1).
  assert.strictEqual(fromObject({ min: 100000, max: 120000, currency: 'USD' }).salaryMin, 100000);
});

console.log('All salary helper tests passed');
