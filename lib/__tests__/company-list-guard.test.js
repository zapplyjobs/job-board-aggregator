const assert = require('assert');
const fs = require('fs');
const cp = require('child_process');
// Guardrail: company-list removals and silent field rewrites require explicit
// acknowledgement because stale snapshot pushes have repeatedly erased or
// rolled back newly-added SUP supply. CI blocks unacknowledged source-truth loss.

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

function entriesByPlatformAndName(data) {
  const out = new Map();
  for (const [platform, entries] of Object.entries(data)) {
    if (!Array.isArray(entries)) continue;
    const byName = new Map();
    for (const entry of entries) {
      if (!entry || !entry.name) continue;
      byName.set(entry.name, entry);
    }
    out.set(platform, byName);
  }
  return out;
}

function removedByPlatform(prev, curr) {
  const removed = [];
  for (const [platform, prevEntries] of prev.entries()) {
    const currEntries = curr.get(platform) || new Map();
    for (const name of prevEntries.keys()) {
      if (!currEntries.has(name)) removed.push({ platform, name });
    }
  }
  return removed;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const IGNORED_FIELD_CHANGE_KEYS = new Set([
  // Classifier metadata is allowed to evolve with TAG work. INF-DATA-3 protects
  // stale source-truth rollbacks such as URL/site/verified changes, not every
  // company-specific classifier override.
  'titleOverrides',
  'notes',
]);

function changedFields(prev, curr) {
  const changed = [];
  for (const [platform, prevEntries] of prev.entries()) {
    const currEntries = curr.get(platform) || new Map();
    for (const [name, prevEntry] of prevEntries.entries()) {
      const currEntry = currEntries.get(name);
      if (!currEntry) continue;
      if (stableStringify(prevEntry) === stableStringify(currEntry)) continue;
      const keys = new Set([...Object.keys(prevEntry), ...Object.keys(currEntry)]);
      const fields = [...keys]
        .sort()
        .filter(key => !IGNORED_FIELD_CHANGE_KEYS.has(key))
        .filter(key => stableStringify(prevEntry[key]) !== stableStringify(currEntry[key]));
      if (fields.length > 0) changed.push({ platform, name, fields });
    }
  }
  return changed;
}

function headMessage() {
  try {
    return sh(['git', 'log', '-1', '--pretty=%B']);
  } catch {
    return '';
  }
}

function formatItems(items) {
  return items.map(item => {
    const fields = item.fields ? ` fields=${item.fields.join('|')}` : '';
    return `${item.platform}:${item.name}${fields}`;
  }).join(', ');
}

(function main() {
  const target = 'lib/fetchers/company-list.json';
  if (!changedFiles().includes(target)) {
    console.log('PASS: company-list guard skipped (file unchanged)');
    return;
  }

  const prevRaw = sh(['git', 'show', `HEAD~1:${target}`]);
  const currRaw = fs.readFileSync(target, 'utf8');
  const prev = entriesByPlatformAndName(JSON.parse(prevRaw));
  const curr = entriesByPlatformAndName(JSON.parse(currRaw));
  const removed = removedByPlatform(prev, curr);
  const fieldChanges = changedFields(prev, curr);
  const message = headMessage();

  const removalToken = '[company-list-removals-ok]';
  if (removed.length > 0 && !message.includes(removalToken)) {
    assert.fail(
      'company-list.json removed entries without explicit acknowledgement. ' +
        `Add ${removalToken} to the commit message for intentional removals. ` +
        'Removed: ' + formatItems(removed)
    );
  }

  const fieldToken = '[company-list-field-updates-ok]';
  if (fieldChanges.length > 0 && !message.includes(fieldToken)) {
    assert.fail(
      'company-list.json changed existing entry fields without explicit acknowledgement. ' +
        `Add ${fieldToken} to the commit message for intentional source-truth field updates. ` +
        'Changed: ' + formatItems(fieldChanges)
    );
  }

  if (removed.length > 0) {
    console.log(`PASS: company-list removals explicitly acknowledged via ${removalToken}`);
    console.log(formatItems(removed));
  }
  if (fieldChanges.length > 0) {
    console.log(`PASS: company-list field updates explicitly acknowledged via ${fieldToken}`);
    console.log(formatItems(fieldChanges));
  }
  if (removed.length === 0 && fieldChanges.length === 0) {
    console.log('PASS: company-list guard found no removed entries or existing-entry field changes');
  }
})();
