// src/components/run/TargetPicker.jsx
//
// Searchable, filterable checkbox list of the servers the caller may act
// on (GET /app-instances — already scoped to their app access). Used by
// Run Automations and EC2 Start/Stop. Selection is a convenience only: the
// backend re-checks every server when the run is submitted.
//
// props
//   instances      authorized instances
//   selected       array of instance IDs
//   onChange(ids)
//   blockReason(i) → string | null   why a row can't be selected here
//   extraColumn    { header, render(i) } optional (EC2 state)
//   showOs         show the OS column (catalog os_type / operating_system …)
//   summary        text for the selection pill (default "N selected")
//   pageSize       rows per page (selection is kept across pages, search
//                  and filters — it lives in the parent as instance IDs)
//   emptyText      shown when there are no servers at all
//   loading, error

import React, { useMemo, useState } from 'react';
import { Btn, Input, Select, Spinner } from '../ui';
import { accountNameOf, appsLabel, facetOptions, filterInstances, osOf, paginate, serverLabel, sortInstances } from '../../utils/runTargets';

const th = {
  textAlign: 'left', padding: '8px 10px', fontSize: 13, fontWeight: 600, color: '#2F4258', background: 'var(--bg-tint)', borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 1,
};
const td = { padding: '7px 8px', borderBottom: '1px solid var(--slate-100)', fontSize: 14, verticalAlign: 'middle' };
const mono = { fontFamily: 'var(--font-mono)', fontSize: 12 };

// One filter. Options come from facetOptions(): only values that still
// match the other filters, each with its server count.
function FacetSelect({ label, value, onChange, options, width = 170, allCount }) {
  return (
    <label className="rs-label" style={{ display: 'grid', gap: 4, flex: `1 1 ${width}px`, minWidth: Math.min(width, 140), maxWidth: width + 140 }}>
      {label}
      <Select value={value} onChange={(e) => onChange(e.target.value)} style={{ padding: '7px 8px', fontSize: 14 }}>
        <option value="">All ({allCount ?? options.reduce((n, o) => n + o.count, 0)})</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.count})</option>)}
      </Select>
    </label>
  );
}

const EMPTY_FILTERS = { q: '', app: '', environment: '', account: '', region: '' };

const PAGE_SIZES = [25, 50, 100];

