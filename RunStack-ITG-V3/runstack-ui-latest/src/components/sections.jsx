// src/components/sections.jsx
//
// Section-level building blocks from the redesigned Run Automation page
// (TriggerJob.jsx), made shareable so other pages use the same card
// colours, headings, chips and plain-language callouts. The values here
// intentionally match TriggerJob's local versions one-for-one; TriggerJob
// itself is left untouched in this change to avoid regressions there.
import React from 'react';
import { Btn, Card, CardHead, Spinner } from './ui';

// Light teal ladder used down the Run Automation page, lightest first,
// plus a caution tone for the irreversible final step.
const TONES = {
  1:       { border: '#BFE0DB', head: '#F4FAF9' },
  2:       { border: '#9FD2CB', head: '#EFF7F5' },
  3:       { border: '#7EC4BB', head: '#E9F4F1' },
  4:       { border: '#0F766E', head: '#E3F3EE' },
  neutral: { border: '#E2E8F0', head: '#F8FAFC' },
  caution: { border: '#F3D9AE', head: '#FDF3E4' },
};

export function SectionHeader({ title, helper, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#0F172A' }}>{title}</div>
        {helper && <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2, fontWeight: 400 }}>{helper}</div>}
      </div>
      {right && <span style={{ marginLeft: 'auto', flexShrink: 0, display: 'flex', gap: 8, alignItems: 'center' }}>{right}</span>}
    </div>
  );
}

/** Card with a coloured left rule and tinted header, as on Run Automation. */
export function SectionCard({ tone = 1, title, helper, right, children, bodyStyle, id }) {
  const t = TONES[tone] || TONES[1];
  return (
    <Card id={id} style={{ borderLeft: `3px solid ${t.border}` }} className="animate-fade">
      <CardHead style={{ background: t.head }}>
        <SectionHeader title={title} helper={helper} right={right} />
      </CardHead>
      <div style={{ padding: '16px 18px', display: 'grid', gap: 14, ...bodyStyle }}>
        {children}
      </div>
    </Card>
  );
}

export function Chip({ children, tone = 'default', title }) {
  const tones = {
    default: { bg: '#E6F5F3', fg: '#0B5C56', border: '#BEE3DE' },
    amber:   { bg: '#FDF3E4', fg: '#92400E', border: '#F3D9AE' },
    gray:    { bg: '#F1F3F5', fg: '#475569', border: '#E2E8F0' },
    red:     { bg: '#FDECEC', fg: '#B91C1C', border: '#F7B9B9' },
    green:   { bg: '#E4F8F0', fg: '#0B6E4C', border: '#A9E7CD' },
  };
  const t = tones[tone] || tones.default;
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px',
      borderRadius: 999, fontSize: 10.5, fontWeight: 600,
      background: t.bg, color: t.fg, border: `1px solid ${t.border}`,
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

export function ReviewRow({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5 }}>
      <span style={{ color: '#64748B' }}>{label}</span>
      <span style={{ color: '#0F172A', fontWeight: 600, fontFamily: mono ? 'var(--font-mono)' : 'inherit', textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

/** Plain-language message box. tone: info | success | warning | danger. */
export function Callout({ tone = 'info', title, children, action }) {
  const tones = {
    info:    { bg: '#EFF7F5', border: '#BFE0DB', fg: '#0B5C56' },
    success: { bg: '#E4F8F0', border: '#A9E7CD', fg: '#0B6E4C' },
    warning: { bg: '#FDF3E4', border: '#F3D9AE', fg: '#92400E' },
    danger:  { bg: '#FDECEC', border: '#F7B9B9', fg: '#9A1E1E' },
  };
  const t = tones[tone] || tones.info;
  return (
    <div role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'} style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      background: t.bg, border: `1px solid ${t.border}`, borderRadius: 8,
      padding: '10px 14px', fontSize: 12.5, color: t.fg, lineHeight: 1.55,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={{ fontWeight: 700, marginBottom: children ? 2 : 0 }}>{title}</div>}
        {children}
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  );
}

/** Small uppercase label used above groups of review rows. */
export function Eyebrow({ children }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 8 }}>
      {children}
    </div>
  );
}

export function fmtClock(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * "Last updated 11:42:05 · auto-refresh every 15s" + Refresh button, used
 * in the Topbar of Dashboard / Automation Executions / DR Switchover so the
 * control looks and behaves the same everywhere.
 */
export function RefreshControl({ onRefresh, refreshing, lastUpdated, label = 'Refresh', stampLabel = 'Last updated', autoEverySec, error }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 11, color: error ? '#B91C1C' : '#64748B', whiteSpace: 'nowrap' }} aria-live="polite">
        {error
          ? `Refresh failed — showing data from ${fmtClock(lastUpdated)}`
          : <>{stampLabel} {fmtClock(lastUpdated)}{autoEverySec ? ` · auto every ${autoEverySec}s` : ''}</>}
      </span>
      <Btn variant="default" size="sm" onClick={onRefresh} disabled={refreshing}>
        {refreshing ? <Spinner size={13} /> : <RefreshIcon />} {label}
      </Btn>
    </div>
  );
}

function RefreshIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="#334155" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.5V6h-3.5" />
    </svg>
  );
}

/** Compact stat for summary strips. */
export function SummaryTile({ label, value, sub, tone = 'default', mono }) {
  const accents = { default: '#0F766E', green: '#0F9D6D', amber: '#B45309', red: '#DC2626', gray: '#94A3B8' };
  return (
    <div style={{
      background: '#FFFFFF', border: '1px solid #E2E8F0', borderTop: `3px solid ${accents[tone] || accents.default}`,
      borderRadius: 10, padding: '12px 14px', minWidth: 0,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', fontFamily: mono ? 'var(--font-mono)' : 'inherit', wordBreak: 'break-all' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#64748B', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
