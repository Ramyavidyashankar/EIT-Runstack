// src/components/filters.jsx — the filter toolbar pieces every list page uses,
// so search boxes, dropdowns, "More filters" and chips look and behave the
// same everywhere (Executions, Triggers & Schedules, SSM Documents).
//
//   Primary filters    always visible in the toolbar (FilterBar)
//   Secondary filters  inside "+ More filters" (MoreFilters)
//   Active filters     removable chips, only when something is set (FilterChips)

import React, { useEffect, useId, useRef, useState } from 'react';
import { Btn } from './ui';

export function FilterBar({ children, className = '' }) {
  return <div className={`rs-filterbar ${className}`}>{children}</div>;
}

/** Small (i) button; the text shows on hover and keyboard focus. */
export function InfoTip({ children, label = 'More information', align = 'left' }) {
  const id = `rs-tip-${useId().replace(/:/g, '')}`;
  return (
    <span className={`rs-infotip rs-infotip--${align}`}>
      <button type="button" className="rs-infotip-btn" aria-label={label} aria-describedby={id}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 7.2v4M8 4.9v.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      <span role="tooltip" id={id} className="rs-infotip-pop">{children}</span>
    </span>
  );
}

/** Search box with an icon and an optional (i) explaining what it matches. */
export function SearchInput({ value, onChange, placeholder, label = 'Search', help, className = '' }) {
  return (
    <div className={`rs-search ${className}`}>
      <svg className="rs-search-icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden>
        <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10.4 10.4l3.1 3.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <input type="search" className="rs-search-input" value={value} onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder} aria-label={label} />
      {help && <InfoTip label="What search matches">{help}</InfoTip>}
    </div>
  );
}

/** Compact dropdown; highlighted when it narrows the list (set). */
export function FilterSelect({ value, onChange, label, set = false, children, className = '', style }) {
  return (
    <select className={`rs-filter-select${set ? ' is-set' : ''} ${className}`} aria-label={label} value={value}
      onChange={(e) => onChange(e.target.value)} style={style}>
      {children}
    </select>
  );
}

/** A labelled control inside the More filters panel. */
export function FilterField({ label, children }) {
  return <label className="rs-field-label rs-filter-field">{label}{children}</label>;
}

/**
 * "+ More filters" button with a panel of secondary filters.
 *   activeCount   how many secondary filters are set (shown on the button)
 *   onClearAll    resets the secondary filters
 */
export function MoreFilters({ activeCount = 0, onClearAll, children, title = 'Additional filters' }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const btn = useRef(null);
  const id = `rs-more-${useId().replace(/:/g, '')}`;
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div className="rs-more" ref={wrap}>
      <button ref={btn} type="button" className={`rs-more-btn${activeCount ? ' is-set' : ''}`} aria-expanded={open} aria-controls={id}
        onClick={() => setOpen((v) => !v)}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        More filters{activeCount > 0 && <span className="rs-more-count">{activeCount}</span>}
      </button>
      {open && (
        <div id={id} className="rs-popover rs-more-pop" role="dialog" aria-label={title}>
          <div className="rs-popover-title">{title}</div>
          <div className="rs-more-fields">{children}</div>
          <div className="rs-popover-foot">
            <Btn variant="ghost" size="sm" onClick={() => onClearAll?.()} disabled={!activeCount}>Clear all</Btn>
            <Btn variant="primary" size="sm" onClick={() => { setOpen(false); btn.current?.focus(); }}>Done</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

/** Removable chips for the filters that are set; nothing when none are. */
export function FilterChips({ chips, onClearAll }) {
  const list = (chips || []).filter(Boolean);
  if (!list.length) return null;
  return (
    <div className="rs-chips" role="group" aria-label="Active filters">
      {list.map((c) => (
        <span key={c.key} className="rs-chip">
          <span className="rs-chip-text"><span className="rs-chip-name">{c.label}:</span> {c.value}</span>
          <button type="button" className="rs-chip-x" onClick={c.onRemove} aria-label={`Remove filter ${c.label}: ${c.value}`}>×</button>
        </span>
      ))}
      {onClearAll && list.length > 1 && <button type="button" className="rs-chips-clear" onClick={onClearAll}>Clear all</button>}
    </div>
  );
}
