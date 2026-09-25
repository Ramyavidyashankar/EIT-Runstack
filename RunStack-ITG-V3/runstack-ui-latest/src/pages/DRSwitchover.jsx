// src/pages/DRSwitchover.jsx
//
// DR Switchover — planned SQL Server Always On availability group switchover.
// (Previously "DR Failover" at /dr-failover; the URL redirects here.)
//
// Two entry points:
//   • Plan a switchover   — saves a DRAFT (AG, intended target, proposed
//     time, change reference) via /dr-failover/{AG}/plans. Drafts never run
//     by themselves: there is no scheduler behind proposed_time, and the
//     page says so. Someone opens the plan later and performs it.
//   • Perform a switchover now — the live flow:
//       Choose availability group
//       → Review live database status   (role-check SSM job, polled)
//       → Choose switchover target
//       → Review readiness              (POST /plan → checks + one-time token,
//                                        also posts the Teams approval card)
//       → Confirm switchover            (a NEW role check runs first; if the
//                                        primary, target or readiness moved
//                                        since review, execution is blocked
//                                        until the new results are reviewed)
//       → Result                         (GET /status polls AND advances the run)
//
// Why everything here polls: API Gateway's 29s limit is shorter than any
// SSM round trip, so role checks and the switchover itself are background
// jobs. The status endpoint advances EXECUTING → CONFIRMING → SUCCESS /
// NEEDS_MANUAL_CHECK lazily on whichever poll notices the previous step
// finished.
//
// Live results are never replaced behind the user's back. Only the
// explicit "Check live status" button updates the status section; the
// final pre-execution check is shown separately and only replaces the
// reviewed results when the user chooses "Review new results".
//
// Unfinished work (mode, AG, plan form, live results, the in-flight role
// check and any run being watched) is kept in sessionStorage so leaving
// the page and coming back resumes where you were. The one-time
// confirmation token is deliberately NOT stored — readiness is re-run.
//
// Authorization is entirely server-side (authorize_action
// "sql_dr_failover", scoped per AG). Nothing on this page grants access.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Topbar } from '../components/Layout';
import {
  Btn, Card, CardHead, ErrorBanner, FormRow, Input, MonoField, Select, Spinner, StatusBadge, Textarea,
} from '../components/ui';
import {
  Callout, Chip, Eyebrow, ReviewRow, SectionCard, SummaryTile, fmtClock,
} from '../components/sections';
import {
  createDrPlan, executeDrFailover, fetchDrAgNames, fetchDrAgServers, fetchDrConfig, fetchDrPlans,
  fetchDrRunStatus, planDrFailover, pollDrRolesJob, triggerDrAgRoles, updateDrPlan,
} from '../api/client';
import { usePageRefresh } from '../hooks/usePageRefresh';

// ─── Constants ───────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 100;           // ~5 min — SSM + cross-account can be slow
const FINAL_CHECK_VALID_MS = 5 * 60_000; // backend allows 10 min (DR_FRESH_CHECK_MAX_AGE_SECONDS); UI is stricter
const STORAGE_KEY = 'runstack.drSwitchover.v1';
const RUN_TERMINAL_STATUSES = new Set(['SUCCESS', 'NEEDS_MANUAL_CHECK', 'EXECUTE_FAILED', 'PLAN_FAILED', 'REJECTED', 'STALE_PLAN']);
const RUN_STATUS_LABEL = {
  PLANNED: 'Waiting for approval',
  PLAN_FAILED: 'Readiness failed',
  EXECUTING: 'Switching over…',
  CONFIRMING: 'Confirming the new primary…',
  SUCCESS: 'Switchover complete',
  NEEDS_MANUAL_CHECK: 'Needs manual check',
  EXECUTE_FAILED: 'Switchover failed',
  REJECTED: 'Rejected in Teams',
  STALE_PLAN: 'Blocked — live state changed',
};
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const EMPTY_PLAN_FORM = { planId: null, intended_target: '', proposed_local: '', change_reference: '', notes: '' };

// ─── Helpers ─────────────────────────────────────────────────────────────────
// The status-check SSM document emits ReplicaName (what the backend's
// classify_ag_roles and the AQS SQL agent schema use). The old page read
// `Replica` (the SQL column alias) — read both so neither shape shows blank.
const replicaName = (r) => r?.ReplicaName ?? r?.Replica ?? '';
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const toNum = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));

function loadSaved() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') || {}; } catch { return {}; }
}
function saveState(state) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage unavailable — non-fatal */ }
}

