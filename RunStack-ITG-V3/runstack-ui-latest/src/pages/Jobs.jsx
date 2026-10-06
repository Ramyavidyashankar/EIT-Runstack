// src/pages/Jobs.jsx — Automation Executions
//
// Rundeck-style paging over the whole execution history:
//   • Rows: GET /jobs/query (limit 50, cursor) — only the current page is
//     loaded. The backend reads its list-month-created-index in time order
//     and applies every filter (status, dates, automation, account,
//     environment, search) to the full dataset, not to loaded rows.
//   • Totals: a separate /jobs/query call returns exact status counts for
//     the same filters, so slow counting never delays the rows.
//     "Showing 1–50 of 15,246 executions" = this page vs all matching.
//   • Previous / Next use cursors (no page numbers: jumping to page N would
//     mean reading every earlier page). Changing any filter returns to page 1.
//   • Auto-refresh reloads the CURRENT page and the counts in place; filters,
//     scroll position and the open job drawer are kept. On a refresh error the
//     last good rows stay on screen.
//   • Export: "This page" (rows on screen) or "All matching" (every row for
//     the filters, fetched page by page, capped at 10,000).
//   • Filters, sort, search and the open job live in the URL.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Topbar } from '../components/Layout';
import Tabs from '../components/Tabs';
import { Btn, Card, Empty, ErrorBanner, Input, Spinner, StatusBadge } from '../components/ui';
import { Callout, RefreshControl } from '../components/sections';
import JobDetailContent, { CopyButton } from '../components/JobDetail';
import { queryJobs } from '../api/client';
import { useAutoRefresh, usePageRefresh } from '../hooks/usePageRefresh';
import {
  DATE_PRESETS, downloadText, fmtFull, fmtStarted, jobDuration, jobsToCsv, pageRangeLabel, rangeToQuery, runBreakdown, statusGroup,
} from '../utils/jobs';

const PAGE_SIZE = 50;
const REFRESH_MS = 15000;
const EXPORT_CAP = 10000;
const EXPORT_PAGE = 100;   // backend maximum per request

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
    name: params.get('name') || '',
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
    <label style={{ display: 'grid', gap: 4, fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>
      {label}
      <select className="rs-input" value={value} onChange={(e) => onChange(e.target.value)} style={{
        width, padding: '7px 10px', borderRadius: 8, border: `1px solid ${value ? 'var(--nav-blue)' : '#C3CFDD'}`,
        background: value ? 'var(--nav-blue-bg)' : '#FFFFFF', color: '#172B4D', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
      }}>
        {children}
      </select>
    </label>
  );
}

function Th({ children, width, align }) {
  return (
    <th style={{
      textAlign: align || 'left', padding: '9px 12px', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', background: 'var(--table-head-bg)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', width,
      position: 'sticky', top: 0, zIndex: 1,
    }}>{children}</th>
  );
}

