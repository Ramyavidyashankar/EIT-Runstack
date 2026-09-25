// src/pages/Jobs.jsx — Automation Executions
//
// Data comes from GET /jobs/query, which filters, counts, sorts and pages
// across the WHOLE jobs table server-side. That's what makes the numbers
// here honest: tab counts and "N matching" are dataset-wide, "loaded" is
// what's on screen, and export fetches every matching job (up to a cap).
// (The old page used /jobs/recent, a DynamoDB Scan with Limit=50, so its
// "All (50)" was 50 arbitrary rows, not a total.)
//
// Stable reading while data changes:
//   • The first page pins `as_of` (newest created_at at load time). Load
//     more and auto-refresh reuse it, so rows never shift or reorder.
//   • Jobs created later are counted, not inserted — a banner offers to
//     show them.
//   • Auto-refresh updates status/timestamps of rows in place. A row that no
//     longer matches the filter (e.g. finished while on the Running tab)
//     stays where it is, marked, until the user changes the view.
//   • Filters, sort, search and the open job live in the URL, so refresh,
//     back/forward and sharing a link keep them.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Topbar } from '../components/Layout';
import { Btn, Card, Empty, ErrorBanner, Input, Spinner, StatusBadge } from '../components/ui';
import { Callout, RefreshControl } from '../components/sections';
import JobDetailContent, { CopyButton } from '../components/JobDetail';
import { fetchJob, queryJobs } from '../api/client';
import { useAutoRefresh, usePageRefresh } from '../hooks/usePageRefresh';
import {
  DATE_PRESETS, downloadText, fmtFull, fmtStarted, jobDuration, jobsToCsv, rangeToQuery, statusGroup,
} from '../utils/jobs';

const PAGE_SIZE = 50;
const REFRESH_MS = 20000;
const EXPORT_CAP = 10000;
const EXPORT_PAGE = 500;

const STATUS_TABS = [
  { key: 'ALL', label: 'All' },
  { key: 'RUNNING', label: 'Running' },
  { key: 'PENDING', label: 'Pending' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'FAILED', label: 'Failed', hint: 'Includes timed out and cancelled' },
];
const SORTS = [
  { value: 'started_desc', label: 'Newest first' },
  { value: 'started_asc', label: 'Oldest first' },
  { value: 'duration_desc', label: 'Longest duration' },
];
const SEARCH_HELP = 'Searches job ID, notification ID, execution ID, resource ID, server name, application name, account ID and automation or document name.';
const GROUP_EDGE = { FAILED: '#DC2626', RUNNING: '#D97706', PENDING: '#F59E0B', COMPLETED: 'transparent' };

const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-GB') : '—');

// ─── URL-backed view state ───────────────────────────────────────────────────
function useViewState() {
  const [params, setParams] = useSearchParams();
  const view = {
    status: params.get('status') || 'ALL',
    q: params.get('q') || '',
    range: params.get('range') || '7d',
    from: params.get('from') || '',
    to: params.get('to') || '',
    automation: params.get('automation') || '',
    account: params.get('account') || '',
    environment: params.get('env') || '',
    sort: params.get('sort') || 'started_desc',
    job: params.get('job') || '',
  };
  const keyMap = { environment: 'env' };
  const update = useCallback((changes, { replace = true } = {}) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      Object.entries(changes).forEach(([k, v]) => {
        const key = keyMap[k] || k;
        if (v === '' || v == null || (key === 'status' && v === 'ALL') || (key === 'sort' && v === 'started_desc') || (key === 'range' && v === '7d')) next.delete(key);
        else next.set(key, v);
      });
      return next;
    }, { replace });
  }, [setParams]);
  return [view, update];
}

// ─── Small pieces ────────────────────────────────────────────────────────────
function FilterSelect({ label, value, onChange, children, width = 180 }) {
  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 11, color: '#64748B', fontWeight: 600 }}>
      {label}
      <select className="rs-input" value={value} onChange={(e) => onChange(e.target.value)} style={{
        width, padding: '7px 10px', borderRadius: 8, border: `1px solid ${value ? 'var(--nav-blue)' : '#CBD5E1'}`,
        background: value ? 'var(--nav-blue-bg)' : '#FFFFFF', color: '#0F172A', fontSize: 12.5, fontFamily: 'inherit', cursor: 'pointer',
      }}>
        {children}
      </select>
    </label>
  );
}

