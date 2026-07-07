#!/usr/bin/env node

/**
 * Job Deduplicator
 *
 * Removes duplicate jobs using multiple strategies:
 * 1. ID-based deduplication (exact matches)
 * 2. Fingerprint-based deduplication (same job, different ID)
 *
 * Maintains a dedupe store for tracking seen jobs across runs.
 * UPDATED 2026-02-05: Added TTL-based cleanup to prevent job starvation
 */

const fs = require('fs');
const path = require('path');
const { generateFingerprint } = require('../utils/helpers');

const DEDUPE_STORE_FILE = path.join(process.cwd(), '.github', 'data', 'dedupe-store.json');
const DEDUPE_TTL_DAYS = 14; // Remove entries after 14 days (matches rolling window cutoff — AGG-DESIGN-2)
const DEDUPE_TTL_MS = DEDUPE_TTL_DAYS * 24 * 60 * 60 * 1000;
const INTERNSHIP_TTL_DAYS = 120;
const INTERNSHIP_TTL_MS = INTERNSHIP_TTL_DAYS * 24 * 60 * 60 * 1000;

function isInternshipJob(job) {
  return job?.tags?.employment === 'internship'
    || job?.employment_type === 'internship'
    || (Array.isArray(job?.employment_types) && job.employment_types.includes('internship'));
}

function activeWindowTtlMs(job) {
  return isInternshipJob(job) ? INTERNSHIP_TTL_MS : DEDUPE_TTL_MS;
}

function activeWindowAnchorTs(job, now = Date.now()) {
  const rawPostedAt = job?.posted_at ? new Date(job.posted_at).getTime() : now;
  const postedTs = Number.isNaN(rawPostedAt) ? now : Math.min(rawPostedAt, now);
  if (job?.source === 'greenhouse' && isInternshipJob(job) && job?.source_updated_at) {
    const rawUpdatedAt = new Date(job.source_updated_at).getTime();
    if (!Number.isNaN(rawUpdatedAt)) {
      const updatedTs = Math.min(rawUpdatedAt, now);
      if (updatedTs > postedTs) return updatedTs;
    }
  }
  return postedTs;
}


/**
 * Load dedupe store
 * @returns {Object} - { ids: Map, fingerprints: Map }
 * Note: Changed from Set to Map to track timestamps
 */
function loadDedupeStore() {
  try {
    if (!fs.existsSync(DEDUPE_STORE_FILE)) {
      return { ids: new Map(), fingerprints: new Map() };
    }

    const data = JSON.parse(fs.readFileSync(DEDUPE_STORE_FILE, 'utf8'));

    // Convert old Set format to new Map format with timestamps
    const ids = new Map();
    const fingerprints = new Map();

    if (data.ids) {
      if (Array.isArray(data.ids)) {
        // Old format: Array of IDs (no timestamps) - set current time
        const now = Date.now();
        for (const id of data.ids) {
          ids.set(id, now);
        }
      } else if (typeof data.ids === 'object') {
        // New format: Map-like object
        for (const [id, ts] of Object.entries(data.ids)) {
          ids.set(id, ts);
        }
      }
    }

    if (data.fingerprints) {
      if (Array.isArray(data.fingerprints)) {
        // Old format: Array of fingerprints (no timestamps) - set current time
        const now = Date.now();
        for (const fp of data.fingerprints) {
          fingerprints.set(fp, now);
        }
      } else if (typeof data.fingerprints === 'object') {
        // New format: Map-like object
        for (const [fp, ts] of Object.entries(data.fingerprints)) {
          fingerprints.set(fp, ts);
        }
      }
    }

    return { ids, fingerprints };

  } catch (error) {
    console.error('⚠️ Error loading dedupe store:', error.message);
    return { ids: new Map(), fingerprints: new Map() };
  }
}

/**
 * Save dedupe store
 * @param {Object} store - { ids: Map, fingerprints: Map }
 */
