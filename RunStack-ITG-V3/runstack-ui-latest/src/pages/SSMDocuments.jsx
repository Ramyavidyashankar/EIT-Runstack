// src/pages/SSMDocuments.jsx
//
// SSM Documents — the Systems Manager documents RunStack can run, in every
// configured region (us-east-1 and us-west-2). An SSM document is regional:
// a run in us-west-2 can only use a document that exists in us-west-2, so
// every row is one document in one region and says where else it exists.
//
// All values come from the SSM API via GET /ssm/documents?regions=all and
// GET /ssm/documents/{name}?region=…&version=… (ListDocuments,
// DescribeDocument, ListDocumentVersions, GetDocument). Nothing is guessed
// from document names; missing values show "Not provided".
//
// Search and filters are kept per tab (sessionStorage), so closing the
// details panel, leaving the page or refreshing keeps them.

import React from 'react';
import ReactDOM from 'react-dom';
import { Topbar } from '../components/Layout';
import { Btn, Card, Empty, ErrorBanner, Input, Select, Spinner } from '../components/ui';
import { Callout, Chip, RefreshControl, SummaryTile } from '../components/sections';
import { fetchSSMDocumentCatalog, fetchSSMDocumentDetail } from '../api/client';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { usePersistentState } from '../hooks/useNavigation';
import { copyText } from '../utils/jobs';
import { downloadName, filterDocuments, missingRegions, regionStyle, statusTone, summarize, versionLabel } from '../utils/ssmDocs';

const TEAL = '#365D9D';
const mono = { fontFamily: 'var(--font-mono)' };
const NOT_PROVIDED = <span style={{ color: '#657185', fontStyle: 'italic' }}>Not provided</span>;
const OWNERS = [
  { value: 'Self', label: 'Owned by this account' },
  { value: 'Private', label: 'Shared with this account' },
  { value: 'Amazon', label: 'Amazon-owned' },
];
const TYPES = ['All', 'Command', 'Automation', 'Policy', 'Session'];

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function RegionPill({ region, muted }) {
  const s = regionStyle(region);
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 9px', borderRadius: 999, fontSize: 12, fontWeight: 600,
      ...mono, color: muted ? '#657185' : s.fg, background: muted ? '#FAFBFC' : s.bg, border: `1px ${muted ? 'dashed' : 'solid'} ${muted ? '#C9D1DC' : s.border}`,
      whiteSpace: 'nowrap',
    }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: muted ? '#C9D1DC' : s.dot }} />{s.label}
    </span>
  );
}

function Availability({ doc, regions }) {
  const missing = missingRegions(doc, regions);
  if (!missing.length) return <div style={{ fontSize: 12, color: '#0B6E4C', marginTop: 4 }}>In all {regions.length} regions</div>;
  return <div style={{ fontSize: 12, color: '#92400E', marginTop: 4 }}>Not in {missing.join(', ')}</div>;
}

