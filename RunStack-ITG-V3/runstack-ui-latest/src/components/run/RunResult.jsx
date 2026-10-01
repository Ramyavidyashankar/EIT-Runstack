// src/components/run/RunResult.jsx
//
// What happened right after a multi-server submission: how many servers
// were queued, and every server that was NOT started with the backend's own
// reason. Nothing here is inferred — it is the POST /notify response.

import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn } from '../ui';
import { Callout } from '../sections';

const REASON_LABEL = {
  app_access_denied: 'No app access',
  environment_restricted: 'Environment restricted',
  target_not_found: 'Not in catalog',
  document_not_in_region: 'Document not in region',
  incompatible_platform: 'Incompatible OS',
  scope_excluded: 'Outside team scope',
  document_not_approved: 'Automation not approved',
  unsupported_region: 'Unsupported region',
  locked: 'Another action in progress',
  dispatch_failed: 'Could not queue',
  invalid_job: 'Invalid target data',
};

export default function RunResult({ result, onStartAnother, what = 'run' }) {
  const nav = useNavigate();
  if (!result) return null;
  const rejected = result.rejected || [];
  const open = () => nav(`/jobs/${encodeURIComponent(result.run_job_id)}`, { state: { justSubmitted: true } });
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {result.duplicate && <Callout tone="info" title="Already submitted">{result.message}</Callout>}
      {result.accepted > 0 ? (
        <Callout tone={rejected.length ? 'warning' : 'success'}
          title={`${result.accepted} of ${result.total_requested} server${result.total_requested === 1 ? '' : 's'} queued as one ${what}`}
          action={result.run_job_id && <Btn variant="accent" size="sm" onClick={open}>Open run →</Btn>}>
          {result.concurrency?.waves > 1
            ? `Dispatched in ${result.concurrency.waves} batches of up to ${result.concurrency.wave_size} servers, ${result.concurrency.wave_seconds}s apart (dispatch batch size and interval — this paces start times, it doesn't cap how many run at once). Each server runs and reports independently.`
            : 'Each server runs and reports independently — one server failing doesn’t stop the others.'}
        </Callout>
      ) : (
        <Callout tone="danger" title="Nothing was started">None of the selected servers could run this. Reasons are below.</Callout>
      )}
      {rejected.length > 0 && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', background: 'var(--bg-tint)', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
            Not started ({rejected.length})
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              {rejected.map((r) => (
                <tr key={r.instance_id} style={{ borderTop: '1px solid var(--slate-100)' }}>
                  <td style={{ padding: '7px 12px', width: '28%' }}>
                    <div style={{ fontWeight: 600 }}>{r.server_name || r.instance_id}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)' }}>{r.instance_id}</div>
                  </td>
                  <td style={{ padding: '7px 12px', width: '20%', fontWeight: 600, color: 'var(--danger)' }}>{REASON_LABEL[r.reason] || r.reason || 'Not started'}</td>
                  <td style={{ padding: '7px 12px', color: 'var(--text-secondary)' }}>{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {onStartAnother && <div><Btn size="sm" variant="default" onClick={onStartAnother}>Start another</Btn></div>}
    </div>
  );
}
