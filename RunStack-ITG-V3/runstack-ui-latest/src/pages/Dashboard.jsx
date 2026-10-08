// src/pages/Dashboard.jsx
//
// One time range (Last 24 hours / 7 / 30 / 90 days / All time / custom UTC
// dates) drives everything on the page, so the numbers always agree with each
// other and with the drill-downs:
//
//   KPI counts + trend chart       GET /jobs/query?view=summary&range=<r>
//                                  (or &from_day=&to_day= for a custom range)
//                                  job_stats counters — exact, no table scan.
//                                  Also returns the all-time total, the live
//                                  running / pending counts and how many runs
//                                  have been running for over an hour.
//   Automation Summary             GET /jobs/query?view=automations (same window)
//                                  per-automation counters (job_stats), or —
//                                  until those are set up — grouped from the
//                                  jobs table by the API (count_source "scan")
//   Recent executions              GET /jobs/query?from=<summary.from>&limit=8
//                                  (same window as the counts)
//   Needs attention                failures in the range, executions waiting
//                                  to start, long-running executions, and the
//                                  dead letter queue count last seen on its
//                                  page (see utils/dlqStatus.js)
//
// Scope: these endpoints count every RunStack execution, not only the
// signed-in user's — the same data the Executions page shows. "Running now"
// is a live count of every execution still running, whatever day it started,
// and is labelled as such.
//
// Every count links to the Executions page with the same window and status
// (and automation, from the Automation Summary), where search, filters,
// paging and per-server output live.

import React from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Page } from '../components/PageLayout';
import { Card, CardHead, StatusBadge, Spinner, Btn } from '../components/ui';
import DateRangeSelect from '../components/DateRangeSelect';
import { SectionHeader, fmtClock } from '../components/sections';
import { fetchAutomationSummary, fetchJobsSummary, queryJobs } from '../api/client';
import { fmtRelative } from '../utils/helpers';
import { fmtFull, fmtSeconds, jobDuration, jobTitle, parseUtc } from '../utils/jobs';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { useLiveSection } from '../hooks/useLiveSection';
import { usePersistentState } from '../hooks/useNavigation';
import { useAuth } from '../auth/AuthContext';
import { canAccess } from '../auth/access';
import { useAppNavigate } from '../components/nav/navigationContext';
import { getDlqStatus, subscribeDlqStatus } from '../utils/dlqStatus';
import { customLabel, customRangeError, fmtLocal, fmtUtcDay, fmtUtcMonth, localInput, utcDay } from '../utils/dateRange';

const RECENT_LIMIT = 8;
const AUTOMATION_TOP = 10;

// Ranges the job counters support (jobs_list.RANGES + custom from_day/to_day).
export const PERIODS = [
  { value: '24h', label: 'Last 24 hours', short: 'the last 24 hours', pollMs: 15000 },
  { value: '7d', label: 'Last 7 days', short: 'the last 7 days', pollMs: 60000 },
  { value: '30d', label: 'Last 30 days', short: 'the last 30 days', pollMs: 60000 },
  { value: '90d', label: 'Last 90 days', short: 'the last 90 days', pollMs: 60000 },
  { value: 'all', label: 'All time', short: 'all time', pollMs: 120000 },
  { value: 'custom', label: 'Custom range…', short: 'the selected dates', pollMs: 60000 },
];

// Status colours (mirror index.css tokens; SVG props can't read CSS vars).
const COLOR = { Completed: '#0F9D6D', Running: '#2563EB', Pending: '#B45309', Failed: '#DC2626', grid: '#D7E0EB', axis: '#52647A' };

const num = (v) => (typeof v === 'number' ? v.toLocaleString('en-GB') : '—');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const pct = (part, whole) => (whole ? `${(Math.round((1000 * part) / whole) / 10).toLocaleString('en-GB')}%` : null);

// Date helpers shared with the Executions page.
export { customLabel, customRangeError, utcDay } from '../utils/dateRange';

/**
 * Executions page URL for the dashboard's window.
 *   period   '24h' | '7d' | '30d' | '90d' | 'all' | 'custom'
 *   win      { from_day, to_day } for a custom range
 *   extra    more query params (status, automation, name …)
 * Both pages use the same ranges (utils/dateRange.js), so the drill-down
 * shows exactly the executions the Dashboard counted.
 */
