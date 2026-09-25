// src/utils/jobs.js — helpers for the Automation Executions page.
//
// Job timestamps are stored as naive UTC ISO strings ("2026-09-25T03:41:07.12")
// by process_messages. Parse them as UTC, display them in the viewer's zone.

export function parseUtc(iso) {
  if (!iso) return null;
  const s = String(iso);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toUtcIso(date) {
  return date ? date.toISOString() : '';
}

export const STATUS_GROUP_OF = {
  COMPLETED: 'COMPLETED', SUCCEEDED: 'COMPLETED', SUCCESS: 'COMPLETED',
  FAILED: 'FAILED', TIMED_OUT: 'FAILED', CANCELLED: 'FAILED', CANCELED: 'FAILED', ERROR: 'FAILED',
  RUNNING: 'RUNNING', IN_PROGRESS: 'RUNNING',
};
export const statusGroup = (s) => STATUS_GROUP_OF[String(s || '').toUpperCase()] || 'PENDING';
export const isActive = (s) => ['PENDING', 'RUNNING'].includes(statusGroup(s));

export function fmtStarted(iso) {
  const d = parseUtc(iso);
  if (!d) return '—';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `Today, ${time}` : `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}, ${time}`;
}

export function fmtFull(iso) {
  const d = parseUtc(iso);
  if (!d) return '—';
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  });
}

export function fmtAgo(iso, now = Date.now()) {
  const d = parseUtc(iso);
  if (!d) return '';
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function fmtSeconds(sec) {
  if (sec == null || Number.isNaN(sec)) return '—';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Finished jobs: created → last update. Active jobs: time so far (live). */
export function jobDuration(job, now = Date.now()) {
  const a = parseUtc(job.created_at);
  if (!a) return { text: '—', live: false, seconds: null };
  if (isActive(job.status)) {
    const sec = (now - a.getTime()) / 1000;
    return { text: fmtSeconds(sec), live: true, seconds: sec };
  }
  const b = parseUtc(job.updated_at);
  if (!b) return { text: '—', live: false, seconds: null };
  const sec = (b.getTime() - a.getTime()) / 1000;
  return { text: fmtSeconds(sec), live: false, seconds: sec };
}

// Date range presets; value is what goes in the URL.
export const DATE_PRESETS = [
  { value: '24h', label: 'Last 24 hours', hours: 24 },
  { value: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { value: '30d', label: 'Last 30 days', hours: 24 * 30 },
  { value: 'all', label: 'All time', hours: null },
  { value: 'custom', label: 'Custom range…', hours: null },
];

export function rangeToQuery(range, fromLocal, toLocal) {
  const preset = DATE_PRESETS.find((p) => p.value === range);
  if (preset?.hours) return { from: toUtcIso(new Date(Date.now() - preset.hours * 3600_000)) };
  if (range === 'custom') {
    const out = {};
    if (fromLocal) out.from = toUtcIso(new Date(fromLocal));
    if (toLocal) out.to = toUtcIso(new Date(toLocal));
    return out;
  }
  return {};
}

const CSV_COLUMNS = [
  ['job_id', (j) => j.job_id],
  ['automation', (j) => j.automation_label],
  ['document_name', (j) => j.document_name],
  ['automation_type', (j) => j.automation_type],
  ['status', (j) => j.status],
  ['server_name', (j) => j.server_name],
  ['app_name', (j) => j.app_name],
  ['resource_id', (j) => j.resource_id],
  ['account_id', (j) => j.account_id],
  ['region', (j) => j.region],
  ['environment', (j) => j.environment],
  ['created_at_utc', (j) => (parseUtc(j.created_at) ? parseUtc(j.created_at).toISOString() : '')],
  ['updated_at_utc', (j) => (parseUtc(j.updated_at) ? parseUtc(j.updated_at).toISOString() : '')],
  ['duration_seconds', (j) => { const d = jobDuration(j); return d.live || d.seconds == null ? '' : Math.round(d.seconds); }],
  ['execution_id', (j) => j.execution_id],
  ['notification_id', (j) => j.notification_id],
];

export function jobsToCsv(jobs) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [CSV_COLUMNS.map(([h]) => h).join(','), ...jobs.map((j) => CSV_COLUMNS.map(([, f]) => esc(f(j))).join(','))].join('\n');
}

export function downloadText(text, filename, type = 'text/csv') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}
