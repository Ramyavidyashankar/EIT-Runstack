// src/components/execution/StepsAndDetails.jsx
//
// Steps and Details tabs of Execution Details. Everything shown comes from
// GET /jobs/{jobId}/execution?target=… ("selected"): Automation step
// executions, Run Command plugins, and the identifiers RunStack resolved
// (dispatch, child execution, command ID, CloudWatch group). Nothing here
// implies live console output — that's the Output tab.

import React, { useState } from 'react';
import { Callout } from '../sections';
import JobDetailContent, { CopyButton } from '../JobDetail';
import { Btn } from '../ui';
import TargetStatusBadge from './TargetStatusBadge';
import { fmtElapsed } from '../../utils/executionLogs';
import { fmtFull } from '../../utils/jobs';

function dur(a, b) {
  const x = Date.parse(a || '');
  const y = b ? Date.parse(b) : NaN;
  if (Number.isNaN(x)) return '—';
  return fmtElapsed(((Number.isNaN(y) ? Date.now() : y) - x) / 1000);
}

const th = { textAlign: 'left', padding: '8px 10px', fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6, background: '#F8FAFC', borderBottom: '1px solid #E2E8F0', whiteSpace: 'nowrap' };
const td = { padding: '8px 10px', borderBottom: '1px solid #F1F5F9', fontSize: 12.5, verticalAlign: 'top' };

