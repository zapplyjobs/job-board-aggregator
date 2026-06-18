#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  parseListingCards,
  parsePageCount,
  parseIcimsStructuredData,
  parseDataLayer,
  normalizeIcimsJob,
  normalizeTenantKey,
} = require('../fetchers/icims');

const listingHtml = `
<h2>Search Results Page 1 of 4</h2>
<li class="iCIMS_JobCardItem">
  <a href="https://careers-axway.icims.com/jobs/8751/intern/job?in_iframe=1" class="iCIMS_Anchor" title="8751 - Software Engineering Intern — AI Developer Tools">
    <h3>Software Engineering Intern &mdash; AI Developer Tools</h3>
  </a>
</li>
<li class="iCIMS_JobCardItem">
  <a href="https://careers-axway.icims.com/jobs/8749/senior-customer-tech-support-engineer-ii/job?in_iframe=1" class="iCIMS_Anchor" title="8749 - Senior Technical Support Engineer – Mainframe">
    <h3>Senior Technical Support Engineer &ndash; Mainframe</h3>
  </a>
</li>`;

const cards = parseListingCards(listingHtml);
assert.strictEqual(cards.length, 2);
assert.strictEqual(cards[0].jid, '8751');
assert.strictEqual(cards[0].title, 'Software Engineering Intern — AI Developer Tools');
assert.deepStrictEqual(parsePageCount(listingHtml), { currentPage: 1, totalPages: 4 });
assert.strictEqual(normalizeTenantKey('careers-sig.icims.com'), 'careers-sig');

const detailHtml = `
<link rel="canonical" href="https://careers-axway.icims.com/jobs/8659/software-engineering-internship/job" />
<meta property="og:description" content="Build secure and scalable integrations." />
<script>
var icimsSD = {"companyName":"Axway","job":{"jid":8659,"jobUrls":[{"name":"Axway","url":"https://careers-axway.icims.com/jobs/8659/software-engineering-internship-%28b2bi%29/job"}],"location":"Scottsdale, Arizona, United States","title":"Software Engineering Internship (B2Bi)"}};
dataLayer = [{"job":{"postedDate":"2026-04-22"}}];
</script>`;

const icims = parseIcimsStructuredData(detailHtml);
assert.strictEqual(icims.job.jid, 8659);
const dataLayer = parseDataLayer(detailHtml);
assert.strictEqual(dataLayer.job.postedDate, '2026-04-22');
const normalized = normalizeIcimsJob(
  { tenantKey: 'careers-axway', companyName: 'Axway', companySlug: 'axway' },
  { jid: '8659', title: 'Software Engineering Internship (B2Bi)' },
  detailHtml,
);
assert.strictEqual(normalized.id, 'icims-careers-axway-8659');
assert.strictEqual(normalized.source, 'icims');
assert.strictEqual(normalized.company_name, 'Axway');
assert.strictEqual(normalized.url, 'https://careers-axway.icims.com/jobs/8659/software-engineering-internship/job');
assert.strictEqual(normalized.posted_at, '2026-04-22T00:00:00.000Z');
assert.ok(normalized.description.includes('Build secure and scalable integrations.'));

console.log('PASS icims fetcher parsing');
