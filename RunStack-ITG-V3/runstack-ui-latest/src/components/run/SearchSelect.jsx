// src/components/run/SearchSelect.jsx
//
// Single-choice searchable dropdown (combobox + floating listbox). Used for
// "Choose automation" and the EC2 "Choose application" selector.
//
// props
//   id             base id (listbox / options)
//   label          visible label (optional; aria-label used otherwise)
//   options        [{ value, disabled?, search: 'text matched by the search box' }]
//   value          selected value
//   onChange(value)
//   display(opt)   text shown in the input when an option is selected
//   renderOption(opt, { selected }) → node
//   placeholder, emptyText

import React, { useEffect, useMemo, useRef, useState } from 'react';

export default function SearchSelect({ id, label, ariaLabel, options, value, onChange, display, renderOption, placeholder, emptyText = 'No matches.' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef(null);
  const list = useRef(null);
  const selected = options.find((o) => o.value === value) || null;
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return options.filter((o) => !n || String(o.search || '').toLowerCase().includes(n));
  }, [options, q]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) { setOpen(false); setQ(''); } };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const i = shown.findIndex((o) => o.value === value);
    setActive(i >= 0 && !q ? i : 0);
  }, [open, q]); // eslint-disable-line
  useEffect(() => {
    if (!open || !list.current) return;
    list.current.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (o) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false); setQ('');
  };
  const move = (d) => setActive((a) => Math.max(0, Math.min(shown.length - 1, a + d)));
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home' && open) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && open) { e.preventDefault(); setActive(shown.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (open) pick(shown[active]); else setOpen(true); }
    else if (e.key === 'Escape') { setOpen(false); setQ(''); }
    else if (e.key === 'Tab') { setOpen(false); setQ(''); }
  };

  const listId = `${id}-list`;
  const input = (
    <span className="rs-combo">
      <input id={id} className="rs-combo-input" role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-label={label ? undefined : ariaLabel}
        aria-activedescendant={open && shown[active] ? `${id}-opt-${active}` : undefined}
        value={open ? q : (selected ? display(selected) : '')} placeholder={selected && open ? display(selected) : placeholder}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={onKey} autoComplete="off"
        style={{ fontWeight: selected && !open ? 600 : 400 }} />
      <span className="rs-combo-caret" aria-hidden>▼</span>
      {open && (
        <div id={listId} ref={list} role="listbox" aria-label={label || ariaLabel} className="rs-combo-list">
          {shown.map((o, n) => (
            <div key={o.value} id={`${id}-opt-${n}`} data-index={n} role="option" aria-selected={o.value === value} aria-disabled={!!o.disabled}
              className={`rs-option${n === active ? ' is-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); pick(o); }} onMouseEnter={() => setActive(n)}>
              {renderOption(o, { selected: o.value === value })}
            </div>
          ))}
          {!shown.length && <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>{emptyText}</div>}
        </div>
      )}
    </span>
  );

  return (
    <div ref={box} style={{ width: '100%' }}>
      {label ? (
        <label htmlFor={id} className="rs-label" style={{ display: 'block', marginBottom: 6 }}>{label}</label>
      ) : null}
      {input}
    </div>
  );
}
