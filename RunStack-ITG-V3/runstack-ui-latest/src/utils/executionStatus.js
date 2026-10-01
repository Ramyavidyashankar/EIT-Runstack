// src/utils/executionStatus.js — the one place execution statuses are styled.
//
// Every execution view (Execution Details header, summary cards, target
// table, output drawer, step tables) takes its label, icon and colours from
// here, so a status always looks the same wherever it appears.
//
// Status values are the ones GET /jobs/{jobId}/execution returns:
//   targets:  pending, running, success, failed, cancelled, timed_out
//   overall:  the same, plus partial ("Finished with failures") and unknown
//
// Colours mirror the CSS tokens in index.css (--success*, --warning*,
// --danger*, --running*). They're hex here because components build
// translucent borders from them (`${dot}40`).
//
// Pure functions only — unit tested in executionStatus.test.js.

const GREEN = { color: '#0B6E4C', bg: '#E4F8F0', dot: '#0F9D6D', border: '#A9E7CD' };
const BLUE = { color: '#1D4ED8', bg: '#EFF6FF', dot: '#2563EB', border: '#BFDBFE' };
const AMBER = { color: '#B45309', bg: '#FEF3E2', dot: '#F59E0B', border: '#FBDCA0' };
const RED = { color: '#B91C1C', bg: '#FDECEC', dot: '#DC2626', border: '#F7B9B9' };
const ORANGE = { color: '#9A3412', bg: '#FFEDD5', dot: '#EA580C', border: '#FDBA8C' };
const GRAY = { color: '#4F5B6E', bg: '#F5F6F8', dot: '#657185', border: '#C9D1DC' };

export const TARGET_STATUS = {
  pending:   { label: 'Pending',   icon: '○', ...AMBER },
  running:   { label: 'Running',   icon: '●', ...BLUE, pulse: true },
  success:   { label: 'Succeeded', icon: '✓', ...GREEN },
  failed:    { label: 'Failed',    icon: '✕', ...RED },
  cancelled: { label: 'Cancelled', icon: '–', ...GRAY },
  timed_out: { label: 'Timed out', icon: '◷', ...ORANGE },
};

export const OVERALL_STATUS = {
  pending:   { label: 'Pending',   icon: '○', ...AMBER },
  running:   { label: 'Running',   icon: '●', ...BLUE, pulse: true },
  success:   { label: 'Succeeded', icon: '✓', ...GREEN },
  partial:   { label: 'Finished with failures', icon: '!', ...ORANGE },
  failed:    { label: 'Failed',    icon: '✕', ...RED },
  cancelled: { label: 'Cancelled', icon: '–', ...GRAY },
  timed_out: { label: 'Timed out', icon: '◷', ...ORANGE },
  unknown:   { label: 'Unknown',   icon: '?', ...GRAY },
};

export const targetStatusMeta = (s) => TARGET_STATUS[s] || TARGET_STATUS.pending;
export const overallStatusMeta = (s) => OVERALL_STATUS[s] || OVERALL_STATUS.unknown;

export const isActiveTarget = (s) => s === 'pending' || s === 'running';
export const isUnsuccessfulTarget = (s) => s === 'failed' || s === 'timed_out' || s === 'cancelled';

function pctOf(n, total) {
  if (!total || !n) return 0;
  return Math.round((n / total) * 100);
}

/** "62%" — but never "0%" for a non-zero count. */
export function fmtPct(n, total) {
  if (!total) return '—';
  const p = pctOf(n, total);
  return n > 0 && p === 0 ? '<1%' : `${p}%`;
}

/**
 * Summary cards for an execution's counts.
 *
 * Failed aggregates failed + timed_out (timed-out servers still show their
 * own "Timed out" status in the table). Cancelled is grey and only shown
 * when something was cancelled.
 */
export function summaryBuckets(counts) {
  const c = counts || {};
  const total = c.total || 0;
  const failedAgg = (c.failed || 0) + (c.timed_out || 0);
  const card = (key, label, value, meta, note) => ({ key, label, value, pct: fmtPct(value, total), meta, note });
  const cards = [
    card('success', 'Succeeded', c.success || 0, TARGET_STATUS.success),
    card('running', 'Running', c.running || 0, TARGET_STATUS.running),
    card('pending', 'Pending', c.pending || 0, TARGET_STATUS.pending),
    card('failed', 'Failed', failedAgg, TARGET_STATUS.failed,
      c.timed_out ? `incl. ${c.timed_out.toLocaleString()} timed out` : null),
  ];
  if (c.cancelled) cards.push(card('cancelled', 'Cancelled', c.cancelled, TARGET_STATUS.cancelled));
  return cards;
}

/**
 * Status filter chips for the target table. Each chip maps to a filter the
 * backend supports exactly, so the chip count always equals the rows shown.
 * Timed out / Cancelled appear only when there are any (or when selected).
 */
export function statusFilters(counts, current = '') {
  const c = counts || {};
  const chip = (value, label, count, meta) => ({ value, label, count: count || 0, meta });
  const chips = [
    chip('', 'All', c.total),
    chip('running', 'Running', c.running, TARGET_STATUS.running),
    chip('pending', 'Pending', c.pending, TARGET_STATUS.pending),
    chip('success', 'Succeeded', c.success, TARGET_STATUS.success),
    chip('failed', 'Failed', c.failed, TARGET_STATUS.failed),
    chip('timed_out', 'Timed out', c.timed_out, TARGET_STATUS.timed_out),
    chip('cancelled', 'Cancelled', c.cancelled, TARGET_STATUS.cancelled),
  ];
  return chips.filter((x) => !['timed_out', 'cancelled'].includes(x.value) || x.count > 0 || x.value === current);
}

/**
 * Where an execution came from, derived from `initiated_by` as RunStack
 * records it (never hardcoded per trigger):
 *   schedule:<rule>  → Scheduled run of that EventBridge rule (scheduler)
 *   client:<id>      → a machine client using client credentials
 *   an e-mail        → the signed-in user who started it
 */
export function triggerSource(initiatedBy) {
  const v = String(initiatedBy || '').trim();
  if (!v) return { kind: 'unknown', label: 'Not recorded', by: null };
  if (v === 'schedule' || v.startsWith('schedule:')) {
    const rule = v.slice('schedule:'.length);
    return { kind: 'scheduled', label: 'Scheduled run', by: rule && v !== 'schedule' ? `Schedule ${rule}` : 'Schedule' };
  }
  if (v.startsWith('client:')) return { kind: 'client', label: 'API client', by: v.slice('client:'.length) || 'API client' };
  if (v.includes('@')) return { kind: 'user', label: 'User', by: v };
  return { kind: 'other', label: 'Other', by: v };
}

/** What the table's output action says for a target. */
export function outputActionLabel(status) {
  if (status === 'running') return 'Live status';
  if (status === 'success') return 'View output';
  if (isUnsuccessfulTarget(status)) return 'View error';
  return null;   // pending — nothing to show yet
}
