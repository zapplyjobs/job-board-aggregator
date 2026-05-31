const assert = require('assert');
const fs = require('fs');
const cp = require('child_process');

function sh(args) {
  return cp.execFileSync(args[0], args.slice(1), { encoding: 'utf8' }).trim();
}

function changedFiles() {
  try {
    return sh(['git', 'diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function flattenNames(data) {
  const out = new Map();
  for (const [platform, entries] of Object.entries(data)) {
    if (!Array.isArray(entries)) continue;
    out.set(platform, new Set(entries.map(entry => entry && entry.name).filter(Boolean)));
  }
  return out;
}

function removedByPlatform(prev, curr) {
  const removed = [];
  for (const [platform, prevNames] of prev.entries()) {
    const currNames = curr.get(platform) || new Set();
    for (const name of prevNames) {
      if (!currNames.has(name)) removed.push({ platform, name });
    }
  }
  return removed;
}

function headMessage() {
  try {
    return sh(['git', 'log', '-1', '--pretty=%B']);
  } catch {
    return '';
  }
}

(function main() {
  const target = 'lib/fetchers/company-list.json';
  if (!changedFiles().includes(target)) {
    console.log('PASS: company-list guard skipped (file unchanged)');
    return;
  }

  const prevRaw = sh(['git', 'show', `HEAD~1:${target}`]);
  const currRaw = fs.readFileSync(target, 'utf8');
  const prev = flattenNames(JSON.parse(prevRaw));
  const curr = flattenNames(JSON.parse(currRaw));
  const removed = removedByPlatform(prev, curr);

  if (removed.length === 0) {
    console.log('PASS: company-list guard found no removed entries');
    return;
  }

  const message = headMessage();
  const allowToken = '[company-list-removals-ok]';
  if (message.includes(allowToken)) {
    console.log(`PASS: company-list removals explicitly acknowledged via ${allowToken}`);
    console.log(removed.map(item => `${item.platform}:${item.name}`).join(', '));
    return;
  }

  assert.fail(
    'company-list.json removed entries without explicit acknowledgement. ' +
      `Add ${allowToken} to the commit message for intentional removals. ` +
      'Removed: ' + removed.map(item => `${item.platform}:${item.name}`).join(', ')
  );
})();
