// src/utils/sqlHealthcheck.js — pure helpers for the SQL Health Check page.
//
// Everything here works on what the backend actually returns:
//   • GET /batch-healthcheck/options → { targets, checks, ... }
//   • GET /jobs/{jobId}             → { status, exit_code, script_result, output, stderr_output, ... }
//
// The overall verdict is decided in exactly one place (interpretResult) so a
// partially completed or unreadable check can never be shown as healthy.

import { statusGroup } from './jobs';

// SSM keeps only the first 24,000 characters of a command's stdout
// (GetCommandInvocation StandardOutputContent). Output at that length may be cut off.
export const SSM_OUTPUT_LIMIT = 24000;

// Per-database breakdown contract. A health-check document that wants the
// page to show a per-database table prints ONE line:
//   RUNSTACK_DBHEALTH:[{"database":"PayrollDB","status":"HEALTHY","detail":"..."}, ...]
// (same RUNSTACK_<TAG>:<json> convention the DR status check already uses —
// see shared.parse_runstack_tagged_json). Without that line the page shows
// the overall result and the raw output, and says no breakdown was provided.
export const DB_TAG = 'RUNSTACK_DBHEALTH:';

const STATUS_WORDS = {
  healthy: ['HEALTHY', 'OK', 'PASS', 'PASSED', 'ONLINE', 'SUCCESS', 'GOOD'],
  warning: ['WARNING', 'WARN', 'DEGRADED'],
  failed: ['FAILED', 'FAIL', 'CRITICAL', 'ERROR', 'UNHEALTHY', 'OFFLINE', 'SUSPECT'],
  unavailable: ['UNAVAILABLE', 'SKIPPED', 'NOT_CHECKED', 'UNKNOWN', 'TIMEOUT', 'TIMED_OUT', 'NOT_RUN'],
};

/** Map one per-database status word onto healthy | warning | failed | unavailable. */
export function normalizeDbStatus(raw) {
  const s = String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  for (const [key, words] of Object.entries(STATUS_WORDS)) {
    if (words.includes(s)) return key;
  }
  // Anything unrecognised is NOT treated as healthy.
  return 'unavailable';
}

/**
 * Parse the per-database line out of raw job output.
 * Returns { rows, present, malformed }:
 *   present   — the tag line exists
 *   malformed — it exists but can't be read (e.g. cut off by the 24,000-char limit)
 */
export function parseDatabaseResults(output) {
  const line = String(output || '').split(/\r?\n/).find((l) => l.startsWith(DB_TAG));
  if (!line) return { rows: [], present: false, malformed: false };
  let data;
  try {
    data = JSON.parse(line.slice(DB_TAG.length));
  } catch {
    return { rows: [], present: true, malformed: true };
  }
  const list = Array.isArray(data) ? data : [data];
  const rows = list
    .filter((r) => r && typeof r === 'object')
    .map((r) => {
      const database = r.database ?? r.Database ?? r.name ?? r.Name ?? r.db ?? '';
      const rawStatus = r.status ?? r.Status ?? r.state ?? r.State ?? '';
      const detail = r.detail ?? r.Detail ?? r.message ?? r.Message ?? '';
      return { database: String(database), rawStatus: String(rawStatus), status: normalizeDbStatus(rawStatus), detail: String(detail || '') };
    });
  return { rows, present: true, malformed: rows.length === 0 };
}

/** Other non-tag output lines, for the raw output panel. */
export function visibleOutput(output) {
  return String(output || '').split(/\r?\n/).filter((l) => !l.startsWith(DB_TAG)).join('\n').trim();
}

// ── The PowerShell report printed by the SQL health check script ───────────
// SQL-Database-Healthcheck's script (Get-SQLPatchReport_FINAL.ps1) exits 0
// even when the SQL Agent is stopped or a database is OFFLINE — it only exits
// 1 when no SQL service exists. So the exit code alone must never be read as
// "healthy". The script's own report is read instead:
//   [3] DATABASE HEALTH - USER DATABASES   sqlcmd table "Database|State|RecoveryModel"
//   VALIDATION SUMMARY                     "  Label : [OK] … / [!!] …" lines
// Health = engine, agent, user databases, connectivity. The patch-date and
// BigFix checks are patch validation, reported separately: on any day other
// than patch day they fail by design and say nothing about database health.

