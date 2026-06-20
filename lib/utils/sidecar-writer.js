#!/usr/bin/env node

/**
 * Sidecar Writer — Per-source description file management (AGG-PIPE-13)
 *
 * Extracted from index.js Step 8b. Handles:
 * - Grouping jobs by source with description extraction
 * - Accumulating prior sidecar entries across runs (ENR-2 fix)
 * - Chunked file writing (40 MB limit)
 * - Stale file cleanup (chunk-count transitions)
 *
 * Excludes workday and smartrecruiters (owned by enrichment workflow, DESC-MIGRATE-1).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SIDECAR_CHUNK_LIMIT_BYTES = 40 * 1024 * 1024;

// Sources owned by enrichment workflow — skip sidecar writes
const SKIP_SOURCES = new Set(['workday', 'smartrecruiters']);

function looksLikeRichOracleDescription(text) {
  if (!text || typeof text !== 'string') return false;
  return /^(Responsibilities|Qualifications):/m.test(text) || text.length >= 2000;
}

function chooseDescription(src, priorText, currentText) {
  if (src !== 'oracle') return currentText;
  if (looksLikeRichOracleDescription(currentText)) return currentText;
  if (looksLikeRichOracleDescription(priorText)) return priorText;
  return currentText;
}


/**
 * Write per-source description sidecar files.
 * @param {Array} sortedJobs - Pipeline output jobs (sorted by posted_at)
 * @param {string} dataDir - Path to .github/data/ directory
 * @returns {{ writtenFiles: Set<string>, stats: Object }} written filenames + per-source stats
 */
