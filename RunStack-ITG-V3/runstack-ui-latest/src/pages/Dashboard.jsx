// src/pages/Dashboard.jsx
import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { Topbar } from '../components/Layout';
import { Card, CardHead, StatusBadge, TypeTag, Spinner, ErrorBanner, Btn, Empty } from '../components/ui';
import { fetchRecentJobs } from '../api/client';
import { fmtRelative } from '../utils/helpers';
import { RefreshControl } from '../components/sections';
import { useAutoRefresh, usePageRefresh } from '../hooks/usePageRefresh';
import { FixedSizeList as List } from 'react-window';

// ─── Constants ────────────────────────────────────────────────────────────────
const POLL_MS   = 15000;
const FETCH_LIMIT = 100;    // backend hard cap — Lambda rejects limit outside 10–100
const MAX_AUTO_PAGES = 50;  // safety valve: auto-load stops at ~5000 jobs, "Load more" continues past it
const ROW_HEIGHT = 58;      // fixed row height required by react-window
// Column widths shared between the header row and each virtualized row so they stay aligned.
const COLS = [
  { key: 'job',     label: 'Job ID',            width: 170 },
  { key: 'doc',     label: 'Document',          width: null }, // flex: 1
  { key: 'account', label: 'Account / Region',  width: 170 },
  { key: 'status',  label: 'Status',             width: 110 },
  { key: 'created', label: 'Created',            width: 130 },
];

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

// ─── Chart range presets — standard Grafana/Datadog-style windows.
// Bucket size scales with range so the chart never renders 1 vs 720 bars. ───
const RANGE_PRESETS = [
  { label: 'Last 24 hours', hours: 24,   bucketMs: 3600_000 },        // hourly, 24 bars
  { label: 'Last 3 days',   hours: 72,   bucketMs: 3 * 3600_000 },    // 3h buckets, 24 bars
  { label: 'Last 7 days',   hours: 168,  bucketMs: 12 * 3600_000 },   // 12h buckets, 14 bars
  { label: 'Last 30 days',  hours: 720,  bucketMs: 24 * 3600_000 },   // daily, 30 bars
];

function fmtBucketLabel(ts, bucketMs) {
  const d = new Date(ts);
  return bucketMs >= 24 * 3600_000
    ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', hour12: false }) + ':00';
}

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
const IconDownload = (p) => <Icon {...p}><path d="M8 2v8M5 7l3 3 3-3" /><path d="M3 12.5v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1" /></Icon>;

