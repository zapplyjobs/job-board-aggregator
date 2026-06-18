#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { normalizeGoogleDescriptionText, buildFullDescription } = require('../fetchers/google');

const rawListing = '\\n\nWrite product or system development code.\n\\n\nReview code developed by other engineers and provide feedback.';

const normalized = normalizeGoogleDescriptionText(rawListing);
assert.ok(normalized, 'normalizer should keep non-empty descriptions');
assert.ok(!normalized.includes('\\n'), 'normalized listing must not keep literal backslash-n sequences');
assert.ok(normalized.startsWith('Write product or system development code.'), 'leading escaped newlines should be trimmed');
assert.ok(normalized.includes('\n\nReview code developed by other engineers'), 'section break should become real newlines');

const full = buildFullDescription(rawListing, {
  minimumQualifications: 'Bachelor\'s degree or equivalent practical experience.\n4 years of experience with JavaScript.',
  preferredQualifications: 'Experience building developer tools.'
});
assert.ok(full, 'full description should be built');
assert.ok(!full.includes('\\n'), 'full description must not keep literal backslash-n sequences');
assert.ok(full.includes('Minimum Qualifications:\nBachelor\'s degree or equivalent practical experience.'), 'minimum qualifications should remain readable');
assert.ok(full.includes('Preferred Qualifications:\nExperience building developer tools.'), 'preferred qualifications should remain readable');

console.log('PASS google fetcher description normalization');
