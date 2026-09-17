// src/pages/DRFailover.jsx
//
// Everything SSM-backed here is async — API Gateway's 29s limit is shorter
// than the Step Function's own 30s initial wait, so nothing that touches
// SSM can return a synchronous answer. Two places poll:
//
//  1. "Check Live Roles" — triggers a role-check job, polls it to
//     completion, shows the role table. The completed job_id then gets
//     passed to Pre-Validation (step 3) instead of that step re-checking
//     live state itself.
//  2. "Execute Failover" — creates the failover job and returns
//     immediately; polling GET /dr-failover/{AG}/status/{RunId} both
//     checks AND ADVANCES the run's state machine
//     (EXECUTING -> CONFIRMING -> SUCCESS/NEEDS_MANUAL_CHECK) — the
//     backend does the next step's work lazily, on whichever poll notices
//     the previous step finished.
//
// NOTE: pre-validation covers replica health + per-DB sync/queue size —
// it does NOT yet include the WSFC quorum/member check, port 5022 test, or
// active-transaction check from the original scripts (backend open item).

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Topbar } from '../components/Layout';
import {
  Card, CardHead, Btn, FormRow, Input, Select, ErrorBanner,
  Spinner, Empty, SectionTitle, MonoField, StatusBadge,
} from '../components/ui';
import {
  fetchDrAgNames, fetchDrAgServers, triggerDrAgRoles, pollDrRolesJob, fetchDrConfig,
  planDrFailover, executeDrFailover, fetchDrRunStatus,
} from '../api/client';

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 100; // ~5 minutes at 3s — generous, SSM+cross-account can be slow

const RUN_TERMINAL_STATUSES = new Set(['SUCCESS', 'NEEDS_MANUAL_CHECK', 'EXECUTE_FAILED', 'PLAN_FAILED', 'REJECTED']);

/** Polls `fn()` every `intervalMs` until `isDone(result)` is true, or
 *  throws after maxAttempts. Calls `onTick(result)` after every poll
 *  (including the final one) so the caller can update UI progressively. */
async function pollUntil(fn, isDone, { intervalMs = POLL_INTERVAL_MS, maxAttempts = POLL_MAX_ATTEMPTS, onTick } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await fn();
    if (onTick) onTick(result);
    if (isDone(result)) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for a result — the operation may still be running in the background.');
}

function CheckRow({ check }) {
  const pass = check.result === 'PASS';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 0', borderBottom: '1px solid #EFEBE7', fontSize: 12.5,
    }}>
      <span style={{
        flexShrink: 0, width: 18, height: 18, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11, fontWeight: 700, color: '#FFFFFF',
        background: pass ? '#1C9C6B' : '#D14600',
      }}>
        {pass ? '✓' : '✕'}
      </span>
      <span style={{ color: '#0E1020' }}>{check.detail}</span>
    </div>
  );
}

