// src/components/execution/TargetTable.jsx
//
// One row per target (server) for the current page of GET
// /jobs/{jobId}/execution. Output is never loaded here — the Output column
// opens the drawer, which fetches it for that one server only.
//
// Paging is server-side (offset cursors from the API): "1–25 of 500 · Page
// 1 of 20" with previous/next. Jumping to a numbered page needs a backend
// `offset` parameter and is not offered yet.

import React from 'react';
import { Btn, Spinner } from '../ui';
import TargetStatusBadge from './TargetStatusBadge';
import { fmtFull, parseUtc } from '../../utils/jobs';
import { fmtElapsed, targetElapsed } from '../../utils/executionLogs';
import { isActiveTarget, isUnsuccessfulTarget, outputActionLabel } from '../../utils/executionStatus';

const th = {
  textAlign: 'left', padding: '8px 12px', fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)',
  textTransform: 'uppercase', letterSpacing: 0.6, background: 'var(--bg-tint)', borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1,
};
const td = { padding: '8px 12px', borderBottom: '1px solid var(--slate-100)', fontSize: 12.5, verticalAlign: 'middle' };
const mono = { fontFamily: 'var(--font-mono)', fontSize: 11.5 };

function timeOf(iso) {
  const d = parseUtc(iso);
  return d ? d.toLocaleTimeString('en-GB') : '—';
}

function OutputAction({ status, onOpen }) {
  const label = outputActionLabel(status);
  if (!label) return <span style={{ color: 'var(--slate-400)' }}>—</span>;
  const error = isUnsuccessfulTarget(status);
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(); }}
      style={{
        background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
        color: error ? 'var(--danger)' : status === 'running' ? 'var(--running-text)' : 'var(--brand-hover)', whiteSpace: 'nowrap',
      }}>
      {label} ›
    </button>
  );
}

function Row({ t, selected, onOpen, now }) {
  const elapsed = targetElapsed(t, now);
  const open = () => onOpen(t);
  return (
    <tr tabIndex={0} aria-selected={selected} onClick={open}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
      className="rs-target-row"
      style={{ cursor: 'pointer', background: selected ? 'var(--brand-bg)' : undefined }}>
      <td style={{ ...td, maxWidth: 260 }}>
        <div style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t.server_name || t.instance_id || '—'}
        </div>
        {t.server_name && t.instance_id && <div style={{ ...mono, fontSize: 10.5, color: 'var(--text-tertiary)' }}>{t.instance_id}</div>}
      </td>
      <td style={td}>
        <TargetStatusBadge status={t.status} detail={t.status_detail} />
        {t.retrieval_error && isActiveTarget(t.status) && (
          <span title="Live Systems Manager status isn't available; showing RunStack's record" style={{ marginLeft: 6, color: 'var(--warning)', fontSize: 11 }}>⚠</span>
        )}
      </td>
      <td style={{ ...td, ...mono, color: 'var(--text-secondary)' }}>{t.account_id || '—'}</td>
      <td style={{ ...td, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{t.region || '—'}</td>
      <td style={{ ...td, ...mono, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }} title={t.started_at ? fmtFull(t.started_at) : ''}>
        {t.status === 'pending' ? '—' : timeOf(t.started_at)}
      </td>
      <td style={{ ...td, ...mono, whiteSpace: 'nowrap' }}>
        {t.status === 'pending' || elapsed == null ? '—' : `${fmtElapsed(elapsed)}${isActiveTarget(t.status) ? '…' : ''}`}
      </td>
      <td style={td}><OutputAction status={t.status} onOpen={open} /></td>
    </tr>
  );
}

export default function TargetTable({
  targets, selectedKey, onOpen, now, loading, total, offset, limit, hasPrev, hasNext, onPrev, onNext, hiddenJobs, filtered,
}) {
  const from = total ? offset + 1 : 0;
  const to = Math.min(offset + (targets?.length || 0), total);
  const page = limit ? Math.floor(offset / limit) + 1 : 1;
  const pages = limit ? Math.max(1, Math.ceil(total / limit)) : 1;
  return (
    <div style={{ display: 'grid', gap: 0 }}>
      <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface)' }}>
        <table style={{ width: '100%', minWidth: 820, borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              <th style={th}>Server</th><th style={th}>Status</th><th style={th}>Account</th><th style={th}>Region</th>
              <th style={th}>Started</th><th style={th}>Duration</th><th style={th}>Output</th>
            </tr>
          </thead>
          <tbody>
            {(targets || []).map((t) => <Row key={t.key} t={t} selected={t.key === selectedKey} onOpen={onOpen} now={now} />)}
            {!loading && (!targets || targets.length === 0) && (
              <tr><td colSpan={7} style={{ ...td, textAlign: 'center', color: 'var(--text-tertiary)', padding: 28 }}>
                {filtered ? 'No servers match this search or filter.' : 'No servers to show.'}
              </td></tr>
            )}
            {loading && (!targets || targets.length === 0) && (
              <tr><td colSpan={7} style={{ ...td, textAlign: 'center', padding: 28 }}><Spinner /></td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 2px 0', fontSize: 12, color: 'var(--text-tertiary)', flexWrap: 'wrap' }}>
        <span><strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{from.toLocaleString()}–{to.toLocaleString()}</strong> of {total.toLocaleString()}</span>
        {hiddenJobs > 0 && (
          <span title="Servers in this run that your application access or team capabilities don't cover">
            · {hiddenJobs.toLocaleString()} job{hiddenJobs === 1 ? '' : 's'} in this run not visible to you
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span>Page {page} of {pages}</span>
          <Btn size="sm" variant="default" onClick={onPrev} disabled={!hasPrev} aria-label="Previous page">‹ Prev</Btn>
          <Btn size="sm" variant="default" onClick={onNext} disabled={!hasNext} aria-label="Next page">Next ›</Btn>
        </span>
      </div>
    </div>
  );
}
