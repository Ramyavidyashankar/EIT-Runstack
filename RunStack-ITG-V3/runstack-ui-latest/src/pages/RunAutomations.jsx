// src/pages/RunAutomations.jsx — Automate → Run Automations
//
// Run one approved SSM document (Command or Automation, e.g. /var Cleanup)
// on servers from one or more applications as ONE RunStack run.
//
//   Automation    chosen in the Category → Automation bar above the page
//                 (components/run/AutomationHub.jsx) and carried in the URL:
//                 /automations?category=<id>&doc=<name>. The list is
//                 GET /ssm/documents?approved=true (APPROVED_AUTOMATION_DOCUMENTS,
//                 with friendly names: "Automation-var-cleanup=/var Cleanup").
//                 Changing the automation clears applications, servers and
//                 settings — every selection below depends on it.
//   Applications  from the server list below — app access, or for a
//                 team-capability automation (SQL/SAP/Tidal) the team scope
//   Servers       GET /app-instances[?for_document=<doc>]; catalog rows are
//                 merged by instance ID (a server shared by two applications
//                 is one target)
//   Parameters    from the document's own definition; shared values apply to
//                 every server, InstanceId is filled per server by RunStack
//   Run           POST /notify { kind: "automation", document, parameters,
//                 targets, client_request_id } — one request for all servers.
//                 The backend re-checks every server (authorization,
//                 environment, approved document, region/OS) and queues one
//                 job per server under one execution group, dispatched in
//                 staggered batches.
//
// Anything hidden or disabled here is a convenience; the backend decides.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Page, RunLayout, RunSummary } from '../components/PageLayout';
import { Btn, ErrorBanner, Spinner } from '../components/ui';
import { Callout, SectionCard } from '../components/sections';
import ParamField from '../components/ParamField';
import TargetPicker from '../components/run/TargetPicker';
import { docTechName, docTitle } from '../components/run/AutomationSelect';
import AppMultiSelect from '../components/run/AppMultiSelect';
import RunResult from '../components/run/RunResult';
import { fetchAppInstances, submitRun } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useAppNavigate } from '../components/nav/navigationContext';
import { categoryForAuth, loadApprovedAutomations, loadAppAccess } from '../utils/automationCatalog';
import { useAutomationEntries } from '../components/run/AutomationHub';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { toRequestParameters } from '../utils/sqlHealthcheck';
import {
  appSummaries, appsLabel, documentBlockReason, inApps, keepSelectedCompatible, keepSelectedInApps,
  locationSummary, mergeTargets, paramErrors, selectionSummary, serverLabel, waveSummary,
} from '../utils/runTargets';
import { v4 as uuidv4 } from '../utils/uuid';

function errText(e) {
  return e?.body?.message || e?.message || String(e);
}

const EMPTY_INV = { loading: false, error: null, instances: [], loaded: false };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listNames = (names, max = 4) => (names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', '));

function Loading({ children }) {
  return <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-tertiary)', fontSize: 13 }}><Spinner size={14} /> {children}</div>;
}
const Help = ({ children }) => <div className="rs-help">{children}</div>;

