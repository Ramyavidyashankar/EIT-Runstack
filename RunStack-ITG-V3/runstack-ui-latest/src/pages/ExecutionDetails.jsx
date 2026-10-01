// src/pages/ExecutionDetails.jsx — Rundeck-style Execution Details
//
// Opened from Automation Executions (and the Dashboard) at /jobs/:jobId.
// For a job that belongs to an explicit execution group (one scheduled run,
// one batch health-check sweep) it shows every server in that run; for any
// other job it shows that job's own targets.
//
// Layout
//   header      status, automation, group/job ID, trigger line
//   metadata    three compact columns
//   progress    ring (finished / total) + Succeeded / Running / Pending /
//               Failed cards (Failed includes timed out)
//   tabs        Targets (table, search, status filter, page size, export)
//               Execution Details (identifiers, trigger, timing)
//   drawer      one server's status, Output / Steps / Details — opened from
//               the table; nothing per-server loads until then
//
// Data (all through the existing authenticated apiFetch → API Gateway →
// process_messages flow; the backend checks access before reading AWS):
//   GET /jobs/{jobId}/execution  header, counts, one page of servers and —
//                                while the drawer is open — that server's
//                                detail; polled ~5 s while the run is active,
//                                stopped once it's finished
//   GET /jobs/{jobId}/logs       the open server's output (OutputPanel)
//
// Retry / Cancel / Retry history / Audit trail are not shown: they need
// backend support that doesn't exist yet.
//
// Pausing updates stops this page asking for data; it never pauses the
// automation. Errors reading status are shown separately from the
// execution's own result.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Topbar } from '../components/Layout';
import { Btn, Card, ErrorBanner, Spinner } from '../components/ui';
import { Callout, fmtClock } from '../components/sections';
import { useLogBuffers } from '../components/execution/OutputPanel';
import { ExecutionTitle, ExecutionTopbar } from '../components/execution/ExecutionHeader';
import ExecutionMetadata from '../components/execution/ExecutionMetadata';
import ExecutionProgress from '../components/execution/ExecutionProgress';
import TargetFilters, { PAGE_SIZES } from '../components/execution/TargetFilters';
import TargetTable from '../components/execution/TargetTable';
import TargetOutputDrawer from '../components/execution/TargetOutputDrawer';
import ExecutionInfoTab from '../components/execution/ExecutionInfoTab';
import { fetchExecution } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { downloadText, parseUtc } from '../utils/jobs';
import { exportFileName, fetchAllTargets, targetsToCsv } from '../utils/exportTargets';

const DEFAULT_PAGE_SIZE = PAGE_SIZES[0];
const EMPTY_QUERY = { q: '', status: '', cursor: '', limit: DEFAULT_PAGE_SIZE };