function writeSidecars(sortedJobs, dataDir, options = {}) {
  // Group jobs by source, collect id + description
  const chunkLimit = options.chunkLimit || SIDECAR_CHUNK_LIMIT_BYTES;
  const bySource = {};
  for (const job of sortedJobs) {
    const src = job.source;
    if (!src || SKIP_SOURCES.has(src)) continue;
    if (!bySource[src]) bySource[src] = [];
    if (job.description) {
      bySource[src].push({ id: job.id, description_text: job.description });
    }
  }

  // Accumulate prior entries across runs (ENR-2 fix)
  for (const src of Object.keys(bySource)) {
    const priorMap = new Map();
    const priorFiles = fs.readdirSync(dataDir)
      .filter(f => f.startsWith(`descriptions-${src}`) && f.endsWith('.jsonl'));
    for (const fname of priorFiles) {
      const lines = fs.readFileSync(path.join(dataDir, fname), 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const { id, description_text } = JSON.parse(line);
          if (id && description_text) priorMap.set(id, description_text);
        } catch (_) {}
      }
    }

    const merged = new Map(priorMap);
    for (const entry of bySource[src]) {
      if (!entry.description_text) continue;
      merged.set(entry.id, chooseDescription(src, priorMap.get(entry.id), entry.description_text));
    }

    const priorCount = priorMap.size;
    const newCount = merged.size - priorCount;
    if (priorCount > 0 && newCount !== 0) {
      console.log(`   📎 ${src}: accumulated ${priorCount} prior + ${bySource[src].length} current → ${merged.size} total`);
    }

    bySource[src] = Array.from(merged, ([id, description_text]) => ({ id, description_text }));
  }

  // Write per-source files (chunked if needed)
  const writtenFiles = new Set();
  const stats = {};
  const removedFiles = new Set();   // stale files unlinked this run (for R2 prune — AGG-R2-SINGLEFILE-1)

  for (const [src, entries] of Object.entries(bySource)) {
    if (entries.length === 0) continue;

    const totalBytes = entries.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e), 'utf8') + 1, 0);
    const numChunks = Math.min(Math.ceil(totalBytes / chunkLimit), entries.length);

    if (numChunks === 1) {
      const fname = `descriptions-${src}.jsonl`;
      fs.writeFileSync(path.join(dataDir, fname), entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      writtenFiles.add(fname);
      console.log(`📄 ${fname}: ${entries.length} entries (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
      stats[src] = { entries: entries.length, files: 1 };
    } else {
      const perChunk = Math.ceil(entries.length / numChunks);
      for (let i = 0; i < numChunks; i++) {
        const chunk = entries.slice(i * perChunk, (i + 1) * perChunk);
        const fname = `descriptions-${src}-${i + 1}.jsonl`;
        const chunkBytes = chunk.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e), 'utf8') + 1, 0);
        fs.writeFileSync(path.join(dataDir, fname), chunk.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
        writtenFiles.add(fname);
        console.log(`📄 ${fname}: ${chunk.length} entries (${(chunkBytes / 1024 / 1024).toFixed(1)} MB)`);
      }
      stats[src] = { entries: entries.length, files: numChunks };
    }
  }
  // Track which sources were rewritten this run and in what format (single vs chunked).
  // AGG-DESCGAP-1: when a source crosses the 40MB chunk threshold it switches format
  // (e.g. descriptions-greenhouse.jsonl -> -1/-2 shards). The old-format file(s) must be
  // removed, not preserved, or consumers reading a single file see a stale/incomplete set.
  const writtenFormat = {};
  for (const f of writtenFiles) {
    const srcName = f.replace(/^descriptions-/, '').replace(/-\d+\.jsonl$/, '').replace(/\.jsonl$/, '');
    writtenFormat[srcName] = /-\d+\.jsonl$/.test(f) ? 'chunked' : 'single';
  }

  // Stale file cleanup — preserve sidecars for active sources even if
  // current run produced 0 jobs for that source (AGG-FETCH-10: prevents
  // timeout cascade where fetcher timeout → 0 jobs → sidecar deleted → cache lost).
  // Active sources = sources in current run + sources with existing sidecar files.
  // The second condition handles the timeout case: fetcher times out → 0 jobs →
  // source not in sortedJobs, but sidecar exists → preserve it.
  const activeSources = new Set();
  for (const job of sortedJobs) {
    if (job.source && !SKIP_SOURCES.has(job.source)) activeSources.add(job.source);
  }
  // Also preserve sources that have existing sidecar files (fetcher may have timed out).
  // Only check non-enriched, non-WD, non-SR files (same filter as below).
  const existingForActiveCheck = fs.readdirSync(dataDir)
    .filter(f => /^descriptions-.+\.jsonl$/.test(f) && !f.startsWith('descriptions-enriched') && !f.startsWith('descriptions-workday') && !f.startsWith('descriptions-smartrecruiters'));
  for (const fname of existingForActiveCheck) {
    const srcName = fname.replace(/^descriptions-/, '').replace(/-\d+\.jsonl$/, '').replace(/\.jsonl$/, '');
    activeSources.add(srcName);
  }
  const existingSidecarFiles = fs.readdirSync(dataDir)
    .filter(f => /^descriptions-.+\.jsonl$/.test(f) && !f.startsWith('descriptions-enriched') && !f.startsWith('descriptions-workday') && !f.startsWith('descriptions-smartrecruiters'));
  for (const fname of existingSidecarFiles) {
    if (writtenFiles.has(fname)) continue;
    const srcName = fname.replace(/^descriptions-/, '').replace(/-\d+\.jsonl$/, '').replace(/\.jsonl$/, '');
    // Source was fully rewritten this run: writtenFiles holds its complete current set,
    // so any OTHER file for it is a stale leftover from a format or chunk-count transition
    // (single<->chunked, or chunk count shrank). Remove it. This does NOT affect the
    // AGG-FETCH-10 timeout case below, because a timed-out source is not in writtenFormat.
    if (writtenFormat[srcName]) {
      fs.unlinkSync(path.join(dataDir, fname));
      execSync(`git rm --cached ".github/data/${fname}" 2>/dev/null || true`);
      removedFiles.add(fname);
      console.log(`🗑️  Removed stale sidecar leftover for ${srcName}: ${fname} (rewritten this run as ${writtenFormat[srcName]})`);
      continue;
    }
    if (activeSources.has(srcName)) {
      console.log(`  📎 Preserved sidecar for active source ${srcName}: ${fname} (fetcher may have timed out)`);
      writtenFiles.add(fname);
      continue;
    }
    fs.unlinkSync(path.join(dataDir, fname));
    execSync(`git rm --cached ".github/data/${fname}" 2>/dev/null || true`);
    removedFiles.add(fname);
    console.log(`🗑️  Removed stale sidecar: ${fname}`);
  }

  return { writtenFiles, stats, removedFiles };
}

module.exports = { writeSidecars };