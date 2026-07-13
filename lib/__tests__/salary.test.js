#!/usr/bin/env node
'use strict';

// AGG-SALARY-EXTRACT-1 — unit tests for the salary normalization helper.
// The helper converts ATS compensation (structured object OR free-text string)
// into flat, annual-normalized { salaryMin, salaryMax, salaryCurrency } fields.

const assert = require('assert');
const { normalizeSalary, fromObject, fromString, fromDescription } = require('../fetchers/salary');

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

test('lever interval formats — per-hour-wage converts to annual', () => {
  // lever API uses 'per-hour-wage'/'per-month-salary'/'per-year-salary', not 'hourly'/'monthly'/'yearly'.
  assert.strictEqual(fromObject({ min: 20, max: 25, currency: 'USD', interval: 'per-hour-wage' }).salaryMin, 41600);
  assert.strictEqual(fromObject({ min: 20, max: 25, currency: 'USD', interval: 'per-hour-wage' }).salaryMax, 52000);
});

test('lever interval formats — per-month-salary and per-year-salary', () => {
  assert.strictEqual(fromObject({ min: 8000, max: 10000, interval: 'per-month-salary' }).salaryMin, 96000);
  assert.strictEqual(fromObject({ min: 90000, max: 110000, interval: 'per-year-salary' }).salaryMin, 90000);
});

console.log('\nfromDescription tests (description-text salary extraction):');

// --- Real patterns from live descriptions (scout-verified 2026-07-12) ---

test('Amazon pattern — "Salary Range $X/year to $Y/year"', () => {
  const desc = '40 hours / week, 8:00am-5:00pm, Salary Range $161,136/year to $178,800/year. Amazon is a total compensation company.';
  const r = fromDescription(desc);
  assert.strictEqual(r.salaryMin, 161136);
  assert.strictEqual(r.salaryMax, 178800);
  assert.strictEqual(r.salaryCurrency, 'USD');
});

test('Greenhouse pattern — "US Salary Range $X — $Y USD" (HTML already stripped)', () => {
  const desc = 'US Salary Range $113,000 — $155,000 USD Compensation and Benefits';
  const r = fromDescription(desc);
  assert.strictEqual(r.salaryMin, 113000);
  assert.strictEqual(r.salaryMax, 155000);
});

test('WD/SR pattern — "Annual Salary Range ... $X-$Y USD"', () => {
  const desc = 'Annual Salary Range for jobs which could be performed in the US: $164,470.00-311,890.00 USD The range displayed on each';
  const r = fromDescription(desc);
  assert.strictEqual(r.salaryMin, 164470);
  assert.strictEqual(r.salaryMax, 311890);
});

test('WD/SR pattern — "base salary range ... $X - $Y per year"', () => {
  const desc = 'The base salary range for this position for all U.S. candidates is $120,000 - $180,000 per year, with eligibility for';
  const r = fromDescription(desc);
  assert.strictEqual(r.salaryMin, 120000);
  assert.strictEqual(r.salaryMax, 180000);
});

test('WD/SR pattern — "base salary range ... X USD - Y USD" (no $ sign)', () => {
  const desc = 'The base salary range for this role is 74,000 USD - 116,000 USD. Please note that actual salaries may vary within';
  const r = fromDescription(desc);
  assert.strictEqual(r.salaryMin, 74000);
  assert.strictEqual(r.salaryMax, 116000);
});

test('Hourly pattern — "Pay Range: $X - $Y per hour" converts to annual', () => {
  const desc = 'Pay Range: $16.50 - $17.20 per hour Starting rate of pay may vary based on factors';
  const r = fromDescription(desc);
  assert.strictEqual(r.salaryMin, 34320);   // 16.50 * 2080
  assert.strictEqual(r.salaryMax, 35776);   // 17.20 * 2080
});

test('Hourly pattern — "The typical pay range ... $X - $Y"', () => {
  const desc = 'Pay Range The typical pay range for this role is: $16.00 - $31.46 This pay range represents the base hourly rate';
  const r = fromDescription(desc);
  assert.strictEqual(r.salaryMin, 33280);   // 16.00 * 2080
  assert.strictEqual(r.salaryMax, 65437);   // 31.46 * 2080 = 65436.8 → rounds up
});

test('Annual decimal — "$X.00 - $Y.00"', () => {
  const desc = 'The annual salary range for this position is $80,000.00 - $120,000.00 Additional compensation includes annual';
  const r = fromDescription(desc);
  assert.strictEqual(r.salaryMin, 80000);
  assert.strictEqual(r.salaryMax, 120000);
});

// --- False-positive guards (must return null) ---

test('Vague "competitive salary" returns null', () => {
  const r = fromDescription("You'll enjoy a competitive salary, great benefits, and a creative work environment.");
  assert.strictEqual(r.salaryMin, null);
});

test('Vague "competitive compensation" returns null', () => {
  const r = fromDescription('You will enjoy competitive compensation and your contributions will impact customers.');
  assert.strictEqual(r.salaryMin, null);
});

test('Revenue figure NOT captured — "$35 billion" in non-salary context', () => {
  const desc = 'Come be a part of a rapidly expanding $35 billion dollar global business. At Amazon Business, we are working to move faster.';
  const r = fromDescription(desc);
  assert.strictEqual(r.salaryMin, null);
});

test('Full description with many numbers — only salary extracted', () => {
  const desc = 'We are hiring for our San Francisco office (floor 12). You will manage 3 direct reports with 5+ years of experience. Our team ships to 50 million users. Salary Range $120,000 - $150,000 per year. We offer 401k matching.';
  const r = fromDescription(desc);
  assert.strictEqual(r.salaryMin, 120000);
  assert.strictEqual(r.salaryMax, 150000);
});

test('No salary mention returns null', () => {
  const r = fromDescription('We are looking for a software engineer with 3+ years of experience in Python and React.');
  assert.strictEqual(r.salaryMin, null);
});

test('Empty/null input returns empties', () => {
  assert.deepStrictEqual(fromDescription(null), EMPTIES);
  assert.deepStrictEqual(fromDescription(''), EMPTIES);
  assert.deepStrictEqual(fromDescription(undefined), EMPTIES);
});

test('EUR currency detected from salary range', () => {
  const desc = 'Base Salary Range €60,000 - €80,000 per year. We are an equal opportunity employer.';
  const r = fromDescription(desc);
  assert.strictEqual(r.salaryMin, 60000);
  assert.strictEqual(r.salaryMax, 80000);
  assert.strictEqual(r.salaryCurrency, 'EUR');
});

console.log('All salary helper tests passed');
