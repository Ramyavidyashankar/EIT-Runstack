// src/pages/Dashboard.jsx
//
// Three sections load and refresh independently, so one slow request never
// holds up the page:
//   1. Summary cards  — GET /jobs/query?view=summary&range=24h
//   2. Activity chart — GET /jobs/query?view=summary&range=<chart range>
//   3. Recent executions — GET /jobs/query?view=recent&limit=10
// Counts come from the job counters kept by the job_stats Lambda (exact, no
// table scan). Each section keeps its last good data while it refreshes and
// shows when it was last updated. Full history lives on Automation Executions.
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { Topbar } from '../components/Layout';
import { Card, CardHead, StatusBadge, TypeTag, Spinner, Btn, Empty } from '../components/ui';
import { fetchJobsSummary, fetchRecentExecutions } from '../api/client';
import { fmtRelative } from '../utils/helpers';
import { fmtFull, fmtSeconds, parseUtc } from '../utils/jobs';
import { fmtClock } from '../components/sections';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { useLiveSection } from '../hooks/useLiveSection';

// ─── Constants ────────────────────────────────────────────────────────────────
const POLL_MS = 15000;
const RECENT_LIMIT = 10;

// DXC brand tokens (mirrors src/index.css — inline styles can't read CSS vars
// for SVG fill/stroke props, so the hexes are restated here on purpose).
const C = {
  midnight: '#0A0F1C',
  canvas:   '#F1F5F9',
  orange:   '#0F766E',   // now the single accent — see index.css --brand
  blue:     '#0F766E',
  royal:    '#0B5C56',
  gold:     '#B45309',
  green:    '#0F9D6D',
  red:      '#DC2626',
  ink:      '#0F172A',
  textSec:  '#334155',
  textTer:  '#64748B',
  border:   '#E2E8F0',
  surface:  '#FFFFFF',
  tint:     '#F8FAFC',
};

const STATUS_COLOR = {
  Completed: C.green,
  Running:   C.blue,
  Pending:   C.gold,
  Failed:    C.red,
};

// Chart ranges — must match RANGES in process_messages/jobs_list.py. Hour
// buckets are UTC hours shown in local time; 30-day buckets are UTC days.
const RANGE_PRESETS = [
  { value: '24h', label: 'Last 24 hours', pollMs: POLL_MS },
  { value: '3d',  label: 'Last 3 days',   pollMs: 60000 },
  { value: '7d',  label: 'Last 7 days',   pollMs: 60000 },
  { value: '30d', label: 'Last 30 days',  pollMs: 60000 },
];

function fmtBucketLabel(iso, bucket) {
  const d = parseUtc(iso);
  if (!d) return '';
  if (bucket === 'day') return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return bucket === '1h' ? time : `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${time}`;
}

const num = (v) => (typeof v === 'number' ? v.toLocaleString('en-GB') : '—');

