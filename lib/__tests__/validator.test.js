#!/usr/bin/env node
'use strict';

// Validator contract tests (the validator's first test suite — V-AGG-5).
// Binds V-AGG-1: the GARBAGE_TITLE_PATTERNS /^test/ rule must drop the "Test, Do not Apply"
// placeholder but NOT legitimate "Test Engineer/Manager/Specialist" roles (the prior
// /^test[,\s]/i space-branch silently dropped the whole Test/QA/SDET role class).
// Plain node + assert, mirroring the repo's existing test style. Run by `npm test`.

const assert = require('assert');
const { isValidJob, normalizeJob } = require('../processors/validator');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
const mk = (title, extra = {}) => ({ title, company_name: 'Acme', url: 'https://acme.test/j', ...extra });

console.log('validator garbage-title contract (V-AGG-1):');

// --- V-AGG-1: the regression this test exists to prevent ---
test('legit "Test" roles are NOT dropped (V-AGG-1)', () => {
  for (const t of ['Test Engineer', 'Test Manager', 'Test Specialist', 'Test Lead', 'Test Automation Engineer']) {
    assert.ok(isValidJob(mk(t)), `"${t}" must be valid (the /^test[\\s]/ regression would drop it)`);
  }
});

test('placeholder "Test, Do not Apply" IS dropped (intent preserved)', () => {
  assert.ok(!isValidJob(mk('Test, Do not Apply')), 'placeholder must be rejected');
  assert.ok(!isValidJob(mk('Test, fake')), 'comma-placeholder must be rejected');
});

// --- other GARBAGE patterns stay dropping (pin the contract) ---
test('placeholder/garbage titles are dropped', () => {
  for (const t of ['TBD', 'N/A', 'Job', 'Position', 'Open Position', 'potentially a fit']) {
    assert.ok(!isValidJob(mk(t)), `"${t}" should be rejected`);
  }
});

// --- Tier-1 required-field gates stay correct ---
test('valid jobs pass', () => {
  assert.ok(isValidJob(mk('Software Engineer')), 'normal title valid');
  assert.ok(isValidJob(mk('Senior Test Pilot')), 'Test not at start is fine');
});

test('missing/short title, company, url are rejected', () => {
  assert.ok(!isValidJob(mk('')), 'empty title');
  assert.ok(!isValidJob({ title: 'Software Engineer', url: 'https://x.test' }), 'missing company');
  assert.ok(!isValidJob(mk('Software Engineer', { company_name: 'A' })), 'short company');
  assert.ok(!isValidJob(mk('Software Engineer', { url: 'ftp://x.test' })), 'non-http url');
});

// --- AGG-VALIDATOR-COUNTRY-INFER-1: ISO country-code tails are not US proof ---
test('collision-code Workday locations do not infer job_country=us', () => {
  for (const location of ['Bangalore, IN', 'Waldshut-Tiengen, DE', 'Brampton, Ontario, CA']) {
    const job = normalizeJob({ title: 'Engineer', company_name: 'Acme', url: 'https://acme.test/j', location });
    assert.notStrictEqual(job.job_state, undefined, `${location} should still preserve parsed state`);
    assert.notStrictEqual(job.job_country, 'us', `${location} must not infer US`);
  }
});

test('explicit US evidence still infers job_country=us for collision states', () => {
  for (const location of ['Boston, Massachusetts, United States', 'USA - El Segundo, CA']) {
    const job = normalizeJob({ title: 'Engineer', company_name: 'Acme', url: 'https://acme.test/j', location });
    assert.strictEqual(job.job_country, 'us', `${location} should infer US`);
  }
});

console.log(`\n${failed === 0 ? '✅' : '❌'} validator.test.js: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
