// src/pages/ExecutionDetails.jsx — Rundeck-style Execution Details
//
// Opened from Automation Executions (and the Dashboard) at /jobs/:jobId.
// For a job that belongs to an explicit execution group (one scheduled run,
// one batch health-check sweep) it shows every server in that run; for any
// other job it shows that job's own targets.
//
// Data (all through the existing authenticated apiFetch → API Gateway →
// process_messages flow; the backend checks access before reading AWS):
//   GET /jobs/{jobId}/execution  header, counts, a page of servers and the
//                                selected server's Steps/Details — polled
//                                about every 5 s while the run is active
//   GET /jobs/{jobId}/logs       the selected server's output (OutputPanel)
//
// Pausing updates stops this page asking for data; it never pauses the
// automation. Errors reading status are shown separately from the
// execution's own result.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Topbar } from '../components/Layout';
import { Btn, Card, ErrorBanner, Spinner, TypeTag } from '../components/ui';
import { Callout, fmtClock } from '../components/sections';
import { CopyButton } from '../components/JobDetail';
import ServerList, { TargetStatusChip } from '../components/execution/ServerList';
import OutputPanel, { useLogBuffers } from '../components/execution/OutputPanel';
import { DetailsPanel, StepsPanel } from '../components/execution/StepsAndDetails';
import { fetchExecution } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { fmtFull } from '../utils/jobs';
import {
  OVERALL_STATUS, TARGET_STATUS, fmtElapsed, isActiveTarget, progressOf, targetElapsed,
} from '../utils/executionLogs';

const PAGE_SIZE = 100;

function pickDefault(targets) {
  return (targets.find((t) => t.status === 'running')
    || targets.find((t) => ['failed', 'timed_out', 'cancelled'].includes(t.status))
    || targets[0])?.key;
}

function OverallBadge({ status }) {
  const m = OVERALL_STATUS[status] || OVERALL_STATUS.unknown;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999,
      background: m.bg, color: m.color, fontSize: 11.5, fontWeight: 700, border: `1px solid ${m.color}33`,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.color, animation: m.pulse ? 'pulse 1.6s ease infinite' : 'none' }} />
      {m.label}
    </span>
  );
}

function Meta({ label, children, mono }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontSize: 12.5, color: '#0F172A', fontWeight: 600, marginTop: 2, fontFamily: mono ? 'var(--font-mono)' : 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {children ?? '—'}
      </div>
    </div>
  );
}

function CountPill({ label, value, status, active, onClick }) {
  const m = TARGET_STATUS[status];
  return (
    <button type="button" onClick={onClick} aria-pressed={active} title={`Show ${label.toLowerCase()} servers`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 12, fontWeight: 600, color: m ? m.color : '#0F172A',
        background: active ? 'var(--brand-bg)' : '#FFFFFF', border: `1px solid ${active ? 'var(--brand)' : '#E2E8F0'}`,
      }}>
      {m && <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.dot }} />}
      {label} <span style={{ fontFamily: 'var(--font-mono)', color: '#0F172A' }}>{(value || 0).toLocaleString()}</span>
    </button>
  );
}

function ProgressBar({ counts }) {
  const p = progressOf(counts);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: '#475569', marginBottom: 5 }}>
        <span><strong style={{ color: '#0F172A' }}>{p.finishedPct}% finished</strong> · {p.label}</span>
        {p.active > 0 && <span>{p.active} still pending or running</span>}
      </div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p.finishedPct}
        aria-label={`${p.finished} of ${p.total} targets finished`}
        style={{ display: 'flex', height: 8, borderRadius: 999, overflow: 'hidden', background: '#E2E8F0' }}>
        <div style={{ width: `${p.successPct}%`, background: TARGET_STATUS.success.dot }} title={`${p.successful} succeeded`} />
        <div style={{ width: `${p.unsuccessfulPct}%`, background: TARGET_STATUS.failed.dot }} title={`${p.unsuccessful} did not succeed`} />
        <div style={{ width: `${p.runningPct}%`, background: TARGET_STATUS.running.dot, opacity: 0.55 }} title="running" />
      </div>
    </div>
  );
}

