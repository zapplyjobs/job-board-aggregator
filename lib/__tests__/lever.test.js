#!/usr/bin/env node
// AGG-LEVER-POSTEDAT-1: Lever's API returns createdAt as epoch-ms (number).
// The fetcher must normalize posted_at/first_published to ISO string so they match
// the cross-source schema (every other fetcher emits ISO). Downstream code that does
// Date.parse(String(posted_at)) returns NaN on a bare epoch-ms number.
'use strict';
const assert = require('assert');
const { normalizeLeverJob } = require('../fetchers/lever');

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const EPOCH_MS = 1781929799037; // a real Lever createdAt value (2026-06-21T...)

(function leverPostedAtIso() {
  // Minimal Lever API posting shape — only the fields the normalizer reads for dates.
  const apiJob = {
    id: 'floqast-abc123',
    createdAt: EPOCH_MS,           // Lever returns epoch-ms (number)
    hostedUrl: 'https://jobs.lever.co/floqast/abc123',
    applyUrl: 'https://jobs.lever.co/floqast/abc123/apply',
    text: 'Pigment Model Builder',
    categories: {},
  };

  const out = normalizeLeverJob(apiJob, 'floqast', 'FloQast');

  // posted_at MUST be an ISO string (not the raw epoch-ms number).
  assert.strictEqual(typeof out.posted_at, 'string', `posted_at must be string, got ${typeof out.posted_at}`);
  assert.ok(ISO_RE.test(out.posted_at), `posted_at not ISO: "${out.posted_at}"`);
  // Value preserved (same instant).
  assert.strictEqual(new Date(out.posted_at).getTime(), EPOCH_MS, 'posted_at instant must equal createdAt');

  // first_published also ISO.
  assert.strictEqual(typeof out.first_published, 'string', `first_published must be string, got ${typeof out.first_published}`);
  assert.ok(ISO_RE.test(out.first_published), `first_published not ISO: "${out.first_published}"`);
  assert.strictEqual(new Date(out.first_published).getTime(), EPOCH_MS, 'first_published instant must equal createdAt');

  console.log('PASS: lever posted_at/first_published normalized to ISO string (createdAt epoch-ms preserved)');
})();

(function leverPostedAtFallback() {
  // Missing createdAt -> posted_at falls back to now (ISO), first_published null.
  const apiJob = { id: 'x-1', hostedUrl: 'https://jobs.lever.co/x/1', text: 'No Date Job', categories: {} };
  const out = normalizeLeverJob(apiJob, 'x', 'X');
  assert.strictEqual(typeof out.posted_at, 'string');
  assert.ok(ISO_RE.test(out.posted_at), `fallback posted_at not ISO: "${out.posted_at}"`);
  assert.strictEqual(out.first_published, null, 'first_published must be null when createdAt missing');
  console.log('PASS: lever posted_at fallback (ISO) + first_published null when createdAt absent');
})();

console.log('All lever tests passed');
