// src/components/execution/ServerList.jsx
//
// Left pane of Execution Details: searchable, filterable, paged list of the
// execution's targets (servers). Rows are virtualised with react-window
// (already a RunStack UI dependency) so a page of 100+ servers stays light.
// Search and the status filter run on the backend across ALL targets in the
// execution, not just the rows on screen.

import React, { useEffect, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';
import { Btn, Input, Spinner } from '../ui';
import { TARGET_STATUS, fmtElapsed, targetElapsed } from '../../utils/executionLogs';

const ROW_H = 66;

const FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'active', label: 'Pending or running' },
  { value: 'running', label: 'Running' },
  { value: 'pending', label: 'Pending' },
  { value: 'unsuccessful', label: 'Did not succeed' },
  { value: 'failed', label: 'Failed' },
  { value: 'timed_out', label: 'Timed out' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'success', label: 'Succeeded' },
];

export function TargetStatusChip({ status, detail }) {
  const m = TARGET_STATUS[status] || TARGET_STATUS.pending;
  return (
    <span title={detail && detail !== m.label ? detail : undefined} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '1px 8px', borderRadius: 999,
      background: m.bg, color: m.color, fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap',
      border: `1px solid ${m.dot}40`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.dot, animation: m.pulse ? 'pulse 1.6s ease infinite' : 'none' }} />
      {m.label}
    </span>
  );
}

function useHeight(ref) {
  const [h, setH] = useState(400);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setH(Math.max(120, Math.floor(entry.contentRect.height))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

function Row({ index, style, data }) {
  const { targets, selectedKey, onSelect, now } = data;
  const t = targets[index];
  const selected = t.key === selectedKey;
  const m = TARGET_STATUS[t.status] || TARGET_STATUS.pending;
  return (
    <div style={style}>
      <button type="button" onClick={() => onSelect(t.key)} aria-current={selected ? 'true' : undefined}
        style={{
          width: '100%', height: ROW_H - 4, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
          display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 8px', alignContent: 'center',
          padding: '6px 10px 6px 11px', borderRadius: 8, marginTop: 2,
          border: `1px solid ${selected ? 'var(--brand-border)' : 'transparent'}`,
          borderLeft: `3px solid ${m.dot}`,
          background: selected ? 'var(--brand-bg)' : 'transparent',
        }}
        onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = '#F8FAFC'; }}
        onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent'; }}>
        <span style={{ fontWeight: 600, fontSize: 12.5, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={t.instance_id || ''}>
          {t.server_name || t.instance_id || 'Target'}
        </span>
        <span style={{ justifySelf: 'end' }}><TargetStatusChip status={t.status} detail={t.status_detail} /></span>
        <span style={{ fontSize: 11, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{t.account_id || '—'}</span> · {t.region || '—'}
          {t.current_step ? <> · <span title="Current step">{t.current_step}</span></> : null}
        </span>
        <span style={{ fontSize: 11, color: '#475569', fontFamily: 'var(--font-mono)', justifySelf: 'end' }}>
          {t.retrieval_error && (t.status === 'running' || t.status === 'pending') ? <span title={`Live status unavailable (${t.retrieval_error.kind}); showing RunStack's record`} style={{ color: '#B45309', marginRight: 4 }}>⚠</span> : null}
          {fmtElapsed(targetElapsed(t, now))}
        </span>
      </button>
    </div>
  );
}

/**
 * @param {{ targets, total, offset, limit, loading, selectedKey, onSelect,
 *           search, onSearch, status, onStatus, onPrev, onNext, hasPrev, hasNext, hiddenJobs, now }} props
 */
export default function ServerList(props) {
  const { targets = [], total = 0, offset = 0, loading, selectedKey, onSelect, search, onSearch,
    status, onStatus, onPrev, onNext, hasPrev, hasNext, hiddenJobs, now } = props;
  const listBox = useRef(null);
  const height = useHeight(listBox);
  const listRef = useRef(null);
  const [text, setText] = useState(search || '');

  useEffect(() => { setText(search || ''); }, [search]);
  useEffect(() => {
    if (text === (search || '')) return undefined;
    const id = setTimeout(() => onSearch(text.trim()), 300);
    return () => clearTimeout(id);
  }, [text]); // eslint-disable-line

  // Keep the selected row in view when the page changes under it.
  useEffect(() => {
    const idx = targets.findIndex((t) => t.key === selectedKey);
    if (idx >= 0) listRef.current?.scrollToItem(idx, 'smart');
  }, [selectedKey, offset]); // eslint-disable-line

  const from = total ? offset + 1 : 0;
  const to = offset + targets.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ padding: 10, display: 'grid', gap: 8, borderBottom: '1px solid #E2E8F0' }}>
        <Input type="search" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search servers"
          placeholder="Search server, instance, account, region…" style={{ fontSize: 12.5, padding: '7px 10px' }} />
        <select className="rs-input" value={status || ''} onChange={(e) => onStatus(e.target.value)} aria-label="Filter by status"
          style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid #CBD5E1', fontSize: 12.5, fontFamily: 'inherit', background: '#FFFFFF', color: '#0F172A' }}>
          {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>
      <div ref={listBox} style={{ flex: 1, minHeight: 0, padding: '2px 6px', position: 'relative' }}>
        {targets.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#64748B', fontSize: 12.5 }}>
            {loading ? <Spinner /> : (search || status ? 'No servers match.' : 'No servers to show.')}
          </div>
        ) : (
          <FixedSizeList ref={listRef} height={height - 4} width="100%" itemCount={targets.length} itemSize={ROW_H}
            itemData={{ targets, selectedKey, onSelect, now }} itemKey={(i, d) => d.targets[i].key}>
            {Row}
          </FixedSizeList>
        )}
      </div>
      <div style={{ padding: '8px 10px', borderTop: '1px solid #E2E8F0', background: '#F8FAFC', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#475569' }}>
        <span aria-live="polite">{total ? `${from}–${to} of ${total}` : '0 servers'}</span>
        {hiddenJobs > 0 && (
          <span title="Servers in this run that you don't have access to are not shown" style={{ color: '#94A3B8' }}>
            · {hiddenJobs} hidden
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <Btn size="sm" variant="default" onClick={onPrev} disabled={!hasPrev || loading}>‹</Btn>
          <Btn size="sm" variant="default" onClick={onNext} disabled={!hasNext || loading}>›</Btn>
        </span>
      </div>
    </div>
  );
}
