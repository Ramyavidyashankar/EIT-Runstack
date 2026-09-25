// src/pages/TriggerJob.jsx
//
// Redesign notes (spec: operator shouldn't need AWS technical identifiers):
//  - Catalog flow is now Application → Environment → Server instead of
//    Application → Instance. Environment is derived client-side from
//    instance.environment values already in the catalog fetch — if no
//    instance in the selected app has that field set, the environment step
//    is skipped entirely rather than showing an empty/fake selector.
//  - "Server" shows server_name/name as primary, falls back to instance_id
//    only when no friendlier name exists — no live "Running" status is
//    shown anywhere, because the instance catalog is static metadata, not
//    a live SSM ping; showing a fabricated status would be misleading.
//  - Account ID / Region / Resource ID collapse into a single read-only
//    target summary card with a "View technical details" expander.
//  - Automation Parameters render as a dynamic form generated from the
//    keys already present in the existing DEFAULT_PARAMS template for the
//    selected document — not a live SSM DescribeDocument schema fetch,
//    since no such integration exists. InstanceId (when present in that
//    template) is auto-populated from the selected server and shown
//    read-only with a lock indicator; resolving-and-injecting it happens
//    on server change AND on document change. "Advanced: Edit JSON" still
//    exposes the raw textarea for anything the dynamic form doesn't cover.
//  - Manual mode, the /v1/notify payload shape, and handleSubmit are
//    unchanged from before.
//
//  Visual redesign (this pass):
//  - No numbered steps / wizard chrome. Sections 2–4 still only render
//    once their prerequisite is complete (progressive reveal), but are
//    presented as a natural top-to-bottom flow rather than a numbered
//    sequence, per spec.
//  - Notification ID and the SQS→Lambda→...→SSM pipeline description move
//    out of prominent placement into a "Technical details" expander inside
//    the Review section — still fully editable/visible there, just not
//    front-and-center for an operator who doesn't need AWS internals.
//  - Single accent color throughout: Deep Teal (#0F766E), matching the
//    rest of the app (Dashboard/index.css) rather than introducing a
//    separate blue — replaces this file's old hardcoded DXC orange
//    (#EE6C24) everywhere it appeared.
//  - Amber "Production" chip on the target summary when the selected
//    environment string contains "prod" (case-insensitive) — a direct
//    read of the existing `environment` field already in the instance
//    catalog, not a new data source.
//
import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Topbar } from '../components/Layout';
import { Card, CardHead, Btn, FormRow, Input, Select, Textarea, ErrorBanner, StatusBadge } from '../components/ui';
import { triggerJob, fetchSSMDocuments, fetchAppInstances } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { AWS_REGIONS } from '../utils/helpers';
import { v4 as uuidv4 } from '../utils/uuid';

const AUTOMATION_TYPES = ['SSM-Automation', 'SSM-RunCommand'];

const DOC_TYPE_FOR_AUTOMATION_TYPE = {
  'SSM-Automation': 'Automation',
  'SSM-RunCommand': 'Command',
};

const DEFAULT_PARAMS = {
  'SSM-Automation': {
    'AWS-RestartEC2Instance': `{\n  "InstanceId": ["i-0REPLACE"]\n}`,
    'AWS-StopEC2Instance':    `{\n  "InstanceId": ["i-0REPLACE"]\n}`,
    'AWS-StartEC2Instance':   `{\n  "InstanceId": ["i-0REPLACE"]\n}`,
    default: `{\n  "InstanceId": ["i-0REPLACE"]\n}`,
  },
  'SSM-RunCommand': {
    'AWS-RunShellScript':     `{\n  "commands": ["echo Hello from RunStack", "uptime"]\n}`,
    'AWS-RunRemoteScript':    `{\n  "sourceType": ["S3"],\n  "sourceInfo": ["{\\\"path\\\":\\\"https://YOUR-BUCKET.s3.amazonaws.com/script.sh\\\"}\"],\n  "commandLine": ["script.sh"]\n}`,
    'AWS-RunPowerShellScript':`{\n  "commands": ["Write-Host 'Hello from RunStack'"]\n}`,
    default: `{\n  "commands": ["echo hello"]\n}`,
  },
};

function getDefaultParams(type, doc) {
  return DEFAULT_PARAMS[type]?.[doc] || DEFAULT_PARAMS[type]?.default || '{}';
}

// Set (or overwrite) the InstanceId key within a params JSON string, if
// that key exists in it — used to auto-sync it to whichever server is
// currently selected, per spec §4. Leaves the JSON untouched if it doesn't
// have an InstanceId key (e.g. RunCommand's "commands" template) or isn't
// valid JSON (mid-edit) — never throws.
function injectInstanceId(paramsText, instanceId) {
  if (!instanceId) return paramsText;
  try {
    const obj = JSON.parse(paramsText);
    if (Object.prototype.hasOwnProperty.call(obj, 'InstanceId')) {
      obj.InstanceId = [instanceId];
      return JSON.stringify(obj, null, 2);
    }
    return paramsText;
  } catch {
    return paramsText;
  }
}

