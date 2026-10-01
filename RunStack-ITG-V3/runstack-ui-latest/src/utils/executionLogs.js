// src/utils/executionLogs.js — helpers for the Execution Details page.
//
// Pure functions only (no React), so they can be unit tested:
//   • target status colours/labels (pending, running, success, failed,
//     cancelled, timed_out — the buckets the backend returns)
//   • progress maths that separates "finished" from "successful"
//   • a bounded console buffer: new output is appended, older output is
//     prepended, and the buffer never grows past MAX_CONSOLE_LINES
//   • plain-text formatting for copy / download

export const MAX_CONSOLE_LINES = 5000;

export const TARGET_STATUS = {
  pending:   { label: 'Pending',   color: '#B45309', bg: '#FEF3E2', dot: '#F59E0B' },
  running:   { label: 'Running',   color: '#B45309', bg: '#FEF3E2', dot: '#D97706', pulse: true },
  success:   { label: 'Succeeded', color: '#0B6E4C', bg: '#E4F8F0', dot: '#0F9D6D' },
  failed:    { label: 'Failed',    color: '#B91C1C', bg: '#FDECEC', dot: '#DC2626' },
  cancelled: { label: 'Cancelled', color: '#475569', bg: '#F1F5F9', dot: '#64748B' },
  timed_out: { label: 'Timed out', color: '#9A3412', bg: '#FFEDD5', dot: '#EA580C' },
};

export const OVERALL_STATUS = {
  pending:   { label: 'Pending', color: '#B45309', bg: '#FEF3E2' },
  running:   { label: 'Running', color: '#B45309', bg: '#FEF3E2', pulse: true },
  success:   { label: 'Succeeded', color: '#0B6E4C', bg: '#E4F8F0' },
  partial:   { label: 'Finished with failures', color: '#9A3412', bg: '#FFEDD5' },
  failed:    { label: 'Failed', color: '#B91C1C', bg: '#FDECEC' },
  cancelled: { label: 'Cancelled', color: '#475569', bg: '#F1F5F9' },
  timed_out: { label: 'Timed out', color: '#9A3412', bg: '#FFEDD5' },
  unknown:   { label: 'Unknown', color: '#475569', bg: '#F1F5F9' },
};

export const isActiveTarget = (s) => s === 'pending' || s === 'running';

/** Progress counts every finished target — failures, cancellations and
 *  timeouts included — so "finished" and "successful" are different numbers. */
export function progressOf(counts) {
  const c = counts || {};
  const total = c.total || 0;
  const unsuccessful = (c.failed || 0) + (c.cancelled || 0) + (c.timed_out || 0);
  const finished = (c.success || 0) + unsuccessful;
  const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    total,
    finished,
    successful: c.success || 0,
    unsuccessful,
    active: (c.running || 0) + (c.pending || 0),
    finishedPct: pct(finished),
    successPct: pct(c.success || 0),
    unsuccessfulPct: pct(unsuccessful),
    runningPct: pct(c.running || 0),
    label: total
      ? `${finished} of ${total} finished · ${c.success || 0} succeeded${unsuccessful ? `, ${unsuccessful} did not succeed` : ''}`
      : 'No targets',
  };
}

/** Log events → console lines. One CloudWatch event may hold many lines. */
export function eventsToLines(events, seqStart = 0) {
  const out = [];
  let seq = seqStart;
  for (const ev of events || []) {
    const text = String(ev.message ?? '').replace(/\r\n/g, '\n').replace(/\n$/, '');
    const parts = text.split('\n');
    parts.forEach((line, i) => {
      out.push({
        id: seq += 1,
        ts: ev.ts,
        stream: ev.stream === 'stderr' ? 'stderr' : 'stdout',
        plugin: ev.plugin || '',
        step: ev.step || '',
        text: line,
        truncated: Boolean(ev.truncated) && i === parts.length - 1,
      });
    });
  }
  return out;
}

/** Append newer lines; drop the oldest when over the cap. */
export function appendBounded(lines, newer, max = MAX_CONSOLE_LINES) {
  if (!newer || newer.length === 0) return { lines, dropped: 0 };
  const all = lines.concat(newer);
  const dropped = Math.max(0, all.length - max);
  return { lines: dropped ? all.slice(dropped) : all, dropped };
}

/** Prepend older lines; never evicts what's already on screen. Returns how
 *  many of the older lines were kept (0 when the buffer is already full). */
export function prependBounded(lines, older, max = MAX_CONSOLE_LINES) {
  if (!older || older.length === 0) return { lines, kept: 0 };
  const room = Math.max(0, max - lines.length);
  if (room === 0) return { lines, kept: 0 };
  const kept = older.slice(Math.max(0, older.length - room));
  return { lines: kept.concat(lines), kept: kept.length };
}

export function filterLines(lines, view) {
  if (view === 'stdout' || view === 'stderr') return lines.filter((l) => l.stream === view);
  return lines;
}

function hhmmss(ts) {
  if (!ts) return '--:--:--';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toISOString().slice(11, 19);
}

/** Plain text for copy / download. Timestamps are UTC upload batch times. */
export function linesToText(lines, { withMeta = true } = {}) {
  return lines.map((l) => (withMeta
    ? `${hhmmss(l.ts)}Z ${l.stream === 'stderr' ? 'ERR' : 'OUT'} ${l.text}`
    : l.text)).join('\n');
}

export function logFileName(target, stamp = new Date()) {
  const safe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const when = stamp.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `runstack-${safe(target?.server_name || target?.instance_id || 'target')}-${safe((target?.job_id || '').slice(0, 8))}-${when}.log`;
}

/** Error from apiFetch → how to present it and how long to wait. */
export function classifyFetchError(e) {
  if (!e) return null;
  if (e.name === 'AbortError') return { kind: 'aborted' };
  if (e.status === 404) return { kind: 'not_found', message: 'This execution was not found, or you do not have access to it.' };
  if (e.status === 429) return { kind: 'throttled', message: 'AWS is throttling status reads. Retrying shortly.' };
  if (e.status === 401 || e.name === 'AuthRequiredError') return { kind: 'auth', message: 'Your session expired. Sign in again.' };
  return { kind: 'error', message: e.body?.message || e.message || String(e) };
}

/** Exponential back-off for failed polls, capped. Throttling starts higher. */
export function backoffMs(baseMs, failures, { throttled = false, maxMs = 60000 } = {}) {
  if (!failures) return baseMs;
  const start = throttled ? Math.max(baseMs, 15000) : baseMs;
  return Math.min(maxMs, start * 2 ** Math.min(failures, 6));
}

export function fmtElapsed(sec) {
  if (sec == null || Number.isNaN(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Live elapsed seconds for an active target, stored value otherwise. */
export function targetElapsed(t, now = Date.now()) {
  if (!t) return null;
  if (isActiveTarget(t.status) && t.started_at) {
    const a = Date.parse(t.started_at);
    if (!Number.isNaN(a)) return Math.max(0, (now - a) / 1000);
  }
  return t.elapsed_seconds ?? null;
}