function StatusTab({ tab, count, active, onClick }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} title={tab.hint}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, transition: 'all 0.12s',
        border: `1px solid ${active ? 'var(--nav-navy)' : '#E2E8F0'}`,
        background: active ? 'var(--nav-navy)' : '#FFFFFF',
        color: active ? '#FFFFFF' : '#334155',
      }}>
      {tab.label}
      <span style={{
        fontSize: 11, fontWeight: 700, padding: '0 6px', borderRadius: 999, fontFamily: 'var(--font-mono)',
        background: active ? 'rgba(255,255,255,0.22)' : '#F1F5F9', color: active ? '#FFFFFF' : '#475569',
      }}>{n(count)}</span>
    </button>
  );
}

function Th({ children, width, align }) {
  return (
    <th style={{
      textAlign: align || 'left', padding: '9px 12px', fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase',
      letterSpacing: 0.6, background: '#F8FAFC', borderBottom: '1px solid #E2E8F0', whiteSpace: 'nowrap', width,
      position: 'sticky', top: 0, zIndex: 1,
    }}>{children}</th>
  );
}

function JobRow({ job, selected, stale, onOpen, now }) {
  const group = statusGroup(job.status);
  const dur = jobDuration(job, now);
  const hasName = job.server_name || job.app_name;
  const td = { padding: '8px 12px', borderBottom: '1px solid #F1F5F9', verticalAlign: 'middle', fontSize: 12.5 };
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } };
  return (
    <tr className="rs-exec-row" tabIndex={0} aria-selected={selected} onClick={onOpen} onKeyDown={onKey}
      data-stale={stale ? 'true' : undefined} style={{ cursor: 'pointer', opacity: stale ? 0.5 : 1 }}>
      <td style={{ ...td, borderLeft: `3px solid ${GROUP_EDGE[group]}`, maxWidth: 280 }}>
        <div style={{ fontWeight: 600, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={job.document_name}>
          {job.automation_label || job.document_name || job.automation_type || '—'}
        </div>
        <div style={{ fontSize: 11, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.automation_name && job.automation_name !== job.automation_label ? job.automation_name : job.automation_type}
        </div>
      </td>
      <td style={{ ...td, maxWidth: 240 }}>
        {hasName && (
          <div style={{ fontWeight: 600, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {job.server_name || job.app_name}
            {job.server_name && job.app_name && <span style={{ fontWeight: 400, color: '#64748B' }}> · {job.app_name}</span>}
          </div>
        )}
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: hasName ? 11 : 12, color: hasName ? '#64748B' : '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.resource_id || '—'}
        </div>
      </td>
      <td style={td}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: '#334155' }}>{job.account_id || '—'}</div>
        <div style={{ fontSize: 11, color: '#64748B' }}>{job.region || '—'}{job.environment ? ` · ${job.environment}` : ''}</div>
      </td>
      <td style={td} title={stale ? 'Status changed — this job no longer matches the current filter' : undefined}>
        <StatusBadge status={job.status} />
      </td>
      <td style={{ ...td, whiteSpace: 'nowrap', color: '#334155' }} title={fmtFull(job.created_at)}>{fmtStarted(job.created_at)}</td>
      <td style={{ ...td, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 12, color: dur.live ? '#B45309' : '#334155' }}>
        {dur.text}{dur.live && <span style={{ fontFamily: 'var(--font-sans)', fontSize: 10.5 }}> so far</span>}
      </td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--nav-blue-text)' }} title={job.job_id}>{(job.job_id || '').slice(0, 8)}</span>
          <CopyButton value={job.job_id} label="Copy job ID" />
        </span>
      </td>
    </tr>
  );
}

function DetailDrawer({ jobId, row, onClose, onUpdate }) {
  const nav = useNavigate();
  const closeRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, jobId]);
  return (
    <>
      <div onClick={onClose} aria-hidden style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.18)', zIndex: 30 }} />
      <aside role="dialog" aria-modal="true" aria-label="Execution details" style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(620px, 100vw)', background: '#F8FAFC', zIndex: 31,
        boxShadow: '-12px 0 32px rgba(15,23,42,0.18)', display: 'flex', flexDirection: 'column', animation: 'slideIn 0.18s ease both',
      }}>
        <div style={{ padding: '14px 18px', background: 'var(--brand-hover)', color: '#FFFFFF', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 10.5, color: '#A9DED8', fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase' }}>Execution details</div>
            <div style={{ fontSize: 15, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row?.automation_label || 'Job'} {row?.server_name ? `· ${row.server_name}` : ''}
            </div>
          </div>
          <button type="button" onClick={() => nav(`/jobs/${encodeURIComponent(jobId)}`)} style={{
            background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)', color: '#E2E8F0', borderRadius: 6,
            padding: '5px 10px', fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit',
          }}>Open full page</button>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close details" style={{
            background: 'none', border: 'none', color: '#E2E8F0', fontSize: 20, cursor: 'pointer', lineHeight: 1, padding: 4,
          }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          <JobDetailContent key={jobId} jobId={jobId} initial={row} onUpdate={onUpdate} />
        </div>
      </aside>
    </>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function Jobs() {
  const [view, setView] = useViewState();
  const [searchText, setSearchText] = useState(view.q);
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [asOf, setAsOf] = useState(null);
  const [stale, setStale] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(null);
  const [exporting, setExporting] = useState(null); // null | { done, total }
  const [exportError, setExportError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [now, setNow] = useState(Date.now());
  const reqGen = useRef(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  // Search: debounce typing into the URL.
  useEffect(() => { setSearchText(view.q); }, [view.q]);
  useEffect(() => {
    if (searchText === view.q) return undefined;
    const id = setTimeout(() => setView({ q: searchText.trim() }), 350);
    return () => clearTimeout(id);
  }, [searchText]);

  // Everything that defines "the result set" (not the open job).
  const baseQuery = useMemo(() => ({
    status: view.status, q: view.q, automation: view.automation, account: view.account,
    environment: view.environment, sort: view.sort, ...rangeToQuery(view.range, view.from, view.to),
  }), [view.status, view.q, view.automation, view.account, view.environment, view.sort, view.range, view.from, view.to]);
  const queryKey = JSON.stringify({ ...baseQuery, from: view.range === 'custom' ? baseQuery.from : view.range });

  const loadFirstPage = useCallback(async ({ keepRows = false } = {}) => {
    const gen = ++reqGen.current;
    if (!keepRows) { setLoading(true); setRows([]); setStale(new Set()); }
    setLoadError(null); setMoreError(null);
    try {
      const res = await queryJobs({ ...baseQuery, limit: PAGE_SIZE, offset: 0, refresh: keepRows ? 'true' : undefined });
      if (gen !== reqGen.current) return;
      setRows(res.jobs || []);
      setMeta(res);
      setAsOf(res.as_of);
      setStale(new Set());
      setLastUpdated(new Date());
    } catch (e) {
      if (gen === reqGen.current) setLoadError(e.message || String(e));
    } finally {
      if (gen === reqGen.current) setLoading(false);
    }
  }, [baseQuery]);

  useEffect(() => { loadFirstPage(); }, [queryKey]);

  const loadMore = async () => {
    if (!meta?.has_more || loadingMore) return;
    const gen = reqGen.current;
    setLoadingMore(true); setMoreError(null);
    try {
      const res = await queryJobs({ ...baseQuery, limit: PAGE_SIZE, offset: rows.length, as_of: asOf });
      if (gen !== reqGen.current) return;
      setRows((prev) => {
        const seen = new Set(prev.map((j) => j.job_id));
        return [...prev, ...(res.jobs || []).filter((j) => !seen.has(j.job_id))];
      });
      setMeta(res);
    } catch (e) {
      if (gen === reqGen.current) setMoreError(e.message || String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  // Background refresh: same query + as_of → same rows; patch them in place.
  const softRefresh = useCallback(async () => {
    const current = rowsRef.current;
    if (!asOf) return;
    const gen = reqGen.current;
    const limit = Math.min(500, Math.max(PAGE_SIZE, current.length));
    const res = await queryJobs({ ...baseQuery, limit, offset: 0, as_of: asOf });
    if (gen !== reqGen.current) return;
    const fresh = new Map((res.jobs || []).map((j) => [j.job_id, j]));
    // Rows that were in view but aren't in the refreshed window anymore
    // (e.g. finished while on the Running tab): fetch a few individually.
    const missing = current.filter((j) => !fresh.has(j.job_id)).slice(0, 10);
    const fetched = await Promise.allSettled(missing.map((j) => fetchJob(j.job_id)));
    if (gen !== reqGen.current) return;
    const outOfFilter = new Set();
    fetched.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const d = r.value;
        fresh.set(missing[i].job_id, { ...missing[i], status: d.status, updated_at: d.updated_at, execution_id: d.execution_id });
        outOfFilter.add(missing[i].job_id);
      }
    });
    // Rows beyond the first 500 loaded keep their last values until the next manual load.
    setRows((prev) => prev.map((j) => (fresh.has(j.job_id) ? { ...j, ...fresh.get(j.job_id) } : j)));
    setStale((prev) => {
      const next = new Set(prev);
      outOfFilter.forEach((id) => next.add(id));
      return next;
    });
    setMeta((m) => ({ ...m, ...res, has_more: res.has_more }));
    setLastUpdated(new Date());
  }, [asOf, baseQuery]);

  const auto = useAutoRefresh(softRefresh, { intervalMs: REFRESH_MS, enabled: !loading && !loadError && !!asOf });
  usePageRefresh(auto.refresh);

  const openJob = (id) => setView({ job: id }, { replace: false });
  const closeJob = useCallback(() => setView({ job: '' }, { replace: false }), [setView]);
  const patchRow = useCallback((d) => {
    setRows((prev) => prev.map((j) => (j.job_id === d.job_id
      ? { ...j, status: d.status, updated_at: d.updated_at, execution_id: d.execution_id, server_name: d.server_name ?? j.server_name, app_name: d.app_name ?? j.app_name }
      : j)));
  }, []);

  const exportFiltered = async () => {
    const total = Math.min(meta?.total_matching || 0, EXPORT_CAP);
    if (!total) return;
    setExporting({ done: 0, total }); setExportError(null);
    try {
      const all = [];
      for (let offset = 0; offset < total; offset += EXPORT_PAGE) {
        const res = await queryJobs({ ...baseQuery, limit: Math.min(EXPORT_PAGE, total - offset), offset, as_of: asOf });
        all.push(...(res.jobs || []));
        setExporting({ done: all.length, total });
        if (!res.has_more) break;
      }
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      downloadText(jobsToCsv(all), `runstack-executions-${stamp}.csv`);
    } catch (e) {
      setExportError(e.message || String(e));
    } finally {
      setExporting(null);
    }
  };

  // ── Derived ─────────────────────────────────────────────────────────────
  const counts = meta?.status_counts || {};
  const facets = meta?.facets || {};
  const total = meta?.total_matching;
  const filtersActive = !!(view.q || view.automation || view.account || view.environment || view.range !== '7d' || view.status !== 'ALL');
  const openRow = rows.find((j) => j.job_id === view.job);
  const exportLabel = total > EXPORT_CAP ? `Export first ${n(EXPORT_CAP)} of ${n(total)}` : `Export filtered results (${n(total ?? 0)})`;
  const rangeLabel = DATE_PRESETS.find((p) => p.value === view.range)?.label || 'Custom range';

  const subtitle = loading && !meta ? 'Loading executions…'
    : meta ? `${n(total)} matching · ${n(rows.length - stale.size)} loaded · ${n(meta.total_in_table)} jobs in RunStack`
    : 'Jobs recorded by RunStack';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Topbar
        title="Automation Executions"
        subtitle={subtitle}
        actions={<>
          <RefreshControl onRefresh={auto.refresh} refreshing={auto.refreshing} lastUpdated={lastUpdated}
            autoEverySec={REFRESH_MS / 1000} error={auto.error} />
          <Btn variant="navy" size="sm" onClick={exportFiltered} disabled={!total || !!exporting}>
            {exporting ? <><Spinner size={12} /> Exporting {n(exporting.done)} / {n(exporting.total)}</> : `↓ ${exportLabel}`}
          </Btn>
        </>}
      />

      {/* Subtle in-place loading indicator (auto/manual refresh, load more) */}
      <div aria-hidden style={{ height: 2, background: 'transparent', overflow: 'hidden', position: 'relative' }}>
        {(auto.refreshing || loadingMore) && (
          <div style={{ position: 'absolute', inset: 0, width: '35%', background: 'var(--nav-blue)', animation: 'rs-indeterminate 1.1s ease-in-out infinite' }} />
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px 24px' }}>
        <div style={{ maxWidth: 1680, margin: '0 auto', display: 'grid', gap: 14 }}>

          {exportError && <ErrorBanner message={`Export failed: ${exportError}`} />}
          {meta?.scan_truncated && (
            <Callout tone="warning" title="Partial results">
              The jobs table has more than {n(meta.max_scan_items)} jobs, so counts, filters and export cover only the first {n(meta.total_in_table)} RunStack read.
            </Callout>
          )}

          {/* ── Attention: running + failed within the current filters ── */}
          {meta && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '10px 14px', borderRadius: 10,
              background: '#FFFFFF', border: '1px solid #E2E8F0', boxShadow: 'var(--shadow-sm)',
            }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6 }}>Needs a look</span>
              {counts.FAILED > 0 && (
                <button type="button" onClick={() => setView({ status: 'FAILED' })} style={attnBtn('#DC2626', view.status === 'FAILED')}>
                  <span style={dot('#DC2626')} /> {n(counts.FAILED)} failed
                </button>
              )}
              {counts.RUNNING > 0 && (
                <button type="button" onClick={() => setView({ status: 'RUNNING' })} style={attnBtn('#B45309', view.status === 'RUNNING')}>
                  <span style={{ ...dot('#D97706'), animation: 'pulse 1.6s ease infinite' }} /> {n(counts.RUNNING)} running
                </button>
              )}
              {counts.PENDING > 0 && (
                <button type="button" onClick={() => setView({ status: 'PENDING' })} style={attnBtn('#B45309', view.status === 'PENDING')}>
                  <span style={dot('#F59E0B')} /> {n(counts.PENDING)} pending
                </button>
              )}
              {!counts.FAILED && !counts.RUNNING && !counts.PENDING && (
                <span style={{ fontSize: 12.5, color: '#0B6E4C', fontWeight: 600, padding: '4px 0' }}>Nothing failed or in progress</span>
              )}
              <span style={{ fontSize: 11.5, color: '#64748B', marginLeft: 'auto' }}>
                {rangeLabel}{view.automation || view.account || view.environment || view.q ? ' · with your filters' : ''}
              </span>
            </div>
          )}

          {/* ── Filters ── */}
          <Card style={{ padding: 14, display: 'grid', gap: 12, overflow: 'visible' }}>
            <div role="tablist" aria-label="Status" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {STATUS_TABS.map((t) => (
                <StatusTab key={t.key} tab={t} count={counts[t.key]} active={view.status === t.key} onClick={() => setView({ status: t.key })} />
              ))}
              {!(meta?.new_since_as_of > 0) && (
                <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 6 }}>Counts cover all matching jobs, not just loaded rows.</span>
              )}
              {meta?.new_since_as_of > 0 && (
                <button type="button" onClick={() => loadFirstPage({ keepRows: true })} title="New jobs aren't added automatically, so rows don't move while you're reading"
                  style={{
                    marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 999, cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: 12, fontWeight: 700, color: 'var(--nav-blue-text)', background: 'var(--nav-blue-bg)', border: '1px solid var(--nav-blue-border)',
                  }}>
                  ↑ {n(meta.new_since_as_of)} new since you opened this view · Show latest
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 11, color: '#64748B', fontWeight: 600, flex: '1 1 220px', maxWidth: 420 }}>
                Search
                <Input type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Job, execution or resource ID, server, app, account, automation…"
                  aria-describedby="exec-search-help" style={{ fontSize: 12.5, padding: '7px 10px' }} />
              </label>
              <FilterSelect label="Date range" value={view.range === '7d' ? '' : view.range} onChange={(v) => setView({ range: v || '7d', ...(v !== 'custom' ? { from: '', to: '' } : {}) })} width={140}>
                {DATE_PRESETS.map((p) => <option key={p.value} value={p.value === '7d' ? '' : p.value}>{p.label}</option>)}
              </FilterSelect>
              {view.range === 'custom' && (
                <>
                  <label style={{ display: 'grid', gap: 4, fontSize: 11, color: '#64748B', fontWeight: 600 }}>
                    From
                    <Input type="datetime-local" value={view.from} onChange={(e) => setView({ from: e.target.value })} style={{ padding: '6px 8px', fontSize: 12.5 }} />
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 11, color: '#64748B', fontWeight: 600 }}>
                    To
                    <Input type="datetime-local" value={view.to} onChange={(e) => setView({ to: e.target.value })} style={{ padding: '6px 8px', fontSize: 12.5 }} />
                  </label>
                </>
              )}
              <FilterSelect label="Automation" value={view.automation} onChange={(v) => setView({ automation: v })} width={190}>
                <option value="">All automations</option>
                {(facets.automations || []).map((f) => <option key={f.value} value={f.value}>{f.value} ({n(f.count)})</option>)}
              </FilterSelect>
              <FilterSelect label="Account" value={view.account} onChange={(v) => setView({ account: v })} width={160}>
                <option value="">All accounts</option>
                {(facets.accounts || []).map((f) => <option key={f.value} value={f.value}>{f.value} ({n(f.count)})</option>)}
              </FilterSelect>
              {(facets.environments || []).length > 0 && (
                <FilterSelect label="Environment" value={view.environment} onChange={(v) => setView({ environment: v })} width={150}>
                  <option value="">All environments</option>
                  {facets.environments.map((f) => <option key={f.value} value={f.value}>{f.value} ({n(f.count)})</option>)}
                </FilterSelect>
              )}
              <FilterSelect label="Sort" value={view.sort === 'started_desc' ? '' : view.sort} onChange={(v) => setView({ sort: v || 'started_desc' })} width={140}>
                {SORTS.map((s) => <option key={s.value} value={s.value === 'started_desc' ? '' : s.value}>{s.label}</option>)}
              </FilterSelect>
              {filtersActive && (
                <Btn variant="ghost" size="sm" onClick={() => { setSearchText(''); setView({ status: 'ALL', q: '', automation: '', account: '', environment: '', range: '7d', from: '', to: '' }); }}>
                  Clear filters
                </Btn>
              )}
            </div>
            <div id="exec-search-help" style={{ fontSize: 11, color: '#94A3B8', marginTop: -4 }}>
              {SEARCH_HELP} Environment is only available for jobs submitted with it.
            </div>
          </Card>


          {/* ── Table ── */}
          <Card style={{ overflow: 'hidden' }}>
            {loading && rows.length === 0 ? (
              <div style={{ padding: 56, display: 'flex', justifyContent: 'center', gap: 10, alignItems: 'center', color: '#64748B', fontSize: 12.5 }}>
                <Spinner /> Loading executions…
              </div>
            ) : loadError && rows.length === 0 ? (
              <div style={{ padding: 20 }}>
                <ErrorBanner message={`Could not load executions: ${loadError}`} />
                <Btn variant="navy" size="sm" onClick={() => loadFirstPage()}>Try again</Btn>
              </div>
            ) : rows.length === 0 ? (
              <Empty message={filtersActive ? 'No executions match these filters.' : 'No executions recorded yet.'} />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1080 }}>
                  <thead>
                    <tr>
                      <Th>Automation</Th><Th>Target</Th><Th width={170}>Account / Region</Th><Th width={130}>Status</Th>
                      <Th width={130}>Started</Th><Th width={110}>Duration</Th><Th width={130}>Job ID</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((j) => (
                      <JobRow key={j.job_id} job={j} now={now} selected={view.job === j.job_id} stale={stale.has(j.job_id)} onOpen={() => openJob(j.job_id)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {rows.length > 0 && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: '1px solid #E2E8F0', background: '#F8FAFC',
                fontSize: 12, color: '#475569', flexWrap: 'wrap',
              }}>
                <span>Showing <strong>{n(rows.length - stale.size)}</strong> of <strong>{n(total)}</strong> matching executions</span>
                {stale.size > 0 && (
                  <span style={{ color: '#64748B' }}>
                    · {n(stale.size)} dimmed row{stale.size === 1 ? '' : 's'} changed status and no longer match{stale.size === 1 ? 'es' : ''} this filter
                    (<button type="button" onClick={() => loadFirstPage({ keepRows: true })} style={{ background: 'none', border: 'none', padding: 0, color: 'var(--nav-blue-text)', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>reload view</button>)
                  </span>
                )}
                {moreError && <span style={{ color: '#B91C1C' }}>Couldn't load more: {moreError}</span>}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                  {meta?.has_more ? (
                    <Btn variant="accent" size="sm" onClick={loadMore} disabled={loadingMore}>
                      {loadingMore ? <><Spinner size={12} /> Loading…</> : `Load ${n(Math.min(PAGE_SIZE, total - rows.length))} more`}
                    </Btn>
                  ) : <span style={{ color: '#0B6E4C', fontWeight: 600 }}>All matching executions loaded</span>}
                </span>
              </div>
            )}
          </Card>
        </div>
      </div>

      {auto.error && (
        <div role="alert" style={{
          position: 'fixed', left: 'calc(var(--sidebar-w) + 24px)', bottom: 20, zIndex: 20, maxWidth: 520,
          display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 14px', borderRadius: 10,
          background: '#FFFFFF', border: '1px solid #F3D9AE', borderLeft: '4px solid #B45309', boxShadow: 'var(--shadow-lg)', fontSize: 12.5, color: '#0F172A',
        }}>
          <div>
            <div style={{ fontWeight: 700, color: '#92400E' }}>Couldn't refresh</div>
            <div style={{ color: '#475569', marginTop: 2 }}>
              {auto.error}. Showing data from {lastUpdated ? lastUpdated.toLocaleTimeString('en-GB') : 'the last successful load'}; retrying every {REFRESH_MS / 1000}s.
            </div>
          </div>
          <Btn variant="accent" size="sm" onClick={auto.refresh} disabled={auto.refreshing}>Retry</Btn>
        </div>
      )}

      {view.job && <DetailDrawer jobId={view.job} row={openRow} onClose={closeJob} onUpdate={patchRow} />}
    </div>
  );
}

const dot = (c) => ({ width: 8, height: 8, borderRadius: '50%', background: c, display: 'inline-block' });
const attnBtn = (c, active) => ({
  display: 'inline-flex', alignItems: 'center', gap: 7, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, color: c,
  background: active ? 'var(--nav-blue-bg)' : '#FFFFFF', border: `1px solid ${active ? 'var(--nav-blue)' : '#E2E8F0'}`,
});

// ─── Full-page detail (/jobs/:jobId — linked from the Dashboard) ─────────────
export function JobDetail() {
  const { jobId } = useParams();
  const nav = useNavigate();
  const [row, setRow] = useState(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Topbar
        title={row?.automation_label ? `${row.automation_label}` : 'Execution details'}
        subtitle={row ? `${row.server_name || row.resource_id || ''}${row.created_at ? ` · started ${fmtStarted(row.created_at)}` : ''}` : jobId}
        actions={<Btn variant="accent" size="sm" onClick={() => (window.history.length > 1 ? nav(-1) : nav('/jobs'))}>← Back to executions</Btn>}
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <JobDetailContent jobId={jobId} onUpdate={setRow} />
        </div>
      </div>
    </div>
  );
}