// "InstanceId" -> "Instance ID", "commands" -> "Commands"
const ACRONYMS = { id: 'ID', url: 'URL', arn: 'ARN', os: 'OS' };
function humanizeKey(key) {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().split(/\s+/);
  return words.map(w => ACRONYMS[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}
// "Database-Healthcheck" -> "Database Healthcheck" — cosmetic transform of
// the real document name, not a separate "friendly name" field (none exists
// server-side), so this is a heuristic, not authoritative data.
function humanizeDocName(name) {
  if (!name) return '';
  return name.replace(/[-_]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

// Fields the backend accepts as optional top-level metadata on the job
// payload. Unchanged — only the display ORDER changed below, so the
// genuinely-optional-context fields (Problem ID, Automation Name) lead,
// and the fields that duplicate catalog data (App ID/Name, Server Name,
// OS, Environment — useful mainly for manual mode / non-catalog triggers
// like Dynatrace) come after.
const METADATA_FIELDS = [
  { key: 'problem_id',      label: 'Problem ID',       placeholder: 'Dynatrace problem ID' },
  { key: 'automation_name', label: 'Automation Name',  placeholder: 'Automation-var-cleanup' },
  { key: 'app_id',          label: 'App ID',           placeholder: '500579' },
  { key: 'app_name',        label: 'App Name',         placeholder: 'EIT Rundeck' },
  { key: 'server_name',     label: 'Server Name',      placeholder: 'EC2_LNX_C40T300293' },
  { key: 'OS',              label: 'OS Type',          placeholder: 'Linux / Windows' },
  { key: 'environment',     label: 'Environment',      placeholder: 'ITG / Production' },
];

function buildMetadata(form) {
  const meta = {};
  for (const { key } of METADATA_FIELDS) {
    if (form[key] && form[key].trim()) meta[key] = form[key].trim();
  }
  return meta;
}

// Unique key for an instance row — instance_id alone isn't guaranteed
// unique across apps in the catalog table.
function instanceKey(inst) {
  return `${inst.app_id}#${inst.instance_id}`;
}

function SegButton({ active, onClick, children }) {
  return (
    <button
      type="button" onClick={onClick}
      style={{
        padding: '4px 12px', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit',
        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
        border: active ? '1px solid #0F766E' : '1px solid #CBD5E1',
        background: active ? '#E6F5F3' : '#FFFFFF',
        color: active ? '#0F766E' : '#334155',
        transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  );
}

// Section heading + helper text, no step number — sections reveal
// progressively by conditional rendering, not by a numbered indicator.
function SectionHeader({ title, helper, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#0F172A' }}>{title}</div>
        {helper && <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2, fontWeight: 400 }}>{helper}</div>}
      </div>
      {right && <span style={{ marginLeft: 'auto', flexShrink: 0 }}>{right}</span>}
    </div>
  );
}

// Small colored pill — used for environment/region badges and the
// "Optional" tag on the additional-context section.
function Chip({ children, tone = 'default' }) {
  const tones = {
    default: { bg: '#E6F5F3', fg: '#0B5C56', border: '#BEE3DE' }, // teal tint
    amber:   { bg: '#FDF3E4', fg: '#92400E', border: '#F3D9AE' },
    gray:    { bg: '#F1F3F5', fg: '#475569', border: '#E2E8F0' },
  };
  const t = tones[tone] || tones.default;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 9px',
      borderRadius: 999, fontSize: 10.5, fontWeight: 600,
      background: t.bg, color: t.fg, border: `1px solid ${t.border}`,
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

// Generic collapsed "Technical details" toggle — neutral gray text, not
// a prominent accent-colored link, per spec (technical info shouldn't
// visually compete with the main flow).
function TechnicalDetails({ children, label = 'Technical details' }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button" onClick={() => setOpen(o => !o)}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          color: '#64748B', fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
          display: 'flex', alignItems: 'center', gap: 4,
        }}
      >
        <span style={{ fontSize: 9 }}>{open ? '▾' : '▸'}</span> {label}
      </button>
      {open && <div style={{ marginTop: 10 }}>{children}</div>}
    </div>
  );
}

function LockIcon({ size = 12, color = '#64748B' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

// One row in the final review panel — label left, value right, typography
// only (no borders/boxes per row), per spec.
function ReviewRow({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5 }}>
      <span style={{ color: '#64748B' }}>{label}</span>
      <span style={{ color: '#0F172A', fontWeight: 600, fontFamily: mono ? 'var(--font-mono)' : 'inherit', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

// ─── Searchable single-select — portal-based so it isn't clipped by an
// ancestor Card's overflow:hidden. options: [{value, label, sublabel}] ─────
function SearchablePicker({ value, onChange, options, placeholder, disabled }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [panelPos, setPanelPos] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (btnRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function openPanel() {
    if (disabled) return;
    const r = btnRef.current.getBoundingClientRect();
    setPanelPos({ top: r.bottom + window.scrollY + 4, left: r.left + window.scrollX, width: r.width });
    setOpen(o => !o);
    setQ('');
  }

  const selected = options.find(o => o.value === value);
  const filtered = q.trim()
    ? options.filter(o => (o.label + ' ' + (o.sublabel || '')).toLowerCase().includes(q.trim().toLowerCase()))
    : options;

  return (
    <>
      <button
        ref={btnRef} type="button" disabled={disabled} onClick={openPanel}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 12px', borderRadius: 'var(--radius-md)', border: '1px solid #CBD5E1',
          background: disabled ? '#F8FAFC' : '#FFFFFF', fontSize: 13,
          color: selected ? '#0F172A' : '#64748B',
          cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', textAlign: 'left',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {selected ? selected.label : placeholder}
        </span>
        <span style={{ marginLeft: 'auto', color: '#64748B', fontSize: 10, flexShrink: 0 }}>▾</span>
      </button>
      {open && panelPos && ReactDOM.createPortal(
        <div ref={panelRef} style={{
          position: 'absolute', zIndex: 1000, top: panelPos.top, left: panelPos.left,
          width: Math.max(panelPos.width, 260), maxHeight: 300, overflowY: 'auto',
          background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 'var(--radius-md)',
          boxShadow: '0 6px 18px rgba(18,21,28,0.14)', padding: 8,
        }}>
          <input
            autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search…"
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 12, border: '1px solid #CBD5E1', borderRadius: 6, marginBottom: 6, fontFamily: 'inherit' }}
          />
          {filtered.length === 0 ? (
            <div style={{ fontSize: 11, color: '#64748B', padding: '6px 4px' }}>No matches.</div>
          ) : filtered.map(o => (
            <div
              key={o.value} onClick={() => { onChange(o.value); setOpen(false); }}
              style={{ padding: '6px 8px', borderRadius: 6, cursor: 'pointer' }}
              onMouseEnter={e => e.currentTarget.style.background = '#F8FAFC'}
              onMouseLeave={e => e.currentTarget.style.background = ''}
            >
              <div style={{ fontSize: 12.5, color: '#0F172A', fontWeight: 500 }}>{o.label}</div>
              {o.sublabel && <div style={{ fontSize: 10.5, color: '#64748B', marginTop: 1, fontFamily: 'var(--font-mono)' }}>{o.sublabel}</div>}
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

// ─── Target summary card — replaces the always-visible Account/Region
// /Resource ID fields with a prominent name, status chips, and an
// expandable technical-details block. Self-contained (owns its own
// expand/collapse state). ─────────────────────────────────────────────
function ResourceSummary({ form, isProdEnv }) {
  const [showDetails, setShowDetails] = useState(false);

  if (!form.resource_id) {
    return <div style={{ fontSize: 12, color: '#64748B' }}>No server selected yet.</div>;
  }

  return (
    <div style={{
      padding: '16px 18px', background: '#F8FAFC', border: '1px solid #E2E8F0',
      borderRadius: 12, borderLeft: `3px solid ${isProdEnv ? '#B45309' : '#0F766E'}`,
    }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', fontFamily: 'var(--font-mono)' }}>
        {form.server_name || form.resource_id}
      </div>
      {form.app_name && (
        <div style={{ fontSize: 12.5, color: '#334155', marginTop: 2 }}>{form.app_name}</div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        {form.environment && <Chip tone={isProdEnv ? 'amber' : 'default'}>{form.environment}</Chip>}
        {form.region && <Chip tone="gray">{form.region}</Chip>}
        {form.account_id && <Chip tone="gray">Account {form.account_id}</Chip>}
      </div>

      <div style={{ fontSize: 11, color: '#64748B', fontFamily: 'var(--font-mono)', marginTop: 10 }}>
        {form.resource_id}
      </div>

      <div style={{ marginTop: 10 }}>
        <button
          type="button" onClick={() => setShowDetails(s => !s)}
          style={{ background: 'none', border: 'none', color: '#0F766E', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
        >
          {showDetails ? 'Hide' : 'View'} technical details
        </button>
        {showDetails && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 10 }}>
            <FormRow label="Account ID"><Input value={form.account_id} disabled placeholder="—" /></FormRow>
            <FormRow label="Region"><Input value={form.region} disabled placeholder="—" /></FormRow>
            <FormRow label="Resource ID"><Input value={form.resource_id} disabled placeholder="—" /></FormRow>
            <FormRow label="App ID"><Input value={form.app_id} disabled placeholder="—" /></FormRow>
            <FormRow label="App Name"><Input value={form.app_name} disabled placeholder="—" /></FormRow>
            <FormRow label="Environment"><Input value={form.environment} disabled placeholder="—" /></FormRow>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TriggerJob() {
  const nav = useNavigate();
  const { role } = useAuth();
  const canManualEntry = role === 'admin' || role === 'operator';

  const [form, setForm] = useState({
    id: uuidv4(),
    account_id: '',
    region: 'us-east-1',
    resource_id: '',
    automation_type: 'SSM-Automation',
    docOwner: 'Self',
    docName: '',
    docArn: '',
    instances: '',
    comment: '',
    params: getDefaultParams('SSM-Automation', ''),
    app_id: '',
    app_name: '',
    problem_id: '',
    automation_name: '',
    server_name: '',
    OS: '',
    environment: '',
  });
  const [docs, setDocs] = useState([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsError, setDocsError] = useState(null);
  const [showMetadata, setShowMetadata] = useState(false);
  const [showParamsJson, setShowParamsJson] = useState(false);
  const [showPayloadPreview, setShowPayloadPreview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  // ── Instance catalog ─────────────────────────────────────────────────────
  const [instances, setInstances] = useState([]);
  const [instancesLoading, setInstancesLoading] = useState(true);
  const [instancesError, setInstancesError] = useState(null);
  const [targetMode, setTargetMode] = useState('catalog');
  const [selectedAppId, setSelectedAppId] = useState('');
  const [selectedEnvironment, setSelectedEnvironment] = useState('');
  const [selectedInstanceKey, setSelectedInstanceKey] = useState('');

  function loadInstances() {
    setInstancesLoading(true);
    setInstancesError(null);
    fetchAppInstances()
      .then(data => {
        const list = data.instances || [];
        setInstances(list);
        if (list.length === 0) setTargetMode('manual');
      })
      .catch(e => {
        setInstancesError(e.message);
        setTargetMode('manual');
      })
      .finally(() => setInstancesLoading(false));
  }

  useEffect(() => { loadInstances(); }, []);

  const appOptions = useMemo(() => {
    const ids = new Set(instances.map(i => i.app_id).filter(Boolean));
    return Array.from(ids).sort();
  }, [instances]);

  const appPickerOptions = useMemo(() => appOptions.map(id => {
    const withName = instances.find(i => i.app_id === id && i.app_name);
    return { value: id, label: withName ? `${id} — ${withName.app_name}` : id };
  }), [appOptions, instances]);

  const instancesForSelectedApp = useMemo(
    () => instances.filter(i => i.app_id === selectedAppId),
    [instances, selectedAppId]
  );

  // Environment step is derived, not fetched — and skipped entirely if the
  // catalog has no environment data for this app, rather than showing an
  // empty/fake selector.
  const environmentsForApp = useMemo(() => {
    const envs = new Set(instancesForSelectedApp.map(i => i.environment).filter(Boolean));
    return Array.from(envs).sort();
  }, [instancesForSelectedApp]);

  useEffect(() => {
    if (environmentsForApp.length === 1) {
      setSelectedEnvironment(prev => prev === environmentsForApp[0] ? prev : environmentsForApp[0]);
    } else if (environmentsForApp.length === 0) {
      setSelectedEnvironment(prev => prev === '' ? prev : '');
    }
  }, [environmentsForApp]);

  const serversForSelection = useMemo(() => {
    if (environmentsForApp.length === 0) return instancesForSelectedApp;
    if (!selectedEnvironment) return [];
    return instancesForSelectedApp.filter(i => i.environment === selectedEnvironment);
  }, [instancesForSelectedApp, environmentsForApp, selectedEnvironment]);

  // No live status here — the catalog is static metadata, not a live SSM
  // ping, so the secondary line only ever shows real fields.
  const serverOptions = useMemo(() => serversForSelection.map(inst => ({
    value: instanceKey(inst),
    label: inst.server_name || inst.name || inst.instance_id,
    sublabel: [inst.instance_id, inst.environment, inst.region].filter(Boolean).join('  •  '),
  })), [serversForSelection]);

  function handleAppChange(appId) {
    setSelectedAppId(appId);
    setSelectedEnvironment('');
    setSelectedInstanceKey('');
  }

  function handleEnvironmentChange(e) {
    setSelectedEnvironment(e.target.value);
    setSelectedInstanceKey('');
  }

  function handleServerChange(key) {
    setSelectedInstanceKey(key);
    const inst = serversForSelection.find(i => instanceKey(i) === key);
    if (!inst) return;
    setForm(prev => ({
      ...prev,
      account_id: inst.account_id || prev.account_id,
      region: inst.region || prev.region,
      resource_id: inst.instance_id || prev.resource_id,
      app_id: prev.app_id || inst.app_id || '',
      app_name: prev.app_name || inst.app_name || '',
      server_name: prev.server_name || inst.server_name || inst.name || '',
      environment: prev.environment || inst.environment || '',
      params: injectInstanceId(prev.params, inst.instance_id || ''),
      instances: (prev.automation_type === 'SSM-RunCommand' && !prev.instances) ? (inst.instance_id || '') : prev.instances,
    }));
  }

  function switchToManual() { setTargetMode('manual'); }
  function switchToCatalog() { setTargetMode('catalog'); }

  useEffect(() => {
    const docType = DOC_TYPE_FOR_AUTOMATION_TYPE[form.automation_type];
    setDocsLoading(true);
    setDocsError(null);
    fetchSSMDocuments({ type: docType, owner: form.docOwner })
      .then(data => {
        const list = data.documents || [];
        setDocs(list);
        setForm(prev => {
          const stillValid = list.some(d => d.name === prev.docName);
          if (stillValid) return prev;
          const first = list[0];
          const nextParams = first ? getDefaultParams(prev.automation_type, first.name) : prev.params;
          return first
            ? { ...prev, docName: first.name, docArn: first.arn || '', params: injectInstanceId(nextParams, prev.resource_id) }
            : { ...prev, docName: '', docArn: '' };
        });
      })
      .catch(e => setDocsError(e.message))
      .finally(() => setDocsLoading(false));
  }, [form.automation_type, form.docOwner]);

  const set = (k) => (e) => {
    const val = e.target.value;
    setForm(prev => {
      const next = { ...prev, [k]: val };
      if (k === 'automation_type') next.params = getDefaultParams(val, '');
      return next;
    });
  };

  const docPickerOptions = useMemo(() => docs.map(d => ({
    value: d.name,
    label: humanizeDocName(d.name),
    sublabel: d.name + (d.description ? ` — ${d.description}` : ''),
  })), [docs]);

  const setDoc = (docName) => {
    const doc = docs.find(d => d.name === docName);
    setForm(prev => {
      const nextParams = getDefaultParams(prev.automation_type, docName);
      return { ...prev, docName, docArn: doc?.arn || '', params: injectInstanceId(nextParams, prev.resource_id) };
    });
  };

  // ── Dynamic parameter fields, derived from the current params JSON ──────
  const parsedParams = useMemo(() => {
    try { return JSON.parse(form.params); } catch { return null; }
  }, [form.params]);
  const paramsValid = parsedParams !== null;

  function updateParamField(key, val) {
    setForm(prev => {
      let obj;
      try { obj = JSON.parse(prev.params); } catch { obj = {}; }
      obj[key] = [val];
      return { ...prev, params: JSON.stringify(obj, null, 2) };
    });
  }

  async function handleSubmit() {
    setError(null);
    setLoading(true);

    let parsedForSubmit;
    try { parsedForSubmit = JSON.parse(form.params); }
    catch { setError('Parameters JSON is invalid. Please fix and retry.'); setLoading(false); return; }

    const isRunCommandNow = form.automation_type === 'SSM-RunCommand';
    const payload = {
      id: form.id,
      region: form.region,
      account_id: form.account_id.trim(),
      resource_id: form.resource_id.trim(),
      automation_type: form.automation_type,
      ...buildMetadata(form),
      automation_data: {
        DocumentName: form.docArn || form.docName,
        Parameters: parsedForSubmit,
        ...(isRunCommandNow && {
          InstanceIds: form.instances.split(',').map(s => s.trim()).filter(Boolean),
          Comment: form.comment || `RunStack dispatch ${new Date().toISOString()}`,
        }),
      },
    };

    try {
      const res = await triggerJob(payload);
      setResult({ payload, response: res });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (result) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Topbar title="Run Automation" />
        <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          <Card style={{ maxWidth: 640 }} className="animate-fade">
            <CardHead>
              <span style={{ fontWeight: 600, color: 'var(--green)' }}>✓ Job dispatched successfully</span>
              <StatusBadge status="PENDING" />
            </CardHead>
            <div style={{ padding: '16px 18px', display: 'grid', gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Payload sent</div>
                <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--bg-surface)', padding: 14, borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', overflow: 'auto', margin: 0, color: 'var(--text-primary)' }}>
                  {JSON.stringify(result.payload, null, 2)}
                </pre>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>API response</div>
                <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--bg-surface)', padding: 14, borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', overflow: 'auto', margin: 0, color: 'var(--green)' }}>
                  {JSON.stringify(result.response, null, 2)}
                </pre>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <Btn variant="primary" onClick={() => nav('/jobs')}>View jobs →</Btn>
                <Btn variant="default" onClick={() => { setResult(null); setForm(f => ({ ...f, id: uuidv4() })); }}>Trigger another</Btn>
              </div>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  const isRunCommand = form.automation_type === 'SSM-RunCommand';

  // ── Step completion — same conditions as `missing` below; used to
  // decide whether the next section renders at all (progressive reveal,
  // no step numbers).
  const step1Complete = targetMode === 'catalog'
    ? !!selectedAppId && (environmentsForApp.length === 0 || !!selectedEnvironment) && !!selectedInstanceKey
    : !!form.account_id.trim() && !!form.resource_id.trim();

  const step2Complete = !!form.docName;

  const step3Complete = paramsValid && (!isRunCommand || !!form.instances.trim());

  // Heuristic read of the existing `environment` field — not a new data
  // source — used only to color the target chip amber as a "handle with
  // care" signal for production targets, per spec.
  const currentEnv = selectedEnvironment || form.environment || '';
  const isProdEnv = /prod/i.test(currentEnv);

  // ── Validation — what's missing before Run Automation unlocks ───────────
  const missing = [];
  if (targetMode === 'catalog') {
    if (!selectedAppId) missing.push('Application');
    if (environmentsForApp.length > 0 && !selectedEnvironment) missing.push('Environment');
    if (!selectedInstanceKey) missing.push('Server');
  } else {
    if (!form.account_id.trim()) missing.push('Account ID');
    if (!form.resource_id.trim()) missing.push('Resource ID');
  }
  if (!form.docName) missing.push('SSM document');
  if (!paramsValid) missing.push('Parameters JSON (invalid)');
  if (isRunCommand && !form.instances.trim()) missing.push('Instance IDs');
  const canRun = missing.length === 0;

  const selectedApp = appPickerOptions.find(a => a.value === selectedAppId);
  const selectedDocLabel = form.docName ? humanizeDocName(form.docName) : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Topbar title="Run Automation" subtitle="Choose where the automation should run and what you want RunStack to execute." />
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
        {error && <ErrorBanner message={error} />}
        <div style={{ maxWidth: 1360, margin: '0 auto' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* ── Where do you want to run the automation? — always visible ── */}
            <Card style={{ borderLeft: '3px solid #BFE0DB' }}>
            <CardHead style={{ background: '#F4FAF9' }}>
              <SectionHeader
                title="Where do you want to run the automation?"
                helper="Choose the application, environment, and server you want to work with."
                right={
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {targetMode === 'catalog' && (
                      <Btn variant="ghost" size="sm" onClick={loadInstances} disabled={instancesLoading}>
                        {instancesLoading ? '⏳' : '↺'} Refresh
                      </Btn>
                    )}
                    {canManualEntry && (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <SegButton active={targetMode === 'catalog'} onClick={switchToCatalog}>Pick from catalog</SegButton>
                        <SegButton active={targetMode === 'manual'} onClick={switchToManual}>Enter manually</SegButton>
                      </div>
                    )}
                  </div>
                }
              />
            </CardHead>

            <div style={{ padding: '16px 18px', display: 'grid', gap: 14 }}>
              {targetMode === 'catalog' ? (
                <>
                  {instancesError && (
                    <ErrorBanner message={
                      `Could not load instance catalog: ${instancesError}` +
                      (canManualEntry ? ' — switch to "Enter manually" to continue.' : '')
                    } />
                  )}

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                    <FormRow label="Application" hint={instancesLoading ? 'Loading catalog…' : `${appOptions.length} app(s) available`}>
                      <SearchablePicker
                        value={selectedAppId} onChange={handleAppChange} options={appPickerOptions}
                        placeholder="Search applications…" disabled={instancesLoading || appOptions.length === 0}
                      />
                    </FormRow>

                    <FormRow
                      label="Environment"
                      hint={
                        !selectedAppId ? 'Select an application first'
                        : environmentsForApp.length === 0 ? 'No environment data for this app'
                        : environmentsForApp.length === 1 ? 'Auto-selected — only one environment'
                        : `${environmentsForApp.length} environment(s)`
                      }
                    >
                      <Select
                        value={selectedEnvironment} onChange={handleEnvironmentChange}
                        disabled={!selectedAppId || environmentsForApp.length <= 1}
                      >
                        {environmentsForApp.length === 0 && <option value="">— n/a —</option>}
                        {environmentsForApp.length > 0 && <option value="">— select —</option>}
                        {environmentsForApp.map(env => <option key={env} value={env}>{env}</option>)}
                      </Select>
                    </FormRow>

                    <FormRow
                      label="Server"
                      hint={
                        !selectedAppId ? 'Select an application first'
                        : environmentsForApp.length > 0 && !selectedEnvironment ? 'Select an environment first'
                        : serverOptions.length === 0 ? 'No servers found'
                        : `${serverOptions.length} server(s) · search by name or instance ID`
                      }
                    >
                      <SearchablePicker
                        value={selectedInstanceKey} onChange={handleServerChange} options={serverOptions}
                        placeholder="Search servers…"
                        disabled={!selectedAppId || (environmentsForApp.length > 0 && !selectedEnvironment) || serverOptions.length === 0}
                      />
                    </FormRow>
                  </div>

                  <ResourceSummary form={form} isProdEnv={isProdEnv} />

                  {!canManualEntry && !instancesLoading && instances.length === 0 && (
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                      No instances are available to your account. Contact your RunStack administrator to be granted app access.
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <FormRow label="Account ID" hint="12-digit AWS account">
                      <Input value={form.account_id} onChange={set('account_id')} placeholder="123456789012" maxLength={12} />
                    </FormRow>
                    <FormRow label="Region">
                      <Select value={form.region} onChange={set('region')}>
                        {AWS_REGIONS.map(r => <option key={r}>{r}</option>)}
                      </Select>
                    </FormRow>
                  </div>
                  <FormRow label="Resource ID" hint="EC2 instance ID">
                    <Input value={form.resource_id} onChange={set('resource_id')} placeholder="i-0abc1234def567890" />
                  </FormRow>
                  <ResourceSummary form={form} isProdEnv={isProdEnv} />
                </>
              )}
            </div>
          </Card>

            {/* ── What would you like to run? — reveals once a target is chosen ── */}
            {step1Complete && (
            <Card style={{ borderLeft: '3px solid #9FD2CB' }}>
              <CardHead style={{ background: '#EFF7F5' }}>
                <SectionHeader
                  title="What would you like to run?"
                  helper="Choose the automation that should be executed on the selected server."
                />
              </CardHead>
              <div style={{ padding: '16px 18px', display: 'grid', gap: 16 }}>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <div style={{ width: 220 }}>
                    <FormRow label="Automation type">
                      <Select value={form.automation_type} onChange={set('automation_type')}>
                        {AUTOMATION_TYPES.map(t => <option key={t}>{t}</option>)}
                      </Select>
                    </FormRow>
                  </div>
                  <div style={{ width: 240 }}>
                    <FormRow label="Document source">
                      <Select value={form.docOwner} onChange={set('docOwner')}>
                        <option value="Self">EIT RunStack Custom Documents</option>
                        <option value="Amazon">AWS built-in documents</option>
                      </Select>
                    </FormRow>
                  </div>
                </div>

                <div>
                  <label style={{ fontSize: 13, fontWeight: 700, color: '#0F172A', display: 'block', marginBottom: 6 }}>
                    Automation
                  </label>
                  <SearchablePicker
                    value={form.docName} onChange={setDoc} options={docPickerOptions}
                    placeholder="Search documents…" disabled={docsLoading || docs.length === 0}
                  />
                  <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4, minHeight: 14 }}>
                    {docsLoading ? 'Loading documents…'
                      : docsError ? `Could not load documents: ${docsError}`
                      : docs.length === 0 ? `No ${DOC_TYPE_FOR_AUTOMATION_TYPE[form.automation_type]} documents found for this source`
                      : ''}
                  </div>
                </div>

                {isRunCommand && (
                  <>
                    <FormRow label="Instance IDs" hint="Comma-separated list of EC2 instance IDs — auto-filled from the selected server">
                      <Input value={form.instances} onChange={set('instances')} placeholder="i-0abc123, i-0def456" />
                    </FormRow>
                    <FormRow label="Comment (optional)">
                      <Input value={form.comment} onChange={set('comment')} placeholder="Deployment patching via RunStack" />
                    </FormRow>
                  </>
                )}

                <TechnicalDetails>
                  <div style={{ fontSize: 11.5, color: '#334155', fontFamily: 'var(--font-mono)' }}>
                    {form.docArn || 'AWS-managed document — no account-specific ARN'}
                  </div>
                </TechnicalDetails>
              </div>
            </Card>
          )}

                      {/* ── Review the automation parameters — reveals once an automation is chosen ── */}
            {step2Complete && (
            <Card style={{ borderLeft: '3px solid #7EC4BB' }}>
              <CardHead style={{ background: '#E9F4F1' }}>
                <SectionHeader
                  title="Review the automation parameters"
                  helper="Check the values RunStack will use during execution."
                  right={
                    <button
                      type="button" onClick={() => setShowParamsJson(s => !s)}
                      style={{ background: 'none', border: 'none', color: '#64748B', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
                    >
                      {showParamsJson ? 'Hide advanced' : 'Advanced: Edit JSON'}
                    </button>
                  }
                />
              </CardHead>
              <div style={{ padding: '16px 18px', display: 'grid', gap: 14 }}>
                {!paramsValid ? (
                  <ErrorBanner message="Parameters JSON is invalid — fix it in the JSON view below." />
                ) : Object.keys(parsedParams).length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>This document takes no parameters.</div>
                ) : !showParamsJson && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    {Object.entries(parsedParams).map(([key, val]) => {
                      const isInstanceId = key.toLowerCase() === 'instanceid';
                      const displayVal = Array.isArray(val) ? (val[0] ?? '') : String(val ?? '');
                      if (isInstanceId) {
                        return (
                          <div key={key}>
                            <div style={{ fontSize: 11.5, fontWeight: 600, color: '#334155', marginBottom: 6 }}>{humanizeKey(key)}</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8 }}>
                              <LockIcon />
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: '#334155' }}>{displayVal || '—'}</span>
                            </div>
                            <div style={{ fontSize: 10.5, color: '#94A3B8', marginTop: 4 }}>From selected server</div>
                          </div>
                        );
                      }
                      return (
                        <FormRow key={key} label={humanizeKey(key)}>
                          <Input
                            value={displayVal}
                            onChange={e => updateParamField(key, e.target.value)}
                            placeholder={`Enter ${humanizeKey(key).toLowerCase()}`}
                          />
                        </FormRow>
                      );
                    })}
                  </div>
                )}

                {showParamsJson && (
                  <FormRow label="Parameters (JSON)" hint="Document-specific parameters — advanced editing">
                    <Textarea value={form.params} onChange={set('params')} style={{ minHeight: 120 }} />
                  </FormRow>
                )}
              </div>
            </Card>
          )}

            {/* ── Add additional context — always visible, collapsed by default ── */}
            <Card>
            <CardHead style={{ cursor: 'pointer', background: '#F8FAFC' }} onClick={() => setShowMetadata(s => !s)}>
              <span style={{ fontWeight: 600 }}>Add additional context</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Chip tone="gray">Optional</Chip>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{showMetadata ? '▾' : '▸'}</span>
              </span>
            </CardHead>
            {showMetadata && (
              <div style={{ padding: '16px 18px', display: 'grid', gap: 14 }}>
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: -4 }}>
                  Optionally include information that can help identify or track this execution.
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {METADATA_FIELDS.map(({ key, label, placeholder }) => (
                    <FormRow key={key} label={label}>
                      <Input value={form[key]} onChange={set(key)} placeholder={placeholder} />
                    </FormRow>
                  ))}
                </div>
              </div>
            )}
          </Card>

            {/* ── Review before you run — reveals once parameters are valid ── */}
            {step3Complete && (
            <Card style={{ borderLeft: '3px solid #0F766E' }}>
              <CardHead style={{ background: '#E3F3EE' }}>
                <SectionHeader
                  title="Review before you run"
                  helper="Confirm the target and automation details before starting the execution."
                />
              </CardHead>
              <div style={{ padding: '18px 20px', display: 'grid', gap: 18 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>
                  <div>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 }}>
                      Target
                    </div>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <ReviewRow label="Application" value={selectedApp?.label || (targetMode === 'manual' ? 'Manual entry' : '—')} />
                      <ReviewRow label="Environment" value={selectedEnvironment || form.environment || '—'} />
                      <ReviewRow label="Server" value={form.server_name || form.resource_id || '—'} mono />
                      <ReviewRow label="Instance" value={form.resource_id || '—'} mono />
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 }}>
                      Automation
                    </div>
                    <div style={{ display: 'grid', gap: 8 }}>
                      <ReviewRow label="Automation" value={selectedDocLabel || '—'} />
                      <ReviewRow label="Type" value={form.automation_type} />
                      <ReviewRow label="Document" value={form.docName || '—'} mono />
                      <ReviewRow label="Region" value={form.region || '—'} />
                    </div>
                  </div>
                </div>

                {!canRun && (
                  <div style={{ fontSize: 11.5, color: '#92400E', background: '#FDF3E4', border: '1px solid #F3D9AE', borderRadius: 8, padding: '8px 12px' }}>
                    Missing: {missing.join(', ')}
                  </div>
                )}

                <TechnicalDetails>
                  <div style={{ display: 'grid', gap: 10 }}>
                    <FormRow label="Notification ID" hint="Unique identifier — auto-generated, editable">
                      <Input value={form.id} onChange={set('id')} placeholder="unique-notification-id" />
                    </FormRow>
                    <div style={{ fontSize: 11, color: '#94A3B8' }}>
                      Execution path: SQS → Lambda → DynamoDB → Step Function → SSM
                    </div>
                  </div>
                </TechnicalDetails>

                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
                  <Btn variant="default" onClick={() => nav('/')}>Cancel</Btn>
                  <Btn variant="primary" onClick={handleSubmit} disabled={loading || !canRun}>
                    {loading ? '⏳ Dispatching…' : '▶ Run Automation'}
                  </Btn>
                </div>
              </div>
            </Card>
          )}
          </div>

          {/* Right — collapsible payload preview */}
          <div>
            <Card>
              <CardHead style={{ cursor: 'pointer' }} onClick={() => setShowPayloadPreview(s => !s)}>
                <span style={{ fontWeight: 600, fontSize: 12 }}>Payload Preview</span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{showPayloadPreview ? '▾ Hide' : '▸ View generated API payload'}</span>
              </CardHead>
              {showPayloadPreview && (
                <div style={{ padding: '14px 16px' }}>
                  <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
{JSON.stringify({
  id: form.id,
  region: form.region,
  account_id: form.account_id || 'YOUR_ACCOUNT_ID',
  resource_id: form.resource_id || 'i-0REPLACE',
  automation_type: form.automation_type,
  ...buildMetadata(form),
  automation_data: {
    DocumentName: form.docArn || form.docName || 'NO_DOCUMENT_SELECTED',
    Parameters: parsedParams ?? '(invalid JSON)',
    ...(isRunCommand ? {
      InstanceIds: form.instances ? form.instances.split(',').map(s => s.trim()) : [],
      Comment: form.comment || '',
    } : {}),
  },
}, null, 2)}
                  </pre>
                </div>
              )}
            </Card>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
