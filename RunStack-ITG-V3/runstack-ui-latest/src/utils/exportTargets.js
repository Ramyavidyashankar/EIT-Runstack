// src/utils/exportTargets.js — CSV export of an execution's targets.
//
// Reads every target matching the current search/status filter through the
// existing GET /jobs/{jobId}/execution API (same authorization as the page:
// servers the caller can't see are never returned), 200 rows per request.
// Exports status and timing only — never command output or parameters.

import { fmtElapsed, targetElapsed } from './executionLogs';
import { targetStatusMeta } from './executionStatus';

export const EXPORT_PAGE_SIZE = 200;      // backend maximum (TARGET_PAGE_MAX)
export const EXPORT_MAX_PAGES = 50;       // 10,000 rows — above the backend's 5,000-member cap

/**
 * @param {(params: object, opts: object) => Promise<object>} fetchPage  e.g. (p, o) => fetchExecution(jobId, p, o)
 * @returns {Promise<{ rows: object[], complete: boolean }>}
 */
export async function fetchAllTargets(fetchPage, { q, status } = {}, { signal, onProgress } = {}) {
  const rows = [];
  let cursor = '';
  for (let page = 0; page < EXPORT_MAX_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetchPage({ limit: EXPORT_PAGE_SIZE, cursor: cursor || undefined, q: q || undefined, status: status || undefined }, { signal });
    rows.push(...(res.targets || []));
    if (onProgress) onProgress({ loaded: rows.length, total: res.total_matching || rows.length });
    if (!res.next_cursor) return { rows, complete: true };
    cursor = res.next_cursor;
  }
  return { rows, complete: false };
}

// Spreadsheet apps execute cells starting with these characters as formulas.
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUMNS = [
  ['Server', (t) => t.server_name || ''],
  ['Instance ID', (t) => t.instance_id || ''],
  ['Status', (t) => targetStatusMeta(t.status).label],
  ['Status detail', (t) => t.status_detail || ''],
  ['Account', (t) => t.account_id || ''],
  ['Region', (t) => t.region || ''],
  ['Started (UTC)', (t) => t.started_at || ''],
  ['Ended (UTC)', (t) => t.ended_at || ''],
  ['Duration', (t, now) => (t.started_at ? fmtElapsed(targetElapsed(t, now)) : '')],
  ['Job ID', (t) => t.job_id || ''],
];

export function targetsToCsv(rows, now = Date.now()) {
  const lines = [COLUMNS.map(([h]) => csvCell(h)).join(',')];
  for (const t of rows) lines.push(COLUMNS.map(([, get]) => csvCell(get(t, now))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function exportFileName(exec, stamp = new Date()) {
  const base = String(exec?.automation_name || exec?.group_id || exec?.job_id || 'execution')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'execution';
  const ts = stamp.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${base}-targets-${ts}.csv`;
}
