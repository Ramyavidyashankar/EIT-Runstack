// src/pages/Dashboard.jsx
//
// One period (Last 24 hours / 7 days / 30 days) drives everything on the
// page, so the numbers always agree with each other and with the drill-downs:
//
//   Summary counts + trend chart   GET /jobs/query?view=summary&range=<r>
//                                  (job_stats counters — one request for both)
//   Recent executions              GET /jobs/query?from=<summary.from>&limit=8
//                                  (same window start as the counts)
//   Needs attention                failures in the period, executions waiting
//                                  to start, and the dead letter queue count
//                                  last seen on its page (see utils/dlqStatus.js)
//
// Scope: these endpoints count every RunStack execution, not only the
// signed-in user's — the same data the Executions page shows. "Running now"
// is a live count of every execution still running, whatever day it started,
// and is labelled as such.
//
// Every count links to the Executions page with the same period and status,
// where search, filters, paging and per-server output live.

import React from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Page } from '../components/PageLayout';
import { Card, CardHead, StatusBadge, Spinner, Btn } from '../components/ui';
import { SectionHeader, fmtClock } from '../components/sections';
import { fetchJobsSummary, queryJobs } from '../api/client';
import { fmtRelative } from '../utils/helpers';
import { fmtFull, fmtSeconds, parseUtc } from '../utils/jobs';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { useLiveSection } from '../hooks/useLiveSection';
import { usePersistentState } from '../hooks/useNavigation';
import { useAuth } from '../auth/AuthContext';
import { canAccess } from '../auth/access';
import { useAppNavigate } from '../components/nav/navigationContext';
import { getDlqStatus, subscribeDlqStatus } from '../utils/dlqStatus';

const RECENT_LIMIT = 8;

// Periods both the counters (jobs_list.RANGES) and the Executions page
// (utils/jobs.DATE_PRESETS) support, so a drill-down shows the same window.
const PERIODS = [
  { value: '24h', label: 'Last 24 hours', short: 'last 24 hours', pollMs: 15000 },
  { value: '7d', label: 'Last 7 days', short: 'last 7 days', pollMs: 60000 },
  { value: '30d', label: 'Last 30 days', short: 'last 30 days', pollMs: 60000 },
];

// Status colours (mirror index.css tokens; SVG props can't read CSS vars).
const COLOR = { Completed: '#0F9D6D', Running: '#2563EB', Pending: '#B45309', Failed: '#DC2626', grid: '#D7E0EB', axis: '#52647A' };

const num = (v) => (typeof v === 'number' ? v.toLocaleString('en-GB') : '—');
const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

