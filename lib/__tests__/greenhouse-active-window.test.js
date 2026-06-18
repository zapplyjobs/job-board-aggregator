#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { activeWindowAnchorTs, INTERNSHIP_TTL_MS } = require('../processors/deduplicator');
const { normalizeGreenhouseJob } = require('../fetchers/greenhouse');

const now = new Date('2026-06-18T05:00:00.000Z').getTime();

const normalized = normalizeGreenhouseJob({
  id: 7586061002,
  title: 'Quantitative Researcher Intern',
  location: { name: 'New York' },
  offices: [],
  departments: [],
  employment_type: 'Internship',
  first_published: '2024-08-15T17:34:49-04:00',
  updated_at: '2026-06-12T13:40:11-04:00',
  absolute_url: 'https://boards.greenhouse.io/point72/jobs/7586061002?gh_jid=7586061002',
  content: '<p>Internship description</p>',
}, 'point72', 'Point72');
normalized.tags = { employment: 'internship' };

const anchorTs = activeWindowAnchorTs(normalized, now);
assert.strictEqual(new Date(anchorTs).toISOString(), '2026-06-12T17:40:11.000Z');
assert.ok(anchorTs >= now - INTERNSHIP_TTL_MS, 'recent updated_at should keep current-source internship inside active window');

const oldUpdated = {
  ...normalized,
  source_updated_at: '2024-01-01T00:00:00.000Z',
};
const fallbackTs = activeWindowAnchorTs(oldUpdated, now);
assert.strictEqual(fallbackTs, new Date(normalized.posted_at).getTime(), 'older source_updated_at must not override posting date');

const nonGreenhouse = {
  ...normalized,
  source: 'icims',
  source_updated_at: '2026-06-12T17:40:11.000Z',
};
assert.strictEqual(activeWindowAnchorTs(nonGreenhouse, now), new Date(normalized.posted_at).getTime(), 'exception must stay greenhouse-only');

const nonIntern = {
  ...normalized,
  tags: { employment: 'entry_level' },
};
assert.strictEqual(activeWindowAnchorTs(nonIntern, now), new Date(normalized.posted_at).getTime(), 'exception must stay internship-only');

console.log('PASS greenhouse active-window anchor');