export default function ExecutionDetails() {
  const { jobId } = useParams();
  const nav = useNavigate();
  const location = useLocation();
  const initialRow = location.state?.row || null;

  const [data, setData] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [query, setQuery] = useState(EMPTY_QUERY);
  const [tab, setTab] = useState('targets');
  const [drawer, setDrawer] = useState(null);          // the target row that was opened
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [exporting, setExporting] = useState(null);    // progress text while exporting
  const [exportError, setExportError] = useState(null);
  const getBuffer = useLogBuffers();
  const drawerKeyRef = useRef('');
  drawerKeyRef.current = drawer?.key || '';
  const exportAbort = useRef(null);

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => () => exportAbort.current?.abort(), []);

  // Reset when navigating to another execution.
  useEffect(() => {
    setData(null); setNotFound(false); setDrawer(null); setQuery(EMPTY_QUERY); setTab('targets');
    setExportError(null); exportAbort.current?.abort();
  }, [jobId]);

  const load = useCallback(async (signal) => {
    const res = await fetchExecution(jobId, {
      limit: query.limit, cursor: query.cursor, q: query.q, status: query.status, target: drawerKeyRef.current || undefined,
    }, { signal });
    setNotFound(false);
    setData(res);
    const interval = res.poll?.status_interval_ms || 5000;
    return res.execution?.is_active ? { nextDelayMs: interval } : { stop: true };
  }, [jobId, query]);

  const active = data ? data.execution?.is_active : true;
  const intervalMs = data?.poll?.status_interval_ms || 5000;
  const drawerKey = drawer?.key || '';
  const poll = usePolling(load, {
    intervalMs,
    enabled: !paused && active,
    key: `${jobId}|${query.q}|${query.status}|${query.cursor}|${query.limit}|${drawerKey}`,
  });
  usePageRefresh(poll.refresh);

  // Right after a run is submitted its first job can take a few seconds to
  // be created; treat "not found" as "starting" for the first minute.
  const justSubmitted = !!location.state?.justSubmitted;
  const openedAt = useRef(Date.now());
  useEffect(() => { openedAt.current = Date.now(); }, [jobId]);
  useEffect(() => {
    if (poll.error?.kind !== 'not_found' || data) return;
    if (justSubmitted && Date.now() - openedAt.current < 60000) return;
    setNotFound(true);
  }, [poll.error, data, justSubmitted]);
  const starting = justSubmitted && !data && poll.error?.kind === 'not_found' && !notFound;

  // Finished executions don't auto-poll, but opening a server (or changing
  // search/filter/page) still needs one fetch.
  const lastKey = useRef('');
  useEffect(() => {
    const k = `${query.q}|${query.status}|${query.cursor}|${query.limit}|${drawerKey}`;
    if (lastKey.current && lastKey.current !== k && !active) poll.refresh();
    lastKey.current = k;
  }, [query, drawerKey, active]); // eslint-disable-line

  const exec = data?.execution;
  const counts = data?.counts;
  const targets = data?.targets || [];
  const selected = data?.selected && data.selected.target?.key === drawerKey ? data.selected : null;
  // Freshest view of the open server: its detail, else its row on this page, else the row clicked.
  const drawerTarget = drawer
    ? (selected?.target || targets.find((t) => t.key === drawerKey) || drawer)
    : null;
  const isEc2 = exec?.automation_type === 'EC2-Action';

  const setFilter = (changes) => setQuery((q) => ({ ...q, ...changes, cursor: '' }));
  const closeDrawer = useCallback(() => setDrawer(null), []);

  const title = exec?.automation_name || initialRow?.automation_label || 'Execution details';
  const startMs = parseUtc(exec?.started_at)?.getTime();
  const endMs = parseUtc(exec?.ended_at)?.getTime();
  const elapsedSec = startMs ? (((exec.is_active ? now : endMs || now) - startMs) / 1000) : null;

  const onExport = async () => {
    setExportError(null);
    exportAbort.current?.abort();
    const ctl = new AbortController();
    exportAbort.current = ctl;
    setExporting('Exporting…');
    try {
      const { rows, complete } = await fetchAllTargets(
        (params, opts) => fetchExecution(jobId, params, opts),
        { q: query.q, status: query.status },
        { signal: ctl.signal, onProgress: ({ loaded, total }) => setExporting(`Exporting ${loaded.toLocaleString()} / ${total.toLocaleString()}`) },
      );
      downloadText(targetsToCsv(rows), exportFileName(exec));
      if (!complete) setExportError('The export stopped at the size limit; not every server is included.');
    } catch (e) {
      if (e?.name !== 'AbortError') setExportError(`Export failed: ${e?.message || 'unknown error'}`);
    } finally {
      if (exportAbort.current === ctl) exportAbort.current = null;
      setExporting(null);
    }
  };

  if (notFound) {
    return (
      <div className="rs-page">
        <Topbar title="Execution details" subtitle={jobId}
          actions={<Btn variant="accent" size="sm" onClick={() => nav('/jobs')}>← Automation Executions</Btn>} />
        <div style={{ padding: 24, maxWidth: 720 }}>
          <Callout tone="warning" title="Execution not found">
            This execution doesn't exist, or you don't have access to its servers. Access follows the same rules as running it:
            your application access, your team's capabilities, or having started it yourself.
          </Callout>
        </div>
      </div>
    );
  }

  const tabs = [
    { k: 'targets', l: <>Targets{counts ? <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, marginLeft: 6 }}>({counts.total.toLocaleString()})</span> : null}</> },
    { k: 'details', l: 'Execution Details' },
  ];
  const filtered = !!(query.q || query.status);

  return (
    <div className="rs-page">
      <ExecutionTopbar title={title} active={active} paused={paused} onTogglePause={() => setPaused((p) => !p)}
        poll={poll} intervalMs={intervalMs} />

      <div className="rs-page-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {paused && (
          <Callout tone="info" title="Updates paused">
            The page has stopped refreshing. The automation keeps running in AWS — resume to see its latest status and output.
          </Callout>
        )}
        {poll.error && data && poll.error.kind !== 'not_found' && (
          <Callout tone="warning" title="Couldn't refresh the execution status">
            {poll.error.message} The values below are from {fmtClock(poll.lastSuccess)}. This is a problem reading the status,
            not a failure of the execution. {poll.error.kind === 'auth' ? '' : 'Retrying automatically.'}
          </Callout>
        )}
        {!data && poll.error && poll.error.kind !== 'not_found' && !starting && (
          <ErrorBanner message={`Could not load this execution: ${poll.error.message}`} />
        )}

        {/* ── Header, metadata, progress ── */}
        <Card style={{ padding: '16px 18px', display: 'grid', gap: 16, flexShrink: 0 }}>
          {!exec ? (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}>
              <Spinner size={14} /> {starting ? 'Starting the run — waiting for RunStack to create the first job…' : 'Loading execution…'}
            </div>
          ) : (
            <>
              <ExecutionTitle exec={exec} fallbackTitle={title} />
              <div style={{ borderTop: '1px solid var(--slate-100)', paddingTop: 12 }}>
                <ExecutionMetadata exec={exec} counts={counts} hiddenJobs={data?.hidden_jobs || 0} elapsedSec={elapsedSec} />
              </div>
              {counts && (
                <div style={{ borderTop: '1px solid var(--slate-100)', paddingTop: 14 }}>
                  <ExecutionProgress counts={counts} />
                </div>
              )}
              {data?.members_truncated && (
                <Callout tone="warning">This run has more servers than RunStack reads at once; counts cover the first {counts?.total?.toLocaleString()} only.</Callout>
              )}
            </>
          )}
        </Card>

        {/* ── Tabs ── */}
        <Card style={{ padding: 0, display: 'flex', flexDirection: 'column', minWidth: 0, flexShrink: 0 }}>
          <div role="tablist" aria-label="Execution views" style={{ display: 'flex', gap: 2, padding: '0 14px', borderBottom: '1px solid var(--border)' }}>
            {tabs.map((t) => (
              <button key={t.k} type="button" role="tab" aria-selected={tab === t.k} onClick={() => setTab(t.k)}
                style={{
                  padding: '11px 12px', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: 'none', border: 'none',
                  color: tab === t.k ? 'var(--brand-hover)' : 'var(--text-tertiary)',
                  borderBottom: `2px solid ${tab === t.k ? 'var(--brand)' : 'transparent'}`, marginBottom: -1,
                }}>{t.l}</button>
            ))}
          </div>

          <div role="tabpanel" style={{ padding: 14, display: 'grid', gap: 12, minWidth: 0 }}>
            {tab === 'targets' && (
              <>
                <TargetFilters
                  counts={counts}
                  status={query.status} onStatus={(status) => setFilter({ status })}
                  search={query.q} onSearch={(q) => setFilter({ q })}
                  pageSize={query.limit} onPageSize={(limit) => setFilter({ limit })}
                  onExport={onExport} exporting={exporting} exportDisabled={!data || !data.total_matching}
                  exportNote={active ? 'Exports status as of now — the run is still in progress.' : undefined}
                />
                {exportError && <Callout tone="warning">{exportError}</Callout>}
                {data?.live_status_deferred > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    Live status for {data.live_status_deferred} more server{data.live_status_deferred === 1 ? '' : 's'} on this page arrives on the next refresh.
                  </div>
                )}
                <TargetTable
                  targets={targets} selectedKey={drawerKey} onOpen={(t) => setDrawer(t)} now={now}
                  loading={!data || (poll.refreshing && !targets.length)}
                  total={data?.total_matching || 0} offset={data?.offset || 0} limit={data?.limit || query.limit}
                  hasPrev={!!data?.prev_cursor} hasNext={!!data?.next_cursor}
                  onPrev={() => setQuery((q) => ({ ...q, cursor: data?.prev_cursor || '' }))}
                  onNext={() => setQuery((q) => ({ ...q, cursor: data?.next_cursor || '' }))}
                  hiddenJobs={data?.hidden_jobs || 0} filtered={filtered}
                />
              </>
            )}
            {tab === 'details' && <ExecutionInfoTab exec={exec} counts={counts} data={data} elapsedSec={elapsedSec} />}
          </div>
        </Card>
      </div>

      {drawerTarget && (
        <TargetOutputDrawer jobId={jobId} target={drawerTarget} selected={selected} paused={paused}
          getBuffer={getBuffer} isEc2={isEc2} onClose={closeDrawer} now={now} />
      )}
    </div>
  );
}