const HEALTH_LABELS = ['SQL Engine Service', 'SQL Agent Service', 'User Databases', 'Connectivity Test'];
const DB_STATE = {
  ONLINE: 'healthy',
  RESTORING: 'warning', RECOVERING: 'warning',
  OFFLINE: 'failed', SUSPECT: 'failed', EMERGENCY: 'failed', RECOVERY_PENDING: 'failed',
};

export function parseHealthReport(output) {
  const lines = String(output || '').split(/\r?\n/);

  // Validation summary (last occurrence wins — console and report can both print it).
  const items = [];
  let start = -1;
  lines.forEach((l, i) => { if (l.trim() === 'VALIDATION SUMMARY') start = i; });
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (/^=+$/.test(t)) { if (items.length) break; continue; }
      const m = t.match(/^(.+?)\s*:\s*(.*)$/);
      if (m) {
        const value = m[2].trim();
        items.push({
          label: m[1].trim(),
          value: value.replace(/^\[(OK|!!)\]\s*/, ''),
          ok: /^\[OK\]/.test(value) || /^SUCCESS/.test(value),
          bad: /^\[!!\]/.test(value) || /^FAILED/.test(value),
        });
      }
    }
  }

  // [3] DATABASE HEALTH section.
  const rows = [];
  let headerSeen = false;
  let dbError = null;
  const s3 = lines.findIndex((l) => l.trim().startsWith('[3] DATABASE HEALTH'));
  if (s3 >= 0) {
    for (let i = s3 + 1; i < lines.length; i += 1) {
      const t = lines[i].trim();
      if (/^\[\d\]/.test(t) || /^=+$/.test(t)) break;
      if (!t || /^-+$/.test(t) || /^[-|\s]+$/.test(t)) continue;
      if (/^Database\s*\|\s*State/i.test(t)) { headerSeen = true; continue; }
      if (t.includes('|')) {
        const [database, state = '', recovery = ''] = t.split('|').map((x) => x.trim());
        const key = state.toUpperCase().replace(/\s+/g, '_');
        rows.push({
          database, rawStatus: state, status: DB_STATE[key] || 'unavailable',
          detail: [state && `State: ${state}`, recovery && `Recovery model: ${recovery}`].filter(Boolean).join(' · '),
        });
      } else if (!dbError) {
        dbError = t;
      }
    }
  }

  const health = items.filter((it) => HEALTH_LABELS.includes(it.label));
  const patch = items.filter((it) => !HEALTH_LABELS.includes(it.label));
  return {
    found: items.length > 0,
    health, patch,
    missingHealth: HEALTH_LABELS.filter((l) => !health.some((h) => h.label === l)),
    db: { rows, present: s3 >= 0, readable: s3 >= 0 && headerSeen && !dbError, error: dbError },
  };
}

/**
 * The single place that decides what the page calls the result.
 * state: running | failed | unhealthy | incomplete | warning | unknown | healthy | passed
 */
