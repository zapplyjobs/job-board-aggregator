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

/**
 * Write per-source description sidecar files.
 * @param {Array} sortedJobs - Pipeline output jobs (sorted by posted_at)
 * @param {string} dataDir - Path to .github/data/ directory
 * @returns {{ writtenFiles: Set<string>, stats: Object }} written filenames + per-source stats
 */
function writeSidecars(sortedJobs, dataDir) {
  // Group jobs by source, collect id + description
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
      if (entry.description_text) merged.set(entry.id, entry.description_text);
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

  for (const [src, entries] of Object.entries(bySource)) {
    if (entries.length === 0) continue;

    const totalBytes = entries.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e), 'utf8') + 1, 0);
    const numChunks = Math.ceil(totalBytes / SIDECAR_CHUNK_LIMIT_BYTES);

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

  // Stale file cleanup
  const existingSidecarFiles = fs.readdirSync(dataDir)
    .filter(f => /^descriptions-.+\.jsonl$/.test(f) && !f.startsWith('descriptions-enriched') && !f.startsWith('descriptions-workday') && !f.startsWith('descriptions-smartrecruiters'));
  for (const fname of existingSidecarFiles) {
    if (!writtenFiles.has(fname)) {
      fs.unlinkSync(path.join(dataDir, fname));
      execSync(`git rm --cached ".github/data/${fname}" 2>/dev/null || true`);
      console.log(`🗑️  Removed stale sidecar: ${fname}`);
    }
  }

  return { writtenFiles, stats };
}

module.exports = { writeSidecars };
