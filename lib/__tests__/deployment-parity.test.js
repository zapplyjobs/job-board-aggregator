#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const PARITY_FILES = [
  ['lib/processors/tag-engine.js', '.github/scripts/aggregator/lib/processors/tag-engine.js'],
  ['lib/processors/wd-family-domain-map.json', '.github/scripts/aggregator/lib/processors/wd-family-domain-map.json'],
];

for (const [sourceRel, deployedRel] of PARITY_FILES) {
  const sourcePath = path.join(ROOT, sourceRel);
  const deployedPath = path.join(ROOT, deployedRel);

  assert.ok(fs.existsSync(sourcePath), `source file missing: ${sourceRel}`);
  assert.ok(fs.existsSync(deployedPath), `deployed file missing: ${deployedRel}`);

  const source = fs.readFileSync(sourcePath);
  const deployed = fs.readFileSync(deployedPath);
  assert.strictEqual(
    Buffer.compare(source, deployed),
    0,
    `${deployedRel} must be byte-identical to ${sourceRel}`
  );
}

console.log(`PASS deployment parity (${PARITY_FILES.length} file pairs)`);
