// src/pages/SQLHealthCheck.jsx
//
// Database Operations → SQL Health Check.
//
//   Choose target        GET /batch-healthcheck/options → targets
//                        (GDBA MSSQL SharePoint list, resolved to
//                        runstack-instance-catalog, narrowed to the caller's
//                        gdba-sql / sql-db-healthcheck scope — never
//                        runstack-app-access)
//   Choose health check  same call → checks, read live from the SSM documents
//                        (SQL-Database-Healthcheck / SQL-HealthCheck-Bulk);
//                        a check whose document is missing is shown as
//                        unavailable with the reason
//   Review and run       POST /batch-healthcheck { instance_id, check_type,
//                        parameters } → job → Step Functions → SSM RunCommand
//                        in the server's own account/region.
//                        Several servers: ONE POST with instance_ids — the
//                        backend creates one execution group (one run in
//                        Automation Executions) with one job per server.
//   Progress / results   GET /jobs/{jobId}, refreshed in place while active
//
// The job ID lives in the URL (?job=…), so refreshing, reopening or sharing
// the link shows the same job. Opening the page never starts a check —
// only the Run Health Check button does, and the backend returns the
// already-running job instead of starting a duplicate.
//
// Authorization is entirely server-side (authorize_action "sql_healthcheck"
// + target scope + optional environment rule). Hidden/disabled options
// here are a convenience only.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Topbar } from '../components/Layout';
import { Btn, Empty, Input, MonoField, Select, Spinner, StatusBadge } from '../components/ui';
import { Callout, Chip, Eyebrow, RefreshControl, ReviewRow, SectionCard, SummaryTile } from '../components/sections';
import { fetchJob, fetchSqlHealthcheckOptions, runSqlHealthcheck, runSqlHealthcheckBatch } from '../api/client';
import { useAutoRefresh, usePageRefresh } from '../hooks/usePageRefresh';
import ParamField from '../components/ParamField';
import { copyText, fmtFull, isActive, jobDuration, statusGroup } from '../utils/jobs';
import {
  DENIAL_TEXT, interpretResult, toRequestParameters, validateParam, visibleOutput,
} from '../utils/sqlHealthcheck';

const JOB_POLL_MS = 4000;
const BATCH_POLL_MS = 6000;
const MAX_BATCH = 50;            // servers per run
const DISPATCH_CHUNK = 100;      // servers per POST (backend SQL_HEALTHCHECK_MAX_TARGETS_PER_REQUEST)
const FETCH_CONCURRENCY = 6;     // job polls in flight at once
const BATCH_STORE = 'runstack.sqlHealthcheck.batch.';

