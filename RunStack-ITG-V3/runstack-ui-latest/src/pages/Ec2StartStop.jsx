// src/pages/Ec2StartStop.jsx — Automate → EC2 Start/Stop
//
// Start or stop one or many authorized EC2 instances as ONE RunStack run.
//
//   App        GET /app-instances — the caller's applications (no state)
//   Instances  GET /app-instances?app_id=…&include_state=true — that
//              application's instances, with live state read by the backend
//              (ec2:DescribeInstances through runstack-cross-account-role)
//   Run        POST /notify { kind: "ec2_power", action, targets,
//              client_request_id } — the backend applies the same checks as
//              a single start/stop for every instance: app access, instance
//              catalog, the environment rule (EC2_ALLOWED_ENVIRONMENTS) and the ec2:<id>
//              action lock; then AWS-StartEC2Instance / AWS-StopEC2Instance
//              runs per instance under one execution group.
//
// Instances already in the requested state are not selectable (avoids
// redundant actions). State is a point-in-time read; the backend and AWS
// remain the source of truth.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { Page, RunLayout, RunSummary } from '../components/PageLayout';
import { Btn, ErrorBanner, Spinner } from '../components/ui';
import { Callout, SectionCard } from '../components/sections';
import TargetPicker from '../components/run/TargetPicker';
import SearchSelect from '../components/run/SearchSelect';
import RunResult from '../components/run/RunResult';
import { fetchAppInstances, submitRun } from '../api/client';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { fmtFull } from '../utils/jobs';
import { accountLabel, appSummaries, ec2ActionBlock, ec2StateInfo, locationSummary, serverLabel } from '../utils/runTargets';
import { v4 as uuidv4 } from '../utils/uuid';

// Live state as text plus a subtle badge. No state = RunStack couldn't read
// it (shown as Unknown with the reason on hover), never guessed.
function StateBadge({ inst }) {
  const { label, tone } = ec2StateInfo(inst.state);
  const why = !inst.state ? (inst.state_error ? `State couldn't be read (${inst.state_error})` : 'State not available') : undefined;
  return (
    <span className={`rs-badge rs-badge--${tone}`} title={why}>
      <span className="rs-badge-dot" aria-hidden />{label}
    </span>
  );
}

const ACTIONS = [
  { value: 'start', label: 'Start instances', verb: 'Start' },
  { value: 'stop', label: 'Stop instances', verb: 'Stop' },
];
const verbOf = (a) => (a === 'start' ? 'Start' : 'Stop');
const count = (n) => `${n} instance${n === 1 ? '' : 's'}`;
const Help = ({ children }) => <div className="rs-help">{children}</div>;

// Plain-language version of the backend's environment rule
// (shared.EC2_ALLOWED_ENVIRONMENTS; administrators are exempt).
const ENVIRONMENT_RULE = 'Start and stop are currently available for Development, ITG, Staging and Test instances. '
  + 'Requests for Production or DR instances are refused unless you are a RunStack administrator.';

function ActionSelector({ value, onChange }) {
  const onKey = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = value === 'start' ? 'stop' : 'start';
    onChange(next);
    document.getElementById(`ec2-action-${next}`)?.focus();
  };
  return (
    <div role="radiogroup" aria-label="EC2 action" className="rs-segment" onKeyDown={onKey}>
      {ACTIONS.map((a) => (
        <button key={a.value} id={`ec2-action-${a.value}`} type="button" role="radio" aria-checked={value === a.value}
          tabIndex={value === a.value ? 0 : -1} onClick={() => onChange(a.value)}
          className={`rs-segment-btn${a.value === 'stop' ? ' rs-segment-btn--danger' : ''}`}>
          <span aria-hidden style={{ fontSize: 12 }}>{a.value === 'start' ? '▶' : '■'}</span>{a.label}
        </button>
      ))}
    </div>
  );
}

function errText(e) {
  return e?.body?.message || e?.message || String(e);
}