export default function RunAutomations() {
  const nav = useNavigate();
  const go = useAppNavigate();
  const { email } = useAuth();
  const [params] = useSearchParams();
  const docName = params.get('doc') || '';
  const categoryParam = params.get('category') || '';
  const [catalog, setCatalog] = useState({ loading: true, error: null, documents: [], limits: null, configured: true });
  const [appInv, setAppInv] = useState({ ...EMPTY_INV, loading: true });
  const [teamInv, setTeamInv] = useState({ doc: null, ...EMPTY_INV });
  const [appIds, setAppIds] = useState([]);
  const [selected, setSelected] = useState([]);
  const [form, setForm] = useState({});
  const [touched, setTouched] = useState({});
  const [notices, setNotices] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [result, setResult] = useState(null);
  const requestId = useRef(uuidv4());
  const inFlight = useRef(false);

  const notify = (tone, title, text) => setNotices((n) => [{ id: uuidv4(), tone, title, text }, ...n].slice(0, 3));
  const dismiss = (id) => setNotices((n) => n.filter((x) => x.id !== id));

  const loadTeam = (name) => {
    setTeamInv({ doc: name, ...EMPTY_INV, loading: true });
    fetchAppInstances(null, { forDocument: name })
      .then((r) => setTeamInv((t) => (t.doc === name ? { doc: name, loading: false, error: null, loaded: true, instances: mergeTargets(r.instances) } : t)))
      .catch((e) => setTeamInv((t) => (t.doc === name ? { doc: name, loading: false, error: errText(e), loaded: true, instances: [] } : t)));
  };

  const load = (force = false) => {
    setCatalog((c) => ({ ...c, loading: true, error: null }));
    loadApprovedAutomations(email, { force })
      .then((r) => setCatalog({ loading: false, error: null, documents: r.documents, limits: r.limits, configured: r.configured }))
      .catch((e) => setCatalog({ loading: false, error: errText(e), documents: [], limits: null, configured: true }));
    setAppInv((x) => ({ ...x, loading: true, error: null }));
    loadAppAccess(email, { force })
      .then((r) => setAppInv({ loading: false, error: null, loaded: true, instances: r.instances }))
      .catch((e) => setAppInv({ loading: false, error: errText(e), loaded: true, instances: [] }));
    if (teamInv.doc) loadTeam(teamInv.doc);
  };
  useEffect(() => { load(false); }, []); // eslint-disable-line
  usePageRefresh(() => load(true));

  // Same authorized list as the Automation dropdown, so a document typed into
  // the URL that the user can't run isn't offered as a form either (the
  // backend refuses it regardless).
  const hub = useAutomationEntries();
  const allowed = useMemo(() => {
    const names = new Set(hub.entries.filter((e) => e.kind === 'document').map((e) => e.doc.name));
    return { settled: hub.settled, has: (n) => names.has(n) };
  }, [hub.entries, hub.settled]);
  const listedDoc = catalog.documents.find((d) => d.name === docName) || null;
  const doc = listedDoc && allowed.settled && allowed.has(docName) ? listedDoc : null;
  const teamDoc = !!doc && doc.auth && doc.auth !== 'app';
  useEffect(() => { if (teamDoc && teamInv.doc !== doc.name) loadTeam(doc.name); }, [doc?.name]); // eslint-disable-line
  const inv = teamDoc ? (teamInv.doc === doc.name ? teamInv : { ...EMPTY_INV, loading: true }) : appInv;

  const apps = useMemo(() => appSummaries(inv.instances), [inv.instances]);
  const appIdsInList = useMemo(() => appIds.filter((id) => apps.some((a) => a.app_id === id)), [appIds, apps]);
  const listed = useMemo(() => inApps(inv.instances, appIdsInList), [inv.instances, appIdsInList]);
  const blockReason = useMemo(() => (doc ? (i) => documentBlockReason(doc, i) : null), [doc]);

  // The server list changed under the selection (another automation with a
  // different authorization source, or a refresh): drop applications and
  // servers that are no longer offered, and say so.
  useEffect(() => {
    if (inv.loading || !inv.loaded) return;
    const goneApps = appIds.filter((id) => !apps.some((a) => a.app_id === id));
    if (goneApps.length) {
      setAppIds(appIdsInList);
      notify('warning', `${plural(goneApps.length, 'application')} removed`,
        `${listNames(goneApps)} ${goneApps.length === 1 ? 'has' : 'have'} no servers you can run ${docTitle(doc) || 'this automation'} on.`);
    }
    const inList = keepSelectedInApps(inv.instances, selected, appIdsInList);
    const compatible = keepSelectedCompatible(inv.instances, inList.kept, doc);
    if (inList.dropped.length) {
      notify('warning', `${plural(inList.dropped.length, 'server')} deselected`, 'They are no longer in the server list for this automation.');
    }
    if (compatible.dropped.length) {
      notify('warning', `${plural(compatible.dropped.length, 'server')} deselected`,
        `${docTitle(doc)} can't run on ${listNames(compatible.dropped.map((d) => `${d.server} (${d.reason})`), 3)}.`);
    }
    if (inList.dropped.length || compatible.dropped.length) setSelected(compatible.kept);
  }, [inv.instances, inv.loading]); // eslint-disable-line

  // A different automation (or category) starts from scratch: applications,
  // servers, settings, messages and any previous result all depend on it.
  const firstDoc = useRef(true);
  useEffect(() => {
    if (firstDoc.current) { firstDoc.current = false; return; }
    setAppIds([]); setSelected([]); setForm({}); setTouched({});
    setNotices([]); setSubmitError(null); setResult(null);
  }, [docName]);

  const changeApps = (ids) => {
    const removed = appIds.filter((id) => !ids.includes(id));
    setAppIds(ids);
    if (!removed.length) return;
    const { kept, dropped } = keepSelectedInApps(inv.instances, selected, ids);
    if (dropped.length) {
      setSelected(kept);
      const labels = removed.map((id) => apps.find((a) => a.app_id === id)?.label || id);
      notify('info', `${plural(dropped.length, 'server')} deselected`,
        `They belonged only to ${listNames(labels)}. Servers shared with another selected application stay selected.`);
    }
  };

  // A new request ID whenever what would be submitted changes, so a double
  // click resubmits the same request (deduplicated) but a real change doesn't.
  useEffect(() => { requestId.current = uuidv4(); }, [docName, selected, form]);

  const errors = useMemo(() => paramErrors(doc?.parameters, form), [doc, form]);
  const chosen = useMemo(() => inv.instances.filter((i) => selected.includes(i.instance_id)), [inv.instances, selected]);
  const summary = selectionSummary(inv.instances, selected, appIdsInList);
  const maxTargets = catalog.limits?.max_targets;
  const tooMany = maxTargets && selected.length > maxTargets;
  const blockedChosen = doc ? chosen.filter((i) => documentBlockReason(doc, i)) : [];
  const canRun = !!doc && selected.length > 0 && !tooMany && !blockedChosen.length && Object.keys(errors).length === 0 && !submitting;
  const batch = catalog.limits?.dispatch_batch_size || catalog.limits?.wave_size;
  const interval = catalog.limits?.dispatch_interval_seconds ?? catalog.limits?.wave_seconds;

  const run = async () => {
    setTouched(Object.fromEntries((doc?.parameters || []).map((p) => [p.name, true])));
    if (!canRun || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true); setSubmitError(null);
    try {
      const res = await submitRun({
        kind: 'automation', document: doc.name, parameters: toRequestParameters(doc.parameters, form),
        targets: selected, client_request_id: requestId.current,
      });
      if (res.accepted > 0 && !(res.rejected || []).length && res.run_job_id) {
        nav(`/jobs/${encodeURIComponent(res.run_job_id)}`, { state: { justSubmitted: true } });
        return;
      }
      setResult(res);   // some or all servers not started — show why
    } catch (e) {
      setSubmitError(e?.body?.errors ? 'Some parameters are not valid.' : errText(e));
      if (e?.body?.errors) setTouched(Object.fromEntries(Object.keys(e.body.errors).map((k) => [k, true])));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  };
  const startAnother = () => { setResult(null); setSelected([]); setForm({}); setTouched({}); setSubmitError(null); setNotices([]); };

  const perTarget = doc?.per_target_parameters || [];
  const noticeList = notices.map((n) => (
    <Callout key={n.id} tone={n.tone} title={n.title} action={<Btn size="sm" variant="ghost" onClick={() => dismiss(n.id)}>Dismiss</Btn>}>{n.text}</Callout>
  ));
  const paramIssues = Object.keys(errors).length;

  const summaryPanel = (
    <RunSummary
      rows={[
        ['Automation', doc ? docTitle(doc) : '—'],
        ['Applications', appIdsInList.length ? String(appIdsInList.length) : '—'],
        ['Servers', String(selected.length)],
        ...(batch ? [['Dispatch batch size', `${batch} servers`], ['Dispatch interval', `${interval}s`]] : []),
      ]}
      footer={(
        <>
          {submitError && <ErrorBanner message={submitError} />}
          <Btn variant="primary" onClick={run} disabled={!canRun} className="rs-run-btn">
            {submitting ? <><Spinner size={12} /> Submitting…</> : selected.length ? `Run automation (${plural(selected.length, 'server')})` : 'Run automation'}
          </Btn>
          <Help>One grouped run. RunStack re-checks your access, the environment, the approved automation and each server’s region and OS before anything starts.</Help>
        </>
      )}>
      {!doc && <Help>Choose an automation to begin.</Help>}
      {doc && docTechName(doc) && <Help>Document <span style={{ fontFamily: 'var(--font-mono)' }}>{doc.name}</span></Help>}
      {chosen.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 14, color: 'var(--text-primary)', fontWeight: 500 }}>{summary}</div>
          <Help>{locationSummary(chosen)}</Help>
          <Help>{waveSummary(chosen.length, catalog.limits)} Batches pace start times; they don’t limit how many run at once.</Help>
          <ul aria-label="Selected servers" style={{ listStyle: 'none', margin: 0, padding: '4px 0', maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface)' }}>
            {chosen.map((i) => {
              const reason = documentBlockReason(doc, i);
              return (
                <li key={i.instance_id} style={{ padding: '4px 10px', fontSize: 13, borderBottom: '1px solid var(--slate-100)' }}>
                  <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{serverLabel(i)}</span>
                  <span style={{ color: 'var(--text-tertiary)' }}> · {i.environment || '—'} · {appsLabel(i)}</span>
                  {reason && <div style={{ color: '#92400E', fontSize: 13 }}>{reason}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {doc && !selected.length && <Help>No servers selected yet.</Help>}
      {tooMany && <Callout tone="warning">A run can include at most {maxTargets} servers. Narrow your selection.</Callout>}
      {blockedChosen.length > 0 && (
        <Callout tone="warning">{plural(blockedChosen.length, 'selected server')} can’t run {docTitle(doc)}. Deselect {blockedChosen.length === 1 ? 'it' : 'them'} to continue.</Callout>
      )}
      {paramIssues > 0 && selected.length > 0 && <Callout tone="warning">Complete the additional settings before running.</Callout>}
    </RunSummary>
  );

  return (
    <Page title="Run Automations" subtitle="Select an automation and configure its targets.">
      {result ? (
        <SectionCard tone={4} title={`${result.label || 'Automation'} — submitted`}>
          <RunResult result={result} onStartAnother={startAnother} />
        </SectionCard>
      ) : !docName ? (
        <div className="rs-run-empty" role="status">
          {categoryParam ? 'Select an automation to configure its targets.' : 'Select a category, then an automation, to configure its targets.'}
        </div>
      ) : !doc ? (
        (catalog.loading || !allowed.settled) && !catalog.error ? <Loading>Loading automation…</Loading>
          : catalog.error ? <ErrorBanner message={`Could not load automations: ${catalog.error}`} />
            : (
              <Callout tone="warning" title="This automation isn’t available to you"
                action={<Btn size="sm" variant="default" onClick={() => go(`/automations${categoryParam ? `?category=${categoryParam}` : ''}`)}>Choose another</Btn>}>
                <span className="rs-mono">{docName}</span> is not an approved automation you are authorized to run.
              </Callout>
            )
      ) : !doc.available ? (
        <Callout tone="warning" title={`${docTitle(doc)} can’t be run right now`}
          action={<Btn size="sm" variant="default" onClick={() => go(`/automations?category=${categoryForAuth(doc.auth)}`)}>Choose another</Btn>}>
          {doc.reason}
        </Callout>
      ) : (
        <RunLayout summary={summaryPanel}>
          <SectionCard tone={2} open title="Choose applications"
            helper={teamDoc ? 'Applications with servers in your team’s scope for this automation.' : 'Pick one or more applications you have access to.'}>
            {!doc ? <Help>Choose an automation first.</Help>
              : inv.loading ? <Loading>Loading applications…</Loading>
                : inv.error ? <ErrorBanner message={`Could not load servers: ${inv.error}`} />
                  : apps.length ? <AppMultiSelect apps={apps} value={appIdsInList} onChange={changeApps} />
                    : <Help>{teamDoc ? 'Your team scope doesn’t include any servers for this automation.' : 'You don’t have access to any applications yet. Ask your RunStack administrator to grant access in Users & Access.'}</Help>}
            {!appIdsInList.length && noticeList}
          </SectionCard>

          <SectionCard tone={2} title="Choose servers"
            helper="Selections are kept while you search, filter and change pages. Servers this automation can’t run on are shown but can’t be selected.">
            {appIdsInList.length ? (<>
              {noticeList}
              <TargetPicker instances={listed} selected={selected} onChange={setSelected} blockReason={blockReason}
                loading={false} error={null} showOs summary={summary} emptyText="The selected applications have no servers." />
            </>) : <Help>{doc ? 'Choose one or more applications to list their servers.' : 'Choose an automation and applications to list servers.'}</Help>}
          </SectionCard>

          {doc && (
            <SectionCard tone={3} title="Additional settings">
              {doc.parameters.length ? (<>
                <Help>These values are read from the automation and apply to every selected server.</Help>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: 12 }}>
                  {doc.parameters.map((p) => (
                    <ParamField key={p.name} spec={p} value={form[p.name]}
                      onChange={(v) => { setForm((f) => ({ ...f, [p.name]: v })); setTouched((t) => ({ ...t, [p.name]: true })); }}
                      error={touched[p.name] ? errors[p.name] : null} />
                  ))}
                </div>
              </>) : <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>No additional settings required.</div>}
              <Help>
                {perTarget.length
                  ? <>RunStack fills <span style={{ fontFamily: 'var(--font-mono)' }}>{perTarget.join(', ')}</span> with each server’s own instance ID.</>
                  : 'Each server is targeted by its own instance ID; account and region come from the instance catalog.'}
              </Help>
            </SectionCard>
          )}
        </RunLayout>
      )}
    </Page>
  );
}