export default function ExecutionDetails() {
  const { jobId } = useParams();
  const nav = useNavigate();
  const location = useLocation();
  const initialRow = location.state?.row || null;

  const [data, setData] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [query, setQuery] = useState({ q: '', status: '', cursor: '' });
  const [selectedKey, setSelectedKey] = useState('');
  const [tab, setTab] = useState('output');
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(Date.now());
  const getBuffer = useLogBuffers();
  const selectedRef = useRef(selectedKey);
  selectedRef.current = selectedKey;

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  // Reset when navigating to another execution.
  useEffect(() => { setData(null); setNotFound(false); setSelectedKey(''); setQuery({ q: '', status: '', cursor: '' }); setTab('output'); }, [jobId]);

  const load = useCallback(async (signal) => {
    const res = await fetchExecution(jobId, {
      limit: PAGE_SIZE, cursor: query.cursor, q: query.q, status: query.status, target: selectedRef.current || undefined,
    }, { signal });
    setNotFound(false);
    setData(res);
    if (!selectedRef.current && res.targets?.length) {
      setSelectedKey(pickDefault(res.targets));
    }
    const interval = res.poll?.status_interval_ms || 5000;
    return res.execution?.is_active ? { nextDelayMs: interval } : { stop: true };
  }, [jobId, query]);

  const active = data ? data.execution?.is_active : true;
  const poll = usePolling(load, {
    intervalMs: data?.poll?.status_interval_ms || 5000,
    enabled: !paused && active,
    key: `${jobId}|${query.q}|${query.status}|${query.cursor}|${selectedKey}`,
  });
  usePageRefresh(poll.refresh);

  useEffect(() => { if (poll.error?.kind === 'not_found' && !data) setNotFound(true); }, [poll.error, data]);

  // Finished executions don't auto-poll, but picking another server (or
  // changing search/filter/page) still needs one fetch.
  const lastKey = useRef('');
  useEffect(() => {
    const k = `${query.q}|${query.status}|${query.cursor}|${selectedKey}`;
    if (lastKey.current && lastKey.current !== k && !active) poll.refresh();
    lastKey.current = k;
  }, [query, selectedKey, active]); // eslint-disable-line

  const exec = data?.execution;
  const counts = data?.counts;
  const targets = data?.targets || [];
  const selected = data?.selected && data.selected.target?.key === selectedKey ? data.selected : null;
  const selectedTarget = selected?.target || targets.find((t) => t.key === selectedKey) || null;
  const isEc2 = exec?.automation_type === 'EC2-Action';
  const hasSteps = !!(selected && ((selected.steps || []).length || (selected.plugins || []).length));
  const showOutputTab = !selectedTarget || selectedTarget.output_mode !== 'none' || isEc2;
  const tabs = [
    showOutputTab && { k: 'output', l: 'Output' },
    hasSteps && { k: 'steps', l: 'Steps' },
    { k: 'details', l: 'Details' },
  ].filter(Boolean);
  const activeTab = tabs.some((t) => t.k === tab) ? tab : tabs[0].k;

  const setFilter = (changes) => setQuery((q) => ({ ...q, ...changes, cursor: '' }));
  const statusFilterFromPill = (s) => setFilter({ status: query.status === s ? '' : s });

  const title = exec?.automation_name || initialRow?.automation_label || 'Execution details';
  const started = exec?.started_at || initialRow?.created_at;
  const elapsedSec = exec?.started_at
    ? ((exec.is_active ? now : Date.parse(exec.ended_at || '') || now) - Date.parse(exec.started_at)) / 1000
    : null;

  if (notFound) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Topbar
        title={title}
        subtitle={`Execution details${started ? ` · started ${fmtFull(started)}` : ''}`}
        actions={<>
          <span style={{ fontSize: 11, color: poll.error ? '#B45309' : '#64748B', whiteSpace: 'nowrap' }} aria-live="polite">
            {poll.error
              ? `Status refresh failed — showing ${fmtClock(poll.lastSuccess)}`
              : paused ? 'Updates paused' : active ? `Updated ${fmtClock(poll.lastSuccess)} · every ${(data?.poll?.status_interval_ms || 5000) / 1000}s` : `Finished · updated ${fmtClock(poll.lastSuccess)}`}
          </span>
          {active && (
            <Btn size="sm" variant={paused ? 'accent' : 'default'} onClick={() => setPaused((p) => !p)}
              aria-pressed={paused} title="Stops this page asking for updates. The automation keeps running.">
              {paused ? '▶ Resume updates' : '❚❚ Pause updates'}
            </Btn>
          )}
          <Btn size="sm" variant="default" onClick={poll.refresh} disabled={poll.refreshing}>
            {poll.refreshing ? <Spinner size={12} /> : '↻'} Refresh
          </Btn>
          <Btn variant="accent" size="sm" onClick={() => (window.history.length > 1 ? nav(-1) : nav('/jobs'))}>← Back</Btn>
        </>}
      />

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '14px 20px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
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
        {!data && poll.error && poll.error.kind !== 'not_found' && (
          <ErrorBanner message={`Could not load this execution: ${poll.error.message}`} />
        )}

        {/* ── Summary ── */}
        <Card style={{ padding: 14, display: 'grid', gap: 12 }}>
          {!exec ? (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', color: '#64748B', fontSize: 12.5 }}><Spinner size={14} /> Loading execution…</div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <OverallBadge status={exec.status} />
                {exec.automation_type && <TypeTag type={exec.automation_type} />}
                {exec.scope === 'group' && (
                  <span style={{ fontSize: 11, color: '#475569', background: '#F1F5F9', border: '1px solid #E2E8F0', borderRadius: 999, padding: '2px 8px' }}
                    title={`Execution group ${exec.group_id}`}>
                    Bulk run · {exec.jobs_in_scope} jobs
                  </span>
                )}
                {exec.document_name && <span style={{ fontSize: 11.5, color: '#64748B', fontFamily: 'var(--font-mono)' }}>{exec.document_name}</span>}
                <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#64748B', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{(exec.group_id || exec.job_id || '').slice(0, 24)}</span>
                  <CopyButton value={exec.group_id || exec.job_id} label={exec.group_id ? 'Copy group ID' : 'Copy job ID'} />
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
                <Meta label="Automation">{exec.automation_label}</Meta>
                <Meta label="Environment">{exec.environment}</Meta>
                <Meta label="Initiated by">{exec.initiated_by || 'Not recorded'}</Meta>
                <Meta label="Started">{exec.started_at ? fmtFull(exec.started_at) : '—'}</Meta>
                <Meta label={exec.is_active ? 'Elapsed' : 'Duration'} mono>{fmtElapsed(elapsedSec)}</Meta>
              </div>
              {counts && <ProgressBar counts={counts} />}
              {counts && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <CountPill label="Total" value={counts.total} active={!query.status} onClick={() => setFilter({ status: '' })} />
                  {['pending', 'running', 'success', 'failed', 'cancelled', 'timed_out'].map((s) => (
                    <CountPill key={s} label={TARGET_STATUS[s].label} value={counts[s]} status={s}
                      active={query.status === s} onClick={() => statusFilterFromPill(s)} />
                  ))}
                  {data.live_status_deferred > 0 && (
                    <span style={{ fontSize: 11, color: '#94A3B8' }} title="Live status is fetched for a limited number of servers per refresh">
                      · live status for {data.live_status_deferred} more servers on this page arrives on the next refresh
                    </span>
                  )}
                </div>
              )}
              {data.members_truncated && (
                <Callout tone="warning">This run has more servers than RunStack reads at once; counts cover the first {counts?.total} only.</Callout>
              )}
            </>
          )}
        </Card>

        {/* ── Servers + selected server ── */}
        <div style={{ flex: 1, minHeight: 520, display: 'grid', gridTemplateColumns: 'minmax(260px, 360px) minmax(0, 1fr)', gap: 12 }}>
          <Card style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
            <ServerList
              targets={targets} total={data?.total_matching || 0} offset={data?.offset || 0} loading={poll.refreshing && !data}
              selectedKey={selectedKey} onSelect={(k) => setSelectedKey(k)} now={now}
              search={query.q} onSearch={(q) => setFilter({ q })}
              status={query.status} onStatus={(status) => setFilter({ status })}
              hasPrev={!!data?.prev_cursor} hasNext={!!data?.next_cursor}
              onPrev={() => setQuery((q) => ({ ...q, cursor: data?.prev_cursor || '' }))}
              onNext={() => setQuery((q) => ({ ...q, cursor: data?.next_cursor || '' }))}
              hiddenJobs={data?.hidden_jobs || 0}
            />
          </Card>

          <Card style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
            {!selectedTarget ? (
              <div style={{ padding: 32, color: '#64748B', fontSize: 12.5, textAlign: 'center' }}>
                {data ? 'Select a server to see its output.' : <Spinner />}
              </div>
            ) : (
              <>
                <div style={{ padding: '10px 14px', borderBottom: '1px solid #E2E8F0', display: 'grid', gap: 4, background: '#F8FAFC' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: '#0F172A' }}>{selectedTarget.server_name || selectedTarget.instance_id}</span>
                    <TargetStatusChip status={selectedTarget.status} detail={selectedTarget.status_detail} />
                    {selectedTarget.status_detail && TARGET_STATUS[selectedTarget.status]?.label !== selectedTarget.status_detail && (
                      <span style={{ fontSize: 11.5, color: '#475569' }}>{selectedTarget.status_detail}</span>
                    )}
                    <span style={{ marginLeft: 'auto', fontSize: 11.5, color: '#475569', fontFamily: 'var(--font-mono)' }}>
                      {fmtElapsed(targetElapsed(selectedTarget, now))}{isActiveTarget(selectedTarget.status) ? ' so far' : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 11.5, color: '#64748B' }}>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{selectedTarget.instance_id || '—'}</span>
                    {' · '}<span style={{ fontFamily: 'var(--font-mono)' }}>{selectedTarget.account_id}</span> · {selectedTarget.region}
                    {selectedTarget.current_step ? <> · step <strong style={{ color: '#334155' }}>{selectedTarget.current_step}</strong></> : null}
                  </div>
                  {/* Only worth flagging while it's running — then the live status is
                      what's missing. For a finished job RunStack's own record is the
                      result, so the read error just goes to the Details tab. */}
                  {selectedTarget.retrieval_error && isActiveTarget(selectedTarget.status) && (
                    <div style={{ fontSize: 11.5, color: '#64748B' }}>
                      Live Systems Manager status isn't available; showing RunStack's record. See Details.
                    </div>
                  )}
                </div>
                <div role="tablist" aria-label="Server views" style={{ display: 'flex', gap: 2, padding: '0 10px', borderBottom: '1px solid #E2E8F0', background: '#FFFFFF' }}>
                  {tabs.map((t) => (
                    <button key={t.k} type="button" role="tab" aria-selected={activeTab === t.k} onClick={() => setTab(t.k)}
                      style={{
                        padding: '9px 12px', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', background: 'none', border: 'none',
                        color: activeTab === t.k ? 'var(--brand-hover)' : '#64748B',
                        borderBottom: `2px solid ${activeTab === t.k ? 'var(--brand)' : 'transparent'}`, marginBottom: -1,
                      }}>{t.l}</button>
                  ))}
                  {!selected && <span style={{ alignSelf: 'center', marginLeft: 8 }}><Spinner size={12} /></span>}
                </div>
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
                  {activeTab === 'output' && (
                    <OutputPanel key={selectedTarget.key} jobId={jobId} target={selectedTarget} paused={paused}
                      getBuffer={getBuffer} isEc2={isEc2} />
                  )}
                  {activeTab === 'steps' && <StepsPanel selected={selected} />}
                  {activeTab === 'details' && <DetailsPanel selected={selected} target={selectedTarget} />}
                </div>
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
