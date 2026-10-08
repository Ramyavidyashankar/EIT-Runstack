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
import Tabs from '../components/Tabs';
import { Btn, Card, Empty, ErrorBanner, Select, Spinner } from '../components/ui';
import { Callout, Chip, RefreshControl, SummaryTile } from '../components/sections';
import { fetchSSMDocumentCatalog, fetchSSMDocumentDetail } from '../api/client';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { usePersistentState } from '../hooks/useNavigation';
import { FilterBar, FilterChips, FilterField, FilterSelect as CompactSelect, MoreFilters, SearchInput } from '../components/filters';
import { copyText } from '../utils/jobs';
import { downloadName, filterDocuments, missingRegions, regionStyle, statusTone, summarize, versionLabel } from '../utils/ssmDocs';

const mono = { fontFamily: 'var(--font-mono)' };
const NOT_PROVIDED = <span style={{ color: '#52647A', fontStyle: 'italic' }}>Not provided</span>;
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
      ...mono, color: muted ? '#52647A' : s.fg, background: muted ? '#F8FAFD' : s.bg, border: `1px ${muted ? 'dashed' : 'solid'} ${muted ? '#C3CFDD' : s.border}`,
      whiteSpace: 'nowrap',
    }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: muted ? '#C3CFDD' : s.dot }} />{s.label}
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
      <div style={{ fontSize: 14, color: '#172B4D', marginTop: 3, wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}

function CodeView({ text }) {
  const lines = (text || '').split('\n');
  const width = String(lines.length).length;
  return (
    <div style={{ border: '1px solid #D7E0EB', borderRadius: 10, background: '#F8FAFD', overflow: 'auto', flex: 1, minHeight: 0 }}>
      <pre style={{ margin: 0, padding: '12px 0', fontSize: 13, lineHeight: 1.6, ...mono, color: '#172B4D', minWidth: 'max-content' }}>
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'flex' }}>
            <span aria-hidden style={{ userSelect: 'none', color: '#52647A', textAlign: 'right', width: `${width + 2}ch`, paddingRight: 14, flexShrink: 0, borderRight: '1px solid #D7E0EB', marginRight: 14 }}>{i + 1}</span>
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

  return ReactDOM.createPortal(
    <>
      <div onClick={onClose} aria-hidden style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.30)', zIndex: 40 }} />
      <aside role="dialog" aria-modal="true" aria-label={`${doc.name} in ${doc.region}`} style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(1040px, 94vw)', zIndex: 41, background: '#FFFFFF',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{ padding: '16px 22px 0', borderBottom: '1px solid #D7E0EB' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',}}>SSM document</div>
              <div style={{ fontSize: 17, fontWeight: 600, color: '#172B4D', wordBreak: 'break-all', ...mono }}>{doc.name}</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
                <RegionPill region={doc.region} />
                {(data?.document_type || doc.type) && <Chip tone="gray">{data?.document_type || doc.type}</Chip>}
                {(data?.status || doc.status) && <Chip tone={statusTone(data?.status || doc.status)}>{data?.status || doc.status}</Chip>}
              </div>
            </div>
            <button ref={closeRef} type="button" onClick={onClose} aria-label="Close details" style={{ background: 'none', border: 'none', fontSize: 24, color: '#52647A', cursor: 'pointer', lineHeight: 1 }}>×</button>
          </div>

          {/* Version picker */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, color: '#2F4258' }}>
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

          <Tabs label="Document views" idPrefix="rs-ssmdoc" active={tab} onChange={setTab} className="rs-tabs--flush"
            tabs={[{ value: 'overview', label: 'Overview' }, { value: 'source', label: `${data?.document_format === 'JSON' ? 'JSON' : 'YAML'} source` }]} />
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 22, overflowY: tab === 'overview' ? 'auto' : 'hidden' }}>
          {error && <ErrorBanner message={error} />}
          {!data && loading && <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: '#52647A', fontSize: 14 }}><Spinner size={16} /> Loading document from {doc.region}…</div>}

          {data && tab === 'overview' && (
            <div style={{ display: 'grid', gap: 22, opacity: loading ? 0.6 : 1 }}>
              <section>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#172B4D', marginBottom: 6 }}>Purpose</div>
                <div style={{ fontSize: 14, color: '#2F4258', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{data.description || NOT_PROVIDED}</div>
                <div style={{ fontSize: 12, color: '#52647A', marginTop: 4 }}>From the document's own description (version {shown}).</div>
              </section>

              <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 16, padding: 16, border: '1px solid #D7E0EB', borderRadius: 10, background: '#FCFDFD' }}>
                <Fact label="Document type">{data.document_type || NOT_PROVIDED}</Fact>
                <Fact label="Owner">{data.owner ? <span style={mono}>{data.owner}</span> : NOT_PROVIDED}</Fact>
                <Fact label="Region"><RegionPill region={data.region} /></Fact>
                <Fact label="Available in">
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {regions.map((r) => <RegionPill key={r} region={r} muted={!(data.available_in || []).includes(r)} />)}
                  </div>
                  {missing.length > 0 && <div style={{ fontSize: 12, color: '#92400E', marginTop: 4 }}>Runs in {missing.join(', ')} can't use this document.</div>}
                </Fact>
                <Fact label="Status">{data.status ? <><Chip tone={statusTone(data.status)}>{data.status}</Chip>{data.status_information && <div style={{ fontSize: 12, color: '#52647A', marginTop: 3 }}>{data.status_information}</div>}</> : NOT_PROVIDED}</Fact>
                <Fact label="Default version">{data.default_version ? `Version ${data.default_version}` : NOT_PROVIDED}</Fact>
                <Fact label="Latest version">{data.latest_version ? `Version ${data.latest_version}` : NOT_PROVIDED}</Fact>
                <Fact label="Version shown">{shown ? `Version ${shown}${data.version_name ? ` (${data.version_name})` : ''}` : NOT_PROVIDED}</Fact>
                <Fact label="Schema version">{data.schema_version || NOT_PROVIDED}</Fact>
                <Fact label="Platforms">{data.platform_types?.length ? data.platform_types.join(', ') : NOT_PROVIDED}</Fact>
                <Fact label="Target type">{data.target_type || NOT_PROVIDED}</Fact>
                <Fact label="Created">{fmtDate(data.created_date) || NOT_PROVIDED}</Fact>
              </section>

              <section>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#172B4D', marginBottom: 8 }}>
                  Parameters <span style={{ fontWeight: 400, color: '#52647A', fontSize: 13 }}>· {params.filter((p) => p.required).length} required</span>
                </div>
                {params.length === 0 ? <div style={{ fontSize: 14, color: '#52647A' }}>This document has no parameters.</div> : (
                  <div style={{ border: '1px solid #D7E0EB', borderRadius: 10, overflow: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead><tr>{['Name', 'Type', 'Required', 'Default', 'Description'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 12, fontWeight: 600, color: '#52647A', background: '#F8FAFD', borderBottom: '1px solid #D7E0EB' }}>{h}</th>
                      ))}</tr></thead>
                      <tbody>{params.map((p) => (
                        <tr key={p.name}>
                          <td style={{ padding: '8px 12px', borderBottom: '1px solid #F4F6FA', fontWeight: 600, ...mono }}>{p.name}</td>
                          <td style={{ padding: '8px 12px', borderBottom: '1px solid #F4F6FA' }}>{p.type || NOT_PROVIDED}</td>
                          <td style={{ padding: '8px 12px', borderBottom: '1px solid #F4F6FA' }}>{p.required ? <Chip tone="amber">Required</Chip> : <span style={{ color: '#52647A' }}>Optional</span>}</td>
                          <td style={{ padding: '8px 12px', borderBottom: '1px solid #F4F6FA', ...mono, wordBreak: 'break-all' }}>{p.required ? '—' : (p.default_value === '' ? '(empty)' : String(p.default_value))}</td>
                          <td style={{ padding: '8px 12px', borderBottom: '1px solid #F4F6FA', color: '#2F4258' }}>{p.description || NOT_PROVIDED}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
              </section>

              <section>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#172B4D', marginBottom: 8 }}>Main steps <span style={{ fontWeight: 400, color: '#52647A', fontSize: 13 }}>· as defined in version {shown}</span></div>
                {!data.steps?.length ? <div style={{ fontSize: 14 }}>{NOT_PROVIDED}</div> : (
                  <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 8 }}>
                    {data.steps.map((s, i) => (
                      <li key={`${s.name}-${i}`} style={{ display: 'flex', gap: 12, padding: '10px 12px', border: '1px solid #D7E0EB', borderRadius: 10 }}>
                        <span aria-hidden style={{ flexShrink: 0, width: 24, height: 24, borderRadius: '50%', background: '#E8F0FC', color: '#2B4D86', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: '#172B4D' }}>{s.name || <span style={{ color: '#52647A', fontWeight: 400 }}>Unnamed step</span>}</div>
                          <div style={{ fontSize: 13, color: '#52647A', ...mono }}>{s.action || 'No action given'}</div>
                          {s.description && <div style={{ fontSize: 13, color: '#2F4258', marginTop: 3 }}>{s.description}</div>}
                          {s.on_failure && <div style={{ fontSize: 12, color: '#52647A', marginTop: 2 }}>On failure: <span style={mono}>{s.on_failure}</span></div>}
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
                <span style={{ fontSize: 13, color: '#2F4258', flex: 1 }}>
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

  const th = { textAlign: 'left', padding: '9px 12px', fontSize: 13, fontWeight: 600, color: '#2F4258', background: '#F8FAFD', borderBottom: '1px solid #D7E0EB', whiteSpace: 'nowrap' };
  const td = { padding: '11px 12px', borderBottom: '1px solid #F4F6FA', verticalAlign: 'top', fontSize: 14 };
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

          <FilterBar>
            <SearchInput value={search} onChange={setSearch} label="Search documents" placeholder="Search documents…"
              help="Matches the document name and description." />
            <CompactSelect label="Region" value={region} set={!!region} onChange={setRegion}>
              <option value="">All regions</option>
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </CompactSelect>
            <MoreFilters activeCount={(owner !== 'Self' ? 1 : 0) + (type !== 'All' ? 1 : 0)} onClearAll={() => { setOwner('Self'); setType('All'); }}>
              <FilterField label="Owner">
                <CompactSelect label="Owner" value={owner} set={owner !== 'Self'} onChange={setOwner}>
                  {OWNERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CompactSelect>
              </FilterField>
              <FilterField label="Document type">
                <CompactSelect label="Document type" value={type} set={type !== 'All'} onChange={setType}>
                  {TYPES.map((t) => <option key={t} value={t}>{t === 'All' ? 'All types' : t}</option>)}
                </CompactSelect>
              </FilterField>
            </MoreFilters>
            {(filtering || owner !== 'Self' || type !== 'All') && (
              <div className="rs-filterbar-end">
                <button type="button" className="rs-chips-clear" onClick={() => { setSearch(''); setRegion(''); setOwner('Self'); setType('All'); }}>Reset filters</button>
              </div>
            )}
          </FilterBar>
          <FilterChips onClearAll={() => { setOwner('Self'); setType('All'); }} chips={[
            owner !== 'Self' && { key: 'owner', label: 'Owner', value: OWNERS.find((o) => o.value === owner)?.label || owner, onRemove: () => setOwner('Self') },
            type !== 'All' && { key: 'type', label: 'Type', value: type, onRemove: () => setType('All') },
          ]} />

          {error && !data && <ErrorBanner message={`Couldn't load SSM documents: ${error}`} />}
          {regionErrors.map(([r, msg]) => (
            <Callout key={r} tone="warning" title={`Documents in ${r} couldn't be loaded`}>{msg} Documents from the other region are still shown.</Callout>
          ))}
          {truncated.length > 0 && (
            <Callout tone="info">Showing the first {data.max_per_region} documents in {truncated.join(' and ')}. Choose a document type to narrow the list.</Callout>
          )}

          <Card>
            {!data ? (
              loading ? <div style={{ padding: 48, display: 'flex', justifyContent: 'center', gap: 10, alignItems: 'center', color: '#52647A', fontSize: 14 }}><Spinner /> Loading documents from {regions.join(' and ')}…</div>
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
                          <div style={{ fontWeight: 600, color: '#172B4D', wordBreak: 'break-all', ...mono, fontSize: 13 }}>{d.name}</div>
                          <div style={{ fontSize: 13, color: d.description ? '#52647A' : undefined, marginTop: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
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
          {data && <div style={{ fontSize: 12, color: '#52647A' }}>From AWS Systems Manager in {regions.join(' and ')} · {visible.length} of {rows.length} rows shown. Each row is one document in one region.</div>}
        </div>
      </div>
      {open && <DetailsPanel doc={open} regions={regions} onClose={() => setOpen(null)} />}
    </div>
  );
}
