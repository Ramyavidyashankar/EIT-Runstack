// src/components/run/AutomationHub.jsx — Run Automations: Category → Automation.
//
// Shown at the top of every Run Automations page (/automations, /ec2,
// /database/sql-health-check, /database/dr-switchover — see App.jsx <RunHub>),
// above that automation's existing form:
//
//   Category ▾   Automation ▾ (searchable)
//   <selected automation: name, description>
//   <existing configuration form, review & run>
//
// The Automation dropdown is the only way to pick an automation. It lists
// only the automations in the chosen category that the user is authorized
// to run (utils/automationCatalog.js buildEntries). Choosing navigates, so
// the form below always starts fresh:
//   category      → /automations?category=<id>   (automation + form cleared)
//   page entry    → its own route (EC2, SQL Health Check, SQL DR Switchover)
//   document      → /automations?category=<id>&doc=<name>
// Navigation goes through the shell (useAppNavigate), so a page with unsaved
// work (e.g. a DR readiness approval) still asks before leaving.
//
// Data: GET /ssm/documents?approved=true and GET /app-instances, shared with
// RunAutomations through utils/automationCatalog.js. Listing an automation
// never authorizes it — the backend checks every run.

import React, { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useAppNavigate } from '../nav/navigationContext';
import { usePageRefresh } from '../../hooks/usePageRefresh';
import SearchSelect from './SearchSelect';
import { DocBadges } from './AutomationSelect';
import {
  CATEGORIES, buildEntries, categoryById, categoryForLocation, entryForLocation, loadApprovedAutomations, loadAppAccess,
} from '../../utils/automationCatalog';

const errText = (e) => e?.body?.message || e?.message || String(e);

export function useAutomationEntries() {
  const { role, groups, email } = useAuth();
  const [docs, setDocs] = useState({ loading: true, error: null, documents: null });
  const [apps, setApps] = useState({ loading: true, hasAccess: false });

  const load = useCallback((force = false) => {
    setDocs((d) => ({ ...d, loading: true, error: null }));
    loadApprovedAutomations(email, { force })
      .then((r) => setDocs({ loading: false, error: null, documents: r.documents }))
      .catch((e) => setDocs((d) => ({ loading: false, error: errText(e), documents: d.documents })));
    if (role === 'admin') { setApps({ loading: false, hasAccess: true }); return; }
    // A 403 ("no applications") simply means no application access.
    loadAppAccess(email, { force })
      .then((r) => setApps({ loading: false, hasAccess: r.instances.length > 0 }))
      .catch(() => setApps({ loading: false, hasAccess: false }));
  }, [email, role]);

  useEffect(() => { load(false); }, [load]);
  usePageRefresh(() => load(true));

  const entries = buildEntries({ user: { role, groups }, documents: docs.documents, hasAppAccess: apps.hasAccess });
  const settled = !apps.loading && (!docs.loading || !!docs.documents || !!docs.error);
  return { entries, docs, apps, settled, reload: () => load(true) };
}

export default function AutomationHub() {
  const { pathname, search } = useLocation();
  const go = useAppNavigate();
  const { entries, docs, apps, settled, reload } = useAutomationEntries();
  const category = categoryForLocation(entries, pathname, search);
  const current = entryForLocation(entries, pathname, search);
  const inCategory = entries.filter((e) => e.category === category);

  const chooseCategory = (id) => { if (id && id !== category) go(`/automations?category=${id}`); };
  const chooseEntry = (key) => {
    const e = entries.find((x) => x.key === key);
    if (e && e.key !== current?.key) go(e.to);
  };

  const options = inCategory.map((e) => ({
    value: e.key, disabled: !e.available, entry: e,
    search: [e.label, e.doc?.name, e.description, e.team].filter(Boolean).join(' '),
  }));
  const loadingList = !settled;
  const placeholder = !category ? 'Select a category first'
    : loadingList ? 'Loading automations…'
      : options.length ? 'Search or select an automation' : 'No automations available';
  const catLabel = categoryById(category)?.label;

  let note = null;
  if (docs.error) {
    note = (
      <div className="rs-hub-note rs-hub-note--error" role="alert">
        Couldn’t load approved automations: {docs.error}{' '}
        <button type="button" className="rs-link-btn" onClick={reload}>Try again</button>
      </div>
    );
  } else if (category && settled && !options.length) {
    note = (
      <div className="rs-hub-note" role="status">
        You don’t have access to any {catLabel.toLowerCase()} automations.
        {category === 'applications' && !apps.hasAccess ? ' EC2 Start/Stop is available to application teams with application access.' : ''}
      </div>
    );
  }

  return (
    <section className="rs-hub" aria-label="Select an automation">
      <div className="rs-hub-inner">
        <div className="rs-hub-row">
          <div className="rs-hub-field rs-hub-field--category">
            <label htmlFor="rs-hub-category" className="rs-label">Category</label>
            <select id="rs-hub-category" className="rs-input rs-hub-select" value={category || ''}
              onChange={(e) => chooseCategory(e.target.value)}>
              {!category && <option value="" disabled>Select a category</option>}
              {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div className="rs-hub-field rs-hub-field--automation">
            <label htmlFor="rs-hub-automation" className="rs-label">Automation</label>
            {category && !loadingList && options.length ? (
              <SearchSelect id="rs-hub-automation" ariaLabel="Automation" options={options} value={current?.key || ''}
                onChange={chooseEntry} display={(o) => o.entry.label} placeholder={placeholder}
                emptyText="No automations match your search."
                renderOption={(o) => {
                  const e = o.entry;
                  return (
                    <>
                      <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{e.label}</span>
                        {e.kind === 'document' && e.doc.display_name && e.doc.display_name !== e.doc.name && (
                          <span className="rs-mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{e.doc.name}</span>
                        )}
                        {!e.available && <span className="rs-badge rs-badge--muted">Unavailable</span>}
                      </span>
                      {e.description && <span style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{e.description}</span>}
                    </>
                  );
                }} />
            ) : (
              <input id="rs-hub-automation" className="rs-combo-input" disabled placeholder={placeholder} aria-busy={category ? loadingList : undefined} />
            )}
          </div>
        </div>
        {note}
        {current && (
          <div className="rs-hub-selected" aria-live="polite">
            <div className="rs-hub-selected-name">
              {current.label}
              {current.kind === 'document' && current.doc.display_name && current.doc.display_name !== current.doc.name && (
                <span className="rs-mono rs-hub-selected-doc">{current.doc.name}</span>
              )}
            </div>
            {current.description && <p className="rs-hub-selected-desc">{current.description}</p>}
            {current.kind === 'document' && current.available && <DocBadges doc={current.doc} />}
          </div>
        )}
      </div>
    </section>
  );
}
