// src/components/execution/ExecutionProgress.jsx
//
// Progress ring (finished / total) and the summary cards. Both are driven
// only by `counts` from GET /jobs/{jobId}/execution, so they update on every
// status poll. "Finished" counts every terminal target (succeeded, failed,
// timed out, cancelled); the cards split that into outcomes.

import React from 'react';
import { progressOf } from '../../utils/executionLogs';
import { TARGET_STATUS, summaryBuckets } from '../../utils/executionStatus';

const R = 42;
const C = 2 * Math.PI * R;

function ProgressRing({ counts }) {
  const p = progressOf(counts);
  const c = counts || {};
  const total = p.total || 0;
  // Segments in drawing order; the grey track is whatever remains (pending).
  const segs = [
    { n: c.success || 0, color: TARGET_STATUS.success.dot },
    { n: (c.failed || 0) + (c.timed_out || 0), color: TARGET_STATUS.failed.dot },
    { n: c.cancelled || 0, color: TARGET_STATUS.cancelled.dot },
    { n: c.running || 0, color: TARGET_STATUS.running.dot },
  ];
  let offset = 0;
  return (
    <div style={{ position: 'relative', width: 112, height: 112, flexShrink: 0 }}>
      <svg width="112" height="112" viewBox="0 0 112 112" role="img"
        aria-label={`${p.finished} of ${total} targets finished; ${p.successful} succeeded`}>
        <circle cx="56" cy="56" r={R} fill="none" stroke="var(--slate-200)" strokeWidth="10" />
        {total > 0 && segs.map((s, i) => {
          if (!s.n) return null;
          const len = (s.n / total) * C;
          const el = (
            <circle key={i} cx="56" cy="56" r={R} fill="none" stroke={s.color} strokeWidth="10"
              strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset}
              transform="rotate(-90 56 56)" style={{ transition: 'stroke-dasharray .4s ease, stroke-dashoffset .4s ease' }} />
          );
          offset += len;
          return el;
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.1 }}>
          {p.finished.toLocaleString()}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 2 }}>of {total.toLocaleString()}</div>
        <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.6 }}>finished</div>
      </div>
    </div>
  );
}

export function ExecutionSummaryCards({ counts }) {
  const cards = summaryBuckets(counts);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: 10, flex: 1, minWidth: 0 }}>
      {cards.map((c) => (
        <div key={c.key} style={{
          background: c.meta.bg, border: `1px solid ${c.meta.border}`, borderRadius: 'var(--radius-md)',
          padding: '10px 12px', display: 'grid', gap: 2, minWidth: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: c.meta.color }}>
            <span aria-hidden="true" style={{ fontSize: 12, width: 14, textAlign: 'center' }}>{c.meta.icon}</span>
            {c.label}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.2 }}>
              {c.value.toLocaleString()}
            </span>
            <span style={{ fontSize: 12, color: c.meta.color, fontWeight: 600 }}>{c.pct}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', minHeight: 15 }}>{c.note || ''}</div>
        </div>
      ))}
    </div>
  );
}

export default function ExecutionProgress({ counts }) {
  return (
    <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
      <ProgressRing counts={counts} />
      <ExecutionSummaryCards counts={counts} />
    </div>
  );
}
