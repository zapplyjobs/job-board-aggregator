#!/usr/bin/env node

/**
 * Job Archiver
 *
 * Captures jobs expiring from the 7-day active window before all_jobs.json
 * is overwritten. Appends them to weekly JSONL files in .github/data/archive/.
 *
 * Called from index.js Step 9, before writeJobsJSONL overwrites all_jobs.json.
 */

const fs = require('fs');
const path = require('path');

/**
 * Returns the ISO week filename for a given date.
 * e.g. 2026-02-26 → "week-2026-W09"
 * @param {Date} date
 * @returns {string}
 */
function getISOWeekFilename(date) {
  // ISO week: week containing Thursday of that week belongs to that year
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayOfWeek = d.getUTCDay() || 7; // Make Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // Nearest Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `week-${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Find jobs present in the old all_jobs.json but absent from the new job set.
 * These are jobs expiring from the 7-day active window this run.
 *
 * @param {string} oldJobsPath - Path to current all_jobs.json (before overwrite)
 * @param {Array} newJobs - New job array (publicJobs, post-strip)
 * @returns {Array} - Expiring jobs (from old file, with expired_at added)
 */
function getExpiringJobs(oldJobsPath, newJobs) {
  if (!fs.existsSync(oldJobsPath)) {
    return []; // First run — no previous file
  }

  try {
    const content = fs.readFileSync(oldJobsPath, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    const oldJobs = lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(job => job !== null);

    // Build a Set of IDs in the new job set for O(1) lookup
    const newIds = new Set(newJobs.map(j => j.job_id || j.id));

    // expired_at = timestamp this job was detected missing from the active window.
    // This is NOT the job's actual expiry date (posted_at + 7 days) — it's when
    // the archiver first noticed the job had aged out (could lag by one run cycle).
    const expiredAt = new Date().toISOString();
    const expiring = oldJobs.filter(job => {
      const id = job.job_id || job.id;
      return id && !newIds.has(id);
    }).map(job => ({ ...job, expired_at: expiredAt }));

    return expiring;

  } catch (error) {
    console.error('⚠️ Archiver: error reading old jobs file:', error.message);
    return [];
  }
}

/**
 * Append expiring jobs to the weekly archive JSONL file.
 * Creates the archive directory and file if they don't exist.
 * Appends (never overwrites) — multiple runs in the same week accumulate.
 *
 * @param {Array} jobs - Expiring jobs to archive
 * @param {string} archiveDir - Path to archive directory (.github/data/archive)
 * @returns {string|null} - Path to archive file written, or null if nothing to write
 */
function appendToWeeklyArchive(jobs, archiveDir) {
  if (jobs.length === 0) return null;

  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const filename = getISOWeekFilename(new Date()) + '.jsonl';
  const filePath = path.join(archiveDir, filename);

  const lines = jobs.map(job => JSON.stringify(job)).join('\n') + '\n';
  fs.appendFileSync(filePath, lines, 'utf8');

  return filePath;
}

module.exports = { getExpiringJobs, appendToWeeklyArchive, getISOWeekFilename };