export function executionsLink(period, win, extra = {}) {
  const q = new URLSearchParams();
  const { from_day: fromDay, to_day: toDay } = (win && typeof win === 'object') ? win : {};
  if (period === 'custom' && fromDay && toDay) {
    q.set('range', 'custom');
    q.set('from_day', fromDay);
    q.set('to_day', toDay);
  } else {
    q.set('range', period === 'custom' ? 'all' : period);
  }
  Object.entries(extra).forEach(([k, v]) => { if (v) q.set(k, v); });
  if (q.get('range') === '7d') q.delete('range'); // the Executions page default
  const s = q.toString();
  return `/jobs${s ? `?${s}` : ''}`;
}

// ── Trend buckets ────────────────────────────────────────────────────────────

/** { label, full } for one chart bucket. */
export function bucketLabels(b, bucket) {
  const d = parseUtc(b.start);
  if (!d) return { label: '', full: '' };
  const endIncl = parseUtc(b.end) ? new Date(parseUtc(b.end).getTime() - 1) : d;
  if (bucket === 'day') return { label: fmtUtcDay(d), full: fmtUtcDay(d, { weekday: true, year: true }) };
  if (bucket === 'week') {
    const same = utcDay(d) === utcDay(endIncl);
    return { label: fmtUtcDay(d), full: same ? fmtUtcDay(d, { year: true }) : `${fmtUtcDay(d)} – ${fmtUtcDay(endIncl, { year: true })}` };
  }
  if (bucket === 'month') {
    const m = fmtUtcMonth(d);
    return { label: m, full: m };
  }
  return { label: fmtLocal(d, { day: bucket !== '1h' }), full: fmtLocal(d) };
}

function bucketText(bucket) {
  if (bucket === 'day') return 'per day (UTC)';
  if (bucket === 'week') return 'per 7 days (UTC)';
  if (bucket === 'month') return 'per month (UTC)';
  if (bucket === '1h') return 'per hour (your local time)';
  return `per ${String(bucket || '').replace('h', ' hours')} (your local time)`;
}

function useDlq() {
  const [s, setS] = React.useState(getDlqStatus);
  React.useEffect(() => subscribeDlqStatus(setS), []);
  return s;
}

function LoadError({ section, what }) {
  return (
    <div role="alert" className="rs-dash-error">
      Couldn’t load {what}: {section.error}
      <Btn variant="default" size="sm" onClick={section.refresh}>Try again</Btn>
    </div>
  );
}

// ── Summary counts ───────────────────────────────────────────────────────────
function Stat({ label, value, sub, sub2, to, tone, onGo, title }) {
  const body = (
    <>
      <span className="rs-stat-label">{label}</span>
      <span className={`rs-stat-value${tone ? ` rs-stat-value--${tone}` : ''}`}>{value}</span>
      {sub && <span className="rs-stat-sub">{sub}</span>}
      {sub2 && <span className="rs-stat-sub">{sub2}</span>}
    </>
  );
  if (!to) return <div className="rs-stat">{body}</div>;
  return (
    <Link to={to} className="rs-stat rs-stat--link" title={title} onClick={(e) => onGo(e, to)}>{body}</Link>
  );
}

// ── Needs attention ──────────────────────────────────────────────────────────
function AttentionItem({ tone, title, detail, to, onGo }) {
  return (
    <li>
      <Link to={to} className={`rs-attn rs-attn--${tone}`} onClick={(e) => onGo(e, to)}>
        <span className="rs-attn-dot" aria-hidden />
        <span className="rs-attn-text">
          <span className="rs-attn-title">{title}</span>
          {detail && <span className="rs-attn-detail">{detail}</span>}
        </span>
        <span className="rs-attn-go" aria-hidden>→</span>
      </Link>
    </li>
  );
}

