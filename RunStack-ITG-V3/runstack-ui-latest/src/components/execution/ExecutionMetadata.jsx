// src/components/execution/ExecutionMetadata.jsx
//
// Compact three-column information block under the title. Only fields the
// execution API actually returns are shown; anything not recorded shows "—".
// (Run-wide account/region counts and max concurrency aren't available from
// the API yet, so they're not shown rather than estimated from one page.)

import React from 'react';
import { fmtFull } from '../../utils/jobs';
import { fmtElapsed } from '../../utils/executionLogs';
import { triggerSource } from '../../utils/executionStatus';

function Field({ label, children, mono }) {
  const empty = children === null || children === undefined || children === '';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '112px minmax(0, 1fr)', gap: 10, padding: '4px 0', alignItems: 'baseline' }}>
      <dt style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{label}</dt>
      <dd style={{
        margin: 0, fontSize: mono ? 12 : 12.5, fontWeight: 600, color: empty ? 'var(--slate-400)' : 'var(--text-primary)',
        fontFamily: mono ? 'var(--font-mono)' : 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }} title={typeof children === 'string' ? children : undefined}>
        {empty ? '—' : children}
      </dd>
    </div>
  );
}

const column = { margin: 0, minWidth: 0 };

export default function ExecutionMetadata({ exec, counts, hiddenJobs, elapsedSec }) {
  const trigger = triggerSource(exec?.initiated_by);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '4px 28px' }}>
      <dl style={column}>
        <Field label="Automation">{exec?.automation_label}</Field>
        <Field label="Document" mono>{exec?.document_name}</Field>
        <Field label="Type">{exec?.automation_type}</Field>
        <Field label="Environment">{exec?.environment}</Field>
      </dl>
      <dl style={column}>
        <Field label="Targets">{counts ? counts.total.toLocaleString() : null}</Field>
        <Field label="Jobs in run">{exec?.jobs_in_scope != null ? exec.jobs_in_scope.toLocaleString() : null}</Field>
        <Field label="Trigger">{trigger.label}</Field>
        {hiddenJobs > 0 && <Field label="Not visible to you">{`${hiddenJobs.toLocaleString()} job${hiddenJobs === 1 ? '' : 's'}`}</Field>}
      </dl>
      <dl style={column}>
        <Field label="Started by">{trigger.by}</Field>
        <Field label="Start time">{exec?.started_at ? fmtFull(exec.started_at) : null}</Field>
        <Field label={exec?.is_active ? 'Elapsed' : 'Duration'} mono>{elapsedSec != null ? fmtElapsed(elapsedSec) : null}</Field>
        <Field label="Completed">{exec?.ended_at && !exec.is_active ? fmtFull(exec.ended_at) : null}</Field>
      </dl>
    </div>
  );
}
