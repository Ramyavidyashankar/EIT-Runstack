// src/components/execution/TargetStatusBadge.jsx
//
// The status pill used by every execution view (target table, drawer, step
// tables). Label, icon and colours come from utils/executionStatus.js.

import React from 'react';
import { overallStatusMeta, targetStatusMeta } from '../../utils/executionStatus';

export default function TargetStatusBadge({ status, detail, size = 'sm', overall = false }) {
  const m = overall ? overallStatusMeta(status) : targetStatusMeta(status);
  const big = size === 'md';
  return (
    <span title={detail && detail !== m.label ? detail : undefined} style={{
      display: 'inline-flex', alignItems: 'center', gap: big ? 6 : 5,
      padding: big ? '3px 10px' : '1px 8px', borderRadius: 999,
      background: m.bg, color: m.color, border: `1px solid ${m.border}`,
      fontSize: big ? 11.5 : 10.5, fontWeight: 600, whiteSpace: 'nowrap', lineHeight: 1.6,
    }}>
      <span style={{
        width: big ? 7 : 6, height: big ? 7 : 6, borderRadius: '50%', background: m.dot, flexShrink: 0,
        animation: m.pulse ? 'pulse 1.6s ease infinite' : 'none',
      }} />
      {m.label}
    </span>
  );
}