function ConfirmDialog({ action, instances, onCancel, onConfirm, submitting }) {
  const stop = action === 'stop';
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return ReactDOM.createPortal(
    <>
      <div onClick={onCancel} aria-hidden style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.35)', zIndex: 60 }} />
      <div role="alertdialog" aria-modal="true" aria-labelledby="ec2-confirm-title" style={{
        position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 61,
        width: 'min(560px, calc(100vw - 32px))', background: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-lg)', padding: 20, display: 'grid', gap: 12,
      }}>
        <div id="ec2-confirm-title" style={{ fontSize: 16, fontWeight: 600, color: stop ? 'var(--danger)' : 'var(--text-primary)' }}>
          {stop ? 'Stop' : 'Start'} {instances.length} instance{instances.length === 1 ? '' : 's'}?
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {stop ? 'Applications on these servers will be unavailable until they are started again.' : 'These servers will be powered on.'}
          {' '}{locationSummary(instances)}.
        </div>
        <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 13 }}>
          {instances.map((i) => (
            <div key={i.instance_id} style={{ display: 'flex', flexWrap: 'wrap', columnGap: 8, padding: '3px 0' }}>
              <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{serverLabel(i)}</span>
              <span style={{ color: 'var(--text-tertiary)' }}>{i.environment || '—'} · {accountLabel(i)} / {i.region} · now {ec2StateInfo(i.state).label}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Btn variant="default" onClick={onCancel} disabled={submitting}>Cancel</Btn>
          <Btn variant={stop ? 'danger' : 'primary'} className={stop ? 'rs-btn-stop' : ''} onClick={onConfirm} disabled={submitting}>
            {submitting ? <><Spinner size={12} /> Submitting…</> : `${stop ? 'Stop' : 'Start'} ${instances.length} instance${instances.length === 1 ? '' : 's'}`}
          </Btn>
        </div>
      </div>
    </>,
    document.body,
  );
}

export default function Ec2StartStop() {
  // Applications first (fast list, no state), then live state for the chosen
  // application's instances only — reading state for every instance a user
  // can see at once is too slow for large access lists.
  const [apps, setApps] = useState({ loading: true, error: null, instances: [] });
  const [appId, setAppId] = useState('');
  const [inv, setInv] = useState({ loading: false, error: null, instances: [], checkedAt: null, stateErrors: [] });
  const [action, setAction] = useState('stop');
  const [selected, setSelected] = useState([]);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [result, setResult] = useState(null);
  const requestId = useRef(uuidv4());
  const loadGen = useRef(0);

  const loadApps = () => {
    setApps((x) => ({ ...x, loading: !x.instances.length, error: null }));
    fetchAppInstances()
      .then((r) => setApps({ loading: false, error: null, instances: r.instances || [] }))
      .catch((e) => setApps((x) => ({ ...x, loading: false, error: errText(e) })));
  };
  const load = (id = appId) => {
    if (!id) return;
    const gen = ++loadGen.current;
    setInv((x) => ({ ...x, loading: !x.instances.length, refreshing: true, error: null }));
    fetchAppInstances(id, { includeState: true })
      .then((r) => gen === loadGen.current && setInv({ loading: false, refreshing: false, error: null, instances: r.instances || [],
        checkedAt: r.instances?.[0]?.state_checked_at || null, stateErrors: r.state_errors || [] }))
      .catch((e) => gen === loadGen.current && setInv((x) => ({ ...x, loading: false, refreshing: false, error: errText(e) })));
  };
  useEffect(loadApps, []);
  usePageRefresh(() => { loadApps(); load(); });
  const chooseApp = (id) => {
    if (id === appId) return;
    setAppId(id); setSelected([]);
    setInv({ loading: true, error: null, instances: [], checkedAt: null, stateErrors: [] });
    load(id);
  };

  const blockReason = useMemo(() => (i) => ec2ActionBlock(action, i.state), [action]);
  // Changing the action or refreshing state drops selections that no longer apply.
  useEffect(() => {
    setSelected((ids) => ids.filter((id) => !ec2ActionBlock(action, inv.instances.find((i) => i.instance_id === id)?.state)));
  }, [action, inv.instances]);
  useEffect(() => { requestId.current = uuidv4(); }, [action, selected]);

  const chosen = inv.instances.filter((i) => selected.includes(i.instance_id));

  const submit = async () => {
    setSubmitting(true); setSubmitError(null);
    try {
      const res = await submitRun({ kind: 'ec2_power', action, targets: selected, client_request_id: requestId.current });
      setResult(res); setConfirming(false);
    } catch (e) {
      setSubmitError(errText(e)); setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  const appOptions = useMemo(() => appSummaries(apps.instances).map((a) => ({
    value: a.app_id, app: a, search: `${a.label} ${a.app_id} ${a.environments.join(' ')}`,
  })), [apps.instances]);
  const appLabel = appOptions.find((o) => o.value === appId)?.app.label;
  const eligible = inv.instances.filter((i) => !ec2ActionBlock(action, i.state)).length;
  const verb = verbOf(action);
  const stop = action === 'stop';

  const summaryPanel = (
    <RunSummary
      rows={[['Action', stop ? 'Stop instances' : 'Start instances'], ['Application', appLabel || '—'], ['Instances', String(chosen.length)]]}
      footer={(
        <>
          {submitError && <ErrorBanner message={submitError} />}
          <Btn variant={stop ? 'danger' : 'primary'} className={stop ? 'rs-btn-stop rs-run-btn' : 'rs-run-btn'} disabled={!chosen.length || submitting}
            onClick={() => setConfirming(true)}>
            {chosen.length ? `${verb} ${count(chosen.length)}` : `${verb} instances`}
          </Btn>
          <Help>You’ll confirm the instances before anything runs. One grouped run; RunStack re-checks your access and the environment rule for every instance.</Help>
        </>
      )}>
      {chosen.length ? (
        <div style={{ display: 'grid', gap: 6 }}>
          <Help>{locationSummary(chosen)}</Help>
          <ul aria-label="Selected instances" style={{ listStyle: 'none', margin: 0, padding: '4px 0', maxHeight: 240, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface)' }}>
            {chosen.map((i) => (
              <li key={i.instance_id} style={{ padding: '4px 10px', fontSize: 13, borderBottom: '1px solid var(--slate-100)', display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{serverLabel(i)}</span>
                  <span style={{ color: 'var(--text-tertiary)' }}> · {i.environment || '—'}</span>
                </span>
                <StateBadge inst={i} />
              </li>
            ))}
          </ul>
        </div>
      ) : <Help>{appId ? 'No instances selected yet.' : 'Choose an application to list its instances.'}</Help>}
    </RunSummary>
  );

  return (
    <Page title="EC2 Start/Stop" subtitle="Start or stop EC2 instances you have access to — one run for every instance you select.">
      {result ? (
        <SectionCard tone={4} title={`EC2 ${result.action === 'start' ? 'Start' : 'Stop'} — submitted`}>
          <RunResult result={result} onStartAnother={() => { setResult(null); setSelected([]); load(); }} />
        </SectionCard>
      ) : (
        <RunLayout summary={summaryPanel}>
          <SectionCard tone={1} title="Choose action">
            <ActionSelector value={action} onChange={setAction} />
            <Help>
              {stop
                ? 'Only running instances can be stopped. Instances that are already stopped or changing state can’t be selected.'
                : 'Only stopped instances can be started. Instances that are already running or changing state can’t be selected.'}
              {' '}{ENVIRONMENT_RULE}
            </Help>
          </SectionCard>

          <SectionCard tone={2} open title="Choose application" helper="Instances and their current state load for the application you choose.">
            {apps.loading && <div role="status" style={{ display: 'flex', gap: 8, color: 'var(--text-tertiary)', fontSize: 13 }}><Spinner size={14} /> Loading applications…</div>}
            {apps.error && <ErrorBanner message={`Could not load applications: ${apps.error}`} />}
            {!apps.loading && !apps.error && !appOptions.length && (
              <Help>You don’t have access to any applications yet. Ask your RunStack administrator to grant one in Users &amp; Access.</Help>
            )}
            {appOptions.length > 0 && (
              <div className="rs-field">
                <SearchSelect id="ec2-app" label="Application" options={appOptions} value={appId} onChange={chooseApp}
                  display={(o) => o.app.label} placeholder={`Search ${appOptions.length} application${appOptions.length === 1 ? '' : 's'}…`}
                  emptyText="No applications match your search."
                  renderOption={(o) => (
                    <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{o.app.label}</span>
                        <span style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)' }}>{o.app.environments.join(', ') || 'No environment recorded'}</span>
                      </span>
                      <span style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{count(o.app.count)}</span>
                    </span>
                  )} />
              </div>
            )}
          </SectionCard>

          <SectionCard tone={2} title="Choose servers"
            right={appId && <Btn size="sm" variant="default" onClick={() => load()} disabled={inv.refreshing}>{inv.refreshing ? <Spinner size={12} /> : '↻'} Refresh state</Btn>}
            helper={!appId ? undefined : inv.checkedAt ? `Current state read ${fmtFull(inv.checkedAt)}. ${eligible} of ${inv.instances.length} can be ${stop ? 'stopped' : 'started'}.` : 'Reading current state…'}>
            {!appId ? <Help>Choose an application to list its instances.</Help> : (<>
              {inv.error && <ErrorBanner message={`Could not load instances: ${inv.error}`} />}
              {inv.stateErrors.length > 0 && (
                <Callout tone="warning" title="Some states couldn’t be read">
                  {inv.stateErrors.map((e) => `${accountLabel(inv.instances.find((i) => String(i.account_id) === String(e.account_id)) || e)} / ${e.region} (${e.code})`).join(', ')} — those instances show “Unknown” and can still be selected.
                </Callout>
              )}
              <TargetPicker instances={inv.instances} selected={selected} onChange={setSelected} blockReason={blockReason} hideApp showOs
                extraColumn={{ header: 'State', render: (i) => <StateBadge inst={i} /> }} loading={inv.loading} error={inv.error}
                summary={`${count(selected.length)} selected`} emptyText="This application has no instances in the catalog." />
            </>)}
          </SectionCard>
        </RunLayout>
      )}
      {confirming && <ConfirmDialog action={action} instances={chosen} submitting={submitting}
        onCancel={() => !submitting && setConfirming(false)} onConfirm={submit} />}
    </Page>
  );
}
