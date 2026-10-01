// src/components/execution/ExecutionInfoTab.jsx
//
// "Execution Details" tab: the technical identifiers and timing of the run,
// kept off the Targets view. Only what GET /jobs/{jobId}/execution returns.
// Request parameters are deliberately not shown — the API doesn't return
// them (they can contain secrets).

import React from 'react';
import { Callout } from '../sections';
import { CopyButton } from '../JobDetail';
import { fmtFull } from '../../utils/jobs';
import { fmtElapsed } from '../../utils/executionLogs';
import { triggerSource } from '../../utils/executionStatus';

function Row({ label, value, mono, copy, hint }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px minmax(0, 1fr)', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--slate-100)' }}>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', minWidth: 0 }}>
        <div style={{ fontSize: mono ? 11.5 : 12.5, fontFamily: mono ? 'var(--font-mono)' : 'inherit', color: 'var(--text-primary)', wordBreak: 'break-all', flex: 1 }}>
          {String(value)}
          {hint && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)', marginTop: 2, wordBreak: 'normal' }}>{hint}</div>}
        </div>
        {copy && <CopyButton value={String(value)} label={`Copy ${label}`} />}
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface)', padding: '10px 16px 6px' }}>
      <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 2 }}>{title}</h3>
      {children}
    </section>
  );
}

export default function ExecutionInfoTab({ exec, counts, data, elapsedSec }) {
  if (!exec) return null;
  const trigger = triggerSource(exec.initiated_by);
  const errors = data?.retrieval_errors || [];
  return (
    <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', alignItems: 'start' }}>
      <Section title="Run">
        <Row label="Execution group ID" value={exec.group_id} mono copy
          hint="Shared by every per-server job in this run" />
        <Row label={exec.group_id ? 'Opened from job' : 'Job ID'} value={exec.job_id} mono copy />
        <Row label="Scope" value={exec.scope === 'group' ? 'Bulk run (execution group)' : 'Single job'} />
        <Row label="Status" value={exec.status_label} />
        <Row label="Targets" value={counts ? counts.total.toLocaleString() : null} />
        <Row label="Jobs in run" value={exec.jobs_in_scope != null ? exec.jobs_in_scope.toLocaleString() : null} />
        <Row label="Not visible to you" value={data?.hidden_jobs ? `${data.hidden_jobs.toLocaleString()} job(s)` : null}
          hint="Servers your application access or team capabilities don't cover are left out of this view and its counts." />
      </Section>
      <Section title="Automation">
        <Row label="Automation name" value={exec.automation_name} />
        <Row label="Automation" value={exec.automation_label !== exec.automation_name ? exec.automation_label : null} />
        <Row label="Automation type" value={exec.automation_type} mono />
        <Row label="SSM document" value={exec.document_name} mono copy />
        <Row label="Environment" value={exec.environment} />
        <Row label="Group label" value={exec.group_label && exec.group_label !== exec.automation_name ? exec.group_label : null} />
      </Section>
      <Section title="Trigger">
        <Row label="Trigger source" value={trigger.label} />
        <Row label="Initiated by" value={exec.initiated_by || 'Not recorded'} mono={trigger.kind !== 'user'} />
      </Section>
      <Section title="Timing">
        <Row label="Started" value={exec.started_at ? fmtFull(exec.started_at) : null} />
        <Row label="Completed" value={exec.ended_at && !exec.is_active ? fmtFull(exec.ended_at) : null} />
        <Row label={exec.is_active ? 'Elapsed' : 'Duration'} value={elapsedSec != null ? fmtElapsed(elapsedSec) : null} mono />
        <Row label="Status checked" value={data?.generated_at ? fmtFull(data.generated_at) : null} />
      </Section>
      {(data?.members_truncated || errors.length > 0) && (
        <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 10 }}>
          {data?.members_truncated && (
            <Callout tone="warning" title="Very large run">
              This run has more servers than RunStack reads at once; counts cover the first {counts?.total?.toLocaleString()} only.
            </Callout>
          )}
          {errors.length > 0 && (
            <details style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
              <summary style={{ cursor: 'pointer' }}>Some live Systems Manager status couldn't be read ({errors.length})</summary>
              <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-word' }}>
                {errors.map((e, i) => <div key={i}>{e.job_id ? `${e.job_id}: ` : ''}{e.code}{e.message ? ` — ${e.message}` : ''}</div>)}
              </div>
              <div style={{ marginTop: 4 }}>This is a problem reading status, not a failure of the execution. Affected servers show RunStack's own record.</div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