export function interpretResult(job) {
  if (!job) return null;
  const group = statusGroup(job.status);
  const output = job.output || '';
  const truncated = output.length >= SSM_OUTPUT_LIMIT;
  const db = parseDatabaseResults(output);
  const counts = { healthy: 0, warning: 0, failed: 0, unavailable: 0 };
  db.rows.forEach((r) => { counts[r.status] += 1; });
  const notes = [];

  if (group === 'PENDING' || group === 'RUNNING') {
    return { state: 'running', label: group === 'PENDING' ? 'Queued' : 'Running', tone: 'default', db, counts, truncated, notes };
  }
  if (group === 'FAILED') {
    const reason = (job.stderr_output || '').trim();
    if (reason) notes.push(reason.split(/\r?\n/)[0].slice(0, 300));
    return {
      state: 'failed',
      label: 'Check did not complete',
      tone: 'red',
      summary: `The health check job ended as ${String(job.status).toUpperCase()}, so database health could not be determined.`,
      db, counts, truncated, notes,
    };
  }

  // COMPLETED from here on.
  if (truncated) notes.push('The output reached the 24,000-character SSM limit and may be cut off.');
  if (db.malformed) notes.push('The per-database section of the output could not be read.');
  if (!db.present) notes.push('This check’s output does not include a per-database breakdown.');

  const exit = job.exit_code;
  if (exit !== null && exit !== undefined && exit !== -1 && Number(exit) !== 0) {
    return { state: 'unhealthy', label: 'Unhealthy', tone: 'red',
      summary: `The health check script reported a failure (exit code ${exit}).`, db, counts, truncated, notes };
  }
  if (!db.present) {
    const report = parseHealthReport(output);
    if (report.found) return interpretReport(job, report, truncated);
  }
  if (counts.failed > 0) {
    return { state: 'unhealthy', label: 'Unhealthy', tone: 'red',
      summary: `${counts.failed} database${counts.failed === 1 ? '' : 's'} failed the health check.`, db, counts, truncated, notes };
  }
  if (exit === null || exit === undefined || exit === -1) {
    return { state: 'unknown', label: 'Result not reported', tone: 'amber',
      summary: 'The job finished but no exit code was recorded, so RunStack cannot tell whether the check passed.', db, counts, truncated, notes };
  }
  if (counts.unavailable > 0 || db.malformed || (db.present && truncated)) {
    const n = counts.unavailable;
    return { state: 'incomplete', label: 'Partially checked', tone: 'amber',
      summary: n
        ? `${n} database${n === 1 ? '' : 's'} could not be checked. The result is incomplete.`
        : 'Not every database result could be read. The result is incomplete.',
      db, counts, truncated, notes };
  }
  if (counts.warning > 0) {
    return { state: 'warning', label: 'Healthy with warnings', tone: 'amber',
      summary: `${counts.warning} database${counts.warning === 1 ? '' : 's'} reported warnings.`, db, counts, truncated, notes };
  }
  if (db.present && db.rows.length > 0) {
    return { state: 'healthy', label: 'Healthy', tone: 'green',
      summary: `All ${db.rows.length} database${db.rows.length === 1 ? '' : 's'} passed.`, db, counts, truncated, notes };
  }
  return { state: 'passed', label: 'Passed', tone: 'green',
    summary: 'The health check script completed successfully (exit code 0).', db, counts, truncated, notes };
}

function interpretReport(job, report, truncated) {
  const rows = report.db.rows;
  const counts = { healthy: 0, warning: 0, failed: 0, unavailable: 0 };
  rows.forEach((r) => { counts[r.status] += 1; });
  const db = { rows, present: true, malformed: !report.db.readable };
  const base = { db, counts, truncated, health: report.health, patch: report.patch };
  const notes = [];
  if (truncated) notes.push('The output reached the 24,000-character SSM limit and may be cut off.');
  if (report.db.error) notes.push(`Database list: ${report.db.error}`);

  const badHealth = report.health.filter((h) => h.bad);
  if (badHealth.length || counts.failed) {
    const parts = badHealth.map((h) => `${h.label}: ${h.value}`);
    if (counts.failed) parts.push(`${counts.failed} database${counts.failed === 1 ? '' : 's'} not online`);
    return { ...base, notes, state: 'unhealthy', label: 'Unhealthy', tone: 'red', summary: `${parts.join('; ')}.` };
  }
  const exit = job.exit_code;
  if (exit === null || exit === undefined || exit === -1) {
    return { ...base, notes, state: 'unknown', label: 'Result not reported', tone: 'amber',
      summary: 'The job finished but no exit code was recorded, so RunStack cannot confirm the check ran to the end.' };
  }
  if (report.missingHealth.length || !report.db.readable || truncated || counts.unavailable) {
    const missing = [...report.missingHealth];
    if (!report.db.readable) missing.push('the database list');
    return { ...base, notes, state: 'incomplete', label: 'Partially checked', tone: 'amber',
      summary: missing.length
        ? `The report did not include: ${missing.join(', ')}. The result is incomplete.`
        : 'Not every result could be read. The result is incomplete.' };
  }
  if (counts.warning) {
    return { ...base, notes, state: 'warning', label: 'Healthy with warnings', tone: 'amber',
      summary: `${counts.warning} database${counts.warning === 1 ? ' is' : 's are'} restoring or recovering.` };
  }
  return { ...base, notes, state: 'healthy', label: 'Healthy', tone: 'green',
    summary: rows.length
      ? `SQL Engine and Agent are running, connectivity succeeded, and all ${rows.length} user database${rows.length === 1 ? ' is' : 's are'} online.`
      : 'SQL Engine and Agent are running and connectivity succeeded. No user databases were found.' };
}