/** Parses "API error 400: {...}" bodies attached by apiFetch. */
function errorText(e) {
  if (e?.body?.error) return e.body.error;
  return e?.message || String(e);
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Turns raw roles/db_sync into what the summary needs. This mirrors the
 * backend's evaluate_dr_preconditions() so the summary predicts readiness,
 * but "Review readiness" (POST /plan) remains the authoritative evaluation.
 */
function analyseLiveStatus(roles, dbSync, maxQueueKb) {
  const rows = roles || [];
  const primaries = rows.filter((r) => r.Role === 'PRIMARY');
  const secondaries = rows.filter((r) => r.Role === 'SECONDARY');
  const attention = [];

  if (primaries.length !== 1) attention.push(`Expected exactly one primary replica, found ${primaries.length}.`);
  rows.filter((r) => r.SyncHealth && r.SyncHealth !== 'HEALTHY')
    .forEach((r) => attention.push(`${replicaName(r)} reports sync health ${r.SyncHealth}.`));
  secondaries.filter((r) => r.ConnState !== 'CONNECTED')
    .forEach((r) => attention.push(`${replicaName(r)} is ${r.ConnState || 'not connected'}.`));

  const limit = maxQueueKb ?? 1024;
  (dbSync || []).forEach((d) => {
    if (d.SyncState !== 'SYNCHRONIZED') attention.push(`Database ${d.DBName} is ${d.SyncState || 'not synchronized'}.`);
    if (d.Suspended === true || d.Suspended === 1 || d.Suspended === 'True') attention.push(`Database ${d.DBName} data movement is suspended.`);
    if (toNum(d.LogQueueKB) > limit) attention.push(`Database ${d.DBName} log send queue is ${d.LogQueueKB} KB (limit ${limit} KB).`);
    if (toNum(d.RedoQueueKB) > limit) attention.push(`Database ${d.DBName} redo queue is ${d.RedoQueueKB} KB (limit ${limit} KB).`);
  });
  if (rows.length > 0 && (!dbSync || dbSync.length === 0)) attention.push('No per-database sync rows were returned.');

  const targets = secondaries.map((r) => {
    const reasons = [];
    if (r.ConnState !== 'CONNECTED') reasons.push(r.ConnState || 'not connected');
    if (r.SyncHealth && r.SyncHealth !== 'HEALTHY') reasons.push(`sync ${r.SyncHealth}`);
    return {
      name: replicaName(r),
      scope: r.CommitMode === 'ASYNCHRONOUS_COMMIT' ? 'DR' : 'HA',
      commitMode: r.CommitMode,
      eligible: reasons.length === 0,
      reasons,
      row: r,
    };
  });

  const unhealthyReplicas = rows.filter((r) => r.SyncHealth && r.SyncHealth !== 'HEALTHY').length;
  const unsyncedDbs = (dbSync || []).filter((d) => d.SyncState !== 'SYNCHRONIZED').length;
  return {
    primary: primaries.length === 1 ? replicaName(primaries[0]) : null,
    targets,
    eligibleTargets: targets.filter((t) => t.eligible),
    syncHealthy: rows.length > 0 && unhealthyReplicas === 0 && unsyncedDbs === 0 && (dbSync || []).length > 0,
    unhealthyReplicas,
    unsyncedDbs,
    attention,
  };
}

/** Differences between what was reviewed at readiness time and a fresh check. */
function compareWithReviewed(reviewed, fresh, maxQueueKb) {
  const a = analyseLiveStatus(fresh.roles, fresh.dbSync, maxQueueKb);
  const diffs = [];
  if (a.primary !== reviewed.primary) diffs.push(`Primary changed from ${reviewed.primary || 'unknown'} to ${a.primary || 'none/unknown'}.`);
  const t = a.targets.find((x) => x.name === reviewed.target);
  if (!t) diffs.push(`${reviewed.target} is no longer a secondary replica.`);
  else if (!t.eligible) diffs.push(`${reviewed.target} is no longer eligible (${t.reasons.join(', ')}).`);
  a.attention.forEach((msg) => diffs.push(msg));
  return { changed: diffs.length > 0, diffs: Array.from(new Set(diffs)), analysis: a };
}

/**
 * Triggers a role-check job for the AG and polls it to completion,
 * following backend RETRYING hand-offs to a different host.
 * `isStale()` lets the caller abandon a superseded loop without applying it.
 */
async function runRoleCheck(agName, { onStatus, isStale, onJobId, resumeJobId }) {
  let jobId = resumeJobId;
  if (!jobId) {
    const trigger = await triggerDrAgRoles(agName);
    jobId = trigger.job_id;
  }
  onJobId?.(jobId);
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    if (isStale()) return null;
    const r = await pollDrRolesJob(agName, jobId);
    if (isStale()) return null;
    if (r.status === 'RETRYING' && r.retry_job_id) {
      jobId = r.retry_job_id;
      onJobId?.(jobId);
      onStatus?.('RETRYING');
    } else {
      onStatus?.(r.status);
    }
    if (r.status === 'COMPLETED') {
      return { jobId, roles: r.roles || [], dbSync: r.db_sync || [], warning: r.warning || null, checkedAt: new Date().toISOString() };
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Timed out waiting for the live status check — it may still be running in the background. Try again in a minute.');
}

// ─── Small presentational pieces ─────────────────────────────────────────────
const th = { padding: '8px 10px', fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'left', background: '#F8FAFC', borderBottom: '1px solid #E2E8F0' };
const td = { padding: '8px 10px', borderBottom: '1px solid #F1F5F9', fontSize: 12.5, verticalAlign: 'middle' };

function StateChip({ value, good }) {
  if (!value) return <span style={{ color: '#94A3B8' }}>—</span>;
  return <Chip tone={value === good ? 'green' : 'amber'}>{value}</Chip>;
}

function RoleTable({ roles, highlight }) {
  if (!roles?.length) return <div style={{ fontSize: 12, color: '#64748B' }}>No replica rows returned.</div>;
  return (
    <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['Replica', 'Role', 'Sync health', 'Connection', 'Commit mode'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {roles.map((r, i) => (
            <tr key={`${replicaName(r)}-${i}`} style={{ background: highlight && replicaName(r) === highlight ? '#F4FAF9' : 'transparent' }}>
              <td style={td}>
                <MonoField value={replicaName(r) || '—'} />
                {highlight && replicaName(r) === highlight && <span style={{ marginLeft: 8 }}><Chip>Target</Chip></span>}
              </td>
              <td style={{ ...td, fontWeight: r.Role === 'PRIMARY' ? 700 : 500, color: r.Role === 'PRIMARY' ? '#0B5C56' : '#0F172A' }}>{r.Role || '—'}</td>
              <td style={td}><StateChip value={r.SyncHealth} good="HEALTHY" /></td>
              <td style={td}><StateChip value={r.ConnState} good="CONNECTED" /></td>
              <td style={{ ...td, color: '#334155' }}>{r.CommitMode === 'ASYNCHRONOUS_COMMIT' ? 'Asynchronous' : r.CommitMode === 'SYNCHRONOUS_COMMIT' ? 'Synchronous' : (r.CommitMode || '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DbTable({ dbSync, maxQueueKb }) {
  if (!dbSync?.length) return <div style={{ fontSize: 12, color: '#64748B' }}>No per-database rows returned.</div>;
  const limit = maxQueueKb ?? 1024;
  const q = (v) => <span style={{ fontFamily: 'var(--font-mono)', color: toNum(v) > limit ? '#B91C1C' : '#334155', fontWeight: toNum(v) > limit ? 700 : 400 }}>{v ?? '—'}</span>;
  return (
    <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['Database', 'Sync state', 'Log send queue (KB)', 'Redo queue (KB)'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {dbSync.map((d, i) => (
            <tr key={`${d.DBName}-${i}`}>
              <td style={{ ...td, fontWeight: 600 }}>{d.DBName}</td>
              <td style={td}><StateChip value={d.SyncState} good="SYNCHRONIZED" /></td>
              <td style={td}>{q(d.LogQueueKB)}</td>
              <td style={td}>{q(d.RedoQueueKB)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CheckList({ checks }) {
  return (
    <div style={{ display: 'grid', gap: 0, border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden' }}>
      {checks.map((c, i) => {
        const pass = c.result === 'PASS';
        return (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 12px', borderTop: i ? '1px solid #F1F5F9' : 'none', fontSize: 12.5 }}>
            <span aria-hidden style={{
              flexShrink: 0, width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700, color: '#fff', background: pass ? '#0F9D6D' : '#DC2626',
            }}>{pass ? '✓' : '✕'}</span>
            <span style={{ color: '#0F172A' }}><span style={{ position: 'absolute', left: -9999 }}>{pass ? 'Passed: ' : 'Failed: '}</span>{c.detail}</span>
          </div>
        );
      })}
    </div>
  );
}

function Collapsible({ label, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{
        background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#334155',
        fontSize: 12, fontWeight: 600, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{ fontSize: 9, color: '#64748B' }}>{open ? '▾' : '▸'}</span> {label}
      </button>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  );
}

function ModeCard({ title, description, points, cta, onClick, accent }) {
  return (
    <Card onClick={onClick} style={{ borderTop: `3px solid ${accent}`, padding: 20, display: 'grid', gap: 10, alignContent: 'start' }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A' }}>{title}</div>
      <div style={{ fontSize: 12.5, color: '#334155', lineHeight: 1.6 }}>{description}</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#475569', lineHeight: 1.8 }}>
        {points.map((p) => <li key={p}>{p}</li>)}
      </ul>
      <div style={{ marginTop: 4 }}>
        <Btn variant={accent === '#0F766E' ? 'primary' : 'default'} onClick={(e) => { e.stopPropagation(); onClick(); }}>{cta} →</Btn>
      </div>
    </Card>
  );
}

function ProgressItem({ done, active, label, value }) {
  const color = done ? '#0F9D6D' : active ? '#0F766E' : '#CBD5E1';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0' }}>
      <span aria-hidden style={{
        width: 16, height: 16, borderRadius: '50%', flexShrink: 0, marginTop: 1,
        border: `2px solid ${color}`, background: done ? color : 'transparent',
        color: '#fff', fontSize: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700,
      }}>{done ? '✓' : ''}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: done || active ? '#0F172A' : '#94A3B8' }}>{label}</div>
        {value && <div style={{ fontSize: 11, color: '#64748B', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{value}</div>}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function DRSwitchover() {
  const saved = useMemo(loadSaved, []);

  // Where the user is
  const [mode, setMode] = useState(saved.mode || null);           // null | 'plan' | 'perform'
  const [selectedAg, setSelectedAg] = useState(saved.selectedAg || '');
  const [activePlan, setActivePlan] = useState(saved.activePlan || null); // saved plan being performed

  // AG list + AG details
  const [agNames, setAgNames] = useState([]);
  const [agLoading, setAgLoading] = useState(true);
  const [agError, setAgError] = useState(null);
  const [servers, setServers] = useState(null);
  const [config, setConfig] = useState(null);
  const [detailError, setDetailError] = useState(null);

  // Saved plans for the selected AG
  const [plans, setPlans] = useState([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState(null);
  const [planForm, setPlanForm] = useState(saved.planForm || EMPTY_PLAN_FORM);
  const [planSaving, setPlanSaving] = useState(false);
  const [planSaveError, setPlanSaveError] = useState(null);
  const [planSaved, setPlanSaved] = useState(null);

  // Live status (what the user is reviewing)
  const [live, setLive] = useState(saved.live || null);            // { jobId, roles, dbSync, warning, checkedAt }
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveJobStatus, setLiveJobStatus] = useState(null);
  const [liveError, setLiveError] = useState(null);
  const [confirmRecheck, setConfirmRecheck] = useState(false);
  const pendingLiveJobRef = useRef(saved.pendingLiveJobId || null);

  // Target + readiness
  const [targetReplica, setTargetReplica] = useState(saved.targetReplica || '');
  const [readiness, setReadiness] = useState(null);               // /plan response (holds the one-time token — memory only)
  const [readinessAt, setReadinessAt] = useState(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessError, setReadinessError] = useState(null);

  // Final check + execution
  const [finalCheck, setFinalCheck] = useState(null);             // { jobId, roles, dbSync, checkedAt, changed, diffs }
  const [finalLoading, setFinalLoading] = useState(false);
  const [finalStatus, setFinalStatus] = useState(null);
  const [finalError, setFinalError] = useState(null);
  const [confirmText, setConfirmText] = useState('');
  const [executeLoading, setExecuteLoading] = useState(false);
  const [executeError, setExecuteError] = useState(null);
  const [blockedDiffs, setBlockedDiffs] = useState(null);         // server-side STATE_CHANGED details

  // Run being watched (Teams approval, or execution in progress)
  const [watchRunId, setWatchRunId] = useState(saved.watchRunId || null);
  const [runStatus, setRunStatus] = useState(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);

  const [now, setNow] = useState(Date.now());
  const unmounted = useRef(false);
  const liveGen = useRef(0);
  const finalGen = useRef(0);

  // Explicit reset on setup matters under React 18 StrictMode (setup →
  // cleanup → setup in dev), otherwise the flag would stay true.
  useEffect(() => { unmounted.current = false; return () => { unmounted.current = true; }; }, []);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  // ── Persist unfinished work (never the confirmation token) ──────────────
  useEffect(() => {
    saveState({
      mode, selectedAg, activePlan, planForm, live, targetReplica, watchRunId,
      pendingLiveJobId: liveLoading ? pendingLiveJobRef.current : null,
    });
  }, [mode, selectedAg, activePlan, planForm, live, targetReplica, watchRunId, liveLoading]);

  // ── AG list ─────────────────────────────────────────────────────────────
  const loadAgNames = useCallback(async () => {
    setAgError(null);
    try {
      const res = await fetchDrAgNames();
      if (!unmounted.current) setAgNames(res.ag_names || []);
    } catch (e) {
      if (!unmounted.current) setAgError(errorText(e));
    } finally {
      if (!unmounted.current) setAgLoading(false);
    }
  }, []);
  useEffect(() => { loadAgNames(); }, [loadAgNames]);

  // ── AG details + saved plans (metadata only — no live SSM check) ────────
  const loadAgDetails = useCallback(async (ag) => {
    if (!ag) return;
    setDetailError(null);
    const [serversRes, configRes] = await Promise.allSettled([fetchDrAgServers(ag), fetchDrConfig(ag)]);
    if (unmounted.current) return;
    if (serversRes.status === 'fulfilled') setServers(serversRes.value.servers || []);
    if (configRes.status === 'fulfilled') setConfig(configRes.value);
    const failed = [serversRes, configRes].find((r) => r.status === 'rejected');
    if (failed) setDetailError(errorText(failed.reason));
  }, []);

  const loadPlans = useCallback(async (ag) => {
    if (!ag) return;
    setPlansLoading(true);
    setPlansError(null);
    try {
      const res = await fetchDrPlans(ag);
      if (!unmounted.current) setPlans(res.plans || []);
    } catch (e) {
      if (!unmounted.current) setPlansError(errorText(e));
    } finally {
      if (!unmounted.current) setPlansLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedAg) return;
    loadAgDetails(selectedAg);
    loadPlans(selectedAg);
  }, [selectedAg, loadAgDetails, loadPlans]);

  // Sidebar click on this page: refresh reference data only. Live role /
  // sync results are left alone — they change only via "Check live status".
  usePageRefresh(() => {
    loadAgNames();
    if (selectedAg) { loadAgDetails(selectedAg); loadPlans(selectedAg); }
  });

  const analysis = useMemo(
    () => (live ? analyseLiveStatus(live.roles, live.dbSync, config?.max_log_queue_kb) : null),
    [live, config],
  );

  // ── Reset helpers ───────────────────────────────────────────────────────
  const clearReadiness = useCallback(() => {
    setReadiness(null); setReadinessAt(null); setReadinessError(null);
    setFinalCheck(null); setFinalError(null); setFinalStatus(null);
    setConfirmText(''); setExecuteError(null); setBlockedDiffs(null);
  }, []);

  const resetForAg = useCallback(() => {
    liveGen.current++; finalGen.current++;
    pendingLiveJobRef.current = null;
    setLive(null); setLiveError(null); setLiveLoading(false); setLiveJobStatus(null); setConfirmRecheck(false);
    setServers(null); setConfig(null); setPlans([]); setPlanSaved(null);
    setTargetReplica('');
    setWatchRunId(null); setRunStatus(null); setAwaitingApproval(false);
    clearReadiness();
  }, [clearReadiness]);

  const startOver = () => {
    resetForAg();
    setSelectedAg(''); setActivePlan(null); setPlanForm(EMPTY_PLAN_FORM); setMode(null);
  };

  const handleSelectAg = (ag) => {
    if (ag === selectedAg) return;
    resetForAg();
    setActivePlan(null);
    setPlanForm((f) => ({ ...EMPTY_PLAN_FORM, change_reference: f.change_reference, notes: f.notes }));
    setSelectedAg(ag);
  };

  // ── Live status ─────────────────────────────────────────────────────────
  const checkLiveStatus = useCallback(async (resumeJobId) => {
    if (!selectedAg) return;
    const gen = ++liveGen.current;
    setConfirmRecheck(false);
    setLiveLoading(true);
    setLiveError(null);
    setLiveJobStatus('PENDING');
    // New live data invalidates readiness and any final check built on the old data.
    clearReadiness();
    try {
      const result = await runRoleCheck(selectedAg, {
        resumeJobId,
        isStale: () => gen !== liveGen.current || unmounted.current,
        onStatus: (s) => { if (gen === liveGen.current) setLiveJobStatus(s); },
        onJobId: (id) => { pendingLiveJobRef.current = id; },
      });
      if (!result || gen !== liveGen.current || unmounted.current) return;
      setLive(result);
      pendingLiveJobRef.current = null;
      // Keep the chosen target only if it is still a secondary.
      const a = analyseLiveStatus(result.roles, result.dbSync, config?.max_log_queue_kb);
      setTargetReplica((t) => {
        if (t && a.targets.some((x) => x.name === t)) return t;
        const planned = activePlan?.intended_target;
        if (planned && a.eligibleTargets.some((x) => x.name === planned)) return planned;
        return a.eligibleTargets.length === 1 ? a.eligibleTargets[0].name : '';
      });
    } catch (e) {
      if (gen === liveGen.current && !unmounted.current) { setLiveError(errorText(e)); pendingLiveJobRef.current = null; }
    } finally {
      if (gen === liveGen.current && !unmounted.current) setLiveLoading(false);
    }
  }, [selectedAg, clearReadiness, config, activePlan]);

  // Resume a live check that was still running when the user navigated away.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !selectedAg || !saved.pendingLiveJobId || saved.selectedAg !== selectedAg) return;
    resumed.current = true;
    checkLiveStatus(saved.pendingLiveJobId);
  }, [selectedAg, saved, checkLiveStatus]);

  const onCheckLiveClick = () => {
    // Re-checking while readiness is under review replaces what the person
    // is looking at, so ask first rather than doing it silently.
    if (readiness && !confirmRecheck) { setConfirmRecheck(true); return; }
    checkLiveStatus();
  };

  // ── Readiness (POST /plan) ──────────────────────────────────────────────
  const runReadiness = async () => {
    if (!live?.jobId || !targetReplica) return;
    clearReadiness();
    setReadinessLoading(true);
    try {
      const res = await planDrFailover(selectedAg, live.jobId, targetReplica);
      if (res.needs_target_choice) {
        // Only happens without target_replica; we always send one.
        setReadinessError('RunStack could not match the chosen target. Check live status again and re-select the target.');
      } else {
        setReadiness(res);
        setReadinessAt(Date.now());
        if (res.all_pass && res.run_id) setWatchRunId(res.run_id);
      }
    } catch (e) {
      // Failed checks come back as HTTP 400 with the full check list.
      if (e.body && Array.isArray(e.body.checks)) { setReadiness(e.body); setReadinessAt(Date.now()); }
      else setReadinessError(errorText(e));
    } finally {
      if (!unmounted.current) setReadinessLoading(false);
    }
  };

  const tokenExpiresAt = readiness?.confirmation_token && readinessAt && readiness.token_ttl_seconds
    ? readinessAt + readiness.token_ttl_seconds * 1000 : null;
  const tokenSecondsLeft = tokenExpiresAt ? Math.max(0, Math.round((tokenExpiresAt - now) / 1000)) : null;
  const tokenExpired = tokenSecondsLeft === 0;

  // ── Watch the run (Teams approval, then execution progress) ─────────────
  useEffect(() => {
    if (!watchRunId || !selectedAg) return undefined;
    let cancelled = false;
    (async () => {
      let interval = 5000;
      for (let i = 0; i < 1000 && !cancelled && !unmounted.current; i++) {
        try {
          const r = await fetchDrRunStatus(selectedAg, watchRunId);
          if (cancelled || unmounted.current) return;
          setAwaitingApproval(r.status === 'PLANNED');
          if (r.status !== 'PLANNED') setRunStatus(r);
          if (RUN_TERMINAL_STATUSES.has(r.status)) return;
          interval = r.status === 'PLANNED' ? 5000 : POLL_INTERVAL_MS;
        } catch (e) {
          // Transient errors: keep watching; a 404/403 means stop.
          if (e.status === 404 || e.status === 403) { if (!cancelled) setWatchRunId(null); return; }
        }
        await sleep(interval);
      }
    })();
    return () => { cancelled = true; };
  }, [watchRunId, selectedAg]);

  // ── Final live check before execution ───────────────────────────────────
  const reviewed = readiness?.all_pass ? { primary: readiness.primary_host, target: readiness.dr_replica_host } : null;

  const runFinalCheck = async () => {
    if (!reviewed) return;
    const gen = ++finalGen.current;
    setFinalLoading(true); setFinalError(null); setFinalCheck(null); setBlockedDiffs(null); setExecuteError(null);
    setFinalStatus('PENDING');
    try {
      const result = await runRoleCheck(selectedAg, {
        isStale: () => gen !== finalGen.current || unmounted.current,
        onStatus: (s) => { if (gen === finalGen.current) setFinalStatus(s); },
      });
      if (!result || gen !== finalGen.current) return;
      const cmp = compareWithReviewed(reviewed, result, config?.max_log_queue_kb);
      setFinalCheck({ ...result, changed: cmp.changed, diffs: cmp.diffs });
    } catch (e) {
      if (gen === finalGen.current && !unmounted.current) setFinalError(errorText(e));
    } finally {
      if (gen === finalGen.current && !unmounted.current) setFinalLoading(false);
    }
  };

  // User chose to look at the newer results: they replace the reviewed
  // live status, and readiness has to be run again from there.
  const adoptFinalResults = () => {
    if (!finalCheck) return;
    const fresh = { jobId: finalCheck.jobId, roles: finalCheck.roles, dbSync: finalCheck.dbSync, warning: finalCheck.warning, checkedAt: finalCheck.checkedAt };
    // Any earlier run keeps being watched, so if its Teams card is still
    // approved the result is visible here rather than happening silently.
    clearReadiness();
    setLive(fresh);
    const a = analyseLiveStatus(fresh.roles, fresh.dbSync, config?.max_log_queue_kb);
    setTargetReplica((t) => (a.eligibleTargets.some((x) => x.name === t) ? t : ''));
    document.getElementById('dr-live-status')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const finalAgeMs = finalCheck ? Math.max(0, now - new Date(finalCheck.checkedAt).getTime()) : null;
  // How long the user still has to press Start switchover: whichever runs
  // out first, the final check's validity or the readiness token.
  const finalSecondsLeft = finalCheck
    ? Math.max(0, Math.floor(Math.min(
        (FINAL_CHECK_VALID_MS - finalAgeMs) / 1000,
        tokenSecondsLeft ?? Infinity,
      )))
    : null;
  const finalValid = finalCheck && !finalCheck.changed && finalAgeMs < FINAL_CHECK_VALID_MS;

  const execute = async () => {
    if (!finalValid || confirmText !== 'YES' || !readiness?.confirmation_token || tokenExpired) return;
    setExecuteLoading(true); setExecuteError(null); setBlockedDiffs(null);
    try {
      const res = await executeDrFailover(selectedAg, readiness.confirmation_token, finalCheck.jobId);
      setAwaitingApproval(false);
      setRunStatus(res);
      setWatchRunId(res.run_id);
      if (activePlan?.plan_id) {
        updateDrPlan(selectedAg, activePlan.plan_id, { status: 'EXECUTED', executed_run_id: res.run_id })
          .then(() => loadPlans(selectedAg)).catch(() => { /* plan bookkeeping is best-effort */ });
      }
    } catch (e) {
      if (e.status === 409 && e.body?.code === 'STATE_CHANGED') {
        setBlockedDiffs(e.body.differences || []);
        setFinalCheck((f) => (f ? { ...f, changed: true, diffs: e.body.differences || f.diffs } : f));
      } else if (runStatus && runStatus.status !== 'PLANNED') {
        setExecuteError('This switchover was already approved and started (likely from the Teams card) — see progress below.');
      } else {
        setExecuteError(errorText(e));
      }
    } finally {
      if (!unmounted.current) setExecuteLoading(false);
    }
  };

  // ── Plan form ───────────────────────────────────────────────────────────
  const setPlanField = (k) => (e) => setPlanForm((f) => ({ ...f, [k]: e.target.value }));
  const planMissing = [];
  if (!selectedAg) planMissing.push('availability group');
  if (!planForm.intended_target.trim()) planMissing.push('intended target');
  if (!planForm.proposed_local) planMissing.push('proposed time');
  if (!planForm.change_reference.trim()) planMissing.push('change or reference number');
  const planTouched = !!(planForm.planId || planForm.intended_target || planForm.proposed_local || planForm.change_reference || planForm.notes);
  const proposedInPast = planForm.proposed_local && new Date(planForm.proposed_local).getTime() < now;

  const savePlan = async () => {
    if (planMissing.length) return;
    setPlanSaving(true); setPlanSaveError(null); setPlanSaved(null);
    const payload = {
      intended_target: planForm.intended_target.trim(),
      proposed_time: new Date(planForm.proposed_local).toISOString(),
      change_reference: planForm.change_reference.trim(),
      notes: planForm.notes.trim(),
    };
    try {
      const res = planForm.planId
        ? await updateDrPlan(selectedAg, planForm.planId, payload)
        : await createDrPlan(selectedAg, payload);
      setPlanSaved(res.plan);
      setPlanForm(EMPTY_PLAN_FORM);
      loadPlans(selectedAg);
    } catch (e) {
      setPlanSaveError(errorText(e));
    } finally {
      setPlanSaving(false);
    }
  };

  const editPlan = (p) => {
    setPlanSaved(null);
    setPlanForm({ planId: p.plan_id, intended_target: p.intended_target || '', proposed_local: isoToLocalInput(p.proposed_time), change_reference: p.change_reference || '', notes: p.notes || '' });
  };
  const cancelPlan = async (p) => {
    try { await updateDrPlan(selectedAg, p.plan_id, { status: 'CANCELLED' }); loadPlans(selectedAg); }
    catch (e) { setPlansError(errorText(e)); }
  };
  const performPlan = (p) => {
    setActivePlan(p);
    setPlanSaved(null);
    setMode('perform');
    if (analysis?.eligibleTargets.some((t) => t.name === p.intended_target)) setTargetReplica(p.intended_target);
  };

  // ── Derived flags for progressive reveal ────────────────────────────────
  const liveReady = !!live && !liveLoading;
  const targetInfo = analysis?.targets.find((t) => t.name === targetReplica);
  // STALE_PLAN (blocked by the final check) is handled inside Confirm
  // switchover, so it doesn't count as an active/finished run here.
  const runActive = runStatus && !['PLANNED', 'STALE_PLAN'].includes(runStatus.status);
  const plannedTargetIneligible = activePlan && analysis && !analysis.eligibleTargets.some((t) => t.name === activePlan.intended_target);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Topbar
        title="DR Switchover"
        subtitle="Planned switchover of a SQL Server Always On availability group to another replica."
        actions={mode && (
          <Btn variant="ghost" size="sm" onClick={startOver} disabled={executeLoading || (runActive && !RUN_TERMINAL_STATUSES.has(runStatus.status))}>
            ↺ Start over
          </Btn>
        )}
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        <div style={{ maxWidth: 1360, margin: '0 auto' }}>

          {/* ── Start: choose what to do ─────────────────────────────── */}
          {!mode && (
            <div style={{ display: 'grid', gap: 16, maxWidth: 980 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>What would you like to do?</div>
                <div style={{ fontSize: 12.5, color: '#64748B', marginTop: 2 }}>
                  A switchover makes another replica the primary for an availability group. Applications reconnect to the new primary.
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
                <ModeCard
                  title="Plan a switchover"
                  accent="#7EC4BB"
                  description="Record an upcoming switchover so the team can review it before the change window."
                  points={['Choose the availability group and intended target', 'Add the proposed time and change or reference number', 'Saves a draft only — nothing runs automatically']}
                  cta="Plan a switchover"
                  onClick={() => setMode('plan')}
                />
                <ModeCard
                  title="Perform a switchover now"
                  accent="#0F766E"
                  description="Check the live database status, confirm readiness and switch over now."
                  points={['Live role and sync checks against the availability group', 'Readiness checks and Teams approval', 'A final live check runs just before execution']}
                  cta="Perform a switchover"
                  onClick={() => setMode('perform')}
                />
              </div>
              <Callout tone="info" title="Scheduled switchovers aren't available yet">
                RunStack can save a plan with a proposed time, but it will not start the switchover at that time.
                At the change window, open the saved plan and choose <strong>Perform this plan</strong>.
              </Callout>
            </div>
          )}

          {mode && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 20, alignItems: 'start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>

                {/* ── Choose availability group ─────────────────────── */}
                <SectionCard
                  tone={1}
                  title="Choose availability group"
                  helper={mode === 'plan' ? 'Pick the availability group you are planning a switchover for.' : 'Pick the availability group you want to switch over.'}
                  right={<ModeSwitch mode={mode} setMode={setMode} disabled={executeLoading || (runActive && !RUN_TERMINAL_STATUSES.has(runStatus?.status))} />}
                >
                  {agLoading ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#64748B' }}><Spinner size={14} /> Loading availability groups…</div>
                  ) : agError ? (
                    <ErrorBanner message={`Could not load availability groups from Dynatrace: ${agError}`} />
                  ) : (
                    <FormRow label="Availability group" hint="Discovered from Dynatrace SQL Server availability group entities.">
                      <Select value={selectedAg} onChange={(e) => handleSelectAg(e.target.value)} disabled={executeLoading || liveLoading}>
                        <option value="">Select an availability group</option>
                        {agNames.map((ag) => <option key={ag} value={ag}>{ag}</option>)}
                      </Select>
                    </FormRow>
                  )}
                  {detailError && <Callout tone="warning">Some details for this availability group could not be loaded: {detailError}</Callout>}

                  {activePlan && mode === 'perform' && (
                    <Callout tone="info" title="Performing a saved plan"
                      action={<Btn variant="ghost" size="sm" onClick={() => setActivePlan(null)}>Detach</Btn>}>
                      Target {activePlan.intended_target} · proposed {fmtWhen(activePlan.proposed_time)} · reference {activePlan.change_reference}
                    </Callout>
                  )}

                  {selectedAg && (
                    <SavedPlans
                      plans={plans} loading={plansLoading} error={plansError} mode={mode} activePlanId={activePlan?.plan_id}
                      onPerform={performPlan} onEdit={(p) => { setMode('plan'); editPlan(p); }} onCancel={cancelPlan}
                    />
                  )}

                  {servers && servers.length > 0 && (
                    <Collapsible label={`Servers in this availability group (${servers.length})`}>
                      <div style={{ fontSize: 11, color: '#64748B', marginBottom: 8 }}>From Dynatrace — monitoring data, not a live SQL query.</div>
                      <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                          <thead><tr>{['Host', 'AG sync health', 'Backup preference'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
                          <tbody>{servers.map((s, i) => (
                            <tr key={i}><td style={td}><MonoField value={s.host} /></td><td style={td}>{s.sync_health}</td><td style={td}>{s.backup_preference}</td></tr>
                          ))}</tbody>
                        </table>
                      </div>
                    </Collapsible>
                  )}
                </SectionCard>

                {/* ── Plan details (plan mode) ──────────────────────── */}
                {mode === 'plan' && selectedAg && (
                  <SectionCard
                    tone={2}
                    title={planForm.planId ? 'Edit saved plan' : 'Plan details'}
                    helper="Describe the switchover so reviewers and the person performing it know what was agreed."
                  >
                    <Callout tone="info" title="Save plan only saves a draft">
                      It does not schedule or start anything. At the proposed time, someone with access opens this plan and
                      chooses <strong>Perform this plan</strong>, which runs fresh live checks before anything changes.
                    </Callout>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
                      <FormRow label="Intended target replica" hint={analysis ? 'From the latest live status check.' : 'Type the replica name, or check live status below to pick from the current secondaries.'}>
                        {analysis && analysis.targets.length > 0 ? (
                          <Select value={planForm.intended_target} onChange={setPlanField('intended_target')}>
                            <option value="">Select a target</option>
                            {analysis.targets.map((t) => (
                              <option key={t.name} value={t.name}>{t.name} — {t.scope} target{t.eligible ? '' : ` (${t.reasons.join(', ')})`}</option>
                            ))}
                          </Select>
                        ) : (
                          <Input value={planForm.intended_target} onChange={setPlanField('intended_target')} placeholder="e.g. C40W301187\I01" />
                        )}
                      </FormRow>
                      <FormRow label="Proposed time" hint={`Your local time (${LOCAL_TZ}). Stored in UTC.`}>
                        <Input type="datetime-local" value={planForm.proposed_local} onChange={setPlanField('proposed_local')} />
                      </FormRow>
                      <FormRow label="Change or reference number" hint="For example the ServiceNow change request.">
                        <Input value={planForm.change_reference} onChange={setPlanField('change_reference')} placeholder="CHG0012345" maxLength={100} />
                      </FormRow>
                    </div>
                    <FormRow label="Notes (optional)">
                      <Textarea value={planForm.notes} onChange={setPlanField('notes')} maxLength={2000}
                        style={{ fontFamily: 'var(--font-sans)', fontSize: 13, minHeight: 70 }}
                        placeholder="Application owners informed, rollback approach, etc." />
                    </FormRow>

                    {proposedInPast && <Callout tone="warning">The proposed time is in the past.</Callout>}
                    {planSaveError && <ErrorBanner message={planSaveError} />}
                    {planSaved && (
                      <Callout tone="success" title="Plan saved as a draft"
                        action={<Btn variant="primary" size="sm" onClick={() => performPlan(planSaved)}>Perform this plan</Btn>}>
                        {planSaved.ag_name} → {planSaved.intended_target} · {fmtWhen(planSaved.proposed_time)} · {planSaved.change_reference}
                      </Callout>
                    )}

                    <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
                      {planMissing.length > 0 && planTouched && <span style={{ fontSize: 11.5, color: '#92400E' }}>Missing: {planMissing.join(', ')}</span>}
                      {planForm.planId && <Btn variant="default" onClick={() => setPlanForm(EMPTY_PLAN_FORM)}>Discard changes</Btn>}
                      <Btn variant="primary" onClick={savePlan} disabled={planSaving || planMissing.length > 0}>
                        {planSaving ? <Spinner size={13} /> : null} {planForm.planId ? 'Save changes' : 'Save plan'}
                      </Btn>
                    </div>
                  </SectionCard>
                )}

                {/* ── Review live database status ───────────────────── */}
                {selectedAg && (
                  <SectionCard
                    id="dr-live-status"
                    tone={mode === 'plan' ? 'neutral' : 2}
                    title="Review live database status"
                    helper={mode === 'plan'
                      ? 'Optional while planning — check which replicas are secondaries today.'
                      : 'Runs a live SQL query through SSM. This usually takes 30–90 seconds.'}
                    right={<>
                      <span style={{ fontSize: 11, color: '#64748B' }} aria-live="polite">
                        {liveLoading ? `Checking… ${liveJobStatus ? `(${liveJobStatus.toLowerCase()})` : ''}` : `Last checked ${live ? fmtClock(live.checkedAt) : 'never'}`}
                      </span>
                      <Btn variant={live ? 'default' : 'primary'} size="sm" onClick={onCheckLiveClick} disabled={liveLoading || executeLoading || finalLoading}>
                        {liveLoading ? <Spinner size={13} /> : null} Check live status
                      </Btn>
                    </>}
                  >
                    {confirmRecheck && (
                      <Callout tone="warning" title="Check live status again?"
                        action={<div style={{ display: 'flex', gap: 6 }}>
                          <Btn variant="default" size="sm" onClick={() => setConfirmRecheck(false)}>Keep current results</Btn>
                          <Btn variant="primary" size="sm" onClick={() => checkLiveStatus()}>Check again</Btn>
                        </div>}>
                        New results replace the ones you reviewed, and readiness will need to be run again.
                      </Callout>
                    )}
                    {liveError && <ErrorBanner message={liveError} />}
                    {!live && !liveLoading && !liveError && (
                      <div style={{ fontSize: 12.5, color: '#64748B' }}>
                        No live status yet. Choose <strong>Check live status</strong> to see the current primary, secondaries and database sync state.
                      </div>
                    )}
                    {liveLoading && !live && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: '#64748B' }}>
                        <Spinner size={14} /> Querying the availability group… you can leave this page; the check keeps running and resumes here.
                      </div>
                    )}
                    {live && analysis && (
                      <>
                        {liveLoading && <Callout tone="info">A new check is running — the results below are from {fmtClock(live.checkedAt)} and will be replaced when it finishes.</Callout>}
                        {live.warning && <Callout tone="warning" title="Partial results">{live.warning}</Callout>}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
                          <SummaryTile label="Current primary" value={analysis.primary || 'Not found'} mono={!!analysis.primary} tone={analysis.primary ? 'default' : 'red'} />
                          <SummaryTile label="Eligible targets" value={analysis.eligibleTargets.length}
                            sub={analysis.targets.length ? `${analysis.eligibleTargets.length} of ${analysis.targets.length} secondaries` : 'No secondaries'}
                            tone={analysis.eligibleTargets.length ? 'green' : 'red'} />
                          <SummaryTile label="Overall sync health" value={analysis.syncHealthy ? 'Healthy' : 'Needs attention'}
                            sub={`${analysis.unhealthyReplicas} replica(s), ${analysis.unsyncedDbs} database(s) not healthy`}
                            tone={analysis.syncHealthy ? 'green' : 'amber'} />
                          <SummaryTile label="Checks needing attention" value={analysis.attention.length}
                            sub={analysis.attention.length ? 'See below' : 'Nothing flagged'} tone={analysis.attention.length ? 'amber' : 'green'} />
                        </div>
                        {analysis.attention.length > 0 && (
                          <Callout tone="warning" title="Needs attention">
                            <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{analysis.attention.map((m) => <li key={m}>{m}</li>)}</ul>
                          </Callout>
                        )}
                        <Collapsible label={`Replica details (${live.roles.length})`} defaultOpen={mode === 'perform'}>
                          <RoleTable roles={live.roles} highlight={targetReplica} />
                        </Collapsible>
                        <Collapsible label={`Database details (${live.dbSync.length})`} defaultOpen={mode === 'perform' && analysis.unsyncedDbs > 0}>
                          <div style={{ fontSize: 11, color: '#64748B', marginBottom: 8 }}>
                            Queue limit {config?.max_log_queue_kb ?? '—'} KB. Values are from the replica RunStack queried.
                          </div>
                          <DbTable dbSync={live.dbSync} maxQueueKb={config?.max_log_queue_kb} />
                        </Collapsible>
                      </>
                    )}
                  </SectionCard>
                )}

                {/* ── Choose switchover target ──────────────────────── */}
                {mode === 'perform' && liveReady && analysis && (
                  <SectionCard tone={3} title="Choose switchover target"
                    helper="HA targets use synchronous commit (no data loss). DR targets use asynchronous commit and are usually in another region.">
                    {plannedTargetIneligible && (
                      <Callout tone="warning" title="The planned target isn't eligible right now">
                        {activePlan.intended_target} is not a connected, healthy secondary in the latest live status. Choose another target or resolve the issue and check again.
                      </Callout>
                    )}
                    {analysis.targets.length === 0 ? (
                      <Callout tone="danger">No secondary replicas were found, so there is nothing to switch over to.</Callout>
                    ) : (
                      <div role="radiogroup" aria-label="Switchover target" style={{ display: 'grid', gap: 8 }}>
                        {analysis.targets.map((t) => {
                          const selected = targetReplica === t.name;
                          const isOverride = config?.dr_replica_override && t.name.toLowerCase().includes(String(config.dr_replica_override).toLowerCase());
                          return (
                            <label key={t.name} style={{
                              display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 8,
                              border: `1px solid ${selected ? '#0F766E' : '#E2E8F0'}`, background: selected ? '#F4FAF9' : '#FFFFFF',
                              cursor: t.eligible && !readinessLoading ? 'pointer' : 'not-allowed', opacity: t.eligible ? 1 : 0.65,
                            }}>
                              <input type="radio" name="dr-target" value={t.name} checked={selected} disabled={!t.eligible || readinessLoading || executeLoading}
                                onChange={() => { setTargetReplica(t.name); clearReadiness(); }} />
                              <div style={{ minWidth: 0, flex: 1 }}>
                                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600, color: '#0F172A', wordBreak: 'break-all' }}>{t.name}</div>
                                <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>
                                  {t.eligible ? 'Connected and healthy' : `Not eligible: ${t.reasons.join(', ')}`}
                                </div>
                              </div>
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                <Chip tone={t.scope === 'DR' ? 'amber' : 'default'}>{t.scope} target</Chip>
                                {isOverride && <Chip tone="gray">Configured DR replica</Chip>}
                                {activePlan?.intended_target === t.name && <Chip tone="gray">Planned</Chip>}
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </SectionCard>
                )}

                {/* ── Review readiness ──────────────────────────────── */}
                {mode === 'perform' && liveReady && targetInfo?.eligible && (
                  <SectionCard tone={4} title="Review readiness"
                    helper="RunStack evaluates the live status you reviewed against the switchover rules and, if everything passes, sends an approval card to Teams."
                    right={<Btn variant={readiness ? 'default' : 'primary'} size="sm" onClick={runReadiness} disabled={readinessLoading || executeLoading || !!runActive}>
                      {readinessLoading ? <Spinner size={13} /> : null} {readiness ? 'Run readiness again' : 'Run readiness checks'}
                    </Btn>}>
                    <div style={{ fontSize: 12.5, color: '#334155' }}>
                      Uses the live status from <strong>{fmtClock(live.checkedAt)}</strong>. If that was a while ago, check live status again first.
                    </div>
                    {readinessError && <ErrorBanner message={readinessError} />}
                    {readiness && (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <StatusBadge status={readiness.all_pass ? 'SUCCEEDED' : 'FAILED'} />
                          <span style={{ fontSize: 12.5, color: '#0F172A', fontWeight: 600 }}>
                            {readiness.all_pass ? 'Ready to switch over' : 'Not ready — resolve the failed checks, check live status again and re-run readiness'}
                          </span>
                          {readinessAt && <span style={{ fontSize: 11, color: '#64748B' }}>Checked {fmtClock(new Date(readinessAt))}</span>}
                        </div>
                        {readiness.primary_host && (
                          <div style={{ fontSize: 12.5, color: '#334155' }}>
                            <MonoField value={readiness.primary_host} /> → <MonoField value={readiness.dr_replica_host} />
                            {readiness.failover_scope && <span style={{ marginLeft: 8 }}><Chip tone={readiness.failover_scope === 'DR' ? 'amber' : 'default'}>{readiness.failover_scope} switchover</Chip></span>}
                          </div>
                        )}
                        <CheckList checks={readiness.checks || []} />
                        {readiness.all_pass && readiness.teams_notification_sent === false && (
                          <div style={{ fontSize: 11.5, color: '#64748B' }}>Teams approval card was not sent{readiness.teams_notification_error ? `: ${readiness.teams_notification_error}` : ''}.</div>
                        )}
                        <div style={{ fontSize: 11, color: '#94A3B8' }}>Run ID <MonoField value={readiness.run_id} dim /></div>
                      </>
                    )}
                  </SectionCard>
                )}

                {/* ── Confirm switchover ────────────────────────────── */}
                {mode === 'perform' && readiness?.all_pass && !runActive && (
                  <SectionCard tone="caution" title="Confirm switchover"
                    helper="This is a live change. Application connections drop briefly while the new primary takes over.">
                    {awaitingApproval && (
                      <Callout tone="info" title="Approval card sent to Teams">
                        An approver can accept it in Teams, or you can continue here if you have access. Whichever happens first is used; this page follows the result either way.
                      </Callout>
                    )}
                    {tokenExpiresAt && (
                      tokenExpired
                        ? <Callout tone="warning" title="Readiness approval expired" action={<Btn variant="default" size="sm" onClick={runReadiness}>Run readiness again</Btn>}>
                            For safety, readiness results can only be used for {Math.round(readiness.token_ttl_seconds / 60)} minutes.
                          </Callout>
                        : <div style={{ fontSize: 11.5, color: tokenSecondsLeft < 90 ? '#92400E' : '#64748B' }}>
                            Readiness can be used for another {Math.floor(tokenSecondsLeft / 60)}m {String(tokenSecondsLeft % 60).padStart(2, '0')}s.
                          </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 24 }}>
                      <div>
                        <Eyebrow>Switchover</Eyebrow>
                        <div style={{ display: 'grid', gap: 7 }}>
                          <ReviewRow label="Availability group" value={selectedAg} />
                          <ReviewRow label="Current primary" value={readiness.primary_host} mono />
                          <ReviewRow label="New primary" value={readiness.dr_replica_host} mono />
                          <ReviewRow label="Type" value={readiness.failover_scope === 'DR' ? 'DR (asynchronous)' : 'HA (synchronous)'} />
                        </div>
                      </div>
                      <div>
                        <Eyebrow>Record</Eyebrow>
                        <div style={{ display: 'grid', gap: 7 }}>
                          <ReviewRow label="Change reference" value={activePlan?.change_reference || '—'} />
                          <ReviewRow label="Saved plan" value={activePlan ? fmtWhen(activePlan.proposed_time) : 'None'} />
                          <ReviewRow label="Run ID" value={readiness.run_id} mono />
                        </div>
                      </div>
                    </div>

                    {readiness.failover_scope === 'DR' && (
                      <Callout tone="warning">
                        DR targets use asynchronous commit. RunStack allows the switchover only when every database is synchronized with queues inside the limit, but any transactions committed on the primary after the final check could still be lost.
                      </Callout>
                    )}

                    {/* Final live check */}
                    <div style={{ borderTop: '1px solid #F3D9AE', paddingTop: 14, display: 'grid', gap: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <div style={{ flex: 1, minWidth: 220 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>Final live check</div>
                          <div style={{ fontSize: 11.5, color: '#64748B' }}>Runs a fresh role and sync check right before the switchover and compares it with what you reviewed.</div>
                        </div>
                        <Btn variant={finalValid ? 'default' : 'primary'} size="sm" onClick={runFinalCheck} disabled={finalLoading || executeLoading || tokenExpired}>
                          {finalLoading ? <Spinner size={13} /> : null} {finalCheck ? 'Run final check again' : 'Run final live check'}
                        </Btn>
                      </div>
                      {finalLoading && <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#64748B' }}><Spinner size={13} /> Checking live status… ({(finalStatus || 'pending').toLowerCase()})</div>}
                      {finalError && <ErrorBanner message={finalError} />}
                      {finalCheck && !finalCheck.changed && (
                        finalValid
                          ? <Callout tone="success" title={`No changes since review — checked at ${fmtClock(finalCheck.checkedAt)}`}>
                              Primary, target and database sync still match. Start the switchover within {Math.floor(finalSecondsLeft / 60)}m {String(finalSecondsLeft % 60).padStart(2, '0')}s or run the check again.
                            </Callout>
                          : <Callout tone="warning">The final check is more than {FINAL_CHECK_VALID_MS / 60000} minutes old. Run it again before switching over.</Callout>
                      )}
                      {finalCheck?.changed && (
                        <Callout tone="danger" title="Live status has changed since you reviewed it"
                          action={<Btn variant="primary" size="sm" onClick={adoptFinalResults}>Review new results</Btn>}>
                          <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{(blockedDiffs || finalCheck.diffs).map((d) => <li key={d}>{d}</li>)}</ul>
                          <div style={{ marginTop: 4 }}>Switchover is blocked. Review the new results, then run readiness again.</div>
                        </Callout>
                      )}
                    </div>

                    <FormRow label={`Type YES to switch over ${selectedAg}`}>
                      <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="YES"
                        disabled={!finalValid || executeLoading} aria-describedby="dr-confirm-help" style={{ maxWidth: 220 }} />
                    </FormRow>
                    <div id="dr-confirm-help" style={{ fontSize: 11.5, color: '#64748B', marginTop: -8 }}>
                      {!finalCheck ? 'Run the final live check to unlock confirmation.'
                        : finalCheck.changed ? 'Blocked until the new results are reviewed.'
                        : !finalValid ? 'Run the final check again to unlock confirmation.'
                        : 'Type YES in capitals.'}
                    </div>
                    {executeError && <ErrorBanner message={executeError} />}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                      <Btn variant="danger" onClick={execute}
                        disabled={!finalValid || confirmText !== 'YES' || executeLoading || tokenExpired}>
                        {executeLoading ? <Spinner size={13} /> : null} Start switchover
                      </Btn>
                    </div>
                  </SectionCard>
                )}

                {/* ── Result / progress ─────────────────────────────── */}
                {runActive && (
                  <RunResult runStatus={runStatus} agName={selectedAg} />
                )}
              </div>

              {/* ── Right rail: progress summary ───────────────────────── */}
              <div style={{ position: 'sticky', top: 0 }}>
                <Card>
                  <CardHead><span style={{ fontSize: 12.5, fontWeight: 700 }}>{mode === 'plan' ? 'Your plan' : 'Your switchover'}</span></CardHead>
                  <div style={{ padding: '10px 16px 14px' }}>
                    {mode === 'plan' ? (
                      <>
                        <ProgressItem done={!!selectedAg} active={!selectedAg} label="Availability group" value={selectedAg} />
                        <ProgressItem done={!!planForm.intended_target} active={!!selectedAg} label="Intended target" value={planForm.intended_target} />
                        <ProgressItem done={!!planForm.proposed_local} active={!!selectedAg} label="Proposed time" value={planForm.proposed_local ? fmtWhen(new Date(planForm.proposed_local).toISOString()) : ''} />
                        <ProgressItem done={!!planForm.change_reference} active={!!selectedAg} label="Change reference" value={planForm.change_reference} />
                        <div style={{ fontSize: 11, color: '#64748B', marginTop: 10, lineHeight: 1.5 }}>
                          Drafts are kept if you leave this page. Saved plans are visible to everyone with DR access for this availability group.
                        </div>
                      </>
                    ) : (
                      <>
                        <ProgressItem done={!!selectedAg} active={!selectedAg} label="Availability group" value={selectedAg} />
                        <ProgressItem done={!!live} active={!!selectedAg && !live} label="Live status reviewed" value={live ? `at ${fmtClock(live.checkedAt)}` : ''} />
                        <ProgressItem done={!!targetInfo?.eligible} active={!!live && !targetReplica} label="Target chosen" value={targetReplica} />
                        <ProgressItem done={!!readiness?.all_pass} active={!!targetInfo?.eligible && !readiness?.all_pass} label="Readiness passed" value={readiness ? (readiness.all_pass ? 'All checks passed' : 'Checks failed') : ''} />
                        <ProgressItem done={!!finalValid} active={!!readiness?.all_pass && !finalValid} label="Final live check" value={finalCheck ? (finalCheck.changed ? 'Changed — review needed' : finalValid ? `at ${fmtClock(finalCheck.checkedAt)}` : 'Expired') : ''} />
                        <ProgressItem done={runStatus?.status === 'SUCCESS'} active={!!runActive} label="Switchover" value={runStatus ? RUN_STATUS_LABEL[runStatus.status] || runStatus.status : ''} />
                        <div style={{ fontSize: 11, color: '#64748B', marginTop: 10, lineHeight: 1.5 }}>
                          Leaving this page keeps your progress; a running check or switchover is picked up again when you return. Readiness must be re-run after leaving.
                        </div>
                      </>
                    )}
                  </div>
                </Card>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Mode toggle (segmented, as on Run Automation) ───────────────────────────
function ModeSwitch({ mode, setMode, disabled }) {
  const seg = (active) => ({
    padding: '4px 12px', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: active ? '1px solid #0F766E' : '1px solid #CBD5E1', background: active ? '#E6F5F3' : '#FFFFFF',
    color: active ? '#0F766E' : '#334155',
  });
  return (
    <div style={{ display: 'flex', gap: 4 }} role="group" aria-label="Mode">
      <button type="button" style={seg(mode === 'plan')} aria-pressed={mode === 'plan'} disabled={disabled} onClick={() => setMode('plan')}>Plan</button>
      <button type="button" style={seg(mode === 'perform')} aria-pressed={mode === 'perform'} disabled={disabled} onClick={() => setMode('perform')}>Perform now</button>
    </div>
  );
}

// ─── Saved plans list ────────────────────────────────────────────────────────
function SavedPlans({ plans, loading, error, mode, activePlanId, onPerform, onEdit, onCancel }) {
  if (loading && plans.length === 0) {
    return <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#64748B' }}><Spinner size={13} /> Loading saved plans…</div>;
  }
  if (error) return <Callout tone="warning">Saved plans could not be loaded: {error}</Callout>;
  if (plans.length === 0) {
    return mode === 'perform' ? null : <div style={{ fontSize: 12, color: '#64748B' }}>No saved plans for this availability group yet.</div>;
  }
  return (
    <div>
      <Eyebrow>Saved plans ({plans.length})</Eyebrow>
      <div style={{ display: 'grid', gap: 8 }}>
        {plans.map((p) => (
          <div key={p.plan_id} style={{
            display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px', borderRadius: 8,
            border: `1px solid ${p.plan_id === activePlanId ? '#0F766E' : '#E2E8F0'}`, background: '#FFFFFF',
          }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: '#0F172A' }}>
                {fmtWhen(p.proposed_time)} <span style={{ fontWeight: 400, color: '#64748B' }}>· {p.change_reference}</span>
              </div>
              <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>
                Target <span style={{ fontFamily: 'var(--font-mono)' }}>{p.intended_target}</span> · saved by {p.created_by}
                {p.proposed_time && new Date(p.proposed_time).getTime() < Date.now() && <span style={{ marginLeft: 6 }}><Chip tone="amber">Time passed</Chip></span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Btn variant="ghost" size="sm" onClick={() => onEdit(p)}>Edit</Btn>
              <Btn variant="ghost" size="sm" onClick={() => onCancel(p)}>Cancel plan</Btn>
              <Btn variant="primary" size="sm" onClick={() => onPerform(p)} disabled={p.plan_id === activePlanId && mode === 'perform'}>Perform this plan</Btn>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Result card ─────────────────────────────────────────────────────────────
function RunResult({ runStatus, agName }) {
  const s = runStatus.status;
  const terminal = RUN_TERMINAL_STATUSES.has(s);
  const badge = s === 'SUCCESS' ? 'SUCCEEDED' : terminal ? 'FAILED' : 'RUNNING';
  const pre = (text) => (
    <pre style={{
      fontFamily: 'var(--font-mono)', fontSize: 11.5, background: '#FDF3E4', border: '1px solid #F3D9AE', borderRadius: 8,
      padding: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#0F172A', maxHeight: 260, overflowY: 'auto', margin: 0,
    }}>{text}</pre>
  );
  return (
    <SectionCard tone={s === 'SUCCESS' ? 4 : terminal ? 'caution' : 3} title="Switchover progress"
      helper="Updates automatically until the switchover finishes." right={<StatusBadge status={badge} />}>
      <div style={{ fontSize: 13, color: '#0F172A' }} aria-live="polite">
        {!terminal && <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Spinner size={13} /> {RUN_STATUS_LABEL[s] || s}</span>}
        {s === 'SUCCESS' && <Callout tone="success" title="Switchover complete">The new primary for {agName} has been confirmed.</Callout>}
        {s === 'NEEDS_MANUAL_CHECK' && <Callout tone="warning" title="Needs a manual check">The switchover command finished but RunStack could not confirm the target is now primary. Check the availability group directly — do not assume it succeeded.{runStatus.error ? ` (${runStatus.error})` : ''}</Callout>}
        {s === 'EXECUTE_FAILED' && <Callout tone="danger" title="Switchover did not complete">{runStatus.error || (runStatus.ssm_output || runStatus.stderr_output ? 'See the output below.' : 'No further detail was returned.')}</Callout>}
        {s === 'REJECTED' && <Callout tone="info" title="Rejected in Teams">No changes were made to {agName}.</Callout>}
        {s === 'STALE_PLAN' && <Callout tone="warning" title="Blocked before execution">{runStatus.error || 'The live state changed after readiness was reviewed.'} No changes were made.</Callout>}
      </div>
      {s === 'EXECUTE_FAILED' && runStatus.stderr_output && <Collapsible label="Error output" defaultOpen>{pre(runStatus.stderr_output)}</Collapsible>}
      {s === 'EXECUTE_FAILED' && runStatus.ssm_output && <Collapsible label="Command output">{pre(runStatus.ssm_output)}</Collapsible>}
      {runStatus.final_roles && <Collapsible label="Replica roles after switchover" defaultOpen><RoleTable roles={runStatus.final_roles} highlight={runStatus.dr_replica_host} /></Collapsible>}
      <div style={{ fontSize: 11, color: '#94A3B8' }}>Run ID <MonoField value={runStatus.run_id} dim /></div>
    </SectionCard>
  );
}