export default function TargetPicker({
  instances, selected, onChange, blockReason, extraColumn, loading, error, hideApp = false, showOs = false, summary, pageSize = 25,
  emptyText = "You don't have access to any servers yet. Ask your RunStack administrator to grant your application in Users & Access.",
}) {
  const [f, setF] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(pageSize);
  const set = (k) => (v) => { setF((x) => ({ ...x, [k]: v })); setPage(1); };
  const sel = useMemo(() => new Set(selected), [selected]);
  const sorted = useMemo(() => sortInstances(instances), [instances]);
  const filtered = useMemo(() => filterInstances(sorted, f), [sorted, f]);
  const filtersActive = Object.values(f).some(Boolean);
  const selectable = filtered.filter((i) => !(blockReason && blockReason(i)));
  const allFilteredSelected = selectable.length > 0 && selectable.every((i) => sel.has(i.instance_id));
  const view = paginate(filtered, page, size);
  const pageSelectable = view.rows.filter((i) => !(blockReason && blockReason(i)));
  const allPageSelected = pageSelectable.length > 0 && pageSelectable.every((i) => sel.has(i.instance_id));
  const blockedCount = filtered.length - selectable.length;
  const facets = useMemo(() => ({
    app: facetOptions(instances, f, 'app'), environment: facetOptions(instances, f, 'environment'),
    account: facetOptions(instances, f, 'account'), region: facetOptions(instances, f, 'region'),
  }), [instances, f]);
  const showFacet = (k) => facets[k].length > 1 || f[k];

  const toggle = (id) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange([...next]);
  };
  const selectFiltered = () => onChange([...new Set([...selected, ...selectable.map((i) => i.instance_id)])]);
  const clearFiltered = () => {
    const drop = new Set(filtered.map((i) => i.instance_id));
    onChange(selected.filter((id) => !drop.has(id)));
  };
  const togglePage = () => {
    const ids = pageSelectable.map((i) => i.instance_id);
    if (allPageSelected) { const drop = new Set(ids); onChange(selected.filter((id) => !drop.has(id))); }
    else onChange([...new Set([...selected, ...ids])]);
  };
  const visibleIds = useMemo(() => new Set(filtered.map((i) => i.instance_id)), [filtered]);
  const hiddenSelected = selected.filter((id) => !visibleIds.has(id)).length;
  // OS column only when the catalog records an OS for at least one server.
  const osCol = showOs && (instances || []).some((i) => osOf(i));
  const cols = 6 + (extraColumn ? 1 : 0) + (osCol ? 1 : 0) - (hideApp ? 1 : 0);

  if (loading) return <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-tertiary)', fontSize: 13, padding: '6px 0' }}><Spinner size={14} /> Loading servers…</div>;
  if (error) return null;
  if (!instances?.length) {
    return <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '6px 0' }}>{emptyText}</div>;
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="rs-label" style={{ display: 'grid', gap: 4, flex: '2 1 260px', maxWidth: 480 }}>
          Search servers
          <Input type="search" value={f.q} onChange={(e) => set('q')(e.target.value)}
            placeholder={hideApp ? 'Server, instance ID or account name…' : 'Server, instance ID, application, account, OS…'} style={{ padding: '7px 10px', fontSize: 14 }} />
        </label>
        {!hideApp && showFacet('app') && <FacetSelect label="Application" value={f.app} onChange={set('app')} options={facets.app} width={240}
          allCount={filterInstances(instances, { ...f, app: '' }).length} />}
        {showFacet('environment') && <FacetSelect label="Environment" value={f.environment} onChange={set('environment')} options={facets.environment} width={140} />}
        {showFacet('account') && <FacetSelect label="Account" value={f.account} onChange={set('account')} options={facets.account} width={220} />}
        {showFacet('region') && <FacetSelect label="Region" value={f.region} onChange={set('region')} options={facets.region} width={120} />}
        {filtersActive && <Btn size="sm" variant="ghost" onClick={() => { setF(EMPTY_FILTERS); setPage(1); }}>Clear filters</Btn>}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span aria-live="polite" style={{
          fontSize: 13, fontWeight: 500, padding: '3px 10px', borderRadius: 999,
          background: selected.length ? 'var(--brand-bg)' : 'var(--slate-100)',
          color: selected.length ? 'var(--brand-hover)' : 'var(--text-tertiary)',
          border: `1px solid ${selected.length ? 'var(--brand-border)' : 'var(--border)'}`,
        }}>{summary || `${selected.length} selected`}</span>
        <span title="Selects every eligible server matching the search and filters, on every page">
          <Btn size="sm" variant="default" onClick={selectFiltered} disabled={!selectable.length || allFilteredSelected}>
            {filtersActive ? `Select all ${selectable.length} matching servers` : `Select all ${selectable.length} eligible servers`}
          </Btn>
        </span>
        <Btn size="sm" variant="ghost" onClick={clearFiltered} disabled={!filtered.some((i) => sel.has(i.instance_id))}>
          {filtersActive ? 'Deselect matching' : 'Deselect all'}
        </Btn>
        {filtersActive && selected.length > 0 && <Btn size="sm" variant="ghost" onClick={() => onChange([])}>Clear whole selection</Btn>}
        <span style={{ marginLeft: 'auto', fontSize: 13, color: 'var(--text-secondary)' }}>
          {filtered.length} of {instances.length} shown{blockedCount ? ` · ${blockedCount} not eligible` : ''}{hiddenSelected ? ` · ${hiddenSelected} selected server${hiddenSelected === 1 ? '' : 's'} hidden by search/filters (still selected)` : ''}
        </span>
      </div>

      <div className="rs-table-scroll">
        <table style={{ width: '100%', minWidth: osCol ? 700 : 620, borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 36 }}>
                <input type="checkbox" aria-label="Select eligible servers on this page" title="Select eligible servers on this page only" checked={allPageSelected}
                  disabled={!pageSelectable.length} onChange={togglePage} />
              </th>
              <th style={th}>Server</th>
              {extraColumn && <th style={th}>{extraColumn.header}</th>}
              {!hideApp && <th style={th}>Application</th>}
              <th style={th}>Environment</th><th style={th}>Account</th><th style={th}>Region</th>
              {osCol && <th style={th}>OS</th>}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((i) => {
              const reason = blockReason ? blockReason(i) : null;
              const checked = sel.has(i.instance_id);
              return (
                <tr key={i.instance_id} onClick={() => !reason && toggle(i.instance_id)} className={checked ? 'is-selected' : undefined}
                  style={{ cursor: reason ? 'not-allowed' : 'pointer', color: reason ? 'var(--text-tertiary)' : undefined }}>
                  <td style={td}>
                    <input type="checkbox" checked={checked} disabled={!!reason} onClick={(e) => e.stopPropagation()}
                      onChange={() => toggle(i.instance_id)} aria-label={`Select ${serverLabel(i)}`}
                      aria-describedby={reason ? `why-${i.instance_id}` : undefined} style={{ accentColor: 'var(--brand)' }} />
                  </td>
                  <td style={{ ...td, maxWidth: 320 }}>
                    <div style={{ fontWeight: 600, color: reason ? 'var(--text-secondary)' : 'var(--text-primary)', overflowWrap: 'anywhere' }}>{serverLabel(i)}</div>
                    <div style={{ ...mono, fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{i.instance_id}</div>
                    {reason && <div id={`why-${i.instance_id}`} style={{ fontSize: 13, color: '#92400E', marginTop: 1 }}>Not eligible: {reason}</div>}
                  </td>
                  {extraColumn && <td style={td}>{extraColumn.render(i)}</td>}
                  {!hideApp && <td style={{ ...td, color: 'var(--text-secondary)', maxWidth: 280, overflowWrap: 'anywhere' }}>{appsLabel(i)}</td>}
                  <td style={{ ...td, color: 'var(--text-secondary)' }}>{i.environment || '—'}</td>
                  <td style={{ ...td, color: 'var(--text-secondary)' }}>
                    {accountNameOf(i) && <div style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{accountNameOf(i)}</div>}
                    <div style={{ ...mono, whiteSpace: 'nowrap' }}>{i.account_id || '—'}</div>
                  </td>
                  <td style={{ ...td, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{i.region || '—'}</td>
                  {osCol && <td style={{ ...td, color: 'var(--text-secondary)' }}>{osOf(i) || 'Not recorded'}</td>}
                </tr>
              );
            })}
            {!filtered.length && (
              <tr><td colSpan={cols} style={{ ...td, textAlign: 'center', color: 'var(--text-tertiary)', padding: 24 }}>
                No servers match these filters.{' '}
                <button type="button" onClick={() => { setF(EMPTY_FILTERS); setPage(1); }} style={{ background: 'none', border: 'none', color: 'var(--brand-hover)', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13 }}>
                  Clear filters
                </button>
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > PAGE_SIZES[0] && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'flex-end', fontSize: 13, color: 'var(--text-tertiary)' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            Rows
            <Select value={size} onChange={(e) => { setSize(Number(e.target.value)); setPage(1); }} style={{ padding: '3px 6px', fontSize: 13 }} aria-label="Rows per page">
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </Select>
          </label>
          <span>{(view.page - 1) * size + 1}–{Math.min(view.page * size, view.total)} of {view.total}</span>
          <Btn size="sm" variant="ghost" onClick={() => setPage(view.page - 1)} disabled={view.page <= 1}>‹ Prev</Btn>
          <span>Page {view.page} of {view.pages}</span>
          <Btn size="sm" variant="ghost" onClick={() => setPage(view.page + 1)} disabled={view.page >= view.pages}>Next ›</Btn>
        </div>
      )}
    </div>
  );
}