function saveDedupeStore(store) {
  try {
    const dir = path.dirname(DEDUPE_STORE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tempPath = `${DEDUPE_STORE_FILE}.tmp`;

    // Convert Maps to Objects for JSON serialization (preserves timestamps)
    const data = {
      ids: Object.fromEntries(store.ids),
      fingerprints: Object.fromEntries(store.fingerprints),
      last_updated: new Date().toISOString()
    };

    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempPath, DEDUPE_STORE_FILE);

  } catch (error) {
    console.error('⚠️ Error saving dedupe store:', error.message);
  }
}

/**
 * Clean up old entries from dedupe store (older than TTL)
 * @param {Object} store - Dedupe store { ids: Map, fingerprints: Map }
 * @returns {Object} - Cleanup stats
 */
function cleanupOldEntries(store) {
  const now = Date.now();
  const cutoff = now - DEDUPE_TTL_MS;

  let removedIds = 0;
  let removedFingerprints = 0;

  // Clean old IDs
  for (const [id, timestamp] of store.ids.entries()) {
    if (timestamp < cutoff) {
      store.ids.delete(id);
      removedIds++;
    }
  }

  // Clean old fingerprints
  for (const [fp, timestamp] of store.fingerprints.entries()) {
    if (timestamp < cutoff) {
      store.fingerprints.delete(fp);
      removedFingerprints++;
    }
  }

  if (removedIds > 0 || removedFingerprints > 0) {
    console.log(`🧹 Cleaned ${removedIds} old IDs, ${removedFingerprints} old fingerprints (> ${DEDUPE_TTL_DAYS} days)`);
  }

  return { removed_ids: removedIds, removed_fingerprints: removedFingerprints };
}

/**
 * Deduplicate jobs
 *
 * Two separate concerns:
 *   1. OUTPUT: all jobs within the rolling active window (full catalog for consumer repos)
 *   2. STORE: tracks every seen job+fingerprint for Discord re-post prevention
 *
 * A job is "within window" if its store entry (keyed on posted_at) is within its
 * applicable active-window TTL. Net-new jobs (not yet in store) are added with
 * their posted_at as the TTL anchor.
 *
 * @param {Array} jobs - Array of normalized job objects
 * @returns {Object} - { unique: Array, duplicates: number, stats: Object }
 */
