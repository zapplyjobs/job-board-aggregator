#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  buildAshbyGraphQLRequest,
  buildAshbyGraphQLDetailRequest,
  normalizeAshbyGraphQLJob,
  normalizeAshbyGraphQLDetailJob,
  resolveAshbyTeamPath,
} = require('../fetchers/ashby');
const {
  TARGET_COMPANIES,
  buildTargetCompanySet,
  isTargetCompanyName,
} = require('../fetchers/simplify');

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

test('Ashby GraphQL request uses hosted jobs page slug', () => {
  const payload = buildAshbyGraphQLRequest('whatnot');
  assert.strictEqual(payload.operationName, 'ApiJobBoardWithTeams');
  assert.deepStrictEqual(payload.variables, { organizationHostedJobsPageName: 'whatnot' });
  assert(payload.query.includes('jobBoardWithTeams'));
  assert(payload.query.includes('jobPostings'));
});

test('Ashby GraphQL detail request uses hosted jobs page slug and posting id', () => {
  const payload = buildAshbyGraphQLDetailRequest('whatnot', 'abc123');
  assert.strictEqual(payload.operationName, 'ApiJobPosting');
  assert.deepStrictEqual(payload.variables, {
    organizationHostedJobsPageName: 'whatnot',
    jobPostingId: 'abc123',
  });
  assert(payload.query.includes('publishedDate'));
  assert(payload.query.includes('descriptionHtml'));
});

test('Ashby GraphQL normalization preserves team hierarchy and stable URL', () => {
  const teams = new Map([
    ['root', { id: 'root', name: 'Engineering', externalName: null, parentTeamId: null }],
    ['child', { id: 'child', name: 'Data Platform', externalName: null, parentTeamId: 'root' }],
  ]);
  const teamPath = resolveAshbyTeamPath('child', teams);
  assert.deepStrictEqual(teamPath, ['Engineering', 'Data Platform']);

  const job = normalizeAshbyGraphQLJob({
    id: 'abc123',
    title: 'AI Tooling Engineer',
    teamId: 'child',
    locationName: 'San Francisco, CA',
    workplaceType: 'Remote',
    employmentType: 'FullTime',
    secondaryLocations: [{ locationName: 'Seattle, WA' }],
    compensationTierSummary: { min: 10, max: 20, currency: 'USD', interval: 'YEARLY' },
  }, 'whatnot', 'Whatnot', teams, '2026-06-15T08:00:00.000Z');

  assert.strictEqual(job.company_name, 'Whatnot');
  assert.strictEqual(job.department, 'Engineering');
  assert.strictEqual(job.team, 'Data Platform');
  assert.strictEqual(job.url, 'https://jobs.ashbyhq.com/whatnot/abc123');
  assert.strictEqual(job.posted_at, '2026-06-15T08:00:00.000Z');
  assert.strictEqual(job.is_remote, true);
  assert.deepStrictEqual(job.locations, ['San Francisco, CA', 'Seattle, WA']);
});

test('Ashby GraphQL detail normalization preserves published date and description', () => {
  const job = normalizeAshbyGraphQLDetailJob({
    id: 'abc123',
    title: 'AI Tooling Engineer',
    publishedDate: '2026-06-08',
    departmentName: 'Engineering',
    departmentExternalName: 'Engineering',
    locationName: 'San Francisco, CA',
    workplaceType: 'Remote',
    employmentType: 'FullTime',
    descriptionHtml: '<p>Build useful systems.</p>',
    isListed: true,
    teamNames: ['Engineering', 'AI Platform'],
    secondaryLocationNames: ['Seattle, WA'],
    compensationTierSummary: '$200K - $260K',
  }, 'whatnot', 'Whatnot', '2026-06-15T08:00:00.000Z');

  assert.strictEqual(job.company_name, 'Whatnot');
  assert.strictEqual(job.department, 'Engineering');
  assert.strictEqual(job.team, 'AI Platform');
  assert.strictEqual(job.url, 'https://jobs.ashbyhq.com/whatnot/abc123');
  assert.strictEqual(job.posted_at, '2026-06-08T00:00:00.000Z');
  assert.strictEqual(job.first_published, '2026-06-08T00:00:00.000Z');
  assert.strictEqual(job.description, '<p>Build useful systems.</p>');
  assert.strictEqual(job._raw.compensation_tier_summary, '$200K - $260K');
});

test('Simplify target set includes restored names without dropping existing exact targets', () => {
  assert(TARGET_COMPANIES.includes('TikTok'));
  assert(TARGET_COMPANIES.includes('ByteDance'));
  assert(TARGET_COMPANIES.includes('Goldman Sachs'));
  assert(TARGET_COMPANIES.includes('Shopify'));

  const targetSet = buildTargetCompanySet();
  assert.strictEqual(isTargetCompanyName('TikTok', targetSet), true);
  assert.strictEqual(isTargetCompanyName('ByteDance', targetSet), true);
  assert.strictEqual(isTargetCompanyName('Goldman Sachs', targetSet), true);
  assert.strictEqual(isTargetCompanyName('Shopify', targetSet), true);
  assert.strictEqual(isTargetCompanyName(' Whatnot ', targetSet), false);
});

console.log('Bounded survive parity tests passed');