// ─── Small stroke icons — match Layout.jsx's icon language, no emoji ──────────
function Icon({ size = 16, color = 'currentColor', children }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
const IconList   = (p) => <Icon {...p}><path d="M2 4h12M2 8h9M2 12h11" /></Icon>;
const IconCheck  = (p) => <Icon {...p}><path d="M3 8.5l3.2 3.2L13 4.5" /></Icon>;
const IconAlert  = (p) => <Icon {...p}><path d="M8 1.5L14.5 13.5H1.5L8 1.5z" /><path d="M8 6v3.5" /><circle cx="8" cy="11.5" r="0.5" fill={p.color} /></Icon>;
const IconBolt   = (p) => <Icon {...p}><path d="M8.5 1.5L3 9h4l-.5 5.5L13 7H9l-0.5-5.5z" /></Icon>;
const IconPlay   = (p) => <Icon {...p}><path fill={p.color} stroke="none" d="M3.5 2.5l10 5.5-10 5.5z" /></Icon>;
const IconClock  = (p) => <Icon {...p}><circle cx="8" cy="8" r="6" /><path d="M8 5v3.5l2.5 1.5" /></Icon>;

// ─── Metric card — stat with top accent; optional click-through ───────────────
function MetricCard({ label, value, sub, accent, icon, onClick, title }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick} title={title} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{
        background: C.surface, border: `1px solid ${onClick && hov ? accent : C.border}`,
        borderTop: `3px solid ${accent}`, borderRadius: 'var(--radius-lg)',
        padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 4,
        boxShadow: '0 1px 2px rgba(15,23,42,0.05)', cursor: onClick ? 'pointer' : 'default', transition: 'border-color 0.15s',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.7 }}>
          {label}
        </span>
        <span style={{
          width: 26, height: 26, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${accent}18`,
        }}>
          {icon(16, accent)}
        </span>
      </div>
      <div style={{ fontSize: 30, fontWeight: 700, color: C.ink, lineHeight: 1, letterSpacing: '-0.4px', fontFamily: 'var(--font-mono)' }}>
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: C.textTer, marginTop: 2 }}>{sub}</div>
    </div>
  );
}

// ─── Per-section status: "Updated 14:20:05", spinner, or refresh error ────────
function SectionStamp({ section, label = 'Updated' }) {
  const { refreshing, error, updatedAt, data } = section;
  return (
    <span aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: error ? '#B91C1C' : C.textTer, whiteSpace: 'nowrap' }}>
      {refreshing && <Spinner size={10} />}
      {error
        ? (data ? `Couldn't refresh — showing ${fmtClock(updatedAt)}` : "Couldn't load")
        : updatedAt ? `${label} ${fmtClock(updatedAt)}` : 'Loading…'}
      {error && (
        <button type="button" onClick={section.refresh} style={{ background: 'none', border: 'none', padding: 0, color: C.orange, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', fontSize: 10.5 }}>
          Retry
        </button>
      )}
    </span>
  );
}

function SectionError({ section, what }) {
  return (
    <div role="alert" style={{ padding: '18px 16px', fontSize: 12.5, color: '#9A1E1E', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      Couldn't load {what}: {section.error}
      <Btn variant="default" size="sm" onClick={section.refresh}>Try again</Btn>
    </div>
  );
}

function PartialNote({ data }) {
  if (!data || data.complete !== false) return null;
  return (
    <div style={{ fontSize: 10.5, color: '#92400E', marginTop: 6 }}>
      Partial: the job counters are not set up yet, so these numbers cover only the jobs RunStack could scan.
    </div>
  );
}

// ─── Quick Action Card ────────────────────────────────────────────────────────
function ActionCard({ label, sub, icon, color, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 14px', borderRadius: 'var(--radius-md)',
        border: `1px solid ${hov ? color : C.border}`,
        background: hov ? `${color}0C` : C.surface,
        cursor: 'pointer', transition: 'all 0.15s',
      }}
    >
      <div style={{
        width: 32, height: 32, borderRadius: 7, flexShrink: 0,
        background: `${color}16`, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {icon(15, color)}
      </div>
      <div>
        <div style={{ fontWeight: 600, fontSize: 12.5, color: C.ink }}>{label}</div>
        <div style={{ fontSize: 10.5, color: C.textTer, marginTop: 1 }}>{sub}</div>
      </div>
      <div style={{ marginLeft: 'auto', color: hov ? color : '#CBD5E1', fontSize: 15 }}>→</div>
    </div>
  );
}

// ─── Custom chart tooltip — DXC-styled ────────────────────────────────────────
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
      padding: '8px 10px', fontSize: 11, boxShadow: '0 4px 12px rgba(18,21,28,0.1)',
    }}>
      <div style={{ fontWeight: 700, color: C.ink, marginBottom: 4, fontFamily: 'var(--font-mono)' }}>{label}</div>
      {payload.filter(p => p.value > 0).map(p => (
        <div key={p.dataKey} style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.textSec }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: p.color, display: 'inline-block' }} />
          {p.dataKey} — <b style={{ color: C.ink }}>{p.value}</b>
        </div>
      ))}
    </div>
  );
}

// ─── Recent executions (fixed, small list) ───────────────────────────────────
const COLS = [
  { key: 'automation', label: 'Automation', width: null },
  { key: 'account', label: 'Account / Region', width: 170 },
  { key: 'status', label: 'Status', width: 120 },
  { key: 'created', label: 'Started', width: 120 },
];

