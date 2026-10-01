// src/components/execution/VarCleanupSummary.jsx
//
// /var cleanup result for one server, read from that server's actual output
// (the script prints `df -h /var` before and after zipping old logs). Renders
// nothing for other automations or when the output doesn't contain it.
// Nothing is estimated: values missing from the output are shown as missing.

import React from 'react';
import { fmtBytes, parseVarCleanup } from '../../utils/runTargets';

function Stat({ label, value, sub, tone }) {
  const color = tone === 'warn' ? 'var(--warning)' : tone === 'good' ? '#0B6E4C' : 'var(--text-primary)';
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',}}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-mono)', color }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{sub}</div>}
    </div>
  );
}

export default function VarCleanupSummary({ text }) {
  const r = parseVarCleanup(text);
  if (!r) return null;
  const { before, after } = r;
  return (
    <div style={{ margin: '10px 12px 0', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      background: 'var(--bg-tint)', display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
        /var cleanup{before?.mount ? ` · ${before.mount}` : ''}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 12 }}>
        <Stat label="Before" value={before ? `${before.usePct}%` : '—'} sub={before ? `${before.used} used · ${before.avail} free of ${before.size}` : 'Not in output'} />
        <Stat label="After" value={after ? `${after.usePct}%` : '—'}
          sub={after ? `${after.used} used · ${after.avail} free` : (r.noFiles ? 'Nothing was zipped' : 'Not in output yet')}
          tone={after ? (after.usePct < (before?.usePct ?? 101) ? 'good' : undefined) : undefined} />
        <Stat label="Space reclaimed" value={r.reclaimedBytes != null ? fmtBytes(r.reclaimedBytes) : '—'}
          sub={r.filesZipped != null ? `${r.filesZipped} file${r.filesZipped === 1 ? '' : 's'} zipped` : undefined} />
      </div>
      {r.noFiles && (
        <div style={{ fontSize: 13, color: 'var(--warning)' }}>
          No rotated log files matched the cleanup pattern{before ? `, so /var is still at ${before.usePct}%` : ''}. Manual review may be needed if space is still low.
        </div>
      )}
    </div>
  );
}
