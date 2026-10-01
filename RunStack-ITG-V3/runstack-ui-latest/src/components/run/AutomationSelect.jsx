// src/components/run/AutomationSelect.jsx
//
// "Choose automation": a searchable dropdown of the approved automations
// only (GET /ssm/documents?approved=true). Each option shows the configured
// friendly name (display_name from APPROVED_AUTOMATION_DOCUMENTS) with the
// technical SSM document name as secondary text. Description, supported OS
// and regions come straight from the document as the backend reports them —
// nothing is invented; a missing value is simply not shown.
// Unavailable documents are listed but can't be chosen, with the reason.
//
// props
//   documents   approved documents (describe_approved_document shape)
//   value       selected document name
//   onChange(name)

import React from 'react';
import SearchSelect from './SearchSelect';

const TYPE_LABEL = { 'SSM-RunCommand': 'Run Command', 'SSM-Automation': 'Automation' };
export const docTitle = (d) => d?.display_name || d?.name || '';
/** Technical name, only when it differs from what's shown as the title. */
export const docTechName = (d) => (d && d.display_name && d.display_name !== d.name ? d.name : null);
export const docOsList = (d) => (d?.platform_types?.length ? d.platform_types : []);

export function DocBadges({ doc }) {
  const os = docOsList(doc);
  const regions = doc?.regions_available || [];
  if (!os.length && !regions.length && !TYPE_LABEL[doc?.automation_type]) return null;
  return (
    <span style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
      {os.map((o) => <span key={o} className="rs-badge rs-badge--brand" title="Supported OS">{o}</span>)}
      {regions.map((r) => <span key={r} className="rs-badge" title="Available region">{r}</span>)}
      {TYPE_LABEL[doc?.automation_type] && <span className="rs-badge rs-badge--muted">{TYPE_LABEL[doc.automation_type]}</span>}
    </span>
  );
}

export default function AutomationSelect({ documents, value, onChange }) {
  const options = documents.map((d) => ({
    value: d.name, disabled: !d.available, doc: d,
    search: [d.display_name, d.name, d.description, ...(d.platform_types || [])].filter(Boolean).join(' '),
  }));
  const selected = documents.find((d) => d.name === value) || null;
  return (
    <div style={{ display: 'grid', gap: 10, maxWidth: 820 }}>
      <SearchSelect id="rs-automation" label="Automation" options={options} value={value} onChange={onChange}
        display={(o) => docTitle(o.doc)}
        placeholder={`Search ${documents.length} approved automation${documents.length === 1 ? '' : 's'}…`}
        emptyText="No approved automations match your search."
        renderOption={(o) => {
          const d = o.doc;
          return (
            <>
              <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>{docTitle(d)}</span>
                {docTechName(d) && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-secondary)' }}>{d.name}</span>}
                {!d.available && <span className="rs-badge rs-badge--muted">Unavailable</span>}
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {d.available ? (d.description || 'No description in the document.') : d.reason}
              </span>
              {d.available && <DocBadges doc={d} />}
            </>
          );
        }} />

      {selected && (
        <div style={{ display: 'grid', gap: 6, padding: '9px 12px', borderRadius: 'var(--radius-md)', background: 'var(--bg-tint)', border: '1px solid var(--border)' }}>
          {docTechName(selected) && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Document <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{selected.name}</span>
            </div>
          )}
          <div style={{ fontSize: 14, color: 'var(--text-primary)', lineHeight: 1.5 }}>{selected.description || 'No description in the document.'}</div>
          <DocBadges doc={selected} />
        </div>
      )}
    </div>
  );
}
