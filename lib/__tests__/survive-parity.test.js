#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  buildAshbyGraphQLRequest,
  normalizeAshbyGraphQLJob,
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

test('Simplify target set includes TikTok and ByteDance exact names', () => {
  assert(TARGET_COMPANIES.includes('TikTok'));
  assert(TARGET_COMPANIES.includes('ByteDance'));

  const targetSet = buildTargetCompanySet();
  assert.strictEqual(isTargetCompanyName('TikTok', targetSet), true);
  assert.strictEqual(isTargetCompanyName('ByteDance', targetSet), true);
  assert.strictEqual(isTargetCompanyName(' Whatnot ', targetSet), false);
});

console.log('Bounded survive parity tests passed');
