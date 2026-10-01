// src/components/run/AppMultiSelect.jsx
//
// "Choose applications": searchable multi-select over the applications in
// the server list the page loaded (app access, or the team scope for a
// team-capability automation). Chosen applications show as removable chips
// with a selected count. Choosing an application only narrows which servers
// are listed — the backend re-checks every server on submit.
//
// props
//   apps       appSummaries() output: [{ app_id, label, count, environments }]
//   value      selected app IDs
//   onChange(ids)

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Btn } from '../ui';

const ID = 'rs-apps';

export default function AppMultiSelect({ apps, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef(null);
  const list = useRef(null);
  const input = useRef(null);
  const chosen = useMemo(() => new Set(value), [value]);
  const byId = useMemo(() => new Map(apps.map((a) => [a.app_id, a])), [apps]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return apps.filter((a) => !n || `${a.label} ${a.app_id} ${a.environments.join(' ')}`.toLowerCase().includes(n));
  }, [apps, q]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const toggle = (id) => onChange(chosen.has(id) ? value.filter((v) => v !== id) : [...value, id]);
  const move = (d) => setActive((a) => Math.max(0, Math.min(shown.length - 1, a + d)));
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (open && shown[active]) toggle(shown[active].app_id); else setOpen(true); }
    else if (e.key === 'Escape' || e.key === 'Tab') setOpen(false);
    else if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
  };

  return (
    <div ref={box} style={{ display: 'grid', gap: 8 }}>
      <label htmlFor={ID} className="rs-label">Applications</label>
      <div className="rs-combo">
        <div className="rs-combo-box" onClick={() => { setOpen(true); input.current?.focus(); }}>
          {value.map((id) => {
            const a = byId.get(id);
            const label = a ? a.label : id;
            return (
              <span key={id} title={label} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 3px 2px 10px', borderRadius: 999, maxWidth: '100%', minWidth: 0,
                background: 'var(--brand-bg)', border: '1px solid var(--brand-border)', color: 'var(--brand-hover)', fontSize: 13, fontWeight: 500,
              }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{label}</span>
                <button type="button" aria-label={`Remove ${label}`} onClick={(e) => { e.stopPropagation(); toggle(id); }}
                  style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 5px', borderRadius: 999 }}>
                  ×
                </button>
              </span>
            );
          })}
          <input id={ID} ref={input} role="combobox" aria-expanded={open} aria-controls={`${ID}-list`} aria-autocomplete="list"
            aria-activedescendant={open && shown[active] ? `${ID}-opt-${active}` : undefined}
            value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey} autoComplete="off"
            placeholder={value.length ? 'Add another application…' : `Search ${apps.length} application${apps.length === 1 ? '' : 's'}…`}
            style={{ flex: '1 1 160px', minWidth: 120, border: 'none', outline: 'none', fontSize: 14, padding: '4px 2px', background: 'transparent', color: 'var(--text-primary)' }} />
        </div>
        {open && (
          <div id={`${ID}-list`} ref={list} role="listbox" aria-multiselectable="true" aria-label="Applications" className="rs-combo-list">
            {shown.map((a, n) => {
              const on = chosen.has(a.app_id);
              return (
                <div key={a.app_id} id={`${ID}-opt-${n}`} data-index={n} role="option" aria-selected={on}
                  className={`rs-option${n === active ? ' is-active' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); toggle(a.app_id); }} onMouseEnter={() => setActive(n)}
                  style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <input type="checkbox" readOnly checked={on} tabIndex={-1} aria-hidden style={{ pointerEvents: 'none', accentColor: 'var(--brand)' }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 14, fontWeight: 500, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{a.label}</span>
                    <span style={{ display: 'block', fontSize: 13, color: 'var(--text-secondary)' }}>{a.environments.join(', ') || 'No environment recorded'}</span>
                  </span>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{a.count} server{a.count === 1 ? '' : 's'}</span>
                </div>
              );
            })}
            {!shown.length && <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>No applications match your search.</div>}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-secondary)', minHeight: 26 }} aria-live="polite">
        {value.length ? `${value.length} of ${apps.length} application${apps.length === 1 ? '' : 's'} selected` : 'No applications selected yet.'}
        {value.length > 0 && <Btn size="sm" variant="ghost" onClick={() => onChange([])}>Clear all</Btn>}
      </div>
    </div>
  );
}
