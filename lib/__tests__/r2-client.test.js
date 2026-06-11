#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { createR2Client, classifyR2Error } = require('../storage/r2-client');

process.env.R2_BUCKET_NAME = 'unit-test-bucket';

class PutObjectCommand {
  constructor(input) { this.input = input; }
}
class GetObjectCommand {
  constructor(input) { this.input = input; }
}
class HeadObjectCommand {
  constructor(input) { this.input = input; }
}
class ListObjectsV2Command {
  constructor(input) { this.input = input; }
}
class DeleteObjectCommand {
  constructor(input) { this.input = input; }
}

const commands = {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
};

function err(message, status, name = 'Error') {
  const e = new Error(message);
  e.name = name;
  e.$metadata = { httpStatusCode: status, requestId: `req-${status}` };
  return e;
}

function clientFromSteps(steps) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      const step = steps.shift();
      if (!step) return {};
      if (step.throw) throw step.throw;
      return step.return || {};
    },
  };
}

(async () => {
  assert.deepStrictEqual(classifyR2Error(err('Please try again', 500)).retryable, true);
  assert.deepStrictEqual(classifyR2Error(err('Requires authentication', 401)).retryable, false);
  assert.deepStrictEqual(classifyR2Error(err('missing', 404, 'NoSuchKey')).className, 'not_found');

  {
    const fake = clientFromSteps([
      { throw: err('We encountered an internal error. Please try again.', 500, 'InternalError') },
      { return: {} },
    ]);
    const r2 = createR2Client({
      prefix: 'data/',
      client: fake,
      commands,
      retries: 3,
      retryDelayMs: 0,
    });

    const ok = await r2.uploadRaw('jobs-metadata.json', '{}', 'application/json');
    assert.strictEqual(ok, true, 'transient upload failure should succeed after retry');
    assert.strictEqual(fake.calls.length, 2, 'uploadRaw should retry once after transient R2 failure');
    assert.strictEqual(fake.calls[0].input.Key, 'data/jobs-metadata.json');
  }

  {
    const fake = clientFromSteps([
      { throw: err('Forbidden', 403, 'AccessDenied') },
    ]);
    const r2 = createR2Client({
      client: fake,
      commands,
      retries: 3,
      retryDelayMs: 0,
    });

    const ok = await r2.uploadRaw('all_jobs.json', '{}', 'application/json');
    assert.strictEqual(ok, false, 'auth/config upload failure should stay fail-loud');
    assert.strictEqual(fake.calls.length, 1, 'auth/config upload failure must not retry');
  }

  {
    const fake = clientFromSteps([
      { return: {} },
      { throw: err('Please try again', 500, 'InternalError') },
      { return: {} },
      { return: {} },
    ]);
    const r2 = createR2Client({
      client: fake,
      commands,
      retries: 2,
      retryDelayMs: 0,
    });

    const ok = await r2.uploadJson('last-updated.json', { ok: true });
    assert.strictEqual(ok, true, 'uploadJson should retry a transient final put');
    assert.strictEqual(fake.calls.length, 4, 'uploadJson should put temp, retry final, and cleanup');
    assert.strictEqual(fake.calls[0].input.Key.startsWith('last-updated.json.tmp-'), true);
    assert.strictEqual(fake.calls[1].input.Key, 'last-updated.json');
    assert.strictEqual(fake.calls[2].input.Key, 'last-updated.json');
    assert.strictEqual(fake.calls[3].input.Key.startsWith('last-updated.json.tmp-'), true);
  }

  {
    const fake = clientFromSteps([
      { throw: err('rate limit', 429, 'SlowDown') },
      { return: { Contents: [{ Key: 'data/a.json', Size: 1, LastModified: new Date(0) }] } },
    ]);
    const r2 = createR2Client({
      prefix: 'data/',
      client: fake,
      commands,
      retries: 2,
      retryDelayMs: 0,
    });

    const rows = await r2.list('');
    assert.strictEqual(rows.length, 1, 'list should retry transient throttling');
    assert.strictEqual(fake.calls.length, 2);
  }

  {
    const fake = clientFromSteps([
      { throw: err('missing', 404, 'NoSuchKey') },
    ]);
    const r2 = createR2Client({
      client: fake,
      commands,
      retries: 3,
      retryDelayMs: 0,
    });

    const value = await r2.downloadJson('missing.json');
    assert.strictEqual(value, null, 'missing download should return null');
    assert.strictEqual(fake.calls.length, 1, 'missing download should not retry');
  }

  {
    const fake = clientFromSteps([
      { return: { Body: { transformToString: async () => { throw err('stream interrupted', 500, 'InternalError'); } } } },
      { return: { Body: { transformToString: async () => '{\"ok\":true}' } } },
    ]);
    const r2 = createR2Client({
      client: fake,
      commands,
      retries: 2,
      retryDelayMs: 0,
    });

    const value = await r2.downloadJson('retry-body.json');
    assert.deepStrictEqual(value, { ok: true }, 'downloadJson should retry transient body-read failures');
    assert.strictEqual(fake.calls.length, 2, 'body-read retry should issue a fresh GetObject request');
  }

  {
    const { Readable } = require('stream');
    const { tmpdir } = require('os');
    const { join } = require('path');
    const { readFileSync, unlinkSync } = require('fs');
    const dest = join(tmpdir(), `r2-client-download-${Date.now()}.txt`);
    const failingStream = new Readable({
      read() {
        this.destroy(err('stream interrupted', 500, 'InternalError'));
      },
    });
    const fake = clientFromSteps([
      { return: { Body: failingStream } },
      { return: { Body: Readable.from(['ok']) } },
    ]);
    const r2 = createR2Client({
      client: fake,
      commands,
      retries: 2,
      retryDelayMs: 0,
    });

    const result = await r2.downloadToFile('retry-stream.jsonl', dest);
    assert.deepStrictEqual(result, { size: 2 }, 'downloadToFile should retry transient source stream errors');
    assert.strictEqual(readFileSync(dest, 'utf8'), 'ok', 'downloadToFile should leave only the successful retry output');
    assert.strictEqual(fake.calls.length, 2, 'stream retry should issue a fresh GetObject request');
    unlinkSync(dest);
  }

  console.log('PASS r2-client retry behavior');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