function RoleTable({ roles, drReplicaHost }) {
  if (!roles || roles.length === 0) return <Empty message="No replica rows returned." />;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
      <thead>
        <tr style={{ textAlign: 'left', color: '#7A7D95', fontSize: 11 }}>
          <th style={{ padding: '6px 8px' }}>Replica</th>
          <th style={{ padding: '6px 8px' }}>Role</th>
          <th style={{ padding: '6px 8px' }}>Sync Health</th>
          <th style={{ padding: '6px 8px' }}>Connected</th>
          <th style={{ padding: '6px 8px' }}>Commit Mode</th>
        </tr>
      </thead>
      <tbody>
        {roles.map((r, i) => {
          const isDrReplica = drReplicaHost && r.Replica === drReplicaHost;
          return (
            <tr key={i} style={{ borderTop: '1px solid #EFEBE7', background: isDrReplica ? '#FFF7ED' : 'transparent' }}>
              <td style={{ padding: '6px 8px' }}>
                <MonoField value={r.Replica} />
                {isDrReplica && <span style={{ marginLeft: 6, fontSize: 10.5, color: '#D14600', fontWeight: 600 }}>DR TARGET</span>}
              </td>
              <td style={{ padding: '6px 8px', fontWeight: r.Role === 'PRIMARY' ? 700 : 400, color: r.Role === 'PRIMARY' ? '#004AAC' : '#0E1020' }}>
                {r.Role}
              </td>
              <td style={{ padding: '6px 8px' }}>{r.SyncHealth}</td>
              <td style={{ padding: '6px 8px' }}>{r.ConnState}</td>
              <td style={{ padding: '6px 8px' }}>{r.CommitMode}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const RUN_STATUS_LABEL = {
  PLANNED: 'Planned',
  PLAN_FAILED: 'Plan Failed',
  EXECUTING: 'Executing failover…',
  CONFIRMING: 'Confirming new primary…',
  SUCCESS: 'Succeeded',
  NEEDS_MANUAL_CHECK: 'Needs manual check',
  EXECUTE_FAILED: 'Execute Failed',
  REJECTED: 'Rejected',
};

export default function DRFailover() {
  const [agNames, setAgNames] = useState([]);
  const [agLoading, setAgLoading] = useState(true);
  const [agError, setAgError] = useState(null);

  const [selectedAg, setSelectedAg] = useState('');
  const [servers, setServers] = useState(null);
  const [thresholds, setThresholds] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  const [roles, setRoles] = useState(null);
  const [dbSync, setDbSync] = useState(null);
  const [roleCheckJobId, setRoleCheckJobId] = useState(null);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [rolesStatus, setRolesStatus] = useState(null); // 'PENDING' | 'COMPLETED' while polling
  const [rolesError, setRolesError] = useState(null);

  const [planResult, setPlanResult] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [targetChoice, setTargetChoice] = useState(null); // set when /plan returns needs_target_choice — both HA and DR candidates exist

  const [confirmText, setConfirmText] = useState('');
  const [runStatus, setRunStatus] = useState(null); // full run record, polled/advanced via fetchDrRunStatus
  const [executeLoading, setExecuteLoading] = useState(false);
  const [executeError, setExecuteError] = useState(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false); // Teams card is out, nobody has actioned it yet

  const cancelRef = useRef(false);
  // Incremented on every "Check Live Roles" click. A poll loop only applies
  // its results if its captured generation still matches — an older,
  // still-running loop from a previous click (e.g. clicked again before the
  // first attempt finished) becomes a no-op instead of clobbering fresher
  // state with a stale/late tick.
  const rolesRunIdRef = useRef(0);
  // Explicit reset in the setup (not just the cleanup) matters here: React 18
  // StrictMode double-invokes effects in development (setup -> cleanup ->
  // setup) specifically to surface bugs like this — without resetting on
  // setup, the cleanup's `= true` would never get undone, permanently
  // short-circuiting every cancelRef guard in this component from the very
  // first render in dev mode (production builds don't double-invoke, so
  // this wouldn't have shown up there).
  useEffect(() => {
    cancelRef.current = false;
    return () => { cancelRef.current = true; };
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchDrAgNames();
        setAgNames(res.ag_names || []);
      } catch (e) {
        setAgError(e.message);
      } finally {
        setAgLoading(false);
      }
    })();
  }, []);

  // Plan already posts the Teams Adaptive Card for this run_id server-side —
  // this effect starts watching that SAME run record the moment a token
  // exists, so approval via Teams shows up here live even if nobody clicks
  // Execute below. Whichever path (Teams approve, or Execute here) consumes
  // the one-time token first "wins" — this poll just reflects whatever the
  // backend record says, regardless of which path drove it.
  useEffect(() => {
    if (!planResult?.all_pass || !planResult?.confirmation_token || !planResult?.run_id) {
      setAwaitingApproval(false);
      return;
    }
    let cancelled = false;
    setAwaitingApproval(true);
    (async () => {
      try {
        const final = await pollUntil(
          () => fetchDrRunStatus(selectedAg, planResult.run_id),
          (r) => RUN_TERMINAL_STATUSES.has(r.status),
          {
            // Human approval can take a lot longer than an SSM op — poll
            // slower and for much longer than the execute-phase default.
            intervalMs: 5000,
            maxAttempts: 720, // 1 hour
            onTick: (r) => {
              if (cancelled || cancelRef.current) return;
              if (r.status !== 'PLANNED') {
                setAwaitingApproval(false);
                setRunStatus(r);
              }
            },
          }
        );
        if (!cancelled && !cancelRef.current) {
          setAwaitingApproval(false);
          setRunStatus(final);
        }
      } catch (e) {
        // Timed out waiting — not an error, approval may still come later
        // or the token may simply have expired. Execute button (if the
        // token's still valid) remains available regardless.
        if (!cancelled && !cancelRef.current) setAwaitingApproval(false);
      }
    })();
    return () => { cancelled = true; };
  }, [planResult?.run_id, planResult?.confirmation_token, planResult?.all_pass, selectedAg]);

  const resetDownstream = () => {
    setRoles(null); setDbSync(null); setRoleCheckJobId(null); setRolesStatus(null); setRolesError(null);
    setPlanResult(null); setPlanError(null); setTargetChoice(null);
    setRunStatus(null); setExecuteError(null);
    setConfirmText('');
  };

  const handleSelectAg = useCallback(async (agName) => {
    setSelectedAg(agName);
    resetDownstream();
    setServers(null);
    setThresholds(null);
    if (!agName) return;

    setDetailLoading(true);
    setDetailError(null);
    try {
      const [serversRes, thresholdsRes] = await Promise.allSettled([
        fetchDrAgServers(agName),
        fetchDrConfig(agName),
      ]);
      if (serversRes.status === 'fulfilled') setServers(serversRes.value.servers || []);
      if (thresholdsRes.status === 'fulfilled') setThresholds(thresholdsRes.value);
    } catch (e) {
      setDetailError(e.message);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleCheckRoles = async () => {
    const myRun = ++rolesRunIdRef.current;
    setRolesLoading(true);
    setRolesError(null);
    setRoles(null);
    setDbSync(null);
    setRoleCheckJobId(null);
    setRolesStatus('PENDING');
    try {
      const trigger = await triggerDrAgRoles(selectedAg);
      if (myRun !== rolesRunIdRef.current || cancelRef.current) return; // superseded by a newer click

      let jobId = trigger.job_id;
      let result = null;
      for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
        const r = await pollDrRolesJob(selectedAg, jobId);
        if (myRun !== rolesRunIdRef.current || cancelRef.current) return; // a newer click has since started — drop this stale tick entirely

        if (r.status === 'RETRYING' && r.retry_job_id) {
          // Backend already dispatched a fresh job against a different host
          // (first one only saw itself) — follow it, don't keep polling the
          // now-abandoned original job_id.
          jobId = r.retry_job_id;
          setRolesStatus('PENDING');
        } else {
          setRolesStatus(r.status);
        }

        if (r.status === 'COMPLETED') {
          result = r;
          break;
        }
        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
      }
      if (myRun !== rolesRunIdRef.current || cancelRef.current) return;
      if (!result) {
        throw new Error('Timed out waiting for a result — the operation may still be running in the background.');
      }
      setRoles(result.roles || []);
      setDbSync(result.db_sync || []);
      setRoleCheckJobId(jobId);
    } catch (e) {
      if (myRun === rolesRunIdRef.current && !cancelRef.current) setRolesError(e.message);
    } finally {
      if (myRun === rolesRunIdRef.current && !cancelRef.current) setRolesLoading(false);
    }
  };

  const handlePlan = async (targetReplica) => {
    setPlanLoading(true);
    setPlanError(null);
    setPlanResult(null);
    setTargetChoice(null);
    setRunStatus(null);
    setConfirmText('');
    try {
      const res = await planDrFailover(selectedAg, roleCheckJobId, targetReplica);
      if (res.needs_target_choice) {
        setTargetChoice(res);
      } else {
        setPlanResult(res);
      }
    } catch (e) {
      setPlanError(e.message);
    } finally {
      setPlanLoading(false);
    }
  };

  const handleExecute = async () => {
    if (confirmText !== 'YES' || !planResult?.confirmation_token) return;
    setExecuteLoading(true);
    setExecuteError(null);
    try {
      const trigger = await executeDrFailover(selectedAg, planResult.confirmation_token);
      // Don't poll here — the background effect above is already watching
      // this run_id and will pick up every status change from this point,
      // same as it would if Teams had approved it instead.
      setAwaitingApproval(false);
      setRunStatus(trigger);
    } catch (e) {
      if (!cancelRef.current) {
        const alreadyActioned = runStatus && runStatus.status !== 'PLANNED';
        setExecuteError(alreadyActioned
          ? 'This failover was already approved and started (likely via the Teams card) — see status below.'
          : e.message);
      }
    } finally {
      if (!cancelRef.current) setExecuteLoading(false);
    }
  };

  // Once something has moved this run past PLANNED — whether via Teams
  // approval or a previous Execute click — the confirm/execute controls
  // stop being meaningful; the Result card below takes over.
  const canExecute = planResult?.all_pass && planResult?.confirmation_token
    && (!runStatus || runStatus.status === 'PLANNED');
  const rolesReady = roles && rolesStatus === 'COMPLETED' && roleCheckJobId;

  return (
    <>
      <Topbar
        title="DR Failover"
        subtitle="AlwaysOn Availability Group manual planned failover"
      />
      <div style={{ padding: 24, display: 'grid', gap: 20, maxWidth: 900 }}>

        {/* ── AG selection ─────────────────────────────────────────── */}
        <Card>
          <CardHead><span>1. Select Availability Group</span></CardHead>
          <div style={{ padding: 18 }}>
            {agLoading ? (
              <Spinner />
            ) : agError ? (
              <ErrorBanner message={`Could not load AG list from Dynatrace: ${agError}`} />
            ) : (
              <FormRow label="Availability Group" hint="List comes from Dynatrace sql:sql_server_availability_group entities.">
                <Select value={selectedAg} onChange={(e) => handleSelectAg(e.target.value)}>
                  <option value="">— Select an AG —</option>
                  {agNames.map((ag) => <option key={ag} value={ag}>{ag}</option>)}
                </Select>
              </FormRow>
            )}

            {detailLoading && <div style={{ marginTop: 12 }}><Spinner /></div>}
            {detailError && <div style={{ marginTop: 12 }}><ErrorBanner message={detailError} /></div>}

            {servers && servers.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <SectionTitle sub="From Dynatrace — not a live SQL query">Servers in this AG</SectionTitle>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: '#7A7D95', fontSize: 11 }}>
                      <th style={{ padding: '6px 8px' }}>Host</th>
                      <th style={{ padding: '6px 8px' }}>AG Sync Health</th>
                      <th style={{ padding: '6px 8px' }}>Backup Preference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {servers.map((s, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #EFEBE7' }}>
                        <td style={{ padding: '6px 8px' }}><MonoField value={s.host} /></td>
                        <td style={{ padding: '6px 8px' }}>{s.sync_health}</td>
                        <td style={{ padding: '6px 8px' }}>{s.backup_preference}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {thresholds && (
              <div style={{ marginTop: 12, fontSize: 11.5, color: '#7A7D95' }}>
                DR thresholds (same for every AG): max log queue {thresholds.max_log_queue_kb} KB
                {thresholds.dr_replica_override && <> · DR replica override: <MonoField value={thresholds.dr_replica_override} dim /></>}
              </div>
            )}
          </div>
        </Card>

        {/* ── Live roles ───────────────────────────────────────────── */}
        {selectedAg && (
          <Card>
            <CardHead>
              <span>2. Check Live Roles</span>
              <Btn variant="default" size="sm" onClick={handleCheckRoles} disabled={rolesLoading}>
                {rolesLoading ? <Spinner size={13} /> : 'Check Live Roles'}
              </Btn>
            </CardHead>
            <div style={{ padding: 18 }}>
              <div style={{ fontSize: 11.5, color: '#7A7D95', marginBottom: 12 }}>
                Triggers a real SQL query via SSM against one reachable replica, then polls until it
                completes — this can take 30-90 seconds. Primary and DR replica are determined from
                this result, not from stored config.
              </div>
              {rolesLoading && rolesStatus && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12, color: '#7A7D95' }}>
                  <Spinner size={13} /> Job status: {rolesStatus}…
                </div>
              )}
              {rolesError && <ErrorBanner message={rolesError} />}
              {roles && (
                <>
                  <RoleTable roles={roles} />
                  {dbSync && dbSync.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <SectionTitle>Per-Database Sync State</SectionTitle>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                        <thead>
                          <tr style={{ textAlign: 'left', color: '#7A7D95', fontSize: 11 }}>
                            <th style={{ padding: '6px 8px' }}>Database</th>
                            <th style={{ padding: '6px 8px' }}>Sync State</th>
                            <th style={{ padding: '6px 8px' }}>Log Queue (KB)</th>
                            <th style={{ padding: '6px 8px' }}>Redo Queue (KB)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {dbSync.map((d, i) => (
                            <tr key={i} style={{ borderTop: '1px solid #EFEBE7' }}>
                              <td style={{ padding: '6px 8px' }}>{d.DBName}</td>
                              <td style={{ padding: '6px 8px' }}>{d.SyncState}</td>
                              <td style={{ padding: '6px 8px' }}>{d.LogQueueKB}</td>
                              <td style={{ padding: '6px 8px' }}>{d.RedoQueueKB}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </Card>
        )}

        {/* ── Plan (pre-validation) ────────────────────────────────── */}
        {selectedAg && rolesReady && (
          <Card>
            <CardHead><span>3. Pre-Validation</span></CardHead>
            <div style={{ padding: 18, display: 'grid', gap: 14 }}>
              <div style={{ fontSize: 11.5, color: '#7A7D95' }}>
                Uses the role check completed in step 2 — re-run step 2 first if that was a while ago.
              </div>

              <div>
                <Btn variant="primary" onClick={() => handlePlan()} disabled={planLoading}>
                  {planLoading ? <Spinner size={13} /> : 'Run Pre-Validation'}
                </Btn>
              </div>

              {planError && <ErrorBanner message={planError} />}

              {targetChoice && (
                <div>
                  <div style={{ fontSize: 12.5, marginBottom: 10 }}>
                    Current Primary: <MonoField value={targetChoice.primary_host} /> — both an HA and a DR
                    failover target are available for this AG. Pick one to continue Pre-Validation.
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {targetChoice.ha_option && (
                      <Btn variant="default" onClick={() => handlePlan(targetChoice.ha_option)} disabled={planLoading}>
                        {planLoading ? <Spinner size={13} /> : `HA target — ${targetChoice.ha_option}`}
                      </Btn>
                    )}
                    {targetChoice.dr_option && (
                      <Btn variant="default" onClick={() => handlePlan(targetChoice.dr_option)} disabled={planLoading}>
                        {planLoading ? <Spinner size={13} /> : `DR target — ${targetChoice.dr_option}`}
                      </Btn>
                    )}
                  </div>
                </div>
              )}

              {planResult && (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                    <StatusBadge status={planResult.all_pass ? 'SUCCEEDED' : 'FAILED'} />
                    <span style={{ fontSize: 12, color: '#7A7D95' }}>
                      Run ID: <MonoField value={planResult.run_id} dim />
                    </span>
                  </div>
                  {planResult.primary_host && (
                    <div style={{ fontSize: 12.5, marginBottom: 10 }}>
                      Current Primary: <MonoField value={planResult.primary_host} /> → will fail over to: <MonoField value={planResult.dr_replica_host} />
                    </div>
                  )}
                  {(planResult.checks || []).map((c, i) => <CheckRow key={i} check={c} />)}
                  {!planResult.all_pass && (
                    <div style={{ marginTop: 10 }}>
                      <ErrorBanner message="One or more checks failed — resolve and re-run Pre-Validation before a confirmation token can be issued." />
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>
        )}

        {/* ── Approval + Execute ───────────────────────────────────── */}
        {planResult?.all_pass && (!runStatus || runStatus.status === 'PLANNED') && (
          <Card style={{ borderColor: '#F5C4A8' }}>
            <CardHead style={{ background: '#FDEEE6' }}>
              <span style={{ color: '#D14600' }}>4. Approval</span>
            </CardHead>
            <div style={{ padding: 18, display: 'grid', gap: 14 }}>
              {awaitingApproval && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 14px', borderRadius: 6,
                  background: '#EFF6FF', border: '1px solid #BFDBFE',
                  fontSize: 12.5, color: '#1E3A5F',
                }}>
                  <Spinner size={13} />
                  Sent to Teams for approval — waiting for an approver to accept the Adaptive Card,
                  or execute directly below if you have sufficient access.
                </div>
              )}

              <ErrorBanner message={`This will run ALTER AVAILABILITY GROUP FAILOVER against ${selectedAg}, promoting ${planResult.dr_replica_host} to PRIMARY. This is a live production action — zero data loss is enforced by SQL Server, but application connections will drop during the switch. This runs as a background job and can take a few minutes end to end.`} />
              <FormRow label={`Type YES to confirm failover of ${selectedAg}`}>
                <Input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="YES"
                />
              </FormRow>
              <div>
                <Btn
                  variant="danger"
                  onClick={handleExecute}
                  disabled={confirmText !== 'YES' || executeLoading || !canExecute}
                >
                  {executeLoading ? <Spinner size={13} /> : 'Execute Failover'}
                </Btn>
              </div>
              {executeError && <ErrorBanner message={executeError} />}
            </div>
          </Card>
        )}

        {/* ── Result / progress ────────────────────────────────────── */}
        {runStatus && (
          <Card>
            <CardHead>
              <span>Result</span>
              <StatusBadge status={
                runStatus.status === 'SUCCESS' ? 'SUCCEEDED'
                : RUN_TERMINAL_STATUSES.has(runStatus.status) ? 'FAILED'
                : 'RUNNING'
              } />
            </CardHead>
            <div style={{ padding: 18 }}>
              <div style={{ fontSize: 13, marginBottom: 12 }}>
                {!RUN_TERMINAL_STATUSES.has(runStatus.status) && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Spinner size={13} /> {RUN_STATUS_LABEL[runStatus.status] || runStatus.status}
                  </span>
                )}
                {runStatus.status === 'SUCCESS' && `Failover complete — confirmed new PRIMARY for ${selectedAg}.`}
                {runStatus.status === 'NEEDS_MANUAL_CHECK' && `Failover command completed but the target replica was not confirmed as PRIMARY. Check for split-brain manually — do not assume success.`}
                {runStatus.status === 'EXECUTE_FAILED' && (
                  runStatus.error
                    ? `Failover did not complete successfully: ${runStatus.error}`
                    : (runStatus.ssm_output || runStatus.stderr_output)
                      ? 'Failover did not complete successfully — see detail below.'
                      : 'Failover did not complete successfully (no further detail was returned).'
                )}
                {runStatus.status === 'REJECTED' && `Failover request was rejected via the Teams approval card — no changes were made to ${selectedAg}.`}
              </div>
              {runStatus.status === 'EXECUTE_FAILED' && runStatus.stderr_output && (
                <div style={{ marginBottom: 12 }}>
                  <SectionTitle sub="Error output from the failover SSM command">Error Detail</SectionTitle>
                  <pre style={{
                    fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5,
                    background: '#FDEEE6', border: '1px solid #F5C4A8', borderRadius: 6,
                    padding: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    color: '#0E1020', maxHeight: 260, overflowY: 'auto',
                  }}>
                    {runStatus.stderr_output}
                  </pre>
                </div>
              )}
              {runStatus.status === 'EXECUTE_FAILED' && runStatus.ssm_output && (
                <div style={{ marginBottom: 12 }}>
                  <SectionTitle sub="Standard output from the failover SSM command">Output Detail</SectionTitle>
                  <pre style={{
                    fontFamily: 'var(--font-mono, monospace)', fontSize: 11.5,
                    background: '#FDEEE6', border: '1px solid #F5C4A8', borderRadius: 6,
                    padding: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    color: '#0E1020', maxHeight: 260, overflowY: 'auto',
                  }}>
                    {runStatus.ssm_output}
                  </pre>
                </div>
              )}
              {runStatus.final_roles && <RoleTable roles={runStatus.final_roles} drReplicaHost={runStatus.dr_replica_host} />}
              <div style={{ marginTop: 12, fontSize: 11.5, color: '#7A7D95' }}>
                Run ID: <MonoField value={runStatus.run_id} dim />
              </div>
            </div>
          </Card>
        )}

      </div>
    </>
  );
}
