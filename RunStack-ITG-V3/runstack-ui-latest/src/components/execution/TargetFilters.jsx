// src/components/execution/TargetFilters.jsx
//
// Toolbar above the target table. Search and status filtering run on the
// backend across every target in the execution (server name, instance ID,
// account, region, job ID), not just the rows on screen. Each chip maps to
// a status the backend filters on exactly, so its count matches the rows.

import React, { useEffect, useRef, useState } from 'react';
import { Btn, Input, Select, Spinner } from '../ui';
import { statusFilters } from '../../utils/executionStatus';

export const PAGE_SIZES = [25, 50, 100];
const SEARCH_DEBOUNCE_MS = 350;

export default function TargetFilters({
  counts, status, onStatus, search, onSearch, pageSize, onPageSize, onExport, exporting, exportDisabled, exportNote,
}) {
  const [text, setText] = useState(search || '');
  const timer = useRef(null);
  useEffect(() => { setText(search || ''); }, [search]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onType = (v) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onSearch(v.trim()), SEARCH_DEBOUNCE_MS);
  };

  const chips = statusFilters(counts, status);
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 380 }}>
          <Input type="search" value={text} onChange={(e) => onType(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { clearTimeout(timer.current); onSearch(text.trim()); } }}
            placeholder="Search server, instance ID, account or region…" aria-label="Search servers"
            style={{ width: '100%', padding: '7px 12px', fontSize: 13 }} />
        </div>
        <div role="group" aria-label="Filter by status" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {chips.map((c) => {
            const active = (status || '') === c.value;
            return (
              <button key={c.value || 'all'} type="button" aria-pressed={active}
                onClick={() => onStatus(active && c.value ? '' : c.value)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999, cursor: 'pointer',
                  fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
                  color: active ? 'var(--brand-hover)' : 'var(--text-secondary)',
                  background: active ? 'var(--brand-bg)' : 'var(--bg-surface)',
                  border: `1px solid ${active ? 'var(--brand)' : 'var(--border)'}`,
                }}>
                {c.meta && <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.meta.dot }} />}
                {c.label}
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)', fontWeight: 500 }}>{c.count.toLocaleString()}</span>
              </button>
            );
          })}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12, color: 'var(--text-tertiary)', display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
            Rows
            <Select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label="Rows per page" style={{ width: 76, padding: '5px 8px', fontSize: 13 }}>
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </label>
          <Btn size="sm" variant="default" onClick={onExport} disabled={exporting || exportDisabled}
            title={exportNote || 'Download the servers matching this search and filter as CSV (status and timing only, no output)'}>
            {exporting ? <><Spinner size={12} /> {exporting}</> : '⤓ Export'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
