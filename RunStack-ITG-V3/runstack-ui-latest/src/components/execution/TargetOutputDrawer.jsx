// src/components/execution/TargetOutputDrawer.jsx
//
// Right-side drawer for one target (server). Opened from the target table;
// nothing here loads until it's open:
//   • summary + "what's happening" box — current step while running,
//     failed step / reason / execution ID when it didn't succeed
//   • Output / Steps / Details tabs — the existing OutputPanel (GET
//     /jobs/{jobId}/logs, incremental), StepsPanel and DetailsPanel, unchanged
//
// The target's live detail (`selected`) comes from the page's status poll
// (GET /jobs/{jobId}/execution?target=<key>), so it refreshes on the same
// ~5 s cycle while the run is active. Esc or the backdrop closes it.

import React, { useEffect, useRef, useState } from 'react';
import { Spinner } from '../ui';
import { CopyButton } from '../JobDetail';
import OutputPanel from './OutputPanel';
import { DetailsPanel, StepsPanel } from './StepsAndDetails';
import TargetStatusBadge from './TargetStatusBadge';
import VarCleanupSummary from './VarCleanupSummary';
import { fmtFull } from '../../utils/jobs';
import { fmtElapsed, targetElapsed } from '../../utils/executionLogs';
import { isActiveTarget, isUnsuccessfulTarget } from '../../utils/executionStatus';
import Tabs from '../Tabs';

function Info({ label, children, mono, copy }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',}}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, minWidth: 0 }}>
        <span style={{
          fontSize: mono ? 11.5 : 12.5, fontWeight: 600, color: children ? 'var(--text-primary)' : 'var(--slate-400)',
          fontFamily: mono ? 'var(--font-mono)' : 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{children || '—'}</span>
        {copy && children && <CopyButton value={String(children)} label={`Copy ${label}`} />}
      </div>
    </div>
  );
}

function firstFailedStep(selected) {
  const all = [...(selected?.steps || []), ...(selected?.plugins || [])];
  return all.find((s) => isUnsuccessfulTarget(s.status)) || null;
}

function executionIdOf(selected) {
  const d = selected?.details || {};
  return d.command_id || d.child_execution_id || d.automation_execution_id || d.step_functions_execution || null;
}

function StateBox({ target, selected }) {
  if (isActiveTarget(target.status)) {
    return (
      <div style={{ border: '1px solid var(--running-border)', background: 'var(--running-bg)', borderRadius: 'var(--radius-md)', padding: '10px 12px', display: 'grid', gap: 6 }}>
        <Info label="Current step">{target.status === 'pending' ? 'Waiting to start' : target.current_step}</Info>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',}}>Latest status</div>
          <div style={{ fontSize: 13, color: 'var(--text-primary)', marginTop: 2, wordBreak: 'break-word' }}>{target.status_detail || '—'}</div>
        </div>
      </div>
    );
  }
  if (!isUnsuccessfulTarget(target.status)) return null;
  const step = firstFailedStep(selected);
  const reason = step?.failure_message || target.status_detail;
  const execId = executionIdOf(selected);
  return (
    <div style={{ border: '1px solid var(--danger-border)', background: 'var(--danger-bg)', borderRadius: 'var(--radius-md)', padding: '10px 12px', display: 'grid', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <Info label="Failed step">{step?.name || (selected ? null : '…')}</Info>
        <Info label="Execution ID" mono copy>{execId}</Info>
      </div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',}}>Reason</div>
        <div style={{ fontSize: 13, color: '#7F1D1D', marginTop: 2, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{reason || 'No reason recorded.'}</div>
      </div>
    </div>
  );
}

export default function TargetOutputDrawer({ jobId, target, selected, paused, getBuffer, isEc2, onClose, now }) {
  const [tab, setTab] = useState('output');
  const closeRef = useRef(null);
  const returnFocus = useRef(null);

  // Remember what had focus, focus Close, and restore focus on close.
  useEffect(() => {
    returnFocus.current = document.activeElement;
    closeRef.current?.focus();
    return () => { if (returnFocus.current && returnFocus.current.focus) returnFocus.current.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Start on Output (where a script's error text appears) for each server.
  useEffect(() => { setTab('output'); }, [target.key]);

  const hasSteps = !!(selected && ((selected.steps || []).length || (selected.plugins || []).length));
  const showOutput = target.output_mode !== 'none' || isEc2;
  const tabs = [
    showOutput && { k: 'output', l: 'Output' },
    hasSteps && { k: 'steps', l: 'Steps' },
    { k: 'details', l: 'Details' },
  ].filter(Boolean);
  const activeTab = tabs.some((t) => t.k === tab) ? tab : tabs[0].k;
  const elapsed = targetElapsed(target, now);
  const name = target.server_name || target.instance_id || 'Target';

  return (
    <>
      <div onClick={onClose} aria-hidden="true"
        style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.28)', zIndex: 40 }} />
      <aside role="dialog" aria-modal="true" aria-label={`${name} — execution output`}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(780px, 100vw)', zIndex: 41,
          background: 'var(--bg-surface)', borderLeft: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)',
          display: 'flex', flexDirection: 'column', animation: 'rsDrawerIn .18s ease-out',
        }}>
        {/* Header */}
        <div style={{ padding: '14px 18px 12px', borderBottom: '1px solid var(--border)', display: 'grid', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <TargetStatusBadge status={target.status} detail={target.status_detail} size="md" />
                {target.retrieval_error && isActiveTarget(target.status) && (
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Live Systems Manager status isn't available; showing RunStack's record.</span>
                )}
              </div>
            </div>
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close"
              style={{
                border: '1px solid var(--border)', background: 'var(--bg-surface)', borderRadius: 'var(--radius-sm)',
                width: 30, height: 30, cursor: 'pointer', fontSize: 16, lineHeight: 1, color: 'var(--text-secondary)', flexShrink: 0,
              }}>×</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
            <Info label="Instance" mono copy>{target.instance_id}</Info>
            <Info label="Account" mono copy>{target.account_id}</Info>
            <Info label="Region">{target.region}</Info>
            <Info label="Started">{target.started_at && target.status !== 'pending' ? fmtFull(target.started_at) : null}</Info>
            <Info label={isActiveTarget(target.status) ? 'Elapsed' : 'Duration'} mono>
              {elapsed != null && target.status !== 'pending' ? fmtElapsed(elapsed) : null}
            </Info>
          </div>
          <StateBox target={target} selected={selected} />
        </div>

        {/* Tabs */}
        <Tabs label="Server views" idPrefix="rs-target" size="sm" active={activeTab} onChange={setTab} className="rs-tabs--inset"
          tabs={tabs.map((t) => ({ value: t.k, label: t.l }))}
          after={!selected ? <Spinner size={12} /> : null} />

        {/* Body — scrolls inside the drawer, never the page */}
        <div role="tabpanel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
          {activeTab === 'output' && (
            <OutputPanel key={target.key} jobId={jobId} target={target} paused={paused} getBuffer={getBuffer} isEc2={isEc2}
              Summary={VarCleanupSummary} />
          )}
          {activeTab === 'steps' && <StepsPanel selected={selected} />}
          {activeTab === 'details' && <DetailsPanel selected={selected} target={target} />}
        </div>
      </aside>
    </>
  );
}
