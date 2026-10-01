// src/components/execution/ExecutionHeader.jsx
//
// Top of Execution Details:
//   • ExecutionTopbar — breadcrumb, refresh status, Pause/Resume, Refresh
//   • ExecutionTitle  — overall status, automation name, run/job ID and the
//                       trigger line (derived from initiated_by, never
//                       hardcoded per trigger type)
//
// Retry / Cancel actions are intentionally absent until their backend exists.

import React from 'react';
import { Link } from 'react-router-dom';
import { Topbar } from '../Layout';
import { Btn, Spinner, TypeTag } from '../ui';
import { fmtClock } from '../sections';
import { CopyButton } from '../JobDetail';
import TargetStatusBadge from './TargetStatusBadge';
import { fmtFull } from '../../utils/jobs';
import { triggerSource } from '../../utils/executionStatus';

export function ExecutionTopbar({ title, active, paused, onTogglePause, poll, intervalMs }) {
  const statusText = poll.error
    ? `Status refresh failed — showing ${fmtClock(poll.lastSuccess)}`
    : paused ? 'Updates paused'
      : active ? `Updated ${fmtClock(poll.lastSuccess)} · every ${Math.round((intervalMs || 5000) / 1000)}s`
        : `Finished · updated ${fmtClock(poll.lastSuccess)}`;
  return (
    <Topbar
      title={(
        <nav aria-label="Breadcrumb" style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Link to="/jobs" className="rs-hide-narrow" style={{ color: 'var(--text-tertiary)', fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap' }}>
            Automation Executions
          </Link>
          <span aria-hidden="true" className="rs-hide-narrow" style={{ color: 'var(--slate-300)' }}>›</span>
          <span aria-current="page" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 'min(420px, 45vw)' }}>{title}</span>
        </nav>
      )}
      actions={<>
        <span className="rs-hide-narrow" style={{ fontSize: 11, color: poll.error ? 'var(--warning)' : 'var(--text-tertiary)', whiteSpace: 'nowrap' }} aria-live="polite">
          {statusText}
        </span>
        {active && (
          <Btn size="sm" variant={paused ? 'accent' : 'default'} onClick={onTogglePause}
            aria-pressed={paused} title="Stops this page asking for updates. The automation keeps running.">
            {paused ? '▶ Resume updates' : '❚❚ Pause updates'}
          </Btn>
        )}
        <Btn size="sm" variant="default" onClick={poll.refresh} disabled={poll.refreshing}>
          {poll.refreshing ? <Spinner size={12} /> : '↻'} Refresh
        </Btn>
      </>}
    />
  );
}

export function ExecutionTitle({ exec, fallbackTitle }) {
  const trigger = triggerSource(exec?.initiated_by);
  const runId = exec?.group_id || exec?.job_id;
  return (
    <div style={{ display: 'grid', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <TargetStatusBadge overall status={exec?.status} size="md" />
        {exec?.automation_type && <TypeTag type={exec.automation_type} />}
        {exec?.scope === 'group' && (
          <span style={{ fontSize: 11, color: 'var(--text-secondary)', background: 'var(--slate-100)', border: '1px solid var(--border)', borderRadius: 999, padding: '2px 8px' }}>
            Bulk run
          </span>
        )}
      </div>
      <h1 style={{ fontSize: 19, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.25, wordBreak: 'break-word' }}>
        {exec?.automation_name || fallbackTitle}
      </h1>
      {runId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-tertiary)', minWidth: 0 }}>
          <span>{exec.group_id ? 'Execution group' : 'Job'}</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{runId}</span>
          <CopyButton value={runId} label={exec.group_id ? 'Copy group ID' : 'Copy job ID'} />
        </div>
      )}
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', display: 'flex', flexWrap: 'wrap', gap: '2px 8px' }}>
        <span>{trigger.label}</span>
        {exec?.started_at && <><span aria-hidden="true">•</span><span>Started {fmtFull(exec.started_at)}</span></>}
        {trigger.by && <><span aria-hidden="true">•</span><span>Initiated by <strong style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{trigger.by}</strong></span></>}
      </div>
    </div>
  );
}