// ── Automation Summary ───────────────────────────────────────────────────────
const AUTO_COLUMNS = [
  { key: 'automation', label: 'Automation' },
  { key: 'total', label: 'Total Executions', numeric: true, sortable: true, title: 'Started in the range, any status (includes running and waiting)' },
  { key: 'COMPLETED', label: 'Completed', numeric: true, narrowHide: true },
  { key: 'FAILED', label: 'Failed', numeric: true, sortable: true, title: 'Includes timed out and cancelled' },
  { key: 'success_rate', label: 'Success Rate', numeric: true, sortable: true, title: 'Completed ÷ (completed + failed)' },
  { key: 'avg_duration_seconds', label: 'Avg Duration', numeric: true, sortable: true, narrowHide: true, title: 'Average of completed executions' },
  { key: 'last_at', label: 'Last Execution', sortable: true, title: 'Most recent start in the range' },
];

/** Rows sorted by key/dir; missing values always last; ties by total, then name. */
export function sortAutomations(rows, key = 'total', dir = 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  return [...(rows || [])].sort((a, b) => {
    const av = a[key]; const bv = b[key];
    const an = av == null; const bn = bv == null;
    if (an !== bn) return an ? 1 : -1;
    if (!an && av !== bv) return (av < bv ? -1 : 1) * sign;
    if (a.total !== b.total) return b.total - a.total;
    return String(a.automation).localeCompare(String(b.automation));
  });
}