function RecentRow({ job: j, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      role="button" tabIndex={0} onClick={onClick} onKeyDown={(e) => { if (e.key === 'Enter') onClick(); }}
      onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ display: 'flex', alignItems: 'center', minHeight: 54, cursor: 'pointer', borderBottom: `1px solid ${C.canvas}`, background: hov ? C.tint : 'transparent' }}
    >
      <div style={{ flex: '1 1 auto', padding: '6px 14px', minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: C.ink, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={j.document_name}>
          {j.automation_label || j.document_name || '—'}
          {(j.server_name || j.resource_id) && <span style={{ fontWeight: 400, color: C.textTer }}> · {j.server_name || j.resource_id}</span>}
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <TypeTag type={j.automation_type} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: C.textTer }}>{(j.job_id || '').slice(0, 8)}</span>
        </span>
      </div>
      <div style={{ flex: `0 0 ${COLS[1].width}px`, padding: '0 14px', minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: C.textSec }}>{j.account_id || '—'}</div>
        <div style={{ fontSize: 10, color: C.textTer, marginTop: 2 }}>{j.region}</div>
      </div>
      <div style={{ flex: `0 0 ${COLS[2].width}px`, padding: '0 14px' }}><StatusBadge status={j.status} /></div>
      <div style={{ flex: `0 0 ${COLS[3].width}px`, padding: '0 14px', color: C.textTer, fontSize: 12 }} title={fmtFull(j.created_at)}>
        {fmtRelative(j.created_at)}
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const nav = useNavigate();
  const [chartRange, setChartRange] = useState('24h');
  const chartPreset = RANGE_PRESETS.find((r) => r.value === chartRange) || RANGE_PRESETS[0];

  const summary = useLiveSection(() => fetchJobsSummary('24h'), [], { intervalMs: POLL_MS });
  const chart = useLiveSection(() => fetchJobsSummary(chartRange), [chartRange], { intervalMs: chartPreset.pollMs });
  const recent = useLiveSection(() => fetchRecentExecutions(RECENT_LIMIT), [], { intervalMs: POLL_MS });

  const refreshAll = () => Promise.all([summary.refresh(), chart.refresh(), recent.refresh()]);
  usePageRefresh(refreshAll);

  const s = summary.data;
  const t = s?.totals || {};
  const active = s?.active_now || {};
  const since = s ? new Date(s.from).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  const anyRefreshing = summary.refreshing || chart.refreshing || recent.refreshing;
  const sections = [summary, chart, recent];
  const stamps = sections.map((x) => x.updatedAt).filter(Boolean);
  const oldest = stamps.length ? new Date(Math.min(...stamps.map((d) => d.getTime()))) : null;
  const failing = sections.filter((x) => x.error).length;

  const c = chart.data;
  const chartData = (c?.buckets || []).map((b) => ({
    hour: fmtBucketLabel(b.start, c.bucket), Completed: b.COMPLETED, Running: b.RUNNING, Pending: b.PENDING, Failed: b.FAILED,
  }));
  const chartShowsOtherRange = c && c.range !== chartRange; // new range still loading

  const pct = (v) => (t.ALL ? `${Math.round((v / t.ALL) * 100)}%` : '0%');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.canvas }}>

      <Topbar
        title="Dashboard"
        subtitle="Live view of RunStack automation executions"
        actions={
          <>
            <span style={{ fontSize: 11, color: '#64748B', whiteSpace: 'nowrap' }} aria-live="polite">
              {oldest ? `Updated ${fmtClock(oldest)} · auto every ${POLL_MS / 1000}s` : 'Loading…'}
              {failing > 0 && <span style={{ color: '#B91C1C' }}> · {failing} section{failing > 1 ? 's' : ''} couldn't refresh</span>}
            </span>
            <Btn variant="default" size="sm" onClick={refreshAll} disabled={anyRefreshing}>
              {anyRefreshing ? <Spinner size={13} /> : '↻'} Refresh
            </Btn>
            <Btn variant="primary" size="sm" onClick={() => nav('/trigger')}>
              <IconPlay size={12} color="#fff" /> Run automation
            </Btn>
          </>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
       <div style={{ maxWidth: 1680, margin: '0 auto' }}>

        {/* ── Section 1: health + summary cards (last 24 hours) ── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.7 }}>
            Last 24 hours{s ? ` · since ${since}` : ''}
          </div>
          <SectionStamp section={summary} />
        </div>
        {summary.error && !s ? (
          <Card style={{ marginBottom: 16 }}><SectionError section={summary} what="summary counts" /></Card>
        ) : (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: t.FAILED > 0 ? C.red + '14' : C.green + '14',
              border: `1px solid ${t.FAILED > 0 ? C.red + '40' : C.green + '40'}`,
              borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: 12, opacity: s ? 1 : 0.6,
            }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: t.FAILED > 0 ? C.red : C.green,
                boxShadow: `0 0 0 4px ${t.FAILED > 0 ? C.red + '22' : C.green + '22'}`,
              }} />
              <span style={{ fontSize: 12.5, fontWeight: 700, color: t.FAILED > 0 ? '#9A1E1E' : '#0B6E4C' }}>
                {!s ? 'Loading…' : t.FAILED > 0 ? `${num(t.FAILED)} execution${t.FAILED > 1 ? 's' : ''} failed in the last 24 hours` : 'No failed executions in the last 24 hours'}
              </span>
              {active.RUNNING > 0 && (
                <span style={{ fontSize: 11.5, color: C.textTer }}>
                  · {num(active.RUNNING)} execution{active.RUNNING > 1 ? 's' : ''} running now
                </span>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 16 }}>
              <MetricCard label="Executions · 24h" value={s ? num(t.ALL) : '—'}
                sub={s ? `${num(s.all_time?.ALL)} recorded in total` : 'Loading…'} accent={C.royal} icon={IconList}
                onClick={() => nav('/jobs?range=24h')} title="Open these executions" />
              <MetricCard label="Success rate · 24h" value={s ? (s.success_rate == null ? '—' : `${s.success_rate}%`) : '—'}
                sub={s ? (s.success_rate == null ? 'No finished executions' : `${num(t.COMPLETED)} completed of ${num(t.COMPLETED + t.FAILED)} finished`) : 'Loading…'}
                accent={C.green} icon={IconCheck} />
              <MetricCard label="Failed · 24h" value={s ? num(t.FAILED) : '—'} sub="Includes timed out and cancelled"
                accent={C.red} icon={IconAlert} onClick={() => nav('/jobs?status=FAILED&range=24h')} title="Open failed executions" />
              <MetricCard label="Running now" value={s ? num(active.RUNNING) : '—'}
                sub={s ? `${num(active.PENDING)} pending · all dates` : 'Loading…'} accent={C.gold} icon={IconBolt}
                onClick={() => nav('/jobs?status=RUNNING&range=all')} title="Open running executions" />
            </div>
            <PartialNote data={s} />
          </>
        )}

        {/* ── Section 2: activity chart ── */}
        <Card style={{ marginBottom: 16 }}>
          <CardHead>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink }}>Job activity — {chartPreset.label.toLowerCase()}</div>
              <div style={{ fontSize: 10.5, color: C.textTer, marginTop: 1 }}>
                {c?.bucket === 'day' ? 'Executions by day (UTC)' : c ? `Executions per ${c.bucket === '1h' ? 'hour' : c.bucket.replace('h', ' hours')} (your local time)` : 'Executions'}, by start time and current outcome
                {c && ` · ${num(c.totals?.ALL)} in range`}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <SectionStamp section={chart} />
              <select
                value={chartRange}
                onChange={(e) => setChartRange(e.target.value)}
                aria-label="Chart range"
                style={{
                  padding: '6px 10px', borderRadius: 'var(--radius-md)', border: '1px solid #CBD5E1',
                  background: C.surface, fontSize: 12, color: C.textSec, fontFamily: 'inherit',
                  outline: 'none', cursor: 'pointer',
                }}
              >
                {RANGE_PRESETS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          </CardHead>
          <div style={{ padding: '16px 18px 6px', position: 'relative' }}>
            {chart.error && !c ? <SectionError section={chart} what="the activity chart" /> : !c ? (
              <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner /></div>
            ) : (
              <div style={{ opacity: chartShowsOtherRange ? 0.45 : 1, transition: 'opacity 0.15s' }}>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData} barCategoryGap={2} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke={C.border} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="hour" tick={{ fontSize: 9.5, fill: C.textTer }}
                      interval={Math.max(0, Math.ceil(chartData.length / 10) - 1)}
                      axisLine={{ stroke: C.border }} tickLine={false}
                    />
                    <YAxis tick={{ fontSize: 10, fill: C.textTer }} axisLine={false} tickLine={false} allowDecimals={false} width={28} />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(18,21,28,0.04)' }} />
                    <Legend iconType="square" iconSize={8} wrapperStyle={{ fontSize: 11, color: C.textSec, paddingTop: 8 }} />
                    <Bar dataKey="Completed" stackId="s" fill={STATUS_COLOR.Completed} isAnimationActive={false} />
                    <Bar dataKey="Running" stackId="s" fill={STATUS_COLOR.Running} isAnimationActive={false} />
                    <Bar dataKey="Pending" stackId="s" fill={STATUS_COLOR.Pending} isAnimationActive={false} />
                    <Bar dataKey="Failed" stackId="s" fill={STATUS_COLOR.Failed} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
                <PartialNote data={c} />
              </div>
            )}
            {chartShowsOtherRange && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 12, color: C.textSec }}>
                <Spinner size={14} /> Loading {chartPreset.label.toLowerCase()}…
              </div>
            )}
          </div>
        </Card>

        {/* Main content: recent executions + right panel */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 264px', gap: 16 }}>

          {/* ── Section 3: recent executions ── */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 10 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>Recent executions</div>
                <div style={{ fontSize: 10.5, color: C.textTer }}>
                  The {RECENT_LIMIT} most recently started · <SectionStamp section={recent} />
                </div>
              </div>
              <button
                onClick={() => nav('/jobs')}
                style={{ background: 'none', border: 'none', color: C.orange, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                View all{recent.data?.total_in_table != null ? ` ${num(recent.data.total_in_table)}` : ''} executions →
              </button>
            </div>

            <Card>
              {recent.error && !recent.data ? <SectionError section={recent} what="recent executions" />
                : !recent.data ? (
                  <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
                ) : recent.data.jobs.length === 0 ? (
                  <Empty message="No executions recorded yet." />
                ) : (
                  <>
                    <div style={{ display: 'flex', background: C.tint, borderBottom: `1px solid ${C.border}` }}>
                      {COLS.map((col) => (
                        <div key={col.key} style={{
                          flex: col.width ? `0 0 ${col.width}px` : '1 1 auto', padding: '10px 14px',
                          fontSize: 10, fontWeight: 700, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.6,
                        }}>{col.label}</div>
                      ))}
                    </div>
                    {recent.data.jobs.map((j) => (
                      <RecentRow key={j.job_id} job={j} onClick={() => nav(`/jobs/${encodeURIComponent(j.job_id)}`)} />
                    ))}
                  </>
                )}
            </Card>
          </div>

          {/* Right panel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Status breakdown — same 24h counts as the cards */}
            <Card style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 12 }}>
                Status breakdown · 24h
              </div>
              {[
                { name: 'Completed', value: t.COMPLETED, color: C.green },
                { name: 'Running', value: t.RUNNING, color: C.blue },
                { name: 'Pending', value: t.PENDING, color: C.gold },
                { name: 'Failed', value: t.FAILED, color: C.red },
              ].map((b) => (
                <div key={b.name} style={{ marginBottom: 9 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 4 }}>
                    <span style={{ color: C.textSec, fontWeight: 500 }}>{b.name}</span>
                    <span style={{ color: C.textTer, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{s ? num(b.value) : '—'}</span>
                  </div>
                  <div style={{ height: 5, background: C.canvas, borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', background: b.color, borderRadius: 4, width: s ? pct(b.value || 0) : '0%', transition: 'width 0.4s ease' }} />
                  </div>
                </div>
              ))}
              {s?.avg_duration_seconds != null && (
                <div style={{ fontSize: 11, color: C.textTer, marginTop: 6 }}>
                  Average completed run: <b style={{ color: C.textSec }}>{fmtSeconds(s.avg_duration_seconds)}</b> ({num(s.avg_duration_sample)} runs)
                </div>
              )}
            </Card>

            {/* Quick actions */}
            <Card style={{ padding: 14 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 10 }}>
                Quick actions
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <ActionCard label="Run automation" sub="POST to /v1/notify" icon={IconPlay} color={C.orange} onClick={() => nav('/trigger')} />
                <ActionCard label="View all executions" sub="Browse, filter & export" icon={IconList} color={C.royal} onClick={() => nav('/jobs')} />
                <ActionCard label="Manage schedules" sub="EventBridge rules" icon={IconClock} color={C.gold} onClick={() => nav('/schedules')} />
                <ActionCard label="DLQ messages" sub="Failed message queue" icon={IconAlert} color={C.red} onClick={() => nav('/dlq')} />
              </div>
            </Card>

            {/* Pipeline */}
            <Card style={{ padding: 14 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 10 }}>
                Pipeline
              </div>
              {[
                { name: 'API Gateway', color: C.royal },
                { name: 'SQS Queue', color: C.gold },
                { name: 'Lambda', color: '#7C3AED' },
                { name: 'DynamoDB', color: C.green },
                { name: 'Step Function', color: '#0891B2' },
                { name: 'SSM (cross-acct)', color: C.textSec },
              ].map((st, i, arr) => (
                <div key={st.name}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: st.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 11.5, color: C.textSec, fontWeight: 500 }}>{st.name}</span>
                  </div>
                  {i < arr.length - 1 && (
                    <div style={{ marginLeft: 3, width: 1, height: 8, background: C.border }} />
                  )}
                </div>
              ))}
            </Card>
          </div>
        </div>
       </div>
      </div>
    </div>
  );
}