// ─── Details panel ───────────────────────────────────────────────────────────
function Fact({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',}}>{label}</div>
      <div style={{ fontSize: 14, color: '#202938', marginTop: 3, wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}

function CodeView({ text }) {
  const lines = (text || '').split('\n');
  const width = String(lines.length).length;
  return (
    <div style={{ border: '1px solid #DCE2EA', borderRadius: 10, background: '#FAFBFC', overflow: 'auto', flex: 1, minHeight: 0 }}>
      <pre style={{ margin: 0, padding: '12px 0', fontSize: 13, lineHeight: 1.6, ...mono, color: '#202938', minWidth: 'max-content' }}>
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'flex' }}>
            <span aria-hidden style={{ userSelect: 'none', color: '#657185', textAlign: 'right', width: `${width + 2}ch`, paddingRight: 14, flexShrink: 0, borderRight: '1px solid #DCE2EA', marginRight: 14 }}>{i + 1}</span>
            <span style={{ whiteSpace: 'pre' }}>{l || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function DetailsPanel({ doc, regions, onClose }) {
  const [tab, setTab] = React.useState('overview');
  const [version, setVersion] = React.useState(null); // null = default version
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const closeRef = React.useRef(null);

  const load = React.useCallback(async (v) => {
    setLoading(true); setError(null);
    try {
      setData(await fetchSSMDocumentDetail(doc.name, { region: doc.region, version: v || undefined }));
    } catch (e) {
      setError(e.body?.error || e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [doc.name, doc.region]);

  React.useEffect(() => { load(version); }, [load, version]);
  React.useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = data?.document_version;
  const versions = (data?.versions || []).map((v) => ({ ...v, is_latest: v.version === data?.latest_version }));
  const params = [...(data?.parameters || [])].sort((a, b) => Number(b.required) - Number(a.required));
  const missing = data ? regions.filter((r) => !(data.available_in || []).includes(r)) : [];

  const download = () => {
    const blob = new Blob([data.content || ''], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = downloadName(data.name, shown, data.region, data.document_format);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = async () => { if (await copyText(data.content || '')) { setCopied(true); setTimeout(() => setCopied(false), 1800); } };

  const tabBtn = (id, label) => (
    <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} style={{
      background: 'none', border: 'none', borderBottom: `2px solid ${tab === id ? TEAL : 'transparent'}`, color: tab === id ? TEAL : '#4F5B6E',
      fontWeight: 600, fontSize: 14, padding: '10px 2px', marginRight: 22, cursor: 'pointer', fontFamily: 'inherit',
    }}>{label}</button>
  );

  return ReactDOM.createPortal(
    <>
      <div onClick={onClose} aria-hidden style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.30)', zIndex: 40 }} />
      <aside role="dialog" aria-modal="true" aria-label={`${doc.name} in ${doc.region}`} style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(1040px, 94vw)', zIndex: 41, background: '#FFFFFF',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 22px 0', borderBottom: '1px solid #DCE2EA' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',}}>SSM document</div>
              <div style={{ fontSize: 17, fontWeight: 600, color: '#202938', wordBreak: 'break-all', ...mono }}>{doc.name}</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                <RegionPill region={doc.region} />
                {(data?.document_type || doc.type) && <Chip tone="gray">{data?.document_type || doc.type}</Chip>}
                {(data?.status || doc.status) && <Chip tone={statusTone(data?.status || doc.status)}>{data?.status || doc.status}</Chip>}
              </div>
            </div>
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close details" style={{ background: 'none', border: 'none', fontSize: 24, color: '#657185', cursor: 'pointer', lineHeight: 1 }}>×</button>
          </div>

          {/* Version picker */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, color: '#3B4658' }}>
              Showing
              {versions.length > 0 ? (
                <Select value={shown || ''} onChange={(e) => setVersion(e.target.value === data?.default_version ? null : e.target.value)} disabled={loading} style={{ width: 280, fontSize: 13 }} aria-label="Document version">
                  {versions.map((v) => <option key={v.version} value={v.version}>{versionLabel(v)}</option>)}
                </Select>
              ) : <span style={{ ...mono, fontSize: 13 }}>{shown ? `Version ${shown}` : '…'}</span>}
            </label>
            {loading && <Spinner size={14} />}
            {data?.versions_error && <span style={{ fontSize: 12, color: '#92400E' }}>Other versions couldn't be listed ({data.versions_error}).</span>}
          </div>
          {data && !data.is_default_version && (
            <div style={{ marginTop: 10 }}>
              <Callout tone="warning">You're viewing version {shown}. Runs use the default version ({data.default_version}) unless they name a version.</Callout>
            </div>
          )}
          {data && data.is_default_version && data.latest_version && data.latest_version !== data.default_version && (
            <div style={{ marginTop: 10 }}>
              <Callout tone="info">This is the default version ({data.default_version}), which runs use. A newer version {data.latest_version} exists but isn't the default.</Callout>
            </div>
          )}

          <div role="tablist" style={{ display: 'flex', marginTop: 8 }}>
            {tabBtn('overview', 'Overview')}
            {tabBtn('source', `${data?.document_format === 'JSON' ? 'JSON' : 'YAML'} source`)}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 22, overflowY: tab === 'overview' ? 'auto' : 'hidden' }}>
          {error && <ErrorBanner message={error} />}
          {!data && loading && <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#657185', fontSize: 14 }}><Spinner size={16} /> Loading document from {doc.region}…</div>}

          {data && tab === 'overview' && (
            <div style={{ display: 'grid', gap: 22, opacity: loading ? 0.6 : 1 }}>
              <section>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#202938', marginBottom: 6 }}>Purpose</div>
                <div style={{ fontSize: 14, color: '#3B4658', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{data.description || NOT_PROVIDED}</div>
                <div style={{ fontSize: 12, color: '#657185', marginTop: 4 }}>From the document's own description (version {shown}).</div>
              </section>

              <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 16, padding: 16, border: '1px solid #DCE2EA', borderRadius: 10, background: '#FCFDFD' }}>
                <Fact label="Document type">{data.document_type || NOT_PROVIDED}</Fact>
                <Fact label="Owner">{data.owner ? <span style={mono}>{data.owner}</span> : NOT_PROVIDED}</Fact>
                <Fact label="Region"><RegionPill region={data.region} /></Fact>
                <Fact label="Available in">
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {regions.map((r) => <RegionPill key={r} region={r} muted={!(data.available_in || []).includes(r)} />)}
                  </div>
                  {missing.length > 0 && <div style={{ fontSize: 12, color: '#92400E', marginTop: 4 }}>Runs in {missing.join(', ')} can't use this document.</div>}
                </Fact>
                <Fact label="Status">{data.status ? <><Chip tone={statusTone(data.status)}>{data.status}</Chip>{data.status_information && <div style={{ fontSize: 12, color: '#657185', marginTop: 3 }}>{data.status_information}</div>}</> : NOT_PROVIDED}</Fact>
                <Fact label="Default version">{data.default_version ? `Version ${data.default_version}` : NOT_PROVIDED}</Fact>
                <Fact label="Latest version">{data.latest_version ? `Version ${data.latest_version}` : NOT_PROVIDED}</Fact>
                <Fact label="Version shown">{shown ? `Version ${shown}${data.version_name ? ` (${data.version_name})` : ''}` : NOT_PROVIDED}</Fact>
                <Fact label="Schema version">{data.schema_version || NOT_PROVIDED}</Fact>
                <Fact label="Platforms">{data.platform_types?.length ? data.platform_types.join(', ') : NOT_PROVIDED}</Fact>
                <Fact label="Target type">{data.target_type || NOT_PROVIDED}</Fact>
                <Fact label="Created">{fmtDate(data.created_date) || NOT_PROVIDED}</Fact>
              </section>

              <section>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#202938', marginBottom: 8 }}>
                  Parameters <span style={{ fontWeight: 400, color: '#657185', fontSize: 13 }}>· {params.filter((p) => p.required).length} required</span>
                </div>
                {params.length === 0 ? <div style={{ fontSize: 14, color: '#657185' }}>This document has no parameters.</div> : (
                  <div style={{ border: '1px solid #DCE2EA', borderRadius: 10, overflow: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead><tr>{['Name', 'Type', 'Required', 'Default', 'Description'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 12, fontWeight: 600, color: '#657185', background: '#FAFBFC', borderBottom: '1px solid #DCE2EA' }}>{h}</th>
                      ))}</tr></thead>
                      <tbody>{params.map((p) => (
                        <tr key={p.name}>
                          <td style={{ padding: '8px 12px', borderBottom: '1px solid #F5F6F8', fontWeight: 600, ...mono }}>{p.name}</td>
                          <td style={{ padding: '8px 12px', borderBottom: '1px solid #F5F6F8' }}>{p.type || NOT_PROVIDED}</td>
                          <td style={{ padding: '8px 12px', borderBottom: '1px solid #F5F6F8' }}>{p.required ? <Chip tone="amber">Required</Chip> : <span style={{ color: '#657185' }}>Optional</span>}</td>
                          <td style={{ padding: '8px 12px', borderBottom: '1px solid #F5F6F8', ...mono, wordBreak: 'break-all' }}>{p.required ? '—' : (p.default_value === '' ? '(empty)' : String(p.default_value))}</td>
                          <td style={{ padding: '8px 12px', borderBottom: '1px solid #F5F6F8', color: '#3B4658' }}>{p.description || NOT_PROVIDED}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </section>

              <section>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#202938', marginBottom: 8 }}>Main steps <span style={{ fontWeight: 400, color: '#657185', fontSize: 13 }}>· as defined in version {shown}</span></div>
                {!data.steps?.length ? <div style={{ fontSize: 14 }}>{NOT_PROVIDED}</div> : (
                  <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
                    {data.steps.map((s, i) => (
                      <li key={`${s.name}-${i}`} style={{ display: 'flex', gap: 12, padding: '10px 12px', border: '1px solid #DCE2EA', borderRadius: 10 }}>
                        <span aria-hidden style={{ flexShrink: 0, width: 24, height: 24, borderRadius: '50%', background: '#EEF3FA', color: '#2C4D84', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: '#202938' }}>{s.name || <span style={{ color: '#657185', fontWeight: 400 }}>Unnamed step</span>}</div>
                          <div style={{ fontSize: 13, color: '#4F5B6E', ...mono }}>{s.action || 'No action given'}</div>
                          {s.description && <div style={{ fontSize: 13, color: '#3B4658', marginTop: 3 }}>{s.description}</div>}
                          {s.on_failure && <div style={{ fontSize: 12, color: '#657185', marginTop: 2 }}>On failure: <span style={mono}>{s.on_failure}</span></div>}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          )}

          {data && tab === 'source' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0, opacity: loading ? 0.6 : 1 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: '#3B4658', flex: 1 }}>
                  <strong>Version {shown}</strong>{data.is_default_version ? ' (default)' : ''}{data.is_latest_version ? ' (latest)' : ''} · {data.document_format} · {data.region}
                  {data.content ? ` · ${data.content.split('\n').length} lines` : ''}
                </span>
                <Btn variant="default" size="sm" onClick={copy} disabled={!data.content}>{copied ? 'Copied' : 'Copy'}</Btn>
                <Btn variant="primary" size="sm" onClick={download} disabled={!data.content}>Download {data.document_format === 'JSON' ? 'JSON' : 'YAML'}</Btn>
              </div>
              {data.content ? <CodeView text={data.content} /> : <Empty message="SSM returned no content for this version." />}
            </div>
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function SSMDocuments() {
  const [owner, setOwner] = usePersistentState('ssmDocs.owner', 'Self');
  const [type, setType] = usePersistentState('ssmDocs.type2', 'All');
  const [region, setRegion] = usePersistentState('ssmDocs.region', '');
  const [search, setSearch] = usePersistentState('ssmDocs.search', '');
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [lastUpdated, setLastUpdated] = React.useState(null);
  const [open, setOpen] = React.useState(null);
  const gen = React.useRef(0);

  const load = React.useCallback(async () => {
    const my = ++gen.current;
    setLoading(true); setError(null);
    try {
      const res = await fetchSSMDocumentCatalog({ type, owner });
      if (my !== gen.current) return;
      setData(res); setLastUpdated(new Date());
    } catch (e) {
      if (my === gen.current) setError(e.body?.error || e.message || String(e));
    } finally {
      if (my === gen.current) setLoading(false);
    }
  }, [type, owner]);
  React.useEffect(() => { load(); }, [load]);
  usePageRefresh(load);

  const regions = data?.regions || ['us-east-1', 'us-west-2'];
  const rows = data?.documents || [];
  const visible = React.useMemo(() => filterDocuments(rows, { search, region }), [rows, search, region]);
  const sums = React.useMemo(() => summarize(visible, regions), [visible, regions]);
  const filtering = Boolean(search || region);
  const regionErrors = Object.entries(data?.region_errors || {});
  const truncated = Object.entries(data?.truncated || {}).filter(([, v]) => v).map(([r]) => r);

  const th = { textAlign: 'left', padding: '9px 12px', fontSize: 13, fontWeight: 600, color: '#3B4658', background: '#FAFBFC', borderBottom: '1px solid #DCE2EA', whiteSpace: 'nowrap' };
  const td = { padding: '11px 12px', borderBottom: '1px solid #F5F6F8', verticalAlign: 'top', fontSize: 14 };
  const segBtn = (value, label) => (
    <button key={value || 'all'} type="button" role="radio" aria-checked={region === value} onClick={() => setRegion(value)} style={{
      padding: '6px 12px', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', border: 'none',
      borderLeft: value ? '1px solid #C9D1DC' : 'none', background: region === value ? TEAL : '#FFFFFF', color: region === value ? '#FFFFFF' : '#3B4658',
    }}>{label}</button>
  );

  return (
    <div className="rs-page">
      <Topbar
        title="SSM Documents"
        subtitle="Systems Manager documents by region. A run can only use a document that exists in its own region."
        actions={<RefreshControl onRefresh={load} refreshing={loading} lastUpdated={lastUpdated} error={data && error} />}
      />
      <div className="rs-page-body">
        <div className="rs-page-content">
          {data && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
              <SummaryTile label="Documents" value={sums.documents} sub={filtering ? 'matching filters' : `${OWNERS.find((o) => o.value === owner)?.label.toLowerCase()}`} />
              {regions.map((r) => <SummaryTile key={r} label={`In ${r}`} value={sums.perRegion[r] ?? 0} />)}
              <SummaryTile label="In one region only" value={sums.oneRegionOnly} tone={sums.oneRegionOnly ? 'amber' : 'green'} sub={sums.oneRegionOnly ? 'missing from the other region' : 'every document is in both'} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or description…" aria-label="Search documents" style={{ maxWidth: 300, fontSize: 13 }} />
            <Select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Owner" style={{ width: 210, fontSize: 13 }}>
              {OWNERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="Document type" style={{ width: 160, fontSize: 13 }}>
              {TYPES.map((t) => <option key={t} value={t}>{t === 'All' ? 'All types' : t}</option>)}
            </Select>
            <div role="radiogroup" aria-label="Region" style={{ display: 'inline-flex', border: '1px solid #C9D1DC', borderRadius: 8, overflow: 'hidden' }}>
              {segBtn('', 'All regions')}
              {regions.map((r) => segBtn(r, r))}
            </div>
            {filtering && <button type="button" onClick={() => { setSearch(''); setRegion(''); }} style={{ background: 'none', border: 'none', color: TEAL, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>Clear filters</button>}
          </div>

          {error && !data && <ErrorBanner message={`Couldn't load SSM documents: ${error}`} />}
          {regionErrors.map(([r, msg]) => (
            <Callout key={r} tone="warning" title={`Documents in ${r} couldn't be loaded`}>{msg} Documents from the other region are still shown.</Callout>
          ))}
          {truncated.length > 0 && (
            <Callout tone="info">Showing the first {data.max_per_region} documents in {truncated.join(' and ')}. Choose a document type to narrow the list.</Callout>
          )}

          <Card>
            {!data ? (
              loading ? <div style={{ padding: 48, display: 'flex', justifyContent: 'center', gap: 10, alignItems: 'center', color: '#657185', fontSize: 14 }}><Spinner /> Loading documents from {regions.join(' and ')}…</div>
                : <Empty message="SSM documents couldn't be loaded." />
            ) : visible.length === 0 ? (
              <Empty message={rows.length ? 'No documents match these filters.' : `No ${type === 'All' ? '' : `${type} `}documents ${OWNERS.find((o) => o.value === owner)?.label.toLowerCase()} in ${regions.join(' or ')}.`} />
            ) : (
              <div style={{ overflowX: 'auto', opacity: loading ? 0.6 : 1, transition: 'opacity 0.15s' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
                  <thead><tr>
                    <th style={th}>Document</th><th style={th}>Type</th><th style={th}>Region</th><th style={th}>Default version</th><th style={th}>Status</th><th style={{ ...th, textAlign: 'right' }} aria-label="Actions" />
                  </tr></thead>
                  <tbody>
                    {visible.map((d) => (
                      <tr key={`${d.region}:${d.name}`} className="rs-exec-row">
                        <td style={{ ...td, maxWidth: 520 }}>
                          <div style={{ fontWeight: 600, color: '#202938', wordBreak: 'break-all', ...mono, fontSize: 13 }}>{d.name}</div>
                          <div style={{ fontSize: 13, color: d.description ? '#4F5B6E' : undefined, marginTop: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                            {d.description || NOT_PROVIDED}
                          </div>
                        </td>
                        <td style={td}><Chip tone="gray">{d.type || '—'}</Chip></td>
                        <td style={td}><RegionPill region={d.region} /><Availability doc={d} regions={regions} /></td>
                        <td style={td}>
                          {d.default_version ? <span style={{ fontWeight: 600 }}>Version {d.default_version}</span> : NOT_PROVIDED}
                          {d.latest_version && d.default_version && d.latest_version !== d.default_version && (
                            <div style={{ fontSize: 12, color: '#92400E', marginTop: 3 }}>Latest is version {d.latest_version}</div>
                          )}
                        </td>
                        <td style={td}>{d.status ? <Chip tone={statusTone(d.status)}>{d.status}</Chip> : NOT_PROVIDED}</td>
                        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <Btn variant="default" size="sm" onClick={() => setOpen(d)}>View details</Btn>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {data && <div style={{ fontSize: 12, color: '#657185' }}>From AWS Systems Manager in {regions.join(' and ')} · {visible.length} of {rows.length} rows shown. Each row is one document in one region.</div>}
        </div>
      </div>
      {open && <DetailsPanel doc={open} regions={regions} onClose={() => setOpen(null)} />}
    </div>
  );
}