// ── Parameters (mirror of the backend's validate_parameters) ────────────────
// The backend re-validates everything; this only gives early, inline feedback.

export function validateParam(spec, value) {
  const empty = value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0);
  if (empty) return spec.required ? 'Required.' : null;
  const values = spec.type === 'StringList' ? value : [value];
  if (spec.type === 'StringList') {
    if (spec.min_items != null && values.length < Number(spec.min_items)) return `At least ${spec.min_items} value(s) required.`;
    if (spec.max_items != null && values.length > Number(spec.max_items)) return `At most ${spec.max_items} value(s) allowed.`;
  }
  for (const raw of values) {
    const v = String(raw);
    if (v.length > 1024) return 'Must be at most 1024 characters.';
    if (/[\r\n]/.test(v) && spec.display_type !== 'textarea') return 'Must be a single line.';
    if (spec.type === 'Integer' && !/^-?\d+$/.test(v.trim())) return 'Must be a whole number.';
    if (spec.type === 'Boolean' && !['true', 'false'].includes(v.trim().toLowerCase())) return 'Must be true or false.';
    if (spec.min_chars != null && v.length < Number(spec.min_chars)) return `Must be at least ${spec.min_chars} characters.`;
    if (spec.max_chars != null && v.length > Number(spec.max_chars)) return `Must be at most ${spec.max_chars} characters.`;
    if (spec.allowed_values && !spec.allowed_values.map(String).includes(v)) return `Must be one of: ${spec.allowed_values.join(', ')}.`;
    if (spec.allowed_pattern) {
      let re = null;
      try { re = new RegExp(`^(?:${spec.allowed_pattern})$`); } catch { re = null; }
      if (re && !re.test(v)) return 'Does not match the format the document requires.';
    }
  }
  return null;
}

/** Turn form values into the request shape (StringList: one value per line). */
export function toRequestParameters(specs, form) {
  const out = {};
  (specs || []).forEach((p) => {
    const raw = form[p.name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return;
    out[p.name] = p.type === 'StringList'
      ? String(raw).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : String(raw).trim();
  });
  return out;
}

// ── 403/409 reasons → plain language ────────────────────────────────────────
export const DENIAL_TEXT = {
  not_in_group: 'Your account is not in a group that allows SQL health checks.',
  viewer_role: 'Your RunStack role is read-only (Viewer), which cannot run health checks.',
  not_in_team: 'You are not a member of the GDBA SQL team.',
  capability_not_enabled: 'You are in the GDBA SQL team, but the SQL health check permission is not enabled for it.',
  scope_excluded: 'Your SQL health check permission does not include this server.',
  environment_restricted: 'SQL health checks are not enabled for this server’s environment.',
  target_not_found: 'That server is not in the RunStack instance catalog.',
  check_unavailable: 'This health check is not available right now.',
  document_not_in_region: 'The health check document is not available in this server’s AWS region.',
  already_running: 'A health check of this type is already running on this server.',
};
