// src/components/run/AppPicker.jsx
//
// Searchable list of the applications in the caller's access, with server
// counts and environments. Used where work is scoped to one application at
// a time (EC2 Start/Stop), matching RunStack's app-access model.

import React, { useMemo, useState } from 'react';
import { Input } from '../ui';
import { appSummaries } from '../../utils/runTargets';

export default function AppPicker({ instances, value, onChange }) {
  const [q, setQ] = useState('');
  const apps = useMemo(() => appSummaries(instances), [instances]);
  const shown = apps.filter((a) => !q.trim() || `${a.label} ${a.app_id}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${apps.length} application${apps.length === 1 ? '' : 's'}…`}
        aria-label="Search applications" style={{ padding: '6px 10px', fontSize: 12.5, maxWidth: 420 }} />
      <div role="listbox" aria-label="Applications" style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface)' }}>
        {shown.map((a) => {
          const active = a.app_id === value;
          return (
            <button key={a.app_id} type="button" role="option" aria-selected={active} onClick={() => onChange(a.app_id)}
              style={{
                display: 'flex', width: '100%', gap: 12, alignItems: 'center', textAlign: 'left', padding: '8px 12px',
                border: 'none', borderBottom: '1px solid var(--slate-100)', cursor: 'pointer', fontFamily: 'inherit',
                background: active ? 'var(--brand-bg)' : 'transparent',
              }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: active ? 'var(--brand-hover)' : 'var(--text-primary)' }}>{a.label}</span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)' }}>{a.environments.join(', ') || 'No environment recorded'}</span>
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{a.count} server{a.count === 1 ? '' : 's'}</span>
            </button>
          );
        })}
        {!shown.length && <div style={{ padding: 16, fontSize: 12.5, color: 'var(--text-tertiary)' }}>No applications match.</div>}
      </div>
    </div>
  );
}
