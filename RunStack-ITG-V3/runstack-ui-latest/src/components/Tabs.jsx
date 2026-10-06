// src/components/Tabs.jsx — the one tab strip used across RunStack.
//
//   <Tabs label="Users & Access sections" active={tab} onChange={setTab}
//         tabs={[{ value: 'users', label: 'Users', count: 12 }, …]} size="md|sm" />
//
// Active tab: pale-blue fill, bold blue text and an underline (index.css
// .rs-tab). Keyboard: ←/→ move between tabs and select, Home/End jump.
// Each tab gets id `${idPrefix}-tab-${value}`; give the panel
// aria-labelledby with tabPanelProps(idPrefix, value) if you want the full
// tab/tabpanel relationship (and pass withPanels).

import React from 'react';

export function tabPanelProps(idPrefix, value) {
  return { role: 'tabpanel', id: `${idPrefix}-panel-${value}`, 'aria-labelledby': `${idPrefix}-tab-${value}` };
}

export default function Tabs({ tabs, active, onChange, label, idPrefix = 'rs', size = 'md', className = '', after, withPanels = false }) {
  const ref = React.useRef(null);
  const onKey = (e) => {
    const keys = { ArrowRight: 1, ArrowLeft: -1, Home: 'first', End: 'last' };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const enabled = tabs.filter((t) => !t.disabled);
    const i = enabled.findIndex((t) => t.value === active);
    const k = keys[e.key];
    const next = k === 'first' ? enabled[0] : k === 'last' ? enabled[enabled.length - 1]
      : enabled[(i + k + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    ref.current?.querySelector(`[data-value="${CSS.escape(String(next.value))}"]`)?.focus();
  };
  return (
    <div ref={ref} role="tablist" aria-label={label} className={`rs-tabs rs-tabs--${size} ${className}`} onKeyDown={onKey}>
      {tabs.map((t) => {
        const on = t.value === active;
        return (
          <button key={t.value} type="button" role="tab" id={`${idPrefix}-tab-${t.value}`} data-value={t.value}
            aria-selected={on} aria-controls={withPanels && on ? `${idPrefix}-panel-${t.value}` : undefined} tabIndex={on ? 0 : -1}
            disabled={t.disabled} title={t.hint} className="rs-tab" onClick={() => onChange(t.value)}>
            {t.label}
            {t.count != null && <span className="rs-tab-count">{typeof t.count === 'number' ? t.count.toLocaleString('en-GB') : t.count}</span>}
          </button>
        );
      })}
      {after && <span className="rs-tabs-after">{after}</span>}
    </div>
  );
}
