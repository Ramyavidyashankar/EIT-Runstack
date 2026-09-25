// src/components/JobDetail.jsx
//
// Everything RunStack stores for one job (GET /jobs/{jobId}), used both in
// the Automation Executions side panel and on the full /jobs/:jobId page.
//
// Only real fields are shown. The jobs table keeps the *current* status
// plus created_at / updated_at — it does not record each transition — so
// the timeline says exactly that rather than drawing a made-up pipeline.
// Sensitive parameters arrive already masked by the API.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJob } from '../api/client';
import { ErrorBanner, Spinner, StatusBadge, TypeTag } from './ui';
import { Callout } from './sections';
import { copyText, fmtAgo, fmtFull, isActive, jobDuration, statusGroup } from '../utils/jobs';

const ACTIVE_POLL_MS = 10000;

export function CopyButton({ value, label = 'Copy', size = 'sm' }) {
  const [state, setState] = useState('idle');
  if (!value) return null;
  const onClick = async (e) => {
    e.stopPropagation();
    const ok = await copyText(String(value));
    setState(ok ? 'copied' : 'failed');
    setTimeout(() => setState('idle'), 1500);
  };
  return (
    <button type="button" onClick={onClick} aria-label={`${label} ${value}`} title={state === 'copied' ? 'Copied' : `${label} to clipboard`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0,
        padding: size === 'sm' ? '1px 6px' : '3px 8px', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
        fontSize: 10.5, fontWeight: 600,
        border: `1px solid ${state === 'copied' ? '#A9E7CD' : 'var(--nav-blue-border)'}`,
        background: state === 'copied' ? '#E4F8F0' : '#FFFFFF',
        color: state === 'copied' ? '#0B6E4C' : 'var(--nav-blue-text)',
      }}>
      {state === 'copied' ? '✓ Copied' : state === 'failed' ? 'Copy failed' : (
        <>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
            <rect x="5" y="5" width="9" height="9" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
          </svg>
          {size === 'sm' ? null : label}
        </>
      )}
    </button>
  );
}

function Field({ label, value, mono, copy, hint }) {
  const empty = value === undefined || value === null || value === '';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 12, padding: '7px 0', borderBottom: '1px solid #F1F5F9', alignItems: 'start' }}>
      <div style={{ fontSize: 12, color: '#64748B' }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', minWidth: 0 }}>
        <div style={{
          fontSize: mono ? 11.5 : 12.5, color: empty ? '#94A3B8' : '#0F172A', fontFamily: mono ? 'var(--font-mono)' : 'inherit',
          wordBreak: 'break-all', minWidth: 0, flex: 1,
        }}>
          {empty ? 'Not recorded' : value}
          {hint && <div style={{ fontSize: 11, color: '#64748B', fontFamily: 'var(--font-sans)', marginTop: 2, wordBreak: 'normal' }}>{hint}</div>}
        </div>
        {copy && !empty && <CopyButton value={value} label={`Copy ${label}`} />}
      </div>
    </div>
  );
}