function localInput(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Executions page URL for the dashboard's period. 24h and 7d are the same
 * hour-aligned windows on both pages. The counters' 30-day window starts at
 * UTC midnight 29 days ago, while the Executions page's "Last 30 days" starts
 * 720 hours back — so 30d links pass the exact start as a custom range.
 */
export function executionsLink(period, summaryFrom, extra = {}) {
  const q = new URLSearchParams();
  if (period === '30d' && summaryFrom) {
    const from = parseUtc(summaryFrom);
    q.set('range', 'custom');
    if (from) q.set('from', localInput(from));
  } else {
    q.set('range', period);
  }
  Object.entries(extra).forEach(([k, v]) => { if (v) q.set(k, v); });
  if (q.get('range') === '7d') q.delete('range'); // the Executions page default
  const s = q.toString();
  return `/jobs${s ? `?${s}` : ''}`;
}

function fmtBucket(iso, bucket) {
  const d = parseUtc(iso);
  if (!d) return '';
  if (bucket === 'day') return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return bucket === '1h' ? time : `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${time}`;
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
function Stat({ label, value, sub, to, tone, onGo, title }) {
  const body = (
    <>
      <span className="rs-stat-label">{label}</span>
      <span className={`rs-stat-value${tone ? ` rs-stat-value--${tone}` : ''}`}>{value}</span>
      {sub && <span className="rs-stat-sub">{sub}</span>}
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

export default function Dashboard() {
  const go = useAppNavigate();
  const { role, groups } = useAuth();
  const canSeeDlq = canAccess({ role, groups }, { minRole: 'operator' });
  const [periodValue, setPeriod] = usePersistentState('dashboard.period', '24h');
  const period = PERIODS.find((p) => p.value === periodValue) || PERIODS[0];
  const dlq = useDlq();

  const summary = useLiveSection(() => fetchJobsSummary(period.value), [period.value], { intervalMs: period.pollMs });
  const s = summary.data && summary.data.range === period.value ? summary.data : null;
  const windowFrom = s?.from || null;
  const recent = useLiveSection(
    () => queryJobs({ from: windowFrom, limit: RECENT_LIMIT, sort: 'started_desc', include_counts: 'false' }),
    [windowFrom], { intervalMs: period.pollMs, enabled: !!windowFrom },
  );

  const refreshAll = () => Promise.all([summary.refresh(), recent.refresh()]);
  usePageRefresh(refreshAll);

  // Plain clicks go through the shell (loading bar, query handling); modified
  // clicks keep open-in-new-tab.
  const onGo = (e, to) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(to);
  };
  const link = (extra) => executionsLink(period.value, windowFrom, extra);

  const t = s?.totals || {};
  const active = s?.active_now || {};
  const finished = (t.COMPLETED || 0) + (t.FAILED || 0);
  const since = s ? parseUtc(s.from)?.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const refreshing = summary.refreshing || recent.refreshing;
  const stamps = [summary.updatedAt, recent.updatedAt].filter(Boolean);
  const updated = stamps.length ? new Date(Math.min(...stamps.map((d) => d.getTime()))) : null;

  const chartData = (s?.buckets || []).map((b) => ({
    label: fmtBucket(b.start, s.bucket), Completed: b.COMPLETED, Running: b.RUNNING, Pending: b.PENDING, Failed: b.FAILED,
  }));
  const chartEmpty = s && !t.ALL;
  const bucketText = s ? (s.bucket === 'day' ? 'per day (UTC)' : `per ${s.bucket === '1h' ? 'hour' : s.bucket.replace('h', ' hours')} (your local time)`) : '';

  const attention = [];
  if (s && t.FAILED > 0) {
    attention.push({ key: 'failed', tone: 'danger', title: `${plural(t.FAILED, 'failed execution')}`, detail: `Started in the ${period.short} · includes timed out and cancelled`, to: link({ status: 'FAILED' }) });
  }
  if (s && active.PENDING > 0) {
    attention.push({ key: 'pending', tone: 'warning', title: `${plural(active.PENDING, 'execution')} waiting to start`, detail: 'Pending now · any start date', to: '/jobs?status=PENDING&range=all' });
  }
  if (canSeeDlq && dlq && dlq.visible > 0) {
    attention.push({ key: 'dlq', tone: 'danger', title: `${plural(dlq.visible, 'message')} in the dead letter queue`, detail: `As of ${fmtClock(dlq.checkedAt)}, when the queue was last opened`, to: '/dlq' });
  }

  return (
    <Page title="Dashboard"
      subtitle={`All RunStack executions · ${period.label.toLowerCase()}${since ? ` (since ${since})` : ''}`}
      actions={(
        <>
          <label className="rs-visually-hidden" htmlFor="rs-dash-period">Period</label>
          <select id="rs-dash-period" className="rs-select" value={period.value} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <span className="rs-dash-stamp" aria-live="polite">
            {summary.error || recent.error ? <span style={{ color: '#B91C1C' }}>Couldn’t refresh{updated ? ` — showing ${fmtClock(updated)}` : ''}</span>
              : updated ? `Updated ${fmtClock(updated)}` : 'Loading…'}
          </span>
          <Btn variant="default" size="sm" onClick={refreshAll} disabled={refreshing}>{refreshing ? <Spinner size={13} /> : '↻'} Refresh</Btn>
          <Btn variant="primary" size="sm" onClick={() => go('/automations')}>Run automation</Btn>
        </>
      )}>

      {/* ── Summary counts ── */}
      <Card>
        {summary.error && !s ? <LoadError section={summary} what="execution counts" /> : (
          <div className="rs-stats" aria-busy={!s} aria-label={`Execution counts, ${period.label.toLowerCase()}`} role="group">
            <Stat label="Executions" value={s ? num(t.ALL) : '—'} sub={s ? `Started in the ${period.short}` : 'Loading…'}
              to={s ? link({}) : null} onGo={onGo} title="Open these executions" />
            <Stat label="Completed" value={s ? num(t.COMPLETED) : '—'}
              sub={s?.avg_duration_seconds != null ? `Average ${fmtSeconds(s.avg_duration_seconds)}` : s ? 'No duration recorded' : ''}
              to={s ? link({ status: 'COMPLETED' }) : null} onGo={onGo} title="Open completed executions" />
            <Stat label="Failed" value={s ? num(t.FAILED) : '—'} tone={t.FAILED > 0 ? 'danger' : null} sub={s ? 'Incl. timed out, cancelled' : ''}
              to={s ? link({ status: 'FAILED' }) : null} onGo={onGo} title="Open failed executions" />
            <Stat label="Success rate" value={s ? (s.success_rate == null ? '—' : `${s.success_rate}%`) : '—'}
              sub={s ? (finished ? `${num(t.COMPLETED)} of ${num(finished)} finished` : 'Nothing finished yet') : ''} />
            <Stat label="Running now" value={s ? num(active.RUNNING) : '—'} sub={s ? 'Live · any start date' : ''}
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
            <SectionHeader title="Execution trend" helper={s ? `Executions ${bucketText}, by start time and current status` : 'Executions by start time and current status'} />
          </CardHead>
          <div style={{ padding: '14px 16px 8px' }}>
            {summary.error && !s ? <LoadError section={summary} what="the execution trend" />
              : !s ? <div className="rs-dash-placeholder"><Spinner /></div>
                : chartEmpty ? <div className="rs-dash-placeholder rs-help">No executions started in the {period.short}.</div>
                  : (
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={chartData} barCategoryGap={2} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                        accessibilityLayer title={`Execution trend, ${period.label.toLowerCase()}`}>
                        <CartesianGrid vertical={false} stroke={COLOR.grid} strokeDasharray="3 3" />
                        <XAxis dataKey="label" tick={{ fontSize: 12, fill: COLOR.axis }} interval={Math.max(0, Math.ceil(chartData.length / 8) - 1)}
                          axisLine={{ stroke: COLOR.grid }} tickLine={false} />
                        <YAxis tick={{ fontSize: 12, fill: COLOR.axis }} axisLine={false} tickLine={false} allowDecimals={false} width={30} />
                        <Tooltip cursor={{ fill: 'rgba(32,41,56,0.05)' }} contentStyle={{ fontSize: 12, borderRadius: 6, borderColor: COLOR.grid }} />
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
                  <span><strong>Nothing needs attention.</strong><br />No failures in the {period.short} and nothing waiting to start.</span>
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

      {/* ── Recent executions ── */}
      <Card>
        <CardHead style={{ padding: '14px 20px' }}>
          <SectionHeader title="Recent executions" helper={`The ${RECENT_LIMIT} most recently started in the ${period.short}`}
            right={<Link to={link({})} className="rs-text-link" onClick={(e) => onGo(e, link({}))}>View all{s ? ` ${num(t.ALL)}` : ''} →</Link>} />
        </CardHead>
        {recent.error && !recent.data ? <LoadError section={recent} what="recent executions" />
          : !recent.data ? <div className="rs-dash-placeholder" style={{ height: 120 }}><Spinner /></div>
            : !recent.data.jobs?.length ? <div className="rs-help" style={{ padding: '18px 20px' }}>No executions started in the {period.short}.</div>
              : (
                <div className="rs-dash-table-wrap">
                  <table className="rs-dash-table">
                    <thead>
                      <tr>
                        <th scope="col">Automation</th>
                        <th scope="col">Status</th>
                        <th scope="col" className="rs-hide-narrow">Account / Region</th>
                        <th scope="col">Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recent.data.jobs.map((j) => {
                        const to = `/jobs/${encodeURIComponent(j.job_id)}`;
                        return (
                          <tr key={j.job_id} onClick={() => go(to)}>
                            <td>
                              <Link to={to} onClick={(e) => { e.stopPropagation(); onGo(e, to); }} className="rs-dash-job" title={j.document_name}>
                                {j.automation_label || j.document_name || '—'}
                              </Link>
                              {(j.server_name || j.resource_id) && <span className="rs-dash-target"> · {j.server_name || j.resource_id}</span>}
                            </td>
                            <td><StatusBadge status={j.status} /></td>
                            <td className="rs-hide-narrow"><span className="rs-mono">{j.account_id || '—'}</span>{j.region ? <span className="rs-dash-target"> · {j.region}</span> : null}</td>
                            <td title={fmtFull(j.created_at)} style={{ whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>{fmtRelative(j.created_at)}</td>
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