/** Run fn over items with at most n in flight. Returns results in order. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next; next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function errorInfo(e) {
  // fetch() rejects with a TypeError when the browser blocks the request
  // (network down, or a CORS/preflight failure — e.g. the API Gateway route
  // isn't deployed, so its 403 carries no CORS headers).
  if (e instanceof TypeError) {
    return {
      status: null, reason: null, fieldErrors: null,
      text: 'The RunStack API could not be reached from this browser (network or CORS error).',
      detail: 'If this persists, check that GET /batch-healthcheck/options is deployed to the API stage with CORS enabled.',
    };
  }
  const body = e?.body || {};
  return {
    status: e?.status,
    reason: body.reason || null,
    text: (body.reason && DENIAL_TEXT[body.reason]) || body.message || body.error || e?.message || String(e),
    detail: body.reason && body.message ? body.message : null,
    fieldErrors: body.errors || null,
  };
}

const docShortName = (doc) => {
  const s = String(doc || '');
  return s.includes(':document/') ? s.split(':document/')[1] : s;
};

// ─── Page ────────────────────────────────────────────────────────────────────
export default function SQLHealthCheck() {
  const [searchParams, setSearchParams] = useSearchParams();
  const jobId = searchParams.get('job') || '';
  const batchKey = searchParams.get('jobs') || '';
  const batchIds = useMemo(() => batchKey.split(',').map((s) => s.trim()).filter(Boolean), [batchKey]);

  // Options (targets + checks)
  const [options, setOptions] = useState(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState(null);

  // Selection
  const [selectedIds, setSelectedIds] = useState([]);
  const [checkId, setCheckId] = useState('');
  const [paramForm, setParamForm] = useState({});
  const [touched, setTouched] = useState({});

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const submitGuard = useRef(false);
  const [submitError, setSubmitError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [dispatchProgress, setDispatchProgress] = useState(null);   // { done, total }

  // Job
  const [job, setJob] = useState(null);
  const [jobError, setJobError] = useState(null);

  const loadOptions = useCallback(async () => {
    setOptionsLoading(true);
    try {
      setOptions(await fetchSqlHealthcheckOptions());
      setOptionsError(null);
    } catch (e) {
      setOptionsError(errorInfo(e));
    } finally {
      setOptionsLoading(false);
    }
  }, []);
  useEffect(() => { loadOptions(); }, [loadOptions]);

  // Ignore responses for a job that is no longer the one in the URL.
  const currentJobId = useRef(jobId);
  currentJobId.current = jobId;
  const loadJob = useCallback(async () => {
    if (!jobId) return;
    try {
      const j = await fetchJob(jobId);
      if (currentJobId.current !== jobId) return;
      setJob(j);
      setJobError(null);
    } catch (e) {
      if (currentJobId.current !== jobId) return;
      const info = errorInfo(e);
      setJobError(info.status === 404 ? { ...info, text: `Job ${jobId} was not found.` } : info);
      throw e;
    }
  }, [jobId]);

  const jobActive = !!jobId && (!job || isActive(job.status)) && !(jobError && jobError.status === 404);
  const jobPoll = useAutoRefresh(loadJob, { intervalMs: JOB_POLL_MS, enabled: jobActive });

  // New job in the URL → show it from scratch (never reuse the previous job's data).
  useEffect(() => {
    setJob(null);
    setJobError(null);
    if (jobId) jobPoll.refresh();
  }, [jobId]);

  usePageRefresh(() => { loadOptions(); if (jobId) jobPoll.refresh(); });

  const targets = options?.targets || [];
  const checks = options?.checks || [];
  const selectedTargets = targets.filter((t) => selectedIds.includes(t.instance_id));
  const target = selectedTargets.length === 1 ? selectedTargets[0] : null;
  const check = checks.find((c) => c.id === checkId) || null;

  // Only one usable check (today: SQL-Database-Healthcheck) → choose it for the user.
  useEffect(() => {
    const usable = checks.filter((c) => c.available);
    if (!checkId && usable.length === 1) setCheckId(usable[0].id);
  }, [checks]);

  // Drop a check that isn't usable for a single newly chosen target's region.
  useEffect(() => {
    if (check && target && !checkUsableFor(check, target)) setCheckId('');
  }, [selectedIds]);

  const paramErrors = useMemo(() => {
    const out = {};
    (check?.parameters || []).forEach((p) => {
      const value = p.type === 'StringList'
        ? String(paramForm[p.name] || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        : paramForm[p.name];
      const err = validateParam(p, value);
      if (err) out[p.name] = err;
    });
    return out;
  }, [check, paramForm]);

  const isBatch = selectedTargets.length > 1;
  const runnable = check ? selectedTargets.filter((t) => t.selectable && checkUsableFor(check, t)) : [];
  const canRun = !!check && check.available && Object.keys(paramErrors).length === 0 && !submitting
    && (isBatch ? runnable.length > 0 && selectedTargets.length <= MAX_BATCH
      : !!target && target.selectable && checkUsableFor(check, target));

  const run = async () => {
    if (submitGuard.current || !canRun) return;       // double-click / Enter-repeat guard
    submitGuard.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setNotice(null);
    try {
      const res = await runSqlHealthcheck({
        instanceId: target.instance_id,
        checkType: check.id,
        parameters: toRequestParameters(check.parameters, paramForm),
      });
      const started = res?.jobs?.[0];
      if (!started?.job_id) throw new Error('The backend did not return a job ID.');
      if (res.deduplicated) setNotice('This check was already running on this server, so RunStack is showing that job instead of starting another.');
      setSearchParams({ job: started.job_id });
    } catch (e) {
      const info = errorInfo(e);
      const running = e?.body?.jobs?.[0]?.job_id;
      if (info.reason === 'already_running' && running) {
        setNotice('Someone else already started this check on this server. Showing their job — no second check was started.');
        setSearchParams({ job: running });
      } else {
        setSubmitError(info);
        if (info.fieldErrors) setTouched(Object.fromEntries(Object.keys(info.fieldErrors).map((k) => [k, true])));
      }
    } finally {
      submitGuard.current = false;
      setSubmitting(false);
    }
  };

  const runBatch = async () => {
    if (submitGuard.current || !canRun) return;
    submitGuard.current = true;
    setSubmitting(true);
    setSubmitError(null);
    setNotice(null);
    const params = toRequestParameters(check.parameters, paramForm);
    const skipped = selectedTargets.filter((t) => !runnable.includes(t)).map((t) => ({
      server_name: t.server_name, instance_id: t.instance_id, job_id: null,
      error: t.unavailable_reason || `${check.document} is not available in ${t.region}.`,
    }));
    setDispatchProgress({ done: 0, total: runnable.length });
    try {
      // One run: the backend creates the execution group on the first call;
      // later chunks (only for selections above DISPATCH_CHUNK) join it.
      const nameOf = Object.fromEntries(runnable.map((t) => [t.instance_id, t.server_name]));
      const started = [];
      let groupId = null;
      for (let i = 0; i < runnable.length; i += DISPATCH_CHUNK) {
        const chunk = runnable.slice(i, i + DISPATCH_CHUNK);
        let res;
        try {
          // eslint-disable-next-line no-await-in-loop
          res = await runSqlHealthcheckBatch({
            instanceIds: chunk.map((t) => t.instance_id), checkType: check.id, parameters: params, executionGroupId: groupId,
          });
        } catch (e) {
          if (!started.length) throw e;          // nothing started — show the error below
          const info = errorInfo(e);
          chunk.forEach((t) => started.push({ server_name: t.server_name, instance_id: t.instance_id, job_id: null,
            error: info.detail ? `${info.text} ${info.detail}` : info.text }));
          continue;
        }
        groupId = res?.execution_group_id || groupId;
        (res?.jobs || []).forEach((r) => started.push({
          server_name: r.server_name || nameOf[r.instance_id] || r.instance_id, instance_id: r.instance_id,
          job_id: r.job_id || null, deduplicated: !!r.deduplicated,
          error: r.job_id ? null : (r.message || r.error || 'Not started.'),
        }));
        setDispatchProgress({ done: Math.min(i + chunk.length, runnable.length), total: runnable.length });
      }
      const rows = [...started, ...skipped];
      const ids = [...new Set(rows.filter((r) => r.job_id).map((r) => r.job_id))];
      if (!ids.length) {
        setSubmitError({ text: 'No health check could be started.', detail: rows.map((r) => `${r.server_name}: ${r.error}`).slice(0, 5).join(' · ') });
        return;
      }
      const key = ids.join(',');
      const runJobId = rows.find((r) => r.job_id && !r.deduplicated)?.job_id || null;
      try {
        sessionStorage.setItem(BATCH_STORE + key, JSON.stringify({
          rows, check: check.label, started_at: Date.now(), execution_group_id: groupId, run_job_id: runJobId,
        }));
      } catch { /* optional */ }
      setSearchParams({ jobs: key });
    } catch (e) {
      // The whole request was refused (e.g. invalid parameters) — nothing started.
      const info = errorInfo(e);
      setSubmitError(info);
      if (info.fieldErrors) setTouched(Object.fromEntries(Object.keys(info.fieldErrors).map((k) => [k, true])));
    } finally {
      submitGuard.current = false;
      setSubmitting(false);
      setDispatchProgress(null);
    }
  };

  const startAnother = () => {
    setNotice(null);
    setSubmitError(null);
    setSearchParams({});
  };

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="rs-page">
      <Topbar
        title="SQL Health Check"
        subtitle="Check SQL Server database health on an authorized target."
        actions={<>
          {jobId && (
            <RefreshControl onRefresh={jobPoll.refresh} refreshing={jobPoll.refreshing} lastUpdated={jobPoll.lastUpdated}
              autoEverySec={jobActive ? JOB_POLL_MS / 1000 : undefined} error={jobPoll.error && job ? jobPoll.error : null} />
          )}
          {(jobId || batchKey) && <Btn variant="default" size="sm" onClick={startAnother}>Run another check</Btn>}
        </>}
      />

      <div className="rs-page-body">
        <div className="rs-page-content">

          {optionsError && !jobId && !batchKey && (
            <Callout tone={optionsError.status === 403 ? 'danger' : 'warning'}
              title={optionsError.status === 403 ? 'You can’t run SQL health checks' : 'SQL health check options could not be loaded'}
              action={optionsError.status !== 403 && <Btn size="sm" onClick={loadOptions}>Try again</Btn>}>
              {optionsError.text}
              {optionsError.detail && <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>{optionsError.detail}</div>}
              {optionsError.status === 403 && <div style={{ marginTop: 4 }}>Contact a RunStack administrator if you need access.</div>}
            </Callout>
          )}

          {!jobId && !batchKey && !(optionsError && optionsError.status === 403) && (
            <>
              <TargetSelector
                options={options} loading={optionsLoading} error={optionsError}
                selectedIds={selectedIds} onChange={setSelectedIds} onReload={loadOptions}
              />
              <HealthCheckOptions
                checks={checks} loading={optionsLoading} loaded={!!options} target={target}
                selectedId={checkId}
                onSelect={(id) => { setCheckId(id); setParamForm({}); setTouched({}); setSubmitError(null); }}
                form={paramForm}
                onChange={(name, v) => { setParamForm((f) => ({ ...f, [name]: v })); setTouched((t) => ({ ...t, [name]: true })); }}
                errors={paramErrors} serverErrors={submitError?.fieldErrors} touched={touched}
              />
              <ExecutionReview
                target={target} targets={selectedTargets} runnable={runnable} check={check} form={paramForm}
                canRun={canRun} submitting={submitting} progress={dispatchProgress}
                onRun={isBatch ? runBatch : run} error={submitError} paramErrorCount={Object.keys(paramErrors).length}
              />
            </>
          )}

          {batchKey && !jobId && <BatchView key={batchKey} batchKey={batchKey} jobIds={batchIds} checks={checks} />}

          {jobId && (
            <>
              {notice && <Callout tone="info">{notice}</Callout>}
              {jobError && !job && (
                <Callout tone="danger" title="This health check could not be loaded"
                  action={jobError.status !== 404 && <Btn size="sm" onClick={jobPoll.refresh}>Try again</Btn>}>
                  {jobError.text}
                </Callout>
              )}
              {!job && !jobError && (
                <SectionCard tone={4} title="Progress">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#657185' }}>
                    <Spinner size={14} /> Loading job {jobId}…
                  </div>
                </SectionCard>
              )}
              {job && (
                <>
                  <JobSummary job={job} checks={checks} />
                  <JobProgress job={job} />
                  <HealthCheckResults job={job} />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function checkUsableFor(check, target) {
  if (!check?.available) return false;
  if (!target?.region) return true;
  return (check.regions_available || []).includes(target.region);
}

// ─── 1. Choose target ────────────────────────────────────────────────────────
function TargetSelector({ options, loading, error, selectedIds, onChange, onReload }) {
  const [search, setSearch] = useState('');
  const [env, setEnv] = useState('');
  const [app, setApp] = useState('');
  const [showUnresolved, setShowUnresolved] = useState(false);
  const targets = options?.targets || [];

  const envs = useMemo(() => [...new Set(targets.map((t) => t.environment).filter(Boolean))].sort(), [targets]);
  const apps = useMemo(() => [...new Set(targets.map((t) => t.app_name || t.app_id).filter(Boolean))].sort(), [targets]);
  const q = search.trim().toLowerCase();
  const shown = targets.filter((t) =>
    (!env || t.environment === env)
    && (!app || (t.app_name || t.app_id) === app)
    && (!q || [t.server_name, t.catalog_name, t.instance_id, t.app_name, t.app_id, t.account_id]
      .some((v) => String(v || '').toLowerCase().includes(q))));

  const selectedSet = new Set(selectedIds);
  const toggle = (id) => onChange(selectedSet.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  const shownSelectable = shown.filter((t) => t.selectable);
  const allShownSelected = shownSelectable.length > 0 && shownSelectable.every((t) => selectedSet.has(t.instance_id));
  const toggleAllShown = () => {
    if (allShownSelected) {
      const drop = new Set(shownSelectable.map((t) => t.instance_id));
      onChange(selectedIds.filter((id) => !drop.has(id)));
    } else {
      const add = shownSelectable.map((t) => t.instance_id).filter((id) => !selectedSet.has(id));
      onChange([...selectedIds, ...add].slice(0, MAX_BATCH));
    }
  };
  const overCap = selectedIds.length >= MAX_BATCH;

  return (
    <SectionCard tone={1} title="Choose target"
      helper="SQL servers you are authorized to check. Access follows your GDBA SQL team permission, not application access."
      right={selectedIds.length > 0 && (
        <>
          <Chip>{selectedIds.length === 1 ? targets.find((t) => t.instance_id === selectedIds[0])?.server_name : `${selectedIds.length} servers selected`}</Chip>
          <Btn size="sm" variant="ghost" onClick={() => onChange([])}>Clear</Btn>
        </>
      )}>
      {loading && !options && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#657185' }}>
          <Spinner size={14} /> Loading authorized SQL servers…
        </div>
      )}

      {options?.source_error && (
        <Callout tone="danger" title="The SQL server list is unavailable" action={<Btn size="sm" onClick={onReload}>Try again</Btn>}>
          {options.source_error} No targets can be offered until it can be read.
        </Callout>
      )}

      {options && !options.source_error && (
        <>
          <div style={{ fontSize: 12, color: '#657185' }}>
            From the GDBA MSSQL server list (<span style={{ fontFamily: 'var(--font-mono)' }}>{options.source?.file}</span>)
            matched to the RunStack instance catalog{options.scope === 'SCOPED' ? ', limited to the servers in your health check scope' : ''}.
          </div>

          {targets.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px,2fr) minmax(140px,1fr) minmax(160px,1fr)', gap: 10 }}>
              <Input placeholder="Search server, application, instance or account" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search targets" />
              <Select value={env} onChange={(e) => setEnv(e.target.value)} aria-label="Environment">
                <option value="">All environments</option>
                {envs.map((e) => <option key={e} value={e}>{e}</option>)}
              </Select>
              <Select value={app} onChange={(e) => setApp(e.target.value)} aria-label="Application">
                <option value="">All applications</option>
                {apps.map((a) => <option key={a} value={a}>{a}</option>)}
              </Select>
            </div>
          )}

          {targets.length === 0 ? (
            <Empty message="No SQL servers are available to you. If you expect to see servers here, contact a RunStack administrator." />
          ) : (
            <div style={{ border: '1px solid #DCE2EA', borderRadius: 8, maxHeight: 360, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ position: 'sticky', top: 0, background: '#FAFBFC', zIndex: 1 }}>
                  <tr style={{ textAlign: 'left', color: '#657185', fontSize: 12 }}>
                    <th style={th}>
                      <input type="checkbox" checked={allShownSelected} disabled={!shownSelectable.length}
                        onChange={toggleAllShown} aria-label="Select all shown servers" title="Select all shown" />
                    </th>
                    <th style={th}>Server</th>
                    <th style={th}>Application</th>
                    <th style={th}>Environment</th>
                    <th style={th}>AWS account</th>
                    <th style={th}>Region</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => {
                    const isSel = selectedSet.has(t.instance_id);
                    const blocked = !t.selectable || (!isSel && overCap);
                    return (
                      <tr key={t.instance_id}
                        onClick={() => !blocked && toggle(t.instance_id)}
                        title={t.unavailable_reason || undefined}
                        style={{
                          borderTop: '1px solid #EEF2F6',
                          background: isSel ? '#FAFBFC' : 'transparent',
                          cursor: blocked ? 'not-allowed' : 'pointer',
                          opacity: t.selectable ? 1 : 0.55,
                        }}>
                        <td style={td}>
                          <input type="checkbox" checked={isSel} disabled={blocked}
                            onClick={(e) => e.stopPropagation()} onChange={() => toggle(t.instance_id)} aria-label={`Select ${t.server_name}`} />
                        </td>
                        <td style={td}>
                          <div style={{ fontWeight: 600, color: '#202938' }}>{t.server_name}</div>
                          <MonoField value={t.instance_id} dim />
                          {!t.selectable && <div style={{ fontSize: 12, color: '#92400E', marginTop: 2 }}>{t.unavailable_reason}</div>}
                        </td>
                        <td style={td}>{t.app_name || t.app_id || '—'}{t.app_name && t.app_id ? <div style={{ fontSize: 12, color: '#657185' }}>{t.app_id}</div> : null}</td>
                        <td style={td}>{t.environment || '—'}</td>
                        <td style={td}><MonoField value={t.account_id || '—'} /></td>
                        <td style={td}>{t.region || '—'}</td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: '#657185', padding: 20 }}>No servers match these filters.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {targets.length > 0 && (
            <div style={{ fontSize: 12, color: overCap ? '#92400E' : '#657185' }}>
              Showing {shown.length} of {targets.length} authorized server{targets.length === 1 ? '' : 's'}.
              {' '}Tick one server for a detailed check, or several (up to {MAX_BATCH}) to check them together.
              {overCap && ` The ${MAX_BATCH}-server limit for one run is reached.`}
            </div>
          )}

          {options.environment_rule && (
            <Callout tone="info">SQL health checks are enabled for {options.environment_rule.join(', ')} environments only. Servers in other environments are shown but can’t be selected.</Callout>
          )}

          {options.unresolved_count > 0 && (
            <Callout tone="warning" title={`${options.unresolved_count} server${options.unresolved_count === 1 ? '' : 's'} on the SQL list can’t be checked`}
              action={<Btn size="sm" variant="ghost" onClick={() => setShowUnresolved((v) => !v)}>{showUnresolved ? 'Hide' : 'Show'}</Btn>}>
              They are on the GDBA server list but not in the RunStack instance catalog, so RunStack doesn’t know their AWS account or region.
              {showUnresolved && (
                <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{options.unresolved.join(', ')}</div>
              )}
            </Callout>
          )}
        </>
      )}
      {error && options && <Callout tone="warning">Showing the last loaded list. Refresh failed: {error.text}</Callout>}
    </SectionCard>
  );
}

const th = { padding: '8px 10px', fontWeight: 600,};
const td = { fontSize: 14, padding: '8px 10px', verticalAlign: 'top' };

// ─── 2. Choose health check ──────────────────────────────────────────────────
function HealthCheckOptions({ checks, loading, loaded, target, selectedId, onSelect, form, onChange, errors, serverErrors, touched }) {
  const selected = checks.find((c) => c.id === selectedId);
  return (
    <SectionCard tone={2} title="Choose health check"
      helper="Checks are built from the SSM documents themselves; only the parameters a document requires are asked for.">
      {loading && !checks.length && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#657185' }}><Spinner size={14} /> Reading health check documents…</div>
      )}
      {!loading && loaded && !checks.length && <Empty message="No health checks are configured." />}
      {!loading && !loaded && (
        <div style={{ fontSize: 13, color: '#657185' }}>Health checks appear here once the options above load.</div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        {checks.map((c) => {
          const regionOk = !target || !target.region || (c.regions_available || []).includes(target.region);
          const usable = c.available && regionOk;
          const isSel = c.id === selectedId;
          const reason = !c.available ? c.reason
            : !regionOk ? `${c.document} is not available in ${target.region}, where ${target.server_name} runs.` : null;
          return (
            <button key={c.id} type="button" disabled={!usable} onClick={() => onSelect(c.id)}
              aria-pressed={isSel}
              style={{
                textAlign: 'left', padding: 14, borderRadius: 10, font: 'inherit',
                border: `1.5px solid ${isSel ? '#365D9D' : '#DCE2EA'}`,
                background: isSel ? '#FAFBFC' : usable ? '#FFFFFF' : '#FAFBFC',
                cursor: usable ? 'pointer' : 'not-allowed', opacity: usable ? 1 : 0.7, display: 'grid', gap: 6,
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
                  border: `2px solid ${isSel ? '#365D9D' : '#C9D1DC'}`, background: isSel ? 'radial-gradient(#365D9D 45%, transparent 50%)' : 'transparent',
                }} />
                <span style={{ fontWeight: 600, fontSize: 14, color: '#202938' }}>{c.label}</span>
                {!usable && <span style={{ marginLeft: 'auto' }}><Chip tone="gray">Unavailable</Chip></span>}
              </div>
              <div style={{ fontSize: 12, color: '#657185' }}>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{c.document}</span>
                {c.document_version && <> · v{c.document_version}</>}
              </div>
              {c.description && <div style={{ fontSize: 13, color: '#3B4658' }}>{c.description}</div>}
              {c.regions_available?.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {c.regions_available.map((r) => <Chip key={r} tone="gray">{r}</Chip>)}
                </div>
              )}
              {reason && <div style={{ fontSize: 12, color: '#92400E' }}>{reason}</div>}
            </button>
          );
        })}
      </div>

      {selected && (
        <div style={{ display: 'grid', gap: 12 }}>
          <Eyebrow>Parameters</Eyebrow>
          {selected.parameters.length === 0 && (
            <div style={{ fontSize: 13, color: '#657185' }}>This check needs no parameters.</div>
          )}
          {selected.parameters.map((p) => (
            <ParamField key={p.name} spec={p} value={form[p.name]} onChange={(v) => onChange(p.name, v)}
              error={(touched[p.name] && errors[p.name]) || serverErrors?.[p.name] || null} />
          ))}
          {selected.optional_parameter_count > 0 && (
            <div style={{ fontSize: 12, color: '#657185' }}>
              {selected.optional_parameter_count} optional parameter{selected.optional_parameter_count === 1 ? '' : 's'} will use the document’s default value{selected.optional_parameter_count === 1 ? '' : 's'}.
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ─── 3. Review and run ───────────────────────────────────────────────────────
function ExecutionReview({ target, targets, runnable, check, form, canRun, submitting, progress, onRun, error, paramErrorCount }) {
  const params = check ? toRequestParameters(check.parameters, form) : {};
  const n = targets.length;
  const batch = n > 1;
  const skipped = batch && check ? n - runnable.length : 0;
  const missing = !n ? 'Choose a target.' : !check ? 'Choose a health check.' : paramErrorCount ? 'Complete the parameters above.'
    : n > MAX_BATCH ? `Select at most ${MAX_BATCH} servers.` : null;
  const envs = [...new Set(targets.map((t) => t.environment || '—'))];
  const accounts = [...new Set(targets.map((t) => t.account_id).filter(Boolean))];
  const regions = [...new Set(targets.map((t) => t.region).filter(Boolean))];
  return (
    <SectionCard tone={3} title="Review and run"
      helper={batch
        ? 'Starts one health check job per server through RunStack — each runs in the server’s own AWS account and region and is authorized separately. Read-only.'
        : 'Runs through RunStack: the job goes to Step Functions, which runs the SSM document on the server in its own AWS account and region. Read-only.'}>
      <div style={{ display: 'grid', gap: 8, maxWidth: 640 }}>
        {batch ? (
          <>
            <ReviewRow label="Servers" value={`${n} selected${skipped ? ` · ${skipped} can’t run this check` : ''}`} />
            <ReviewRow label="Environments" value={envs.join(', ')} />
            <ReviewRow label="AWS accounts / regions" value={`${accounts.length} account${accounts.length === 1 ? '' : 's'} · ${regions.join(', ') || '—'}`} />
          </>
        ) : (
          <>
            <ReviewRow label="Server" value={target ? target.server_name : '—'} />
            <ReviewRow label="Application" value={target ? (target.app_name || target.app_id || '—') : '—'} />
            <ReviewRow label="Environment" value={target?.environment || '—'} />
            <ReviewRow label="AWS account / region" value={target ? `${target.account_id || '—'} · ${target.region || '—'}` : '—'} mono />
          </>
        )}
        <ReviewRow label="Health check" value={check ? `${check.label} (${docShortName(check.document)}${check.document_version ? ` v${check.document_version}` : ''})` : '—'} />
        {check && check.parameters.length > 0 && check.parameters.map((p) => (
          <ReviewRow key={p.name} label={p.name} mono
            value={params[p.name] === undefined ? '—' : Array.isArray(params[p.name]) ? params[p.name].join(', ') : params[p.name]} />
        ))}
        {check && check.parameters.length === 0 && <ReviewRow label="Parameters" value="None required" />}
      </div>

      {batch && skipped > 0 && (
        <Callout tone="warning">{skipped} selected server{skipped === 1 ? '' : 's'} can’t run this check (region or environment) and will be listed as not started.</Callout>
      )}

      {error && (
        <Callout tone="danger" title={batch ? 'The health checks were not started' : 'The health check was not started'}>
          {error.text}
          {error.detail && <div style={{ marginTop: 4, fontSize: 12, opacity: 0.85 }}>{error.detail}</div>}
        </Callout>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Btn variant="primary" onClick={onRun} disabled={!canRun || submitting}>
          {submitting
            ? <><Spinner size={13} /> {progress ? `Starting ${progress.done} of ${progress.total}…` : 'Starting…'}</>
            : batch ? `Run Health Check on ${runnable.length} server${runnable.length === 1 ? '' : 's'}` : 'Run Health Check'}
        </Btn>
        {!submitting && missing && <span style={{ fontSize: 13, color: '#657185' }}>{missing}</span>}
      </div>
    </SectionCard>
  );
}

// ─── Job view: details, progress, results ────────────────────────────────────
function JobSummary({ job, checks }) {
  const doc = docShortName(job.automation_data?.DocumentName);
  const check = checks.find((c) => c.id === job.check_type) || checks.find((c) => c.document === doc);
  const isHealthCheck = !!check || !!job.check_type;
  const params = job.automation_data?.Parameters || {};
  return (
    <SectionCard tone={1} title="Health check details">
      {!isHealthCheck && (
        <Callout tone="warning" title="This job doesn’t look like a SQL health check">
          It ran <span style={{ fontFamily: 'var(--font-mono)' }}>{doc || job.automation_type}</span>. Results below are shown as recorded;
          open it in Automation Executions for the full record.
        </Callout>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        <SummaryTile label="Server" value={job.server_name || job.resource_id || '—'} sub={job.resource_id} />
        <SummaryTile label="Application" value={job.app_name || job.app_id || '—'} sub={job.environment ? `Environment: ${job.environment}` : undefined} />
        <SummaryTile label="AWS account / region" value={job.account_id || '—'} sub={job.region} mono />
        <SummaryTile label="Health check" value={check?.label || doc || '—'} sub={doc} />
      </div>
      {Object.keys(params).length > 0 && (
        <div style={{ display: 'grid', gap: 6, maxWidth: 640 }}>
          <Eyebrow>Parameters</Eyebrow>
          {Object.entries(params).map(([k, v]) => <ReviewRow key={k} label={k} value={Array.isArray(v) ? v.join(', ') : String(v)} mono />)}
        </div>
      )}
    </SectionCard>
  );
}

function JobProgress({ job }) {
  const group = statusGroup(job.status);
  const dur = jobDuration(job);
  const [copied, setCopied] = useState(false);
  const failed = group === 'FAILED';
  const inProgress = { PENDING: 'queued', RUNNING: 'running' }[group] || null;
  const steps = [
    { key: 'queued', label: 'Queued', done: group !== 'PENDING' },
    { key: 'running', label: 'Running on the server', done: group === 'COMPLETED' || failed },
    { key: 'finished', label: failed ? 'Did not complete' : 'Finished', done: group === 'COMPLETED' || failed },
  ];
  return (
    <SectionCard tone={4} title="Progress"
      helper={isActive(job.status) ? 'Updates automatically while the check runs. You can leave this page and come back — the link keeps this job.' : undefined}
      right={<StatusBadge status={String(job.status || 'PENDING').toUpperCase()} />}>
      <ol style={{ display: 'flex', gap: 8, listStyle: 'none', padding: 0, margin: 0, flexWrap: 'wrap' }}>
        {steps.map((s) => {
          const active = s.key === inProgress;
          const bad = s.key === 'finished' && failed;
          return (
            <li key={s.key} aria-current={active ? 'step' : undefined} style={{
              display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999, fontSize: 13,
              background: bad ? '#FDECEC' : s.done || active ? '#EEF3FA' : '#F5F6F8',
              color: bad ? '#9A1E1E' : s.done || active ? '#2C4D84' : '#657185', fontWeight: active ? 700 : 500,
            }}>
              {active ? <Spinner size={11} /> : <span aria-hidden>{bad ? '✕' : s.done ? '✓' : '○'}</span>}
              {s.label}
            </li>
          );
        })}
      </ol>
      <div style={{ display: 'grid', gap: 8, maxWidth: 640 }}>
        <ReviewRow label="Job ID" value={
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <MonoField value={job.job_id} />
            <Btn size="sm" variant="ghost" onClick={async () => { await copyText(job.job_id); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? 'Copied' : 'Copy'}
            </Btn>
          </span>
        } />
        <ReviewRow label="Started" value={fmtFull(job.created_at)} />
        <ReviewRow label={dur.live ? 'Running for' : 'Execution time'} value={dur.text} />
        {!isActive(job.status) && <ReviewRow label="Finished" value={fmtFull(job.updated_at)} />}
        {job.requested_by && <ReviewRow label="Started by" value={job.requested_by} />}
        {job.execution_id && <ReviewRow label="Step Functions execution" value={job.execution_id} mono />}
      </div>
      <div>
        <Link to={`/jobs/${encodeURIComponent(job.job_id)}`} style={{ fontSize: 13, color: '#365D9D', fontWeight: 600 }}>
          Open in Automation Executions →
        </Link>
      </div>
    </SectionCard>
  );
}

function HealthCheckResults({ job }) {
  const r = interpretResult(job);
  // Raw output opens by default for anything that isn't a clean pass.
  const [showOverride, setShowOverride] = useState(null);
  const showOutput = showOverride ?? !['healthy', 'passed'].includes(r?.state);
  if (!r || r.state === 'running') {
    return (
      <SectionCard tone="neutral" title="Results">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: '#657185' }}>
          <Spinner size={14} /> Results appear here when the check finishes. No result is shown until then.
        </div>
      </SectionCard>
    );
  }
  const raw = visibleOutput(job.output);
  const stderr = String(job.stderr_output || '').trim();
  const toneMap = { green: 'success', amber: 'warning', red: 'danger', default: 'info' };
  return (
    <SectionCard tone={r.tone === 'red' ? 'caution' : 4} title="Results">
      <Callout tone={toneMap[r.tone] || 'info'} title={r.label}>{r.summary}</Callout>

      {r.health?.length > 0 && (
        <div style={{ display: 'grid', gap: 6, maxWidth: 640 }}>
          <Eyebrow>Health checks</Eyebrow>
          {r.health.map((h) => (
            <ReviewRow key={h.label} label={h.label}
              value={<Chip tone={h.bad ? 'red' : h.ok ? 'green' : 'gray'}>{h.value || '—'}</Chip>} />
          ))}
        </div>
      )}

      {r.db.present && r.db.rows.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12 }}>
            <SummaryTile label="Databases" value={r.db.rows.length} />
            <SummaryTile label="Healthy" value={r.counts.healthy} tone="green" />
            <SummaryTile label="Warnings" value={r.counts.warning} tone={r.counts.warning ? 'amber' : 'gray'} />
            <SummaryTile label="Failed" value={r.counts.failed} tone={r.counts.failed ? 'red' : 'gray'} />
            <SummaryTile label="Not checked" value={r.counts.unavailable} tone={r.counts.unavailable ? 'amber' : 'gray'} />
          </div>
          <div style={{ border: '1px solid #DCE2EA', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#FAFBFC' }}>
                <tr style={{ textAlign: 'left', color: '#657185', fontSize: 12 }}>
                  <th style={th}>Database</th><th style={th}>Result</th><th style={th}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {r.db.rows.map((row, i) => (
                  <tr key={`${row.database}-${i}`} style={{ borderTop: '1px solid #EEF2F6' }}>
                    <td style={{ ...td, fontWeight: 600 }}>{row.database || '—'}</td>
                    <td style={td}><DbStatusChip row={row} /></td>
                    <td style={{ ...td, color: '#3B4658' }}>{row.detail || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {r.patch?.length > 0 && (
        <div style={{ display: 'grid', gap: 6, maxWidth: 640 }}>
          <Eyebrow>Patch validation — informational, not part of the health result</Eyebrow>
          {r.patch.map((h) => (
            <ReviewRow key={h.label} label={h.label}
              value={<Chip tone={h.ok ? 'green' : h.bad ? 'amber' : 'gray'}>{h.value || '—'}</Chip>} />
          ))}
        </div>
      )}

      {r.notes.map((n) => <Callout key={n} tone={r.state === 'failed' ? 'danger' : 'info'}>{n}</Callout>)}

      {stderr && r.state !== 'failed' && (
        <Callout tone="danger" title="Errors reported by the command">
          <pre style={preStyle}>{stderr}</pre>
        </Callout>
      )}

      <div>
        <Btn size="sm" variant="ghost" onClick={() => setShowOverride(!showOutput)}>
          {showOutput ? 'Hide raw output' : 'Show raw output'}
        </Btn>
        {showOutput && (
          <pre style={{ ...preStyle, marginTop: 8, maxHeight: 420 }}>{raw || 'No output was recorded.'}</pre>
        )}
      </div>
    </SectionCard>
  );
}

// ─── Multi-server batch ──────────────────────────────────────────────────────
const VERDICT = {
  running:    { tone: 'default', label: 'Running' },
  healthy:    { tone: 'green', label: 'Healthy' },
  passed:     { tone: 'green', label: 'Passed' },
  warning:    { tone: 'amber', label: 'Warnings' },
  unhealthy:  { tone: 'red', label: 'Unhealthy' },
  incomplete: { tone: 'amber', label: 'Partially checked' },
  unknown:    { tone: 'amber', label: 'Result not reported' },
  failed:     { tone: 'red', label: 'Did not complete' },
  notstarted: { tone: 'gray', label: 'Not started' },
};
const NEEDS_ATTENTION = new Set(['warning', 'unhealthy', 'incomplete', 'unknown', 'failed', 'notstarted']);

function BatchView({ batchKey, jobIds, checks }) {
  const record = useMemo(() => {
    try { return JSON.parse(sessionStorage.getItem(BATCH_STORE + batchKey) || 'null'); } catch { return null; }
  }, [batchKey]);
  const [jobs, setJobs] = useState({});
  const [errors, setErrors] = useState({});
  const [expanded, setExpanded] = useState(null);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const load = useCallback(async () => {
    const todo = jobIds.filter((id) => !jobsRef.current[id] || isActive(jobsRef.current[id].status));
    const got = await mapLimit(todo, FETCH_CONCURRENCY, async (id) => {
      try { return [id, await fetchJob(id), null]; } catch (e) { return [id, null, errorInfo(e)]; }
    });
    setJobs((prev) => { const next = { ...prev }; got.forEach(([id, j]) => { if (j) next[id] = j; }); return next; });
    setErrors((prev) => { const next = { ...prev }; got.forEach(([id, j, err]) => { if (j) delete next[id]; else next[id] = err; }); return next; });
  }, [jobIds]);

  const allLoaded = jobIds.every((id) => jobs[id] || (errors[id] && errors[id].status === 404));
  const anyActive = !allLoaded || jobIds.some((id) => jobs[id] && isActive(jobs[id].status));
  const poll = useAutoRefresh(load, { intervalMs: BATCH_POLL_MS, enabled: anyActive });
  useEffect(() => { poll.refresh(); }, [batchKey]);
  usePageRefresh(() => poll.refresh());

  const notStarted = (record?.rows || []).filter((r) => !r.job_id);
  const rows = [
    ...jobIds.map((id) => {
      const job = jobs[id];
      const err = errors[id];
      const r = job ? interpretResult(job) : null;
      const state = r ? r.state : err?.status === 404 ? 'failed' : 'running';
      return { id, job, r, state, err, server: job?.server_name || record?.rows?.find((x) => x.job_id === id)?.server_name || id };
    }),
    ...notStarted.map((x) => ({ id: `ns-${x.instance_id}`, job: null, r: null, state: 'notstarted', server: x.server_name, reason: x.error })),
  ];
  const count = (st) => rows.filter((x) => st.includes(x.state)).length;
  const running = count(['running']);
  const shown = attentionOnly ? rows.filter((x) => NEEDS_ATTENTION.has(x.state)) : rows;
  const checkLabel = record?.check || checks.find((c) => c.id === rows.find((x) => x.job)?.job?.check_type)?.label || 'SQL Server health check';

  const overall = running
    ? { tone: 'info', title: `${running} of ${rows.length} still running`, text: 'Results fill in as each server finishes. You can leave this page — the link keeps this batch.' }
    : count(['unhealthy', 'failed'])
      ? { tone: 'danger', title: 'Some servers need attention', text: `${count(['unhealthy'])} unhealthy, ${count(['failed'])} did not complete.` }
      : count(['incomplete', 'unknown', 'warning', 'notstarted'])
        ? { tone: 'warning', title: 'Checked with gaps', text: 'No server is unhealthy, but some results are partial, have warnings, or did not start.' }
        : { tone: 'success', title: 'All servers healthy', text: `All ${rows.length} servers passed.` };

  return (
    <>
      <SectionCard tone={4} title={`${checkLabel} — ${rows.length} server${rows.length === 1 ? '' : 's'}`}
        helper="One health check job per server. Each result is decided from that server’s own output."
        right={<RefreshControl onRefresh={poll.refresh} refreshing={poll.refreshing} lastUpdated={poll.lastUpdated}
          autoEverySec={anyActive ? BATCH_POLL_MS / 1000 : undefined} error={poll.error} />}>
        <Callout tone={overall.tone} title={overall.title}>{overall.text}</Callout>
        {record?.execution_group_id && record?.run_job_id && (
          <div style={{ fontSize: 13 }}>
            <Link to={`/jobs/${encodeURIComponent(record.run_job_id)}`} style={{ color: '#365D9D', fontWeight: 600 }}>
              Open as one run in Automation Executions →
            </Link>
            <span style={{ color: '#657185', marginLeft: 8 }}>Live status and output for every server in this run</span>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12 }}>
          <SummaryTile label="Healthy" value={count(['healthy', 'passed'])} tone="green" />
          <SummaryTile label="Unhealthy" value={count(['unhealthy'])} tone={count(['unhealthy']) ? 'red' : 'gray'} />
          <SummaryTile label="Warnings / partial" value={count(['warning', 'incomplete', 'unknown'])} tone={count(['warning', 'incomplete', 'unknown']) ? 'amber' : 'gray'} />
          <SummaryTile label="Did not complete" value={count(['failed'])} tone={count(['failed']) ? 'red' : 'gray'} />
          <SummaryTile label="Running" value={running} tone={running ? 'default' : 'gray'} />
          {notStarted.length > 0 && <SummaryTile label="Not started" value={notStarted.length} tone="gray" />}
        </div>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: '#3B4658' }}>
          <input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} />
          Show only servers that need attention
        </label>
        <div style={{ border: '1px solid #DCE2EA', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: '#FAFBFC' }}>
              <tr style={{ textAlign: 'left', color: '#657185', fontSize: 12 }}>
                <th style={th}>Server</th><th style={th}>Application · Environment</th><th style={th}>Account · Region</th>
                <th style={th}>Job</th><th style={th}>Result</th><th style={th}>Time</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((x) => {
                const v = VERDICT[x.state];
                const open = expanded === x.id;
                return (
                  <React.Fragment key={x.id}>
                    <tr onClick={() => x.job && setExpanded(open ? null : x.id)}
                      style={{ borderTop: '1px solid #EEF2F6', cursor: x.job ? 'pointer' : 'default', background: open ? '#FAFBFC' : 'transparent' }}>
                      <td style={{ ...td, fontWeight: 600 }}>{x.job ? (open ? '▾ ' : '▸ ') : ''}{x.server}</td>
                      <td style={td}>{x.job ? `${x.job.app_name || x.job.app_id || '—'} · ${x.job.environment || '—'}` : '—'}</td>
                      <td style={td}>{x.job ? <MonoField value={`${x.job.account_id || '—'} · ${x.job.region || '—'}`} /> : '—'}</td>
                      <td style={td}>{x.job ? <StatusBadge status={String(x.job.status || 'PENDING').toUpperCase()} /> : '—'}</td>
                      <td style={td}>
                        <Chip tone={v.tone}>{v.label}</Chip>
                        <div style={{ fontSize: 12, color: '#657185', marginTop: 3 }}>
                          {x.state === 'notstarted' ? x.reason : x.err && !x.job ? x.err.text : (x.r && x.state !== 'running' ? x.r.summary : '')}
                        </div>
                      </td>
                      <td style={td}>{x.job ? jobDuration(x.job).text : '—'}</td>
                    </tr>
                    {open && x.job && (
                      <tr><td colSpan={6} style={{ padding: 12, background: '#FBFDFC' }}>
                        <div style={{ display: 'grid', gap: 12 }}>
                          <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
                            <Link to={`/database/sql-health-check?job=${encodeURIComponent(x.job.job_id)}`} style={{ color: '#365D9D', fontWeight: 600 }}>Open full result →</Link>
                            <Link to={`/jobs/${encodeURIComponent(x.job.job_id)}`} style={{ color: '#365D9D', fontWeight: 600 }}>Open in Automation Executions →</Link>
                            <span style={{ color: '#657185' }}>Job <MonoField value={x.job.job_id} /></span>
                          </div>
                          <HealthCheckResults job={x.job} />
                        </div>
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
              {shown.length === 0 && (
                <tr><td colSpan={6} style={{ ...td, textAlign: 'center', color: '#657185', padding: 20 }}>No servers need attention.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {!record && notStarted.length === 0 && (
          <div style={{ fontSize: 12, color: '#657185' }}>
            Servers that could not be started are only listed in the browser tab that ran the check.
          </div>
        )}
      </SectionCard>
    </>
  );
}

function DbStatusChip({ row }) {
  const map = { healthy: ['green', 'Healthy'], warning: ['amber', 'Warning'], failed: ['red', 'Failed'], unavailable: ['gray', 'Not checked'] };
  const [tone, label] = map[row.status] || map.unavailable;
  return <Chip tone={tone} title={row.rawStatus ? `Reported as ${row.rawStatus}` : undefined}>{label}</Chip>;
}

const preStyle = {
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--font-mono)', fontSize: 12,
  background: '#202938', color: '#DCE2EA', padding: 12, borderRadius: 8, overflowY: 'auto', margin: 0,
};