function StepRow({ s, kind }) {
  const [open, setOpen] = useState(false);
  const outputs = s.outputs && Object.keys(s.outputs).length ? s.outputs : null;
  const expandable = outputs || s.failure_message || (kind === 'plugin' && s.final_output_preview);
  return (
    <>
      <tr>
        <td style={td}>
          <div style={{ fontWeight: 600, color: '#0F172A' }}>{s.name || '—'}</div>
          {s.action && <div style={{ fontSize: 11, color: '#64748B', fontFamily: 'var(--font-mono)' }}>{s.action}</div>}
        </td>
        <td style={td}><TargetStatusBadge status={s.status} detail={s.status_detail} />
          {s.status_detail && !['Success', 'InProgress', 'Pending'].includes(s.status_detail) && (
            <div style={{ fontSize: 11, color: '#64748B', marginTop: 3 }}>{s.status_detail}</div>
          )}
        </td>
        <td style={{ ...td, whiteSpace: 'nowrap', color: '#334155' }} title={s.started_at ? fmtFull(s.started_at) : ''}>
          {s.started_at ? new Date(s.started_at).toLocaleTimeString('en-GB') : '—'}
        </td>
        <td style={{ ...td, whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{s.started_at ? dur(s.started_at, s.ended_at) : '—'}</td>
        <td style={td}>
          {kind === 'step' && (s.has_running_output
            ? <span style={{ fontSize: 11, color: '#0B6E4C', fontWeight: 600 }}>Console output (Output tab)</span>
            : <span style={{ fontSize: 11, color: '#94A3B8' }}>No console output</span>)}
          {kind === 'plugin' && s.response_code != null && s.response_code !== -1 && (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>exit {s.response_code}</span>
          )}
          {expandable && (
            <div><Btn size="sm" variant="ghost" onClick={() => setOpen((x) => !x)}>{open ? 'Hide' : 'Show'} details</Btn></div>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ ...td, background: '#FBFCFD' }}>
            {s.failure_message && <Callout tone="danger" title="Failure message">{s.failure_message}</Callout>}
            {outputs && (
              <pre style={{ margin: '8px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {JSON.stringify(outputs, null, 2)}
              </pre>
            )}
            {kind === 'plugin' && s.final_output_preview && (
              <>
                <div style={{ fontSize: 11, color: '#64748B', margin: '8px 0 4px' }}>
                  Final output preview from Systems Manager (first 2,500 characters). The full output is on the Output tab when CloudWatch output is enabled.
                </div>
                <pre style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflow: 'auto', background: '#F8FAFC', padding: 10, borderRadius: 8, border: '1px solid #E2E8F0' }}>
                  {s.final_output_preview}
                </pre>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function StepsPanel({ selected }) {
  const steps = selected?.steps || [];
  const plugins = selected?.plugins || [];
  if (!steps.length && !plugins.length) {
    return <div style={{ padding: 16 }}><Callout tone="info">No step information is available for this target yet.</Callout></div>;
  }
  return (
    <div style={{ padding: 12, display: 'grid', gap: 14, overflow: 'auto' }}>
      {steps.length > 0 && (
        <section>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>
            Automation steps
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Step</th><th style={th}>Status</th><th style={th}>Started</th><th style={th}>Duration</th><th style={th}>Output</th></tr></thead>
            <tbody>{steps.map((s, i) => <StepRow key={`${s.name}-${i}`} s={s} kind="step" />)}</tbody>
          </table>
        </section>
      )}
      {plugins.length > 0 && (
        <section>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>
            Command steps on this server
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Step</th><th style={th}>Status</th><th style={th}>Started</th><th style={th}>Duration</th><th style={th}>Result</th></tr></thead>
            <tbody>{plugins.map((p, i) => <StepRow key={`${p.name}-${i}`} s={p} kind="plugin" />)}</tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function Row({ label, value, mono, copy, hint }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 12, padding: '7px 0', borderBottom: '1px solid #F1F5F9' }}>
      <div style={{ fontSize: 12, color: '#64748B' }}>{label}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', minWidth: 0 }}>
        <div style={{ fontSize: mono ? 11.5 : 12.5, fontFamily: mono ? 'var(--font-mono)' : 'inherit', color: '#0F172A', wordBreak: 'break-all', flex: 1 }}>
          {String(value)}
          {hint && <div style={{ fontSize: 11, color: '#64748B', fontFamily: 'var(--font-sans)', marginTop: 2 }}>{hint}</div>}
        </div>
        {copy && <CopyButton value={String(value)} label={`Copy ${label}`} />}
      </div>
    </div>
  );
}

const DISPATCH_KIND = {
  run_command: 'Run Command (same region)',
  run_command_wrapper: 'Run Command via RunStack-Generic-RunCommand-Wrapper (cross-region, TargetLocations)',
  automation: 'SSM Automation (same region)',
  automation_target_locations: 'SSM Automation with TargetLocations (cross-region)',
};

export function DetailsPanel({ selected, target }) {
  const [showRecord, setShowRecord] = useState(false);
  const d = selected?.details || {};
  const t = selected?.target || target || {};
  const cw = d.cloudwatch;
  return (
    <div style={{ padding: 12, overflow: 'auto', display: 'grid', gap: 12 }}>
      {(selected?.output_notes || []).map((n, i) => <Callout key={i} tone="info">{n}</Callout>)}
      {d.workflow_error && (
        <Callout tone="danger" title="Failed before Systems Manager started anything">
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{d.workflow_error.step}</div>
          <div><strong>{d.workflow_error.error}</strong>: {d.workflow_error.cause}</div>
        </Callout>
      )}
      <section style={{ border: '1px solid #E2E8F0', borderRadius: 10, padding: '4px 14px 8px', background: '#FFFFFF' }}>
        <Row label="Server" value={t.server_name} />
        <Row label="Instance ID" value={t.instance_id} mono copy />
        <Row label="Account" value={t.account_id} mono copy />
        <Row label="Region" value={t.region} />
        <Row label="Status detail" value={t.status_detail} hint={t.status_source === 'runstack' ? "From RunStack's job record (live Systems Manager status not available)" : 'From Systems Manager'} />
        <Row label="Started" value={t.started_at ? fmtFull(t.started_at) : null} />
        <Row label="Ended" value={t.ended_at ? fmtFull(t.ended_at) : null} />
      </section>
      <section style={{ border: '1px solid #E2E8F0', borderRadius: 10, padding: '4px 14px 8px', background: '#FFFFFF' }}>
        <Row label="Job ID" value={d.job_id} mono copy />
        <Row label="Execution group" value={d.execution_group_id} mono copy />
        <Row label="Initiated by" value={d.initiated_by} />
        <Row label="Document" value={d.document_name} mono />
        <Row label="How it ran" value={d.dispatch ? (DISPATCH_KIND[d.dispatch.kind] || d.dispatch.kind) : null} />
        <Row label="Step Functions execution" value={d.step_functions_execution} mono copy />
        <Row label="Automation execution" value={d.automation_execution_id} mono copy
          hint={d.dispatch?.dispatch_account ? `In account ${d.dispatch.dispatch_account}, ${d.dispatch.dispatch_region}` : undefined} />
        <Row label="Child execution" value={d.child_execution_id} mono copy
          hint={d.child_location ? `In account ${d.child_location.account_id}, ${d.child_location.region}` : undefined} />
        <Row label="Command ID" value={d.command_id} mono copy />
        <Row label="Command IDs" value={Array.isArray(d.command_ids) && d.command_ids.length ? d.command_ids.join(', ') : null} mono />
        <Row label="CloudWatch output" value={cw ? (cw.enabled ? `Enabled · ${cw.log_group || 'default group'}` : 'Not enabled for this command') : null} />
        <Row label="Exit code" value={d.exit_code != null && d.exit_code !== -1 ? d.exit_code : null} mono />
      </section>
      {(selected?.retrieval_errors || []).length > 0 && (
        <details style={{ fontSize: 12, color: '#64748B' }}>
          <summary style={{ cursor: 'pointer' }}>Systems Manager details not available</summary>
          <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 11, wordBreak: 'break-word' }}>
            {selected.retrieval_errors.map((e, i) => <div key={i}>{e.code}{e.message ? `: ${e.message}` : ''}</div>)}
          </div>
          <div style={{ marginTop: 4 }}>This doesn't affect the execution or its result.</div>
        </details>
      )}
      {d.job_id && (
        <div>
          <Btn size="sm" variant="default" onClick={() => setShowRecord((x) => !x)}>
            {showRecord ? 'Hide' : 'Show'} RunStack job record
          </Btn>
          {showRecord && <div style={{ marginTop: 10 }}><JobDetailContent jobId={d.job_id} /></div>}
        </div>
      )}
    </div>
  );
}
