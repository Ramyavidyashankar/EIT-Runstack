// src/components/sections.jsx
//
// Section-level building blocks from the redesigned Run Automation page
// (TriggerJob.jsx), made shareable so other pages use the same card
// colours, headings, chips and plain-language callouts. The values here
// intentionally match TriggerJob's local versions one-for-one; TriggerJob
// itself is left untouched in this change to avoid regressions there.
import React from 'react';
import { Btn, Card, CardHead, Spinner } from './ui';

// Every section uses the same white card with a near-white header and a
// thin divider. tone is kept for callers; only "caution" (an irreversible
// step) still changes the header, to a warm warning tint.
const TONES = {
  default: { head: 'var(--section-head-bg)', rule: null },
  caution: { head: '#FDF3E4', rule: '#F3D9AE' },
};

export function SectionHeader({ title, helper, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%' }}>
      <div style={{ minWidth: 0 }}>
        <h2 style={{ fontWeight: 600, fontSize: 'var(--fs-section-title)', lineHeight: 1.35, color: 'var(--text-primary)', margin: 0 }}>{title}</h2>
        {helper && <div style={{ fontSize: 'var(--fs-help)', color: 'var(--text-secondary)', marginTop: 2, fontWeight: 400 }}>{helper}</div>}
      </div>
      {right && <span style={{ marginLeft: 'auto', flexShrink: 0, display: 'flex', gap: 8, alignItems: 'center' }}>{right}</span>}
    </div>
  );
}

/** White card with a near-white header, bold title and a thin divider. */
// open: lets dropdowns inside float over the following sections (the card
// normally clips its contents to its rounded corners).
export function SectionCard({ tone = 1, title, helper, right, children, bodyStyle, id, open = false }) {
  const t = TONES[tone] || TONES.default;
  return (
    <Card id={id} style={t.rule ? { borderColor: t.rule } : undefined} className={`animate-fade${open ? ' rs-section-open' : ''}`}>
      <CardHead style={{ background: t.head, padding: '14px 20px' }}>
        <SectionHeader title={title} helper={helper} right={right} />
      </CardHead>
      <div style={{ padding: '16px 20px 20px', display: 'grid', gap: 14, ...bodyStyle }}>
        {children}
      </div>
    </Card>
  );
}

export function Chip({ children, tone = 'default', title }) {
  const tones = {
    default: { bg: '#E8F0FC', fg: '#2B4D86', border: '#C4D4EC' },
    amber:   { bg: '#FDF3E4', fg: '#92400E', border: '#F3D9AE' },
    gray:    { bg: '#F1F3F5', fg: '#52647A', border: '#D7E0EB' },
    red:     { bg: '#FDECEC', fg: '#B91C1C', border: '#F7B9B9' },
    green:   { bg: '#E4F8F0', fg: '#0B6E4C', border: '#A9E7CD' },
  };
  const t = tones[tone] || tones.default;
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 9px',
      borderRadius: 999, fontSize: 12, fontWeight: 600,
      background: t.bg, color: t.fg, border: `1px solid ${t.border}`,
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

export function ReviewRow({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 'var(--fs-body)' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 500, fontFamily: mono ? 'var(--font-mono)' : 'inherit', textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

/** Plain-language message box. tone: info | success | warning | danger. */
export function Callout({ tone = 'info', title, children, action }) {
  const tones = {
    info:    { bg: '#E8F0FC', border: '#C4D4EC', fg: '#223E6E' },
    success: { bg: '#E4F8F0', border: '#A9E7CD', fg: '#0B6E4C' },
    warning: { bg: '#FDF3E4', border: '#F3D9AE', fg: '#92400E' },
    danger:  { bg: '#FDECEC', border: '#F7B9B9', fg: '#9A1E1E' },
  };
  const t = tones[tone] || tones.info;
  return (
    <div role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'} style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      background: t.bg, border: `1px solid ${t.border}`, borderRadius: 8,
      padding: '10px 14px', fontSize: 'var(--fs-body)', color: t.fg, lineHeight: 1.5,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <div style={{ fontWeight: 600, marginBottom: children ? 2 : 0 }}>{title}</div>}
        {children}
      </div>
      {action && <div style={{ flexShrink: 0 }}>{action}</div>}
    </div>
  );
}

/** Small group label used above review rows (sentence case, not uppercase). */
export function Eyebrow({ children }) {
  return (
    <div style={{ fontSize: 'var(--fs-label)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
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
      <span style={{ fontSize: 12, color: error ? '#B91C1C' : '#52647A', whiteSpace: 'nowrap' }} aria-live="polite">
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
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="#2F4258" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 8a5 5 0 1 1-1.5-3.6" /><path d="M13 2.5V6h-3.5" />
    </svg>
  );
}

/** Compact stat for summary strips. */
export function SummaryTile({ label, value, sub, tone = 'default', mono }) {
  const accents = { default: '#365FA3', green: '#0F9D6D', amber: '#B45309', red: '#DC2626', gray: '#52647A' };
  return (
    <div style={{
      background: '#FFFFFF', border: '1px solid #D7E0EB', borderTop: `3px solid ${accents[tone] || accents.default}`,
      borderRadius: 10, padding: '12px 14px', minWidth: 0,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#172B4D', fontFamily: mono ? 'var(--font-mono)' : 'inherit', wordBreak: 'break-all' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#52647A', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}
