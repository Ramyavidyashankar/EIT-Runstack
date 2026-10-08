// src/components/DateRangeSelect.jsx — one time-range control for the
// Dashboard and the Executions page.
//
//   [ Last 7 days ▾ ]                      presets (utils/dateRange.js)
//   [ 01 Sep – 30 Sep 2026 ▾ ] [Change]    after a custom range is applied
//
// Choosing "Custom range…" opens a small panel with From / To dates (UTC
// calendar days, both included — the same days the job counters use). The
// range only changes on Apply; Cancel or Esc leaves it as it was.
//
//   value     { range, from_day, to_day } (+ from / to for older links)
//   onChange  ({ range, from_day, to_day }) => void
//   defaultRange  the page's default (not highlighted as a narrowing filter)

import React, { useEffect, useId, useRef, useState } from 'react';
import { Btn, Input } from './ui';
import { RANGE_PRESETS, addDays, customLabel, customRangeError, rangeText, utcDay } from '../utils/dateRange';

export default function DateRangeSelect({ value, onChange, presets = RANGE_PRESETS, label = 'Time range', defaultRange = '7d', className = '' }) {
  const id = useId().replace(/:/g, '');
  const range = value?.range || '7d';
  const isCustom = range === 'custom';
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ from_day: '', to_day: '' });
  const wrap = useRef(null);

  const openPicker = () => {
    const today = utcDay();
    const ok = isCustom && !customRangeError(value.from_day, value.to_day);
    setDraft(ok ? { from_day: value.from_day, to_day: value.to_day } : { from_day: addDays(today, -29), to_day: today });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); wrap.current?.querySelector('select')?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const today = utcDay();
  const err = customRangeError(draft.from_day, draft.to_day, today);
  const apply = (e) => {
    e.preventDefault();
    if (err) return;
    setOpen(false);
    onChange({ range: 'custom', from_day: draft.from_day, to_day: draft.to_day });
  };
  const customText = isCustom ? rangeText(value).replace(/ \(UTC\)$/, '') : null;

  return (
    <div className={`rs-daterange ${className}`} ref={wrap}>
      <select id={`rs-dr-${id}`} className={`rs-filter-select${range !== defaultRange ? ' is-set' : ''}`} aria-label={label}
        value={open ? 'custom' : range}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'custom') { openPicker(); return; }
          setOpen(false);
          onChange({ range: v, from_day: '', to_day: '' });
        }}>
        {presets.map((p) => (
          <option key={p.value} value={p.value}>{p.value === 'custom' && customText ? customText : p.label}</option>
        ))}
      </select>
      {isCustom && !open && (
        <button type="button" className="rs-filter-iconbtn" onClick={openPicker} aria-label={`Change dates (${rangeText(value)})`} title="Change dates">
          <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden><path d="M2.5 4h11v9.5h-11zM2.5 7h11M5.5 2.5v3M10.5 2.5v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}
      {open && (
        <form className="rs-popover rs-daterange-pop" role="dialog" aria-label="Custom date range" onSubmit={apply}>
          <div className="rs-popover-title">Custom range <span className="rs-popover-note">UTC days, both included</span></div>
          <div className="rs-daterange-fields">
            <label className="rs-field-label">From
              <Input type="date" value={draft.from_day} max={today} required autoFocus
                onChange={(e) => setDraft((d) => ({ ...d, from_day: e.target.value }))} />
            </label>
            <label className="rs-field-label">To
              <Input type="date" value={draft.to_day} min={draft.from_day || undefined} max={today} required
                onChange={(e) => setDraft((d) => ({ ...d, to_day: e.target.value }))} />
            </label>
          </div>
          {err && draft.from_day && draft.to_day && <div className="rs-daterange-err" role="alert">{err}</div>}
          {!err && <div className="rs-popover-note">{customLabel(draft.from_day, draft.to_day)}</div>}
          <div className="rs-popover-foot">
            <Btn variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Btn>
            <Btn type="submit" variant="primary" size="sm" disabled={!!err}>Apply</Btn>
          </div>
        </form>
      )}
    </div>
  );
}