// ─── Metric card — DXC-toned stat with top accent ─────────────────────────────
function MetricCard({ label, value, sub, accent, icon }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderTop: `3px solid ${accent}`, borderRadius: 'var(--radius-lg)',
      padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 4,
      boxShadow: '0 1px 2px rgba(15,23,42,0.05)',
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

// ─── CSV Export ───────────────────────────────────────────────────────────────
function exportCSV(jobs) {
  const headers = ['job_id', 'notification_id', 'account_id', 'region', 'automation_type',
    'document_name', 'status', 'execution_id', 'created_at', 'updated_at'];
  const rows = jobs.map(j => headers.map(h => {
    const v = h === 'document_name' ? (j.automation_data?.DocumentName || '') : (j[h] || '');
    return `"${String(v).replace(/"/g, '""')}"`;
  }).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `runstack-jobs-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Filter Bar ───────────────────────────────────────────────────────────────
function FilterBar({ statusFilter, setStatusFilter, typeFilter, setTypeFilter, search, setSearch, total }) {
  const fStyle = {
    padding: '7px 12px', borderRadius: 'var(--radius-md)', border: `1px solid #CBD5E1`,
    background: C.surface, fontSize: 13, color: C.ink, fontFamily: 'inherit',
    outline: 'none', cursor: 'pointer',
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <input
        style={{ ...fStyle, width: 220, cursor: 'text' }}
        placeholder="Search job ID, account, document…"
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      <select style={fStyle} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
        <option value="">All statuses</option>
        {['COMPLETED', 'FAILED', 'RUNNING', 'PENDING'].map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <select style={fStyle} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
        <option value="">All types</option>
        {['SSM-Automation', 'SSM-RunCommand', 'EC2-Action'].map(t => <option key={t} value={t}>{t}</option>)}
      </select>
      <span style={{ fontSize: 12, color: C.textTer, marginLeft: 'auto' }}>{total} jobs</span>
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

// ─── Table header row — shares COLS widths with the virtualized rows below ───
function TableHeader() {
  return (
    <div style={{ display: 'flex', background: C.tint, borderBottom: `1px solid ${C.border}` }}>
      {COLS.map(c => (
        <div key={c.key} style={{
          flex: c.width ? `0 0 ${c.width}px` : '1 1 auto',
          padding: '10px 14px',
          fontSize: 10, fontWeight: 700, color: C.textTer,
          textTransform: 'uppercase', letterSpacing: 0.6,
        }}>{c.label}</div>
      ))}
    </div>
  );
}

// ─── One virtualized job row ──────────────────────────────────────────────────
function JobRow({ job: j, style, onClick }) {
  const [hov, setHov] = useState(false);
  return (
    <div
      style={{
        ...style,
        display: 'flex', alignItems: 'center', cursor: 'pointer',
        borderBottom: `1px solid ${C.canvas}`,
        background: hov ? C.tint : 'transparent',
      }}
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      <div style={{ flex: `0 0 ${COLS[0].width}px`, padding: '0 14px', minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color: C.royal, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {j.job_id?.slice(0, 12) || '—'}
        </div>
        <div style={{ fontSize: 10, color: C.textTer, marginTop: 2, fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {j.notification_id?.slice(0, 28) || '—'}
        </div>
      </div>
      <div style={{ flex: '1 1 auto', padding: '0 14px', minWidth: 0 }}>
        <div style={{ fontWeight: 600, color: C.ink, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {j.automation_data?.DocumentName || '—'}
        </div>
        <TypeTag type={j.automation_type} />
      </div>
      <div style={{ flex: `0 0 ${COLS[2].width}px`, padding: '0 14px', minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: C.textSec, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.account_id || '—'}</div>
        <div style={{ fontSize: 10, color: C.textTer, marginTop: 2 }}>{j.region}</div>
      </div>
      <div style={{ flex: `0 0 ${COLS[3].width}px`, padding: '0 14px' }}>
        <StatusBadge status={j.status} />
      </div>
      <div style={{ flex: `0 0 ${COLS[4].width}px`, padding: '0 14px', color: C.textTer, fontSize: 12 }}>
        {fmtRelative(j.created_at)}
      </div>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const nav = useNavigate();

  const [allJobs, setAllJobs]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [lastFetched, setLastFetched] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore]         = useState(true);
  const [lastKey, setLastKey]         = useState(null);

  const [search, setSearch]       = useState('');
  const [statusFilter, setStatus] = useState('');
  const [typeFilter, setType]     = useState('');
  const [rangeIdx, setRangeIdx]   = useState(0); // chart time-range preset — see RANGE_PRESETS
  const range = RANGE_PRESETS[rangeIdx];

  const [loadProgress, setLoadProgress] = useState(0); // jobs loaded so far during initial auto-paginate

  // Auto-paginates through /jobs/recent until DynamoDB has no more pages
  // (last_key is empty) or MAX_AUTO_PAGES is hit. Updates state after each
  // page so the table/chart fill in progressively instead of one long wait.
  const loadJobs = useCallback(async (reset = true) => {
    if (reset) { setLoading(true); setError(null); setLoadProgress(0); }

    try {
      let cursor;
      let pages = 0;
      let collected = [];
      let cappedOut = false;

      do {
        const data = await fetchRecentJobs({ limit: FETCH_LIMIT, status: statusFilter || undefined, lastKey: cursor });
        const jobs = data.jobs || [];
        collected = collected.concat(jobs);
        cursor = data.last_key || null;
        pages += 1;
        setLoadProgress(collected.length);
        // Progressive paint: merge what we have so far so the person sees
        // rows appear rather than staring at a spinner for a big table.
        setAllJobs(prev => {
          if (!reset) {
            const ids = new Set(prev.map(j => j.job_id));
            return [...prev, ...collected.filter(j => !ids.has(j.job_id))];
          }
          const existingIds = new Set(collected.map(j => j.job_id));
          const stillMissing = prev.filter(j => !existingIds.has(j.job_id));
          return [...collected, ...stillMissing];
        });
        if (pages >= MAX_AUTO_PAGES && cursor) {
          cappedOut = true;
          break;
        }
      } while (cursor);

      setLastKey(cursor);
      setHasMore(!!cursor);
      if (cappedOut) {
        console.warn(`RunStack: stopped auto-loading at ${MAX_AUTO_PAGES} pages (${collected.length} jobs) — use "Load more" to continue.`);
      }
      setLastFetched(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [statusFilter]);

  // Manual continuation — only needed if MAX_AUTO_PAGES was hit above.
  async function loadMore() {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchRecentJobs({ limit: FETCH_LIMIT, status: statusFilter || undefined, lastKey });
      const jobs = data.jobs || [];
      setAllJobs(prev => {
        const ids = new Set(prev.map(j => j.job_id));
        return [...prev, ...jobs.filter(j => !ids.has(j.job_id))];
      });
      setLastKey(data.last_key || null);
      setHasMore(!!data.last_key);
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => { loadJobs(true); }, [statusFilter]);

  // In-place refresh: re-reads the newest page, updates status/updated_at
  // of jobs already loaded and prepends new ones. Filters, search, chart
  // range and scroll position are untouched. Used by the 15s auto-refresh,
  // the Refresh button and a repeat click on "Dashboard" in the sidebar.
  const softRefresh = useCallback(async () => {
    const data = await fetchRecentJobs({ limit: FETCH_LIMIT, status: statusFilter || undefined });
    const fresh = data.jobs || [];
    const byId = new Map(fresh.map(j => [j.job_id, j]));
    setAllJobs(prev => {
      const existingIds = new Set(prev.map(j => j.job_id));
      const newJobs = fresh.filter(j => !existingIds.has(j.job_id));
      const updated = prev.map(j => {
        const f = byId.get(j.job_id);
        return f ? { ...j, status: f.status, updated_at: f.updated_at } : j;
      });
      return newJobs.length > 0 ? [...newJobs, ...updated] : updated;
    });
    setLastFetched(new Date());
  }, [statusFilter]);

  const auto = useAutoRefresh(softRefresh, { intervalMs: POLL_MS, enabled: !loading });
  usePageRefresh(auto.refresh);

  // Stats
  const stats = useMemo(() => {
    const total     = allJobs.length;
    const completed = allJobs.filter(j => j.status === 'COMPLETED').length;
    const failed    = allJobs.filter(j => j.status === 'FAILED' || j.status === 'TIMED_OUT').length;
    const running   = allJobs.filter(j => j.status === 'RUNNING').length;
    const pending    = allJobs.filter(j => j.status === 'PENDING').length;
    const rate      = total > 0 ? Math.round((completed / total) * 100) : 0;

    // Avg duration across completed jobs with a valid created/updated pair.
    const durations = allJobs
      .filter(j => j.status === 'COMPLETED' && j.created_at && j.updated_at)
      .map(j => {
        const toUtc = s => s.endsWith('Z') || s.includes('+') ? s : s + 'Z';
        return new Date(toUtc(j.updated_at)) - new Date(toUtc(j.created_at));
      })
      .filter(ms => !isNaN(ms) && ms >= 0);
    const avgMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
    const avgLabel = avgMs == null ? '—'
      : avgMs < 1000 ? `${Math.round(avgMs)}ms`
      : avgMs < 60_000 ? `${Math.round(avgMs / 1000)}s`
      : `${Math.floor(avgMs / 60_000)}m ${Math.round((avgMs % 60_000) / 1000)}s`;

    return { total, completed, failed, running, pending, rate, avgLabel, avgSample: durations.length };
  }, [allJobs]);

  // Job activity — stacked bar chart, bucketed per the selected range preset
  const hourlyData = useMemo(() => {
    const now = Date.now();
    const { hours, bucketMs } = range;
    const bucketCount = Math.round((hours * 3600_000) / bucketMs);
    const buckets = Array.from({ length: bucketCount }, (_, i) => {
      const start = now - (bucketCount - 1 - i) * bucketMs;
      return {
        hour: fmtBucketLabel(start, bucketMs),
        _start: start, _end: start + bucketMs,
        Completed: 0, Running: 0, Pending: 0, Failed: 0,
      };
    });
    allJobs.forEach(j => {
      const t = new Date(j.created_at.endsWith('Z') ? j.created_at : j.created_at + 'Z').getTime();
      const b = buckets.find(x => t >= x._start && t < x._end);
      if (!b) return;
      if (j.status === 'COMPLETED') b.Completed++;
      else if (j.status === 'RUNNING') b.Running++;
      else if (j.status === 'PENDING') b.Pending++;
      else if (j.status === 'FAILED' || j.status === 'TIMED_OUT') b.Failed++;
    });
    return buckets;
  }, [allJobs, range]);

  const filtered = useMemo(() => {
    let result = allJobs;
    if (statusFilter) result = result.filter(j => j.status === statusFilter);
    if (typeFilter) result = result.filter(j => j.automation_type === typeFilter);
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(j =>
        j.job_id?.toLowerCase().includes(q) ||
        j.account_id?.includes(q) ||
        j.notification_id?.toLowerCase().includes(q) ||
        j.automation_data?.DocumentName?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [allJobs, statusFilter, typeFilter, search]);

  const timeStr = loading
    ? `Loading job history… ${loadProgress} loaded so far`
    : lastFetched ? `Last updated ${lastFetched.toLocaleTimeString('en-GB')}` : 'Connecting…';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.canvas }}>

      <Topbar
        title="Dashboard"
        subtitle={loading ? timeStr : 'Live view of RunStack automation executions'}
        actions={
          <>
            <RefreshControl
              onRefresh={auto.refresh}
              refreshing={loading || auto.refreshing}
              lastUpdated={lastFetched}
              autoEverySec={POLL_MS / 1000}
              error={auto.error}
            />
            <Btn variant="default" size="sm" onClick={() => exportCSV(filtered)}>
              <IconDownload size={13} color={C.textSec} /> Export CSV
            </Btn>
            <Btn variant="primary" size="sm" onClick={() => nav('/trigger')}>
              <IconPlay size={12} color="#fff" /> Run automation
            </Btn>
          </>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
       <div style={{ maxWidth: 1680, margin: '0 auto' }}>
        {error && <ErrorBanner message={error} />}

        {/* System health — the single most important signal, first thing seen */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: stats.failed > 0 ? C.red + '14' : C.green + '14',
          border: `1px solid ${stats.failed > 0 ? C.red + '40' : C.green + '40'}`,
          borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: 16,
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: stats.failed > 0 ? C.red : C.green,
            boxShadow: `0 0 0 4px ${stats.failed > 0 ? C.red + '22' : C.green + '22'}`,
          }} />
          <span style={{ fontSize: 12.5, fontWeight: 700, color: stats.failed > 0 ? '#9A1E1E' : '#0B6E4C' }}>
            {stats.failed > 0 ? `${stats.failed} job${stats.failed > 1 ? 's' : ''} need attention` : 'All systems operational'}
          </span>
          {stats.running > 0 && (
            <span style={{ fontSize: 11.5, color: C.textTer }}>
              · {stats.running} execution{stats.running > 1 ? 's' : ''} in progress
            </span>
          )}
          <span style={{ fontSize: 11, color: C.textTer, marginLeft: 'auto' }}>{timeStr}</span>
        </div>

        {/* Metric cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 16 }}>
          <MetricCard label="Jobs loaded" value={loading ? loadProgress : stats.total} sub={hasMore ? `Capped at ${MAX_AUTO_PAGES * FETCH_LIMIT} — load more below` : 'Full job history'} accent={C.royal} icon={IconList} />
          <MetricCard label="Success rate" value={loading ? '—' : `${stats.rate}%`} sub={`${stats.completed} completed`} accent={C.green} icon={IconCheck} />
          <MetricCard label="Failed" value={loading ? '—' : stats.failed} sub="Requires attention" accent={C.red} icon={IconAlert} />
          <MetricCard label="Running now" value={loading ? '—' : stats.running} sub="Active executions" accent={C.gold} icon={IconBolt} />
          {/*<MetricCard label="Avg duration" value={loading ? '—' : stats.avgLabel} sub={stats.avgSample ? `Across ${stats.avgSample} completed jobs` : 'No completed jobs yet'} accent={'#7C3AED'} icon={IconClock} />*/}
        </div>

        {/* Job activity — the bar chart */}
        <Card style={{ marginBottom: 16 }}>
          <CardHead>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink }}>Job activity — {range.label.toLowerCase()}</div>
              <div style={{ fontSize: 10.5, color: C.textTer, marginTop: 1 }}>
                {range.bucketMs >= 24 * 3600_000 ? 'Executions by day' : 'Executions by hour'}, grouped by outcome
              </div>
            </div>
            <select
              value={rangeIdx}
              onChange={e => setRangeIdx(Number(e.target.value))}
              style={{
                padding: '6px 10px', borderRadius: 'var(--radius-md)', border: '1px solid #CBD5E1',
                background: C.surface, fontSize: 12, color: C.textSec, fontFamily: 'inherit',
                outline: 'none', cursor: 'pointer',
              }}
            >
              {RANGE_PRESETS.map((r, i) => <option key={r.label} value={i}>{r.label}</option>)}
            </select>
          </CardHead>
          <div style={{ padding: '16px 18px 6px' }}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={hourlyData} barCategoryGap={2} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke={C.border} strokeDasharray="3 3" />
                <XAxis
                  dataKey="hour" tick={{ fontSize: 9.5, fill: C.textTer }}
                  interval={Math.max(0, Math.ceil(hourlyData.length / 10) - 1)}
                  axisLine={{ stroke: C.border }} tickLine={false}
                />
                <YAxis tick={{ fontSize: 10, fill: C.textTer }} axisLine={false} tickLine={false} allowDecimals={false} width={28} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'rgba(18,21,28,0.04)' }} />
                <Legend
                  iconType="square" iconSize={8}
                  wrapperStyle={{ fontSize: 11, color: C.textSec, paddingTop: 8 }}
                />
                <Bar dataKey="Completed" stackId="s" fill={STATUS_COLOR.Completed} />
                <Bar dataKey="Running" stackId="s" fill={STATUS_COLOR.Running} />
                <Bar dataKey="Pending" stackId="s" fill={STATUS_COLOR.Pending} />
                <Bar dataKey="Failed" stackId="s" fill={STATUS_COLOR.Failed} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            {rangeIdx > 0 && hasMore && (
              <div style={{ fontSize: 10.5, color: C.textTer, padding: '0 4px 10px', textAlign: 'right' }}>
                Chart reflects the {allJobs.length} jobs loaded so far, not full {range.label.toLowerCase()} history —{' '}
                <span style={{ color: C.orange, cursor: 'pointer', fontWeight: 600 }} onClick={loadMore}>
                  {loadingMore ? 'loading…' : 'load more'}
                </span>
              </div>
            )}
          </div>
        </Card>

        {/* Main content: jobs table + quick actions */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 264px', gap: 16 }}>

          {/* Jobs table */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                {/*<div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>All jobs</div>*/}
                <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>Recent executions</div>
                <div style={{ fontSize: 10.5, color: C.textTer }}>Live data via DynamoDB · auto-refreshes every 15s</div>
              </div>
              <button
                onClick={() => nav('/jobs')}
                style={{ background: 'none', border: 'none', color: C.orange, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                View all →
              </button>
            </div>

            {/* Sticky so the filters stay visible while scrolling the virtualized list below */}
            <div style={{ marginBottom: 12, position: 'sticky', top: 0, zIndex: 2, background: C.canvas, paddingTop: 4 }}>
              <FilterBar
                statusFilter={statusFilter} setStatusFilter={setStatus}
                typeFilter={typeFilter} setTypeFilter={setType}
                search={search} setSearch={setSearch}
                total={filtered.length}
              />
            </div>

            <Card>
              {loading && allJobs.length === 0 ? (
                <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
              ) : filtered.length === 0 ? (
                <Empty message="No jobs match the current filters." />
              ) : (
                <>
                  <TableHeader />
                  <List
                    height={Math.min(640, filtered.length * ROW_HEIGHT)}
                    itemCount={filtered.length}
                    itemSize={ROW_HEIGHT}
                    width="100%"
                  >
                    {({ index, style }) => (
                      <JobRow
                        job={filtered[index]}
                        style={style}
                        onClick={() => nav(`/jobs/${filtered[index].job_id}`)}
                      />
                    )}
                  </List>

                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '12px 16px', borderTop: `1px solid ${C.border}`, background: C.tint,
                  }}>
                    <div style={{ fontSize: 12, color: C.textTer }}>
                      {filtered.length} job{filtered.length === 1 ? '' : 's'} shown
                      {hasMore && <span style={{ color: C.orange, marginLeft: 6, cursor: 'pointer', fontWeight: 600 }}
                        onClick={loadMore}>{loadingMore ? 'Loading…' : '· Load more from DB'}</span>}
                    </div>
                  </div>
                </>
              )}
            </Card>
          </div>

          {/* Right panel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Status breakdown */}
            <Card style={{ padding: '16px 18px' }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 12 }}>
                Status breakdown
              </div>
              {[
                { name: 'Completed', value: stats.completed, color: C.green },
                { name: 'Running', value: stats.running, color: C.blue },
                { name: 'Pending', value: stats.pending, color: C.gold },
                { name: 'Failed', value: stats.failed, color: C.red },
              ].map(b => (
                <div key={b.name} style={{ marginBottom: 9 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 4 }}>
                    <span style={{ color: C.textSec, fontWeight: 500 }}>{b.name}</span>
                    <span style={{ color: C.textTer, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{b.value}</span>
                  </div>
                  <div style={{ height: 5, background: C.canvas, borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', background: b.color, borderRadius: 4,
                      width: stats.total > 0 ? `${Math.round((b.value / stats.total) * 100)}%` : '0%',
                      transition: 'width 0.4s ease',
                    }} />
                  </div>
                </div>
              ))}
            </Card>

            {/* Quick actions */}
            <Card style={{ padding: 14 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 10 }}>
                Quick actions
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <ActionCard label="Run automation" sub="POST to /v1/notify" icon={IconPlay} color={C.orange} onClick={() => nav('/trigger')} />
                {/*<ActionCard label="View all jobs" sub="Browse & filter jobs" icon={IconList} color={C.royal} onClick={() => nav('/jobs')} />*/}
                <ActionCard label="View all executions" sub="Browse & filter executions" icon={IconList} color={C.royal} onClick={() => nav('/jobs')} />
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
              ].map((s, i, arr) => (
                <div key={s.name}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                    <span style={{ fontSize: 11.5, color: C.textSec, fontWeight: 500 }}>{s.name}</span>
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