function RunTarget({ job }) {
  const many = (job.server_count || 0) > 1;
  return (
    <>
      <div style={{ fontWeight: 600, color: '#172B4D', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {many ? `${n(job.server_count)} servers` : (job.server_name || job.resource_id || '1 server')}
        {job.app_name && <span style={{ fontWeight: 400, color: '#52647A' }}> · {job.app_name}</span>}
        {!job.app_name && job.app_count > 1 && <span style={{ fontWeight: 400, color: '#52647A' }}> · {job.app_count} applications</span>}
      </div>
      <div style={{ fontSize: 12, color: '#52647A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {runBreakdown(job.run_counts)}
      </div>
    </>
  );
}

function JobRow({ job, selected, onOpen, now }) {
  const group = statusGroup(job.status);
  const isRun = !!job.is_run;
  const dur = jobDuration(job, now);
  const hasName = job.server_name || job.app_name;
  const td = { padding: '8px 12px', borderBottom: '1px solid #F4F6FA', verticalAlign: 'middle', fontSize: 14 };
  const onKey = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } };
  return (
    <tr className="rs-exec-row" tabIndex={0} aria-selected={selected} onClick={onOpen} onKeyDown={onKey}
      style={{ cursor: 'pointer' }}>
      <td style={{ ...td, borderLeft: `3px solid ${GROUP_EDGE[group]}`, maxWidth: 280 }}>
        <div style={{ fontWeight: 600, color: '#172B4D', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={job.document_name}>
          {job.automation_label || job.document_name || job.automation_type || '—'}
        </div>
        <div style={{ fontSize: 12, color: '#52647A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.automation_name && job.automation_name !== job.automation_label ? job.automation_name : job.automation_type}
        </div>
      </td>
      <td style={{ ...td, maxWidth: 240 }}>
        {isRun ? <RunTarget job={job} /> : (<>
        {hasName && (
          <div style={{ fontWeight: 600, color: '#172B4D', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {job.server_name || job.app_name}
            {job.server_name && job.app_name && <span style={{ fontWeight: 400, color: '#52647A' }}> · {job.app_name}</span>}
          </div>
        )}
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: hasName ? 11 : 12, color: hasName ? '#52647A' : '#172B4D', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {job.resource_id || '—'}
        </div>
        </>)}
      </td>
      <td style={td}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#2F4258' }}>
          {job.account_id || (isRun && job.account_count > 1 ? <span style={{ fontFamily: 'var(--font-sans)' }}>{job.account_count} accounts</span> : '—')}
        </div>
        <div style={{ fontSize: 12, color: '#52647A' }}>
          {job.region || (isRun && job.region_count > 1 ? `${job.region_count} regions` : '—')}
          {job.environment ? ` · ${job.environment}` : (isRun && job.environment_count > 1 ? ` · ${job.environment_count} environments` : '')}
        </div>
      </td>
      <td style={td}>
        <StatusBadge status={job.status} />
        {isRun && job.run_outcome === 'partial' && (
          <div style={{ fontSize: 12, color: '#9A3412', marginTop: 3 }}>Finished with failures</div>
        )}
      </td>
      <td style={{ ...td, whiteSpace: 'nowrap', color: '#2F4258' }} title={fmtFull(job.created_at)}>{fmtStarted(job.created_at)}</td>
      <td style={{ ...td, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 13, color: dur.live ? '#B45309' : '#2F4258' }}>
        {dur.text}{dur.live && <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12 }}> so far</span>}
      </td>
      <td style={{ ...td, whiteSpace: 'nowrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {isRun ? (
            <>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#52647A', background: '#F4F6FA', border: '1px solid #D7E0EB', borderRadius: 999, padding: '0 6px' }}>RUN</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--nav-blue-text)' }} title={job.execution_group_id}>
                {String(job.execution_group_id || '').replace(/^grp-[a-z]+-/, '').slice(0, 8)}
              </span>
              <CopyButton value={job.execution_group_id} label="Copy run (execution group) ID" />
            </>
          ) : (
            <>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--nav-blue-text)' }} title={job.job_id}>{(job.job_id || '').slice(0, 8)}</span>
              <CopyButton value={job.job_id} label="Copy job ID" />
            </>
          )}
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
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(620px, 100vw)', background: '#F8FAFD', zIndex: 31,
        boxShadow: '-12px 0 32px rgba(15,23,42,0.18)', display: 'flex', flexDirection: 'column', animation: 'slideIn 0.18s ease both',
      }}>
        <div style={{ padding: '14px 18px', background: 'var(--brand-hover)', color: '#FFFFFF', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, color: '#C4D4EC', fontWeight: 600,}}>Execution details</div>
            <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row?.automation_label || 'Job'} {row?.server_name ? `· ${row.server_name}` : ''}
            </div>
          </div>
          <button type="button" onClick={() => nav(`/jobs/${encodeURIComponent(jobId)}`)} style={{
            background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)', color: '#D7E0EB', borderRadius: 6,
            padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
          }}>Open execution details</button>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close details" style={{
            background: 'none', border: 'none', color: '#D7E0EB', fontSize: 20, cursor: 'pointer', lineHeight: 1, padding: 4,
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
  const [pageMeta, setPageMeta] = useState(null);     // rows response (next_cursor, generated_at)
  const [countsMeta, setCountsMeta] = useState(null); // counts response (status_counts, total_matching, …)
  const [facets, setFacets] = useState({});
  const [cursors, setCursors] = useState([null]);     // cursors[i] = cursor that loads page i
  const [pageIndex, setPageIndex] = useState(0);
  const [rowsState, setRowsState] = useState({ loading: true, error: null, updatedAt: null });
  const [countsState, setCountsState] = useState({ loading: true, error: null, updatedAt: null });
  const [exporting, setExporting] = useState(null);   // null | { done, total }
  const [exportError, setExportError] = useState(null);
  const [exportMenu, setExportMenu] = useState(false);
  const [now, setNow] = useState(Date.now());
  const rowsGen = useRef(0);
  const countsGen = useRef(0);
  const activeQuery = useRef(null);  // filters (with the resolved date window) the current pages belong to
  const lastOpenRow = useRef(null);
  const tableTop = useRef(null);

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  // Search: debounce typing into the URL.
  useEffect(() => { setSearchText(view.q); }, [view.q]);
  useEffect(() => {
    if (searchText === view.q) return undefined;
    const id = setTimeout(() => setView({ q: searchText.trim() }), 350);
    return () => clearTimeout(id);
  }, [searchText]); // eslint-disable-line

  // Everything that defines "the result set" (not the open job or the page).
  const queryKey = JSON.stringify([view.status, view.q, view.automation, view.name, view.account, view.environment, view.sort, view.range, view.from, view.to]);
  const buildQuery = useCallback(() => ({
    // One row per run: servers started together (an execution group) are
    // listed once; the run opens Execution Details with every server.
    group: 'runs',
    status: view.status, q: view.q, automation: view.automation, name: view.name, account: view.account,
    environment: view.environment, sort: view.sort, ...rangeToQuery(view.range, view.from, view.to),
  }), [queryKey]); // eslint-disable-line

  const loadRows = useCallback(async (query, cursor, { background = false } = {}) => {
    const gen = ++rowsGen.current;
    setRowsState((st) => ({ ...st, loading: !background, error: null }));
    try {
      const res = await queryJobs({ ...query, limit: PAGE_SIZE, cursor: cursor || undefined, include_counts: 'false' });
      if (gen !== rowsGen.current) return null;
      setRows(res.jobs || []);
      setPageMeta(res);
      setRowsState({ loading: false, error: null, updatedAt: new Date() });
      return res;
    } catch (e) {
      if (gen === rowsGen.current) setRowsState((st) => ({ ...st, loading: false, error: e.message || String(e) }));
      if (background) throw e;
      return null;
    }
  }, []);

  const loadCounts = useCallback(async (query, { withFacets = false, background = false } = {}) => {
    const gen = ++countsGen.current;
    setCountsState((st) => ({ ...st, loading: !background, error: null }));
    try {
      const res = await queryJobs({ ...query, limit: 1, include_facets: withFacets ? 'true' : undefined, refresh: background ? undefined : 'true' });
      if (gen !== countsGen.current) return;
      setCountsMeta(res);
      if (res.facets) setFacets(res.facets);
      setCountsState({ loading: false, error: null, updatedAt: new Date() });
    } catch (e) {
      if (gen === countsGen.current) setCountsState((st) => ({ ...st, loading: false, error: e.message || String(e) }));
      if (background) throw e;
    }
  }, []);

  // Filters changed (or first visit): back to page 1, rows and counts in parallel.
  useEffect(() => {
    const query = buildQuery();
    activeQuery.current = query;
    // Previous rows stay on screen (dimmed) until the new page arrives.
    loadRows(query, null).then((res) => {
      if (!res) return;
      setCursors(res.next_cursor ? [null, res.next_cursor] : [null]);
      setPageIndex(0);
    });
    loadCounts(query, { withFacets: Object.keys(facets).length === 0 });
  }, [queryKey]); // eslint-disable-line

  // cursors[i] loads page i; after loading page i, cursors[i + 1] = its next_cursor.
  const showPage = async (idx, cursor) => {
    const res = await loadRows(activeQuery.current, cursor);
    if (!res) return;
    setCursors((prev) => {
      const base = [...prev.slice(0, idx), cursor];
      return res.next_cursor ? [...base, res.next_cursor] : base;
    });
    setPageIndex(idx);
    tableTop.current?.scrollIntoView({ block: 'nearest' });
  };
  const goToPage = (idx) => { if (idx >= 0 && idx < cursors.length) showPage(idx, cursors[idx]); };
  const nextPage = () => { if (pageMeta?.next_cursor) showPage(pageIndex + 1, pageMeta.next_cursor); };

  // Background refresh: same page, same filters, rows + counts in place.
  // Page 1 re-resolves a preset date window ("last 24 hours" moves with time).
  const softRefresh = useCallback(async () => {
    if (!activeQuery.current) return;
    if (pageIndex === 0) activeQuery.current = buildQuery();
    const query = activeQuery.current;
    const results = await Promise.allSettled([
      loadRows(query, cursors[pageIndex], { background: true }).then((res) => {
        if (res) setCursors((prev) => (res.next_cursor ? [...prev.slice(0, pageIndex + 1), res.next_cursor] : prev.slice(0, pageIndex + 1)));
      }),
      loadCounts(query, { background: true }),
    ]);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, [pageIndex, cursors, buildQuery, loadRows, loadCounts]);

  const auto = useAutoRefresh(softRefresh, { intervalMs: REFRESH_MS, enabled: !rowsState.loading && !!pageMeta });
  usePageRefresh(auto.refresh);

  // Selecting an execution opens Execution Details (per-server status and
  // output). The ?job= side panel still opens for existing links.
  const nav = useNavigate();
  const openJob = (id) => nav(`/jobs/${encodeURIComponent(id)}`, { state: { row: rows.find((j) => j.job_id === id) || null } });
  const closeJob = useCallback(() => setView({ job: '' }, { replace: false }), [setView]);
  const patchRow = useCallback((d) => {
    setRows((prev) => prev.map((j) => (j.job_id === d.job_id
      ? { ...j, status: d.status, updated_at: d.updated_at, execution_id: d.execution_id, server_name: d.server_name ?? j.server_name, app_name: d.app_name ?? j.app_name }
      : j)));
  }, []);

  const exportPage = () => {
    setExportMenu(false);
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadText(jobsToCsv(rows), `runstack-executions-page${pageIndex + 1}-${stamp}.csv`);
  };
  const exportAll = async () => {
    setExportMenu(false);
    const total = Math.min(countsMeta?.total_matching || 0, EXPORT_CAP);
    if (!total) return;
    setExporting({ done: 0, total }); setExportError(null);
    try {
      const all = [];
      let cursor;
      do {
        const res = await queryJobs({ ...activeQuery.current, limit: EXPORT_PAGE, cursor, include_counts: 'false' });
        all.push(...(res.jobs || []));
        setExporting({ done: Math.min(all.length, total), total });
        cursor = res.next_cursor;
      } while (cursor && all.length < total);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      downloadText(jobsToCsv(all.slice(0, total)), `runstack-executions-all-matching-${stamp}.csv`);
    } catch (e) {
      setExportError(e.message || String(e));
    } finally {
      setExporting(null);
    }
  };

  // ── Derived ─────────────────────────────────────────────────────────────
  const counts = countsMeta?.status_counts || {};
  const total = countsMeta?.total_matching;
  const countsComplete = countsMeta?.counts_complete !== false;
  const filtersActive = !!(view.q || view.automation || view.name || view.account || view.environment || view.range !== '7d' || view.status !== 'ALL');
  const openRow = rows.find((j) => j.job_id === view.job) || (lastOpenRow.current?.job_id === view.job ? lastOpenRow.current : undefined);
  if (openRow) lastOpenRow.current = openRow;
  const rangeLabel = DATE_PRESETS.find((p) => p.value === view.range)?.label || 'Custom range';
  const windowStart = activeQuery.current?.from ? fmtStarted(activeQuery.current.from) : null;
  const hasNext = !!pageMeta?.next_cursor;
  const lastUpdated = [rowsState.updatedAt, countsState.updatedAt].filter(Boolean).sort((a, b) => a - b)[0] || null;
  // A refresh error is only current while the last request actually failed;
  // a later successful load (e.g. after a filter change) clears it.
  const refreshError = auto.error && (rowsState.error || countsState.error) ? auto.error : null;
  const showing = rowsState.loading && pageMeta ? 'Loading…' : pageMeta ? pageRangeLabel({ pageIndex, pageSize: PAGE_SIZE, returned: rows.length, total, complete: countsComplete }) : null;

  const subtitle = total != null
    ? `${n(total)} matching${countsComplete ? '' : '+'} · ${n(countsMeta.total_in_table)} executions recorded in RunStack`
    : countsState.error ? 'Totals unavailable' : 'Counting matching executions…';

  return (
    <div className="rs-page">
      <Topbar
        title="Automation Executions"
        subtitle={subtitle}
        actions={<>
          <RefreshControl onRefresh={auto.refresh} refreshing={auto.refreshing} lastUpdated={lastUpdated}
            autoEverySec={REFRESH_MS / 1000} error={refreshError} />
          <div style={{ position: 'relative' }}>
            <Btn variant="navy" size="sm" onClick={() => setExportMenu((v) => !v)} disabled={!!exporting || !rows.length} aria-haspopup="menu" aria-expanded={exportMenu}>
              {exporting ? <><Spinner size={12} /> Exporting {n(exporting.done)} / {n(exporting.total)}</> : '↓ Export CSV ▾'}
            </Btn>
            {exportMenu && (
              <div role="menu" style={{
                position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 40, width: 300, background: '#FFFFFF',
                border: '1px solid #D7E0EB', borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 6,
              }}>
                <ExportChoice title={`This page (${n(rows.length)} rows)`} sub={showing || ''} onClick={exportPage} />
                <ExportChoice
                  title={total > EXPORT_CAP ? `All matching — first ${n(EXPORT_CAP)} of ${n(total)}` : `All matching (${n(total ?? 0)} rows)`}
                  sub={`Every execution for the current filters, newest first${total > EXPORT_CAP ? '. Narrow the filters to export the rest.' : ''}`}
                  onClick={exportAll} disabled={!total} />
              </div>
            )}
          </div>
        </>}
      />

      {/* Subtle in-place loading indicator (refresh, paging) */}
      <div aria-hidden style={{ height: 2, background: 'transparent', overflow: 'hidden', position: 'relative' }}>
        {(auto.refreshing || (rowsState.loading && rows.length > 0)) && (
          <div style={{ position: 'absolute', inset: 0, width: '35%', background: 'var(--nav-blue)', animation: 'rs-indeterminate 1.1s ease-in-out infinite' }} />
        )}
      </div>

      <div className="rs-page-body">
        <div className="rs-page-content">

          {exportError && <ErrorBanner message={`Export failed: ${exportError}`} />}
          {countsMeta && !countsComplete && (
            <Callout tone="warning" title="Totals are partial">
              {countsMeta.count_source === 'scan'
                ? 'The job counters are not set up yet (run the job-stats backfill), so totals cover only the jobs RunStack could scan.'
                : 'Counting every match for this search took too long, so the total is a lower bound. Narrow the date range or filters for an exact number.'}
            </Callout>
          )}

          {/* ── Attention: running + failed within the current filters ── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '10px 14px', borderRadius: 10,
            background: '#FFFFFF', border: '1px solid #D7E0EB', boxShadow: 'var(--shadow-sm)', minHeight: 44,
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',}}>Needs a look</span>
            {countsState.loading && (
              <span style={{ display: 'inline-flex' }} title="Counting executions for these filters"><Spinner size={12} /></span>
            )}
            {!countsMeta ? (
              countsState.error
                ? <span style={{ fontSize: 13, color: '#B91C1C' }}>Couldn't load totals: {countsState.error} <Btn variant="ghost" size="sm" onClick={() => loadCounts(activeQuery.current)}>Retry</Btn></span>
                : <span style={{ fontSize: 13, color: '#52647A', display: 'inline-flex', gap: 8, alignItems: 'center' }}><Spinner size={12} /> Counting…</span>
            ) : (
              <>
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
                  <span style={{ fontSize: 13, color: '#0B6E4C', fontWeight: 600, padding: '4px 0' }}>Nothing failed or in progress</span>
                )}
              </>
            )}
            <span style={{ fontSize: 12, color: '#52647A', marginLeft: 'auto' }}>
              {rangeLabel}{windowStart ? ` (since ${windowStart})` : ''}{view.automation || view.name || view.account || view.environment || view.q ? ' · with your filters' : ''}
            </span>
          </div>

          {/* ── Filters ── */}
          <Card style={{ padding: 14, display: 'grid', gap: 12, overflow: 'visible' }}>
            <Tabs label="Status" idPrefix="rs-jobs-status" size="sm" active={view.status} onChange={(v) => setView({ status: v })}
              tabs={STATUS_TABS.map((t) => ({ value: t.key, label: t.label, hint: t.hint, count: typeof counts[t.key] === 'number' ? counts[t.key] : '—' }))}
              after={<span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Counts cover every execution matching the filters, not just this page.</span>} />

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ display: 'grid', gap: 4, fontSize: 13, color: 'var(--text-primary)', fontWeight: 600, flex: '1 1 220px', maxWidth: 420 }}>
                Search
                <Input type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)}
                  placeholder="Job, execution or resource ID, server, app, account, automation…"
                  aria-describedby="exec-search-help" style={{ fontSize: 13, padding: '7px 10px' }} />
              </label>
              <FilterSelect label="Date range" value={view.range === '7d' ? '' : view.range} onChange={(v) => setView({ range: v || '7d', ...(v !== 'custom' ? { from: '', to: '' } : {}) })} width={140}>
                {DATE_PRESETS.map((p) => <option key={p.value} value={p.value === '7d' ? '' : p.value}>{p.label}</option>)}
              </FilterSelect>
              {view.range === 'custom' && (
                <>
                  <label style={{ display: 'grid', gap: 4, fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>
                    From
                    <Input type="datetime-local" value={view.from} onChange={(e) => setView({ from: e.target.value })} style={{ padding: '6px 8px', fontSize: 13 }} />
                  </label>
                  <label style={{ display: 'grid', gap: 4, fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>
                    Before
                    <Input type="datetime-local" value={view.to} onChange={(e) => setView({ to: e.target.value })} style={{ padding: '6px 8px', fontSize: 13 }} />
                  </label>
                </>
              )}
              <FilterSelect label="Automation" value={view.automation} onChange={(v) => setView({ automation: v })} width={190}>
                <option value="">All automations</option>
                {(facets.automations || []).map((f) => <option key={f.value} value={f.value}>{f.value} ({n(f.count)})</option>)}
                {view.automation && !(facets.automations || []).some((f) => f.value === view.automation) && <option value={view.automation}>{view.automation}</option>}
              </FilterSelect>
              {/* Name given when the job was submitted (e.g. a schedule's
                  automation_name). Only jobs that have a name are listed. */}
              {((facets.names || []).length > 0 || view.name) && (
                <FilterSelect label="Automation name" value={view.name} onChange={(v) => setView({ name: v })} width={220}>
                  <option value="">All automation names</option>
                  {(facets.names || []).map((f) => <option key={f.value} value={f.value}>{f.value} ({n(f.count)})</option>)}
                  {view.name && !(facets.names || []).some((f) => f.value === view.name) && <option value={view.name}>{view.name}</option>}
                </FilterSelect>
              )}
              <FilterSelect label="Account" value={view.account} onChange={(v) => setView({ account: v })} width={160}>
                <option value="">All accounts</option>
                {(facets.accounts || []).map((f) => <option key={f.value} value={f.value}>{f.value} ({n(f.count)})</option>)}
                {view.account && !(facets.accounts || []).some((f) => f.value === view.account) && <option value={view.account}>{view.account}</option>}
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
                <Btn variant="ghost" size="sm" onClick={() => { setSearchText(''); setView({ status: 'ALL', q: '', automation: '', name: '', account: '', environment: '', range: '7d', from: '', to: '' }); }}>
                  Clear filters
                </Btn>
              )}
            </div>
            <div id="exec-search-help" style={{ fontSize: 12, color: '#52647A', marginTop: -4 }}>
              {SEARCH_HELP} Numbers in the filter lists are all-time counts. Environment is only available for jobs submitted with it.
            </div>
          </Card>

          {/* ── Table ── */}
          <Card style={{ overflow: 'hidden' }}>
            <div ref={tableTop} />
            {rowsState.loading && rows.length === 0 ? (
              <div style={{ padding: 56, display: 'flex', justifyContent: 'center', gap: 10, alignItems: 'center', color: '#52647A', fontSize: 13 }}>
                <Spinner /> Loading executions…
              </div>
            ) : rowsState.error && rows.length === 0 ? (
              <div style={{ padding: 20 }}>
                <ErrorBanner message={`Could not load executions: ${rowsState.error}`} />
                <Btn variant="navy" size="sm" onClick={() => goToPage(pageIndex)}>Try again</Btn>
              </div>
            ) : rows.length === 0 ? (
              <Empty message={filtersActive ? 'No executions match these filters.' : 'No executions recorded yet.'} />
            ) : (
              <div style={{ overflowX: 'auto', opacity: rowsState.loading ? 0.55 : 1, transition: 'opacity 0.12s' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1080 }}>
                  <thead>
                    <tr>
                      <Th>Automation</Th><Th>Target</Th><Th width={170}>Account / Region</Th><Th width={130}>Status</Th>
                      <Th width={130}>Started</Th><Th width={110}>Duration</Th><Th width={150}>Job / Run ID</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((j) => (
                      <JobRow key={j.job_id} job={j} now={now} selected={view.job === j.job_id} onOpen={() => openJob(j.job_id)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {(rows.length > 0 || pageIndex > 0) && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: '1px solid #D7E0EB', background: '#F8FAFD',
                fontSize: 13, color: '#52647A', flexWrap: 'wrap',
              }}>
                <span aria-live="polite"><strong>{showing}</strong>{countsMeta?.count_source && <span style={{ color: '#52647A' }} title={countsMeta.count_source === 'counters' ? 'Total from the hourly job counters' : countsMeta.count_source === 'index' ? 'Total counted from the time index for these filters' : 'Total from a table scan'}> · page {pageIndex + 1}</span>}</span>
                {rowsState.error && rows.length > 0 && (
                  <span style={{ color: '#B91C1C' }}>Couldn't load that page: {rowsState.error} — showing the previous rows.</span>
                )}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Btn variant="default" size="sm" onClick={() => goToPage(0)} disabled={pageIndex === 0 || rowsState.loading}>« First</Btn>
                  <Btn variant="default" size="sm" onClick={() => goToPage(pageIndex - 1)} disabled={pageIndex === 0 || rowsState.loading}>‹ Previous</Btn>
                  <Btn variant="accent" size="sm" onClick={nextPage} disabled={!hasNext || rowsState.loading}>
                    {rowsState.loading && rows.length > 0 ? <><Spinner size={12} /> Loading…</> : 'Next ›'}
                  </Btn>
                </span>
              </div>
            )}
          </Card>
        </div>
      </div>

      {refreshError && (
        <div role="alert" style={{
          position: 'fixed', left: 'calc(var(--sidebar-w) + 24px)', bottom: 20, zIndex: 20, maxWidth: 520,
          display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 14px', borderRadius: 10,
          background: '#FFFFFF', border: '1px solid #F3D9AE', borderLeft: '4px solid #B45309', boxShadow: 'var(--shadow-lg)', fontSize: 13, color: '#172B4D',
        }}>
          <div>
            <div style={{ fontWeight: 600, color: '#92400E' }}>Couldn't refresh</div>
            <div style={{ color: '#52647A', marginTop: 2 }}>
              {refreshError}. Showing data from {lastUpdated ? lastUpdated.toLocaleTimeString('en-GB') : 'the last successful load'}; retrying every {REFRESH_MS / 1000}s.
            </div>
          </div>
          <Btn variant="accent" size="sm" onClick={auto.refresh} disabled={auto.refreshing}>Retry</Btn>
        </div>
      )}

      {view.job && <DetailDrawer jobId={view.job} row={openRow} onClose={closeJob} onUpdate={patchRow} />}
    </div>
  );
}

function ExportChoice({ title, sub, onClick, disabled }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled} style={{
      display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 8, border: 'none',
      background: 'transparent', cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: disabled ? 0.5 : 1,
    }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#F4F6FA'; }} onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#172B4D' }}>{title}</div>
      <div style={{ fontSize: 12, color: '#52647A', marginTop: 2 }}>{sub}</div>
    </button>
  );
}

const dot = (c) => ({ width: 8, height: 8, borderRadius: '50%', background: c, display: 'inline-block' });
const attnBtn = (c, active) => ({
  display: 'inline-flex', alignItems: 'center', gap: 7, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 13, fontWeight: 600, color: c,
  background: active ? 'var(--nav-blue-bg)' : '#FFFFFF', border: `1px solid ${active ? 'var(--nav-blue)' : '#D7E0EB'}`,
});

// ─── Full-page detail (/jobs/:jobId — linked from the Dashboard) ─────────────
export function JobDetail() {
  const { jobId } = useParams();
  const nav = useNavigate();
  const [row, setRow] = useState(null);
  return (
    <div className="rs-page">
      <Topbar
        title={row?.automation_label ? `${row.automation_label}` : 'Execution details'}
        subtitle={row ? `${row.server_name || row.resource_id || ''}${row.created_at ? ` · started ${fmtStarted(row.created_at)}` : ''}` : jobId}
        actions={<Btn variant="accent" size="sm" onClick={() => (window.history.length > 1 ? nav(-1) : nav('/jobs'))}>← Back to executions</Btn>}
      />
      <div className="rs-page-body">
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <JobDetailContent jobId={jobId} onUpdate={setRow} />
        </div>
      </div>
    </div>
  );
}