function Section({ title, children, right }) {
  return (
    <div style={{ border: '1px solid #E2E8F0', borderRadius: 10, overflow: 'hidden', background: '#FFFFFF' }}>
      <div style={{ padding: '9px 14px', background: '#F8FAFC', borderBottom: '1px solid #E2E8F0', display: 'flex', alignItems: 'center' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 0.6 }}>{title}</div>
        {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
      </div>
      <div style={{ padding: '6px 14px 10px' }}>{children}</div>
    </div>
  );
}

function OutputBlock({ title, text, tone = 'neutral' }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const long = text.length > 1200 || text.split('\n').length > 18;
  const colors = tone === 'error'
    ? { bg: '#FDECEC', border: '#F7B9B9' }
    : { bg: '#F8FAFC', border: '#E2E8F0' };
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#334155' }}>{title}</div>
        <span style={{ fontSize: 11, color: '#94A3B8' }}>{text.split('\n').length} lines</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          {long && (
            <button type="button" onClick={() => setExpanded((x) => !x)} style={{ background: 'none', border: 'none', color: 'var(--nav-blue-text)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
              {expanded ? 'Collapse' : 'Expand'}
            </button>
          )}
          <CopyButton value={text} label="Copy" size="md" />
        </span>
      </div>
      <pre style={{
        margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.55, color: '#0F172A',
        background: colors.bg, border: `1px solid ${colors.border}`, borderRadius: 8, padding: 12,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: expanded ? 'none' : 280, overflowY: 'auto',
      }}>{text}</pre>
    </div>
  );
}

/**
 * @param {string} jobId
 * @param {object} [initial]  row data already on screen, shown while the full record loads
 * @param {(job) => void} [onUpdate]  called with fresh data so the list row can match
 */
export default function JobDetailContent({ jobId, initial, onUpdate }) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await fetchJob(jobId);
      if (!alive.current) return;
      setJob(data);
      setError(null);
      onUpdateRef.current?.(data);
    } catch (e) {
      if (alive.current) setError(e.status === 404 ? 'This job no longer exists in the jobs table.' : (e.message || String(e)));
    } finally {
      if (alive.current) setRefreshing(false);
    }
  }, [jobId]);

  useEffect(() => { setJob(null); setError(null); load(); }, [load]);

  // Keep an active job's details current while the panel is open.
  const active = job ? isActive(job.status) : initial ? isActive(initial.status) : false;
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => { if (!document.hidden) load(); }, ACTIVE_POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(id); clearInterval(tick); };
  }, [active, load]);

  const j = job || initial;
  if (!j && error) return <ErrorBanner message={error} />;
  if (!j) return <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const group = statusGroup(j.status);
  const dur = jobDuration(j, now);
  const params = job?.automation_data?.Parameters;
  const docFull = job?.automation_data?.DocumentName || j.document_name;
  const noErrorDetail = job && group === 'FAILED' && !job.stderr_output && !job.output;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {error && <Callout tone="warning">Couldn't refresh this job: {error}. Showing the last loaded details.</Callout>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <StatusBadge status={j.status} />
        {j.automation_type && <TypeTag type={j.automation_type} />}
        {j.environment && <span style={{ fontSize: 11, color: '#475569', background: '#F1F5F9', border: '1px solid #E2E8F0', borderRadius: 999, padding: '2px 8px' }}>{j.environment}</span>}
        <span style={{ fontSize: 11.5, color: '#64748B' }}>
          {active ? `Running for ${dur.text} · updates every ${ACTIVE_POLL_MS / 1000}s` : `Took ${dur.text}`}
        </span>
        {refreshing && <Spinner size={12} />}
      </div>

      {group === 'FAILED' && (job?.stderr_output || job?.script_result === 'FAILED') && (
        <Callout tone="danger" title="This execution failed">
          {job?.exit_code != null && job.exit_code !== -1 ? `Exit code ${job.exit_code}. ` : ''}See the error output below.
        </Callout>
      )}
      {noErrorDetail && (
        <Callout tone="warning" title="No error detail was recorded">
          RunStack only stored the final status for this job. Use the execution ID{job.execution_id ? ` (${job.execution_id})` : ''} in the target
          account's Systems Manager console, or the Step Functions execution for this job, to see why it failed.
        </Callout>
      )}

      <Section title="What ran">
        <Field label="Automation" value={j.automation_label} />
        {job?.automation_name && <Field label="Automation name" value={job.automation_name} hint="Name given when the job was submitted" />}
        <Field label="Document" value={j.document_name} mono />
        <Field label={docFull && docFull.startsWith('arn:') ? 'Document ARN' : 'Document reference'} value={docFull} mono copy
          hint={docFull ? (docFull.startsWith('arn:') ? 'Exact reference sent to SSM' : 'Stored as a document name — no ARN was recorded for this job') : undefined} />
        <Field label="Type" value={j.automation_type} />
        {j.problem_id && <Field label="Problem ID" value={j.problem_id} mono copy />}
      </Section>

      <Section title="Target">
        <Field label="Server name" value={j.server_name} />
        <Field label="Application" value={j.app_name ? `${j.app_name}${j.app_id ? ` (${j.app_id})` : ''}` : null} />
        <Field label="Resource ID" value={j.resource_id} mono copy />
        <Field label="Account" value={j.account_id} mono copy />
        <Field label="Region" value={j.region} />
        <Field label="Environment" value={j.environment} />
        {job?.os && <Field label="OS" value={job.os} />}
      </Section>

      <Section title="Identifiers">
        <Field label="Job ID" value={j.job_id} mono copy />
        <Field label="Notification ID" value={j.notification_id} mono copy />
        <Field label="Execution ID" value={j.execution_id} mono copy hint={j.execution_id ? 'SSM execution / command ID in the target account' : undefined} />
      </Section>

      <Section title="Timeline">
        <Field label="Received" value={fmtFull(j.created_at)} hint={`${fmtAgo(j.created_at, now)} · job created as PENDING`} />
        <Field label="Last update" value={fmtFull(j.updated_at)} hint={`${fmtAgo(j.updated_at, now)} · status set to ${j.status}`} />
        <Field label={active ? 'Elapsed' : 'Duration'} value={dur.text} />
        <div style={{ fontSize: 11, color: '#94A3B8', paddingTop: 8 }}>
          RunStack keeps the current status and these two timestamps only; individual status changes are not recorded.
        </div>
      </Section>

      {(job?.exit_code != null || job?.script_result || job?.ec2_state) && (
        <Section title="Result">
          {job.script_result && <Field label="Script result" value={job.script_result} />}
          {job.exit_code != null && <Field label="Exit code" value={job.exit_code === -1 ? '-1 (not captured)' : String(job.exit_code)} mono />}
          {job.ec2_state && <Field label="EC2 state" value={job.ec2_state} />}
        </Section>
      )}

      {job && (job.stderr_output || job.output) ? (
        <Section title="Output">
          <OutputBlock title="Error output (stderr)" text={job.stderr_output} tone="error" />
          <OutputBlock title="Output" text={job.output} />
        </Section>
      ) : job && (
        <Section title="Output"><div style={{ fontSize: 12, color: '#94A3B8', padding: '6px 0' }}>{active ? 'No output yet.' : 'No output was recorded for this job.'}</div></Section>
      )}

      {params && Object.keys(params).length > 0 && (
        <Section title="Parameters" right={<span style={{ fontSize: 11, color: '#94A3B8' }}>Secrets are masked</span>}>
          <pre style={{ margin: '6px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#0F172A' }}>
            {JSON.stringify(params, null, 2)}
          </pre>
        </Section>
      )}
    </div>
  );
}