function deduplicateJobs(jobs) {
  console.log(`🔍 Processing ${jobs.length} jobs for ${DEDUPE_TTL_DAYS}-day active window...`);

  // Load existing dedupe store
  const store = loadDedupeStore();

  // Clean up old entries first (TTL-based) — removes entries > N days old
  const cleanupStats = cleanupOldEntries(store);

  const activeWindow = []; // All jobs within rolling window (output)
  const newJobs = [];      // Jobs not previously seen (for logging)
  const now = Date.now();

  // AGG-11: Track IDs seen within THIS run to prevent within-run duplicates.
  const seenThisRun = new Set();
  let withinRunDupes = 0;
  let expiredByDate = 0;

  for (const job of jobs) {
    // AGG-11: skip if this exact ID was already processed in this run
    if (seenThisRun.has(job.id)) {
      withinRunDupes++;
      continue;
    }
    seenThisRun.add(job.id);

    const seenById = store.ids.has(job.id);
    const seenByFp = store.fingerprints.has(job.fingerprint);

    if (seenById || seenByFp) {
      // Job already in store — do NOT refresh timestamp; TTL must fire on posted_at
      // AGG-POSTEDAT-INTEGRITY-1: For sources with null posted_at (e.g. TikTok API
      // doesn't provide posting dates), restore posted_at from the store entry timestamp.
      // This is the first-seen time (set once on initial entry, never refreshed).
      // Eliminates null posted_at from the output pool — downstream consumers never see null.
      if (!job.posted_at) {
        const storeTs = seenById ? store.ids.get(job.id) : store.fingerprints.get(job.fingerprint);
        if (storeTs) job.posted_at = new Date(storeTs).toISOString();
      }
      activeWindow.push(job);
    } else {
      // Net-new job — store active-window anchor so TTL fires on source freshness, not fetch time.
      const ts = activeWindowAnchorTs(job, now);

      // Enforce active window: if the anchor is older than the job's applicable TTL, skip it.
      if (ts < now - activeWindowTtlMs(job)) {
        expiredByDate++;
        continue;
      }

      // AGG-POSTEDAT-INTEGRITY-1: For net-new jobs with null posted_at (source doesn't
      // provide posting dates), set posted_at = first-seen time. This date is set ONCE
      // (on first pool entry) and restored from the store on subsequent runs. It ages
      // naturally within the 14-day TTL window. After store expiry (~14d), the job
      // re-enters with a fresh first-seen — acceptable for sources with unknown dates.
      // See: AGG_DEDUP_GATE_INVESTIGATION_2026_07_07.md
      if (!job.posted_at) {
        job.posted_at = new Date(ts).toISOString();
      }

      store.ids.set(job.id, ts);
      store.fingerprints.set(job.fingerprint, ts);
      activeWindow.push(job);
      newJobs.push(job);
    }
  }

  if (withinRunDupes > 0) {
    console.log(`🔄 Skipped ${withinRunDupes} within-run duplicate IDs`);
  }
  if (expiredByDate > 0) {
    console.log(`⏰ Filtered ${expiredByDate} expired jobs (posted outside active window; regular baseline >${DEDUPE_TTL_DAYS} days ago, internships wider)`);
  }

  // Save updated store
  saveDedupeStore(store);

  // Calculate stats
  const previouslySeen = activeWindow.length - newJobs.length;
  const stats = {
    input: jobs.length,
    active_window: activeWindow.length,
    net_new: newJobs.length,
    previously_seen: previouslySeen,
    expired_by_date: expiredByDate,
    store_size: store.ids.size,
    cleanup_removed: cleanupStats.removed_ids + cleanupStats.removed_fingerprints
  };

  console.log(`✅ Active window built:`);
  console.log(`   Input: ${stats.input} jobs`);
  console.log(`   Output (${DEDUPE_TTL_DAYS}-day window): ${stats.active_window} jobs`);
  console.log(`   Net-new this run: ${stats.net_new} jobs`);
  console.log(`   Previously seen (refreshed): ${stats.previously_seen} jobs`);
  console.log(`   Store size: ${stats.store_size} entries`);
  if (stats.cleanup_removed > 0) {
    console.log(`   Expired entries cleaned: ${stats.cleanup_removed}`);
  }

  // Return active window as "unique" for backwards compatibility with callers
  return { unique: activeWindow, duplicates: previouslySeen, stats };
}

/**
 * Reset dedupe store (use with caution!)
 * @returns {boolean} - Success status
 */
function resetDedupeStore() {
  try {
    if (fs.existsSync(DEDUPE_STORE_FILE)) {
      // Create backup
      const backupPath = `${DEDUPE_STORE_FILE}.backup-${Date.now()}`;
      fs.copyFileSync(DEDUPE_STORE_FILE, backupPath);
      console.log(`📁 Backup created: ${backupPath}`);
    }

    // Reset to empty state
    saveDedupeStore({ ids: new Map(), fingerprints: new Map() });
    console.log('✅ Dedupe store reset');
    return true;

  } catch (error) {
    console.error('❌ Error resetting dedupe store:', error.message);
    return false;
  }
}

/**
 * Get dedupe store statistics
 * @returns {Object} - Store stats
 */
function getDedupeStats() {
  const store = loadDedupeStore();

  return {
    total_ids: store.ids.size,
    total_fingerprints: store.fingerprints.size,
    store_file: DEDUPE_STORE_FILE,
    last_updated: fs.existsSync(DEDUPE_STORE_FILE)
      ? fs.statSync(DEDUPE_STORE_FILE).mtime.toISOString()
      : null
  };
}

module.exports = {
  DEDUPE_TTL_DAYS,
  DEDUPE_TTL_MS,
  INTERNSHIP_TTL_DAYS,
  INTERNSHIP_TTL_MS,
  deduplicateJobs,
  generateFingerprint, // re-exported from helpers.js — single canonical implementation
  resetDedupeStore,
  getDedupeStats,
  loadDedupeStore,
  saveDedupeStore,
  isInternshipJob,
  activeWindowTtlMs,
  activeWindowAnchorTs
};