function AutomationSummary({ section, rangeText, period, win, onGo, go }) {
  const [sort, setSort] = usePersistentState('dashboard.automationSort', { key: 'total', dir: 'desc' });
  const [showAll, setShowAll] = React.useState(false);
  const data = section.data;
  const rows = React.useMemo(() => sortAutomations(data?.automations, sort.key, sort.dir), [data, sort.key, sort.dir]);
  const shown = showAll ? rows : rows.slice(0, AUTOMATION_TOP);
  const oldApi = section.error && /view must be/i.test(section.error);

  const toggle = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  // Each row says which Executions filter matches it (name= or automation=);
  // counter-based rows (no filter field) are document labels.
  const linkFor = (r, extra = {}) => executionsLink(period, win, { ...(r.filter || { automation: r.automation }), ...extra });
  const rowKey = (r) => JSON.stringify(r.filter || { automation: r.automation });

  let body;
  if (oldApi || data?.available === false) {
    body = (
      <div className="rs-help" style={{ padding: '16px 20px' }} role="status">
        The automation summary isn’t available on this environment yet.{' '}
        {oldApi ? 'The RunStack API needs the update that adds per-automation figures.'
          : 'Per-automation counters are still being set up (a one-time job_stats backfill run by an administrator).'}
      </div>
    );
  } else if (section.error && !data) {
    body = <LoadError section={section} what="the automation summary" />;
  } else if (!data) {
    body = <div className="rs-dash-placeholder" style={{ height: 120 }}><Spinner /></div>;
  } else if (!rows.length) {
    body = <div className="rs-help" style={{ padding: '18px 20px' }}>No executions started in {rangeText}.</div>;
  } else {
    body = (
      <>
        <div className="rs-dash-table-wrap">
          <table className="rs-dash-table rs-dash-table--auto">
            <thead>
              <tr>
                {AUTO_COLUMNS.map((c) => {
                  const active = sort.key === c.key;
                  const cls = [c.numeric && 'is-num', c.narrowHide && 'rs-hide-narrow'].filter(Boolean).join(' ') || undefined;
                  return (
                    <th key={c.key} scope="col" className={cls} title={c.title}
                      aria-sort={c.sortable ? (active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}>
                      {c.sortable ? (
                        <button type="button" className={`rs-sort${active ? ' is-active' : ''}`} onClick={() => toggle(c.key)}>
                          {c.label}<span className="rs-sort-arrow" aria-hidden>{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                        </button>
                      ) : c.label}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const to = linkFor(r);
                const failedTo = linkFor(r, { status: 'FAILED' });
                const docs = (r.documents || []).filter((d) => d !== r.automation);
                return (
                  <tr key={rowKey(r)} onClick={() => go(to)}>
                    <td>
                      <Link to={to} className="rs-dash-job" title={`Open ${r.automation} executions`}
                        onClick={(e) => { e.stopPropagation(); onGo(e, to); }}>{r.automation}</Link>
                      {docs.length > 0 && <span className="rs-dash-target"> · {docs.join(', ')}</span>}
                    </td>
                    <td className="is-num">{num(r.total)}</td>
                    <td className="is-num rs-hide-narrow">{num(r.COMPLETED)}</td>
                    <td className="is-num">
                      {r.FAILED > 0 ? (
                        <Link to={failedTo} className="rs-dash-failed" title={`Open failed ${r.automation} executions`}
                          onClick={(e) => { e.stopPropagation(); onGo(e, failedTo); }}>{num(r.FAILED)}</Link>
                      ) : <span className="rs-dash-muted">0</span>}
                    </td>
                    <td className="is-num">{r.success_rate == null ? <span className="rs-dash-muted" title="Nothing finished yet">—</span> : `${r.success_rate.toLocaleString('en-GB')}%`}</td>
                    <td className="is-num rs-hide-narrow"
                      title={r.avg_duration_sample ? `Average of ${plural(r.avg_duration_sample, 'completed execution')}` : 'No completed executions'}>
                      {r.avg_duration_seconds == null ? <span className="rs-dash-muted">—</span> : fmtSeconds(r.avg_duration_seconds)}
                    </td>
                    <td title={fmtFull(r.last_at)} style={{ whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{fmtRelative(r.last_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data.complete === false && (
          <div className="rs-dash-note">Partial: RunStack read only part of the jobs table for these figures (scan limit reached).</div>
        )}
        {rows.length > AUTOMATION_TOP && (
          <div className="rs-dash-foot">
            <button type="button" className="rs-text-link rs-link-btn" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? `Show top ${AUTOMATION_TOP}` : `View all ${num(rows.length)} automations`}
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <Card>
      <CardHead style={{ padding: '14px 20px' }}>
        <SectionHeader title="Automation Summary" helper={`Usage and performance by automation · ${rangeText}`}
          right={data?.available && rows.length ? <span className="rs-dash-stamp">{plural(rows.length, 'automation')}</span> : null} />
      </CardHead>
      {body}
    </Card>
  );
}

export default function Dashboard() {
  const go = useAppNavigate();
  const { role, groups } = useAuth();
  const canSeeDlq = canAccess({ role, groups }, { minRole: 'operator' });
  const [periodValue, setPeriod] = usePersistentState('dashboard.period', '24h');
  const [custom, setCustom] = usePersistentState('dashboard.customRange', null);
  const customOk = !!custom && !customRangeError(custom.from_day, custom.to_day);
  const period = PERIODS.find((p) => p.value === periodValue && (p.value !== 'custom' || customOk)) || PERIODS[0];
  const isCustom = period.value === 'custom';
  const dlq = useDlq();

  const rangeValue = isCustom ? { range: 'custom', from_day: custom.from_day, to_day: custom.to_day } : { range: period.value };
  const onRangeChange = (next) => {
    if (next.range === 'custom') setCustom({ from_day: next.from_day, to_day: next.to_day });
    setPeriod(next.range);
  };

  const win = isCustom ? { from_day: custom.from_day, to_day: custom.to_day } : period.value;
  const winKey = JSON.stringify(win);
  const rangeLabel = isCustom ? customLabel(custom.from_day, custom.to_day) : period.label;
  const rangeText = isCustom ? `${rangeLabel} (UTC)` : period.label;
  const rangeIn = isCustom ? `${rangeLabel} (UTC)` : period.short;

  const summary = useLiveSection(() => fetchJobsSummary(win).then((d) => ({ ...d, _key: winKey })), [winKey], { intervalMs: period.pollMs });
  const s = summary.data && summary.data._key === winKey ? summary.data : null;
  const windowFrom = s?.from || null;
  const windowTo = isCustom ? (s?.to || null) : null;
  const winBounds = { from: windowFrom, to: s?.to || null, ...(isCustom ? { from_day: custom.from_day, to_day: custom.to_day } : {}) };

  const forceAuto = React.useRef(false);
  const autos = useLiveSection(() => {
    const refresh = forceAuto.current;
    forceAuto.current = false;
    return fetchAutomationSummary(win, { refresh }).then((d) => ({ ...d, _key: winKey }));
  }, [winKey], { intervalMs: Math.max(60000, period.pollMs) });
  const autoSection = { ...autos, data: autos.data && autos.data._key === winKey ? autos.data : null };

  const recent = useLiveSection(
    () => queryJobs({ from: windowFrom, to: windowTo, limit: RECENT_LIMIT, sort: 'started_desc', include_counts: 'false' }),
    [windowFrom, windowTo], { intervalMs: period.pollMs, enabled: !!windowFrom },
  );

  const refreshAll = () => { forceAuto.current = true; return Promise.all([summary.refresh(), autos.refresh(), recent.refresh()]); };
  usePageRefresh(refreshAll);

  // Plain clicks go through the shell (loading bar, query handling); modified
  // clicks keep open-in-new-tab.
  const onGo = (e, to) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(to);
  };
  const link = (extra) => executionsLink(period.value, winBounds, extra);

  const t = s?.totals || {};
  const active = s?.active_now || {};
  const allTime = s && s.complete !== false && s.all_time && typeof s.all_time.ALL === 'number' ? s.all_time.ALL : null;
  const finished = (t.COMPLETED || 0) + (t.FAILED || 0);
  const since = s && !isCustom
    ? (period.value === 'all'
      ? (parseUtc(s.from) ? fmtUtcMonth(parseUtc(s.from)) : null)
      : (parseUtc(s.from) ? fmtLocal(parseUtc(s.from)) : null))
    : null;
  const refreshing = summary.refreshing || recent.refreshing || autos.refreshing;
  const stamps = [summary.updatedAt, recent.updatedAt].filter(Boolean);
  const updated = stamps.length ? new Date(Math.min(...stamps.map((d) => d.getTime()))) : null;

  const chartData = (s?.buckets || []).map((b) => ({
    ...bucketLabels(b, s.bucket), Completed: b.COMPLETED, Running: b.RUNNING, Pending: b.PENDING, Failed: b.FAILED,
  }));
  const chartEmpty = s && !t.ALL;

  const attention = [];
  if (s && t.FAILED > 0) {
    attention.push({ key: 'failed', tone: 'danger', title: `${plural(t.FAILED, 'failed execution')}`, detail: `Started in ${rangeIn} · includes timed out and cancelled`, to: link({ status: 'FAILED' }) });
  }
  if (s && active.PENDING > 0) {
    attention.push({ key: 'pending', tone: 'warning', title: `${plural(active.PENDING, 'execution')} waiting to start`, detail: 'Pending now · any start date', to: '/jobs?status=PENDING&range=all' });
  }
  const longRun = s?.long_running;
  if (longRun && longRun.RUNNING > 0) {
    const before = parseUtc(longRun.started_before);
    const to = before ? `/jobs?status=RUNNING&range=custom&to=${encodeURIComponent(localInput(before))}` : '/jobs?status=RUNNING&range=all';
    attention.push({
      key: 'long', tone: 'warning', title: `${plural(longRun.RUNNING, 'execution')} running for over an hour`,
      detail: `Still running · started before ${before ? fmtLocal(before, { day: before.toDateString() !== new Date().toDateString() }) : 'the previous hour'}`, to,
    });
  }
  if (canSeeDlq && dlq && dlq.visible > 0) {
    attention.push({ key: 'dlq', tone: 'danger', title: `${plural(dlq.visible, 'message')} in the dead letter queue`, detail: `As of ${fmtClock(dlq.checkedAt)}, when the queue was last opened`, to: '/dlq' });
  }


  return (
    <Page title="Dashboard"
      subtitle={`All RunStack executions · ${rangeText}${since ? ` (since ${since})` : ''}`}
      actions={(
        <>
          <DateRangeSelect value={rangeValue} onChange={onRangeChange} presets={PERIODS} label="Dashboard time range" defaultRange="24h" />
          <span className="rs-dash-stamp" aria-live="polite">
            {summary.error || recent.error ? <span style={{ color: '#B91C1C' }}>Couldn’t refresh{updated ? ` — showing ${fmtClock(updated)}` : ''}</span>
              : updated ? `Updated ${fmtClock(updated)}` : 'Loading…'}
          </span>
          <Btn variant="default" size="sm" onClick={refreshAll} disabled={refreshing}>{refreshing ? <Spinner size={13} /> : '↻'} Refresh</Btn>
          <Btn variant="primary" size="sm" onClick={() => go('/automations')}>Run automation</Btn>
        </>
      )}>

      {/* ── KPI summary ── */}
      <Card>
        {summary.error && !s ? <LoadError section={summary} what="execution counts" /> : (
          <div className="rs-stats" aria-busy={!s} aria-label={`Execution counts, ${rangeText}`} role="group">
            <Stat label="Total Executions" value={s ? num(t.ALL) : '—'} sub={s ? rangeText : 'Loading…'}
              sub2={s && allTime != null && period.value !== 'all' ? `${num(allTime)} all-time` : null}
              to={s ? link({}) : null} onGo={onGo} title="Open these executions" />
            <Stat label="Completed" value={s ? num(t.COMPLETED) : '—'}
              sub={s ? (t.ALL ? `${pct(t.COMPLETED, t.ALL)} of executions` : 'No executions') : ''}
              to={s ? link({ status: 'COMPLETED' }) : null} onGo={onGo} title="Open completed executions" />
            <Stat label="Failed" value={s ? num(t.FAILED) : '—'} tone={t.FAILED > 0 ? 'danger' : null}
              sub={s ? (t.ALL ? `${pct(t.FAILED, t.ALL)} of executions` : 'No executions') : ''}
              sub2={s ? 'Incl. timed out, cancelled' : null}
              to={s ? link({ status: 'FAILED' }) : null} onGo={onGo} title="Open failed executions" />
            <Stat label="Success Rate" value={s ? (s.success_rate == null ? '—' : `${s.success_rate}%`) : '—'}
              sub={s ? (finished ? `${num(t.COMPLETED)} of ${num(finished)} finished` : 'Nothing finished yet') : ''} />
            <Stat label="Running Now" value={s ? num(active.RUNNING) : '—'} sub={s ? 'Live · any start date' : ''}
              to={s ? '/jobs?status=RUNNING&range=all' : null} onGo={onGo} title="Open running executions" />
          </div>
        )}
        {s && s.complete === false && (
          <div className="rs-dash-note">Partial: the job counters are not set up yet, so these numbers cover only the jobs RunStack could scan.</div>
        )}
      </Card>

      <div className="rs-dash-grid">
        {/* ── Trend chart ── */}
        <Card>
          <CardHead style={{ padding: '14px 20px' }}>
            <SectionHeader title="Execution trend" helper={s ? `Executions ${bucketText(s.bucket)}, by start time and current status` : 'Executions by start time and current status'} />
          </CardHead>
          <div style={{ padding: '14px 16px 8px' }}>
            {summary.error && !s ? <LoadError section={summary} what="the execution trend" />
              : !s ? <div className="rs-dash-placeholder"><Spinner /></div>
                : chartEmpty ? <div className="rs-dash-placeholder rs-help">No executions started in {rangeIn}.</div>
                  : (
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={chartData} barCategoryGap={2} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                        accessibilityLayer title={`Execution trend, ${rangeText}`}>
                        <CartesianGrid vertical={false} stroke={COLOR.grid} strokeDasharray="3 3" />
                        <XAxis dataKey="label" tick={{ fontSize: 12, fill: COLOR.axis }} interval={Math.max(0, Math.ceil(chartData.length / 8) - 1)}
                          axisLine={{ stroke: COLOR.grid }} tickLine={false} />
                        <YAxis tick={{ fontSize: 12, fill: COLOR.axis }} axisLine={false} tickLine={false} allowDecimals={false} width={36} />
                        <Tooltip cursor={{ fill: 'rgba(32,41,56,0.05)' }} contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: COLOR.grid }}
                          labelFormatter={(l, payload) => payload?.[0]?.payload?.full || l} />
                        <Legend iconType="square" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 6 }} />
                        <Bar dataKey="Completed" stackId="s" fill={COLOR.Completed} isAnimationActive={false} />
                        <Bar dataKey="Running" stackId="s" fill={COLOR.Running} isAnimationActive={false} />
                        <Bar dataKey="Pending" stackId="s" fill={COLOR.Pending} isAnimationActive={false} />
                        <Bar dataKey="Failed" stackId="s" fill={COLOR.Failed} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
          </div>
        </Card>

        {/* ── Needs attention ── */}
        <Card>
          <CardHead style={{ padding: '14px 20px' }}>
            <SectionHeader title="Needs attention" />
          </CardHead>
          <div style={{ padding: '10px 12px 12px', display: 'grid', gap: 8 }}>
            {!s ? (summary.error ? <LoadError section={summary} what="this panel" /> : <div className="rs-dash-placeholder" style={{ height: 80 }}><Spinner /></div>)
              : attention.length ? (
                <ul className="rs-attn-list">
                  {attention.map(({ key, ...a }) => <AttentionItem key={key} {...a} onGo={onGo} />)}
                </ul>
              ) : (
                <div className="rs-attn-clear" role="status">
                  <span className="rs-attn-check" aria-hidden>✓</span>
                  <span><strong>Nothing needs attention.</strong><br />No failures in {rangeIn}, nothing waiting to start and nothing running for over an hour.</span>
                </div>
              )}
            {canSeeDlq && !dlq && (
              <div className="rs-help" style={{ padding: '0 8px' }}>
                Dead letter queue: <Link to="/dlq" onClick={(e) => onGo(e, '/dlq')} className="rs-text-link">open to check for failed messages</Link>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* ── Automation Summary ── */}
      <AutomationSummary section={autoSection} rangeText={rangeText} period={period.value} win={winBounds} onGo={onGo} go={go} />

      {/* ── Recent executions ── */}
      <Card>
        <CardHead style={{ padding: '14px 20px' }}>
          <SectionHeader title="Recent executions" helper={`The ${RECENT_LIMIT} most recently started · ${rangeText}`}
            right={<Link to={link({})} className="rs-text-link" onClick={(e) => onGo(e, link({}))}>View all{s ? ` ${num(t.ALL)}` : ''} →</Link>} />
        </CardHead>
        {recent.error && !recent.data ? <LoadError section={recent} what="recent executions" />
          : !recent.data ? <div className="rs-dash-placeholder" style={{ height: 120 }}><Spinner /></div>
            : !recent.data.jobs?.length ? <div className="rs-help" style={{ padding: '18px 20px' }}>No executions started in {rangeIn}.</div>
              : (
                <div className="rs-dash-table-wrap">
                  <table className="rs-dash-table">
                    <thead>
                      <tr>
                        <th scope="col">Automation</th>
                        <th scope="col">Status</th>
                        <th scope="col" className="rs-hide-narrow">Account / Region</th>
                        <th scope="col">Started</th>
                        <th scope="col" className="is-num">Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.data.jobs.map((j) => {
                        const to = `/jobs/${encodeURIComponent(j.job_id)}`;
                        const dur = jobDuration(j);
                        return (
                          <tr key={j.job_id} onClick={() => go(to)}>
                            <td>
                              <Link to={to} onClick={(e) => { e.stopPropagation(); onGo(e, to); }} className="rs-dash-job" title={j.automation_label || j.document_name}>
                                {jobTitle(j)}
                              </Link>
                              {(j.server_name || j.resource_id) && <span className="rs-dash-target"> · {j.server_name || j.resource_id}</span>}
                            </td>
                            <td><StatusBadge status={j.status} /></td>
                            <td className="rs-hide-narrow"><span className="rs-mono">{j.account_id || '—'}</span>{j.region ? <span className="rs-dash-target"> · {j.region}</span> : null}</td>
                            <td title={fmtFull(j.created_at)} style={{ whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{fmtRelative(j.created_at)}</td>
                            <td className="is-num" style={{ whiteSpace: 'nowrap' }} title={dur.live ? 'Still running — time so far' : undefined}>
                              {dur.text}{dur.live && dur.text !== '—' ? <span className="rs-dash-muted"> so far</span> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
      </Card>
    </Page>
  );
}
