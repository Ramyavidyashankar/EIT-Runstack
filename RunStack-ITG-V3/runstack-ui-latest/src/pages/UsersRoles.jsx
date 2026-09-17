// src/pages/UsersRoles.jsx
//
// Redesign per spec: "Users & Access" — three distinct access concepts
// (Role / Application Access / Team Capability) made visually distinct via
// summary cards + tabs, instead of one long page. Zero backend/API changes:
// every function call below (fetchUsers, setUserRole, fetchTeamCapabilities,
// setTeamCapability, deleteTeamCapability, setTeamMeta, fetchCognitoGroups,
// fetchCognitoGroupMembers, fetchAppInstances) is identical to before —
// only how the results are composed/displayed changed.
//
import React from 'react';
import ReactDOM from 'react-dom';
import { Topbar } from '../components/Layout';
import { Card, CardHead, Btn, Select, Input, Spinner, Empty, ErrorBanner } from '../components/ui';
import {
  fetchUsers, setUserRole, fetchAppInstances,
  fetchTeamCapabilities, setTeamCapability, deleteTeamCapability, setTeamMeta,
  fetchCognitoGroups, fetchCognitoGroupMembers,
} from '../api/client';

// ─── DXC tokens (mirrors index.css — see Dashboard.jsx for the same pattern) ──
const C = {
  ink: '#0E1020', textSec: '#3D4160', textTer: '#7A7D95',
  border: '#E2DDD8', surface: '#FFFFFF', tint: '#FAFAF9', canvas: '#F4F0E9',
  orange: '#EE6C24', royal: '#004AAC', blue: '#4995FF',
  green: '#007A52', greenBg: '#E0F5EE', greenBorder: '#A3DEC9',
  red: '#D14600', redBg: '#FDEEE6', redBorder: '#F5C4A8',
  gold: '#B87A00', goldBg: '#FFF4DC', goldBorder: '#FFD980',
};

// ─── Small stroke icons ────────────────────────────────────────────────────
function Icon({ size = 16, color = 'currentColor', children }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}
const IconUsers  = (p) => <Icon {...p}><circle cx="5.5" cy="5" r="2" /><path d="M1.5 13c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5" /><circle cx="11" cy="5.5" r="1.6" /><path d="M10 9.7c1.7.1 3 1.3 3 3.3" /></Icon>;
const IconShield = (p) => <Icon {...p}><path d="M8 1.5l5.5 2v4.2c0 3.4-2.3 5.9-5.5 6.8-3.2-.9-5.5-3.4-5.5-6.8V3.5l5.5-2z" /><path d="M5.5 8l1.8 1.8L10.5 6.2" /></Icon>;
const IconBolt   = (p) => <Icon {...p}><path d="M8.5 1.5L3 9h4l-.5 5.5L13 7H9l-0.5-5.5z" /></Icon>;
const IconEye    = (p) => <Icon {...p}><path d="M1.5 8s2.3-4.5 6.5-4.5S14.5 8 14.5 8s-2.3 4.5-6.5 4.5S1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></Icon>;
const IconBlock  = (p) => <Icon {...p}><circle cx="8" cy="8" r="6" /><path d="M4 4l8 8" /></Icon>;
const IconLayers = (p) => <Icon {...p}><path d="M8 1.5l6 3-6 3-6-3 6-3z" /><path d="M2 8l6 3 6-3" /><path d="M2 11l6 3 6-3" /></Icon>;
const IconGrid   = (p) => <Icon {...p}><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></Icon>;
const IconPlus   = (p) => <Icon {...p}><path d="M8 3v10M3 8h10" /></Icon>;
const IconTrash  = (p) => <Icon {...p}><path d="M3 4.5h10M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M6.5 7.5v4M9.5 7.5v4M4 4.5l.7 8.3a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.3" /></Icon>;
const IconAlert  = (p) => <Icon {...p}><path d="M8 1.5L14.5 13.5H1.5L8 1.5z" /><path d="M8 6v3.5" /><circle cx="8" cy="11.5" r="0.5" fill={p.color} /></Icon>;
const IconGlobe  = (p) => <Icon {...p}><circle cx="8" cy="8" r="6.2" /><path d="M2 8h12M8 1.8c1.7 1.8 2.6 4 2.6 6.2S9.7 12.4 8 14.2C6.3 12.4 5.4 10.2 5.4 8S6.3 3.6 8 1.8z" /></Icon>;
const IconChevronDown = (p) => <Icon {...p}><path d="M4 6l4 4 4-4" /></Icon>;
const IconChevronUp   = (p) => <Icon {...p}><path d="M4 10l4-4 4 4" /></Icon>;

const ROLES = [
  { value: 'admin',    label: 'Admin',      color: C.orange, icon: IconShield },
  { value: 'operator', label: 'Operator',   color: C.royal,  icon: IconBolt },
  { value: 'viewer',   label: 'Viewer',     color: C.green,  icon: IconEye },
  { value: 'none',     label: 'No access',  color: C.red,    icon: IconBlock },
];
const ROLE_META = Object.fromEntries(ROLES.map(r => [r.value, r]));

function parseApps(text) { return text.split(',').map(s => s.trim()).filter(Boolean); }
function appsToText(apps) { return (apps || []).join(', '); }

function initials(email) {
  const name = (email || '').split('@')[0];
  const parts = name.split(/[._-]/).filter(Boolean);
  const chars = parts.length >= 2 ? [parts[0][0], parts[1][0]] : [name.slice(0, 2)];
  return chars.join('').toUpperCase().slice(0, 2);
}

function Avatar({ email, color, size = 30 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: `${color}18`, color, border: `1px solid ${color}40`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.37, fontWeight: 700, fontFamily: 'var(--font-mono)',
    }}>
      {initials(email)}
    </div>
  );
}

function RoleBadge({ role }) {
  const m = ROLE_META[role] || ROLE_META.none;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 20,
      background: `${m.color}16`, color: m.color, border: `1px solid ${m.color}40`,
      fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, whiteSpace: 'nowrap',
    }}>
      {m.icon(11, m.color)} {m.label}
    </span>
  );
}

function SaveStatus({ status }) {
  if (!status) return null;
  const isError = status.type === 'error';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: isError ? C.redBg : C.greenBg,
      color: isError ? C.red : C.green,
      border: `1px solid ${isError ? C.redBorder : C.greenBorder}`,
      whiteSpace: 'nowrap',
    }}>
      {isError ? <IconAlert size={11} color={C.red} /> : '✓'} {isError ? status.message : 'Saved'}
    </span>
  );
}

// ─── App Access picker — checkbox multi-select over the real instance
// catalog, with manual-entry fallback. Unchanged from before. ──────────────
function AppAccessPicker({ value, onChange, catalog, disabled }) {
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState(catalog.length > 0 ? 'checkbox' : 'text');
  const [q, setQ] = React.useState('');
  const [panelPos, setPanelPos] = React.useState(null);
  const btnRef = React.useRef(null);
  const panelRef = React.useRef(null);
  const hadCatalog = React.useRef(catalog.length > 0);

  React.useEffect(() => {
    if (!hadCatalog.current && catalog.length > 0) setMode('checkbox');
    hadCatalog.current = catalog.length > 0;
  }, [catalog.length]);

  React.useEffect(() => {
    function onDocClick(e) {
      if (btnRef.current?.contains(e.target)) return;
      if (panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function openPanel() {
    const r = btnRef.current.getBoundingClientRect();
    setPanelPos({ top: r.bottom + window.scrollY + 4, left: r.left + window.scrollX, width: Math.max(r.width, 260) });
    setOpen(o => !o);
  }

  const selected = parseApps(value);
  const isAll = selected.length === 1 && selected[0] === 'ALL';

  function toggleApp(appId) {
    if (isAll) return;
    const next = selected.includes(appId) ? selected.filter(a => a !== appId) : [...selected, appId];
    onChange(appsToText(next));
  }
  function toggleAll() {
    onChange(isAll ? '' : 'ALL');
  }

  if (mode === 'text') {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <Input value={value} disabled={disabled} placeholder='ALL or app-id1, app-id2' onChange={e => onChange(e.target.value)} style={{ flex: 1 }} />
        {catalog.length > 0 && <Btn variant="ghost" size="sm" onClick={() => setMode('checkbox')}>Pick from list</Btn>}
      </div>
    );
  }

  const filtered = catalog.filter(a => a.toLowerCase().includes(q.toLowerCase()));
  const label = isAll
    ? 'All apps'
    : selected.length === 0
      ? 'Select apps…'
      : selected.length <= 3
        ? selected.join(', ')
        : `${selected.slice(0, 3).join(', ')} +${selected.length - 3} more`;

  return (
    <>
      <button
        ref={btnRef}
        type="button" disabled={disabled} onClick={openPanel}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 12px', borderRadius: 'var(--radius-md)', border: '1px solid #C8C2BB',
          background: C.surface, fontSize: 13, color: isAll || selected.length ? C.ink : C.textTer,
          cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: selected.length && !isAll ? 'var(--font-mono)' : 'inherit', textAlign: 'left',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ marginLeft: 'auto', color: C.textTer, fontSize: 10, flexShrink: 0 }}>▾</span>
      </button>
      {open && panelPos && ReactDOM.createPortal(
        <div ref={panelRef} style={{
          position: 'absolute', zIndex: 1000, top: panelPos.top, left: panelPos.left, width: panelPos.width, maxHeight: 280,
          overflowY: 'auto', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 'var(--radius-md)',
          boxShadow: '0 6px 18px rgba(18,21,28,0.14)', padding: 8,
        }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', fontWeight: 700, fontSize: 12, color: C.ink, borderBottom: `1px solid ${C.canvas}`, marginBottom: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={isAll} onChange={toggleAll} /> All apps
          </label>
          <Input value={q} placeholder="Filter apps…" onChange={e => setQ(e.target.value)} style={{ marginBottom: 6 }} />
          {filtered.length === 0 ? (
            <div style={{ fontSize: 11, color: C.textTer, padding: '6px 4px' }}>No apps match.</div>
          ) : filtered.map(appId => (
            <label key={appId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', fontSize: 12, cursor: isAll ? 'not-allowed' : 'pointer', opacity: isAll ? 0.5 : 1 }}>
              <input type="checkbox" checked={isAll || selected.includes(appId)} disabled={isAll} onChange={() => toggleApp(appId)} />
              <span style={{ fontFamily: 'var(--font-mono)', color: C.textSec }}>{appId}</span>
            </label>
          ))}
          <div style={{ borderTop: `1px solid ${C.canvas}`, marginTop: 6, paddingTop: 6 }}>
            <button type="button" onClick={() => setMode('text')} style={{ background: 'none', border: 'none', color: C.orange, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
              Or type app IDs manually
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// A real <select> once there are known values, "+ Add new" reveals a text
// input. Auto-switches to select mode once options load asynchronously.
function PickOrCreate({ value, onChange, options, placeholder, newLabel }) {
  const NEW_VALUE = '__new__';
  const [mode, setMode] = React.useState(options.length > 0 ? 'select' : 'input');
  const hadOptions = React.useRef(options.length > 0);

  React.useEffect(() => {
    if (!hadOptions.current && options.length > 0 && !value) setMode('select');
    hadOptions.current = options.length > 0;
  }, [options.length]);

  if (mode === 'input') {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <Input value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} style={{ flex: 1 }} />
        {options.length > 0 && (
          <Btn variant="ghost" size="sm" onClick={() => { setMode('select'); onChange(''); }}>Pick existing</Btn>
        )}
      </div>
    );
  }
  return (
    <Select
      value={options.includes(value) ? value : ''}
      onChange={e => {
        if (e.target.value === NEW_VALUE) { setMode('input'); onChange(''); }
        else onChange(e.target.value);
      }}
    >
      <option value="" disabled>{placeholder}</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
      <option value={NEW_VALUE}>{newLabel}</option>
    </Select>
  );
}

// ─── Summary cards ─────────────────────────────────────────────────────────
function SummaryCard({ icon, iconColor, title, blurb, examples, actionLabel, onAction }) {
  return (
    <div style={{
      flex: 1, background: C.surface, border: `1px solid ${C.border}`,
      borderTop: `3px solid ${iconColor}`, borderRadius: 'var(--radius-lg)', padding: '16px 18px',
      display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ width: 28, height: 28, borderRadius: 7, background: `${iconColor}16`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {icon(15, iconColor)}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: C.ink }}>{title}</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.textSec, lineHeight: 1.5 }}>{blurb}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {examples.map(ex => (
          <span key={ex} style={{ fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 12, background: C.canvas, color: C.textSec, fontFamily: 'var(--font-mono)' }}>
            {ex}
          </span>
        ))}
      </div>
      <button
        onClick={onAction}
        style={{
          marginTop: 'auto', alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0,
          color: iconColor, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        {actionLabel} →
      </button>
    </div>
  );
}

// ─── Tabs ───────────────────────────────────────────────────────────────────
function Tabs({ tabs, active, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 18 }}>
      {tabs.map(t => {
        const isActive = t.value === active;
        return (
          <button
            key={t.value}
            onClick={() => onChange(t.value)}
            style={{
              padding: '9px 16px', fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              background: 'none', border: 'none', borderBottom: `2px solid ${isActive ? C.orange : 'transparent'}`,
              color: isActive ? C.ink : C.textTer, cursor: 'pointer', marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TAB 1 — Users & Roles
// ══════════════════════════════════════════════════════════════════════════
function UsersRolesTab({ users, loading, loadError, appCatalog, teamByEmail, onSaveApps, savingEmail, rowStatus, load }) {
  const [roleFilter, setRoleFilter] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [manageEmail, setManageEmail] = React.useState(null);
  const [manageAppsText, setManageAppsText] = React.useState('');
  const [showRoleInfo, setShowRoleInfo] = React.useState(false);
  const [showAddUser, setShowAddUser] = React.useState(false);
  const [addForm, setAddForm] = React.useState({ email: '', apps: '' });
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState(null);

  const roleCounts = React.useMemo(() => {
    const counts = { all: users.length, admin: 0, operator: 0, viewer: 0, none: 0 };
    users.forEach(u => { counts[u.role] = (counts[u.role] || 0) + 1; });
    return counts;
  }, [users]);

  const filteredUsers = React.useMemo(() => {
    let list = users;
    if (roleFilter !== 'all') list = list.filter(u => u.role === roleFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(u => u.email.toLowerCase().includes(q));
    }
    return list;
  }, [users, roleFilter, search]);

  function openManage(u) {
    setManageEmail(manageEmail === u.email ? null : u.email);
    setManageAppsText(appsToText(u.apps));
    setShowRoleInfo(false);
  }

  async function saveManageApps(email) {
    await onSaveApps(email, manageAppsText);
  }

  async function handleAddUser() {
    const email = addForm.email.trim();
    if (!email) { setAddError('Enter an email address.'); return; }
    const appsList = parseApps(addForm.apps);
    if (appsList.length === 0) { setAddError('Grant at least one app, or "ALL".'); return; }
    setAdding(true);
    setAddError(null);
    try {
      await setUserRole(email, { apps: appsList });
      setAddForm({ email: '', apps: '' });
      setShowAddUser(false);
      await load();
    } catch (e) {
      setAddError(e.message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Users {users.length > 0 && `(${users.length})`}</div>
        <Btn variant="primary" size="sm" onClick={() => setShowAddUser(s => !s)}>
          <IconPlus size={12} color="#fff" /> Add User
        </Btn>
      </div>

      {showAddUser && (
        <Card style={{ marginBottom: 16, padding: 14 }}>
          <div style={{ fontSize: 11, color: C.textTer, marginBottom: 10, lineHeight: 1.6 }}>
            This grants app access. To make someone Admin/Operator/Viewer, add them to the matching Cognito group directly — there's no role field here.
          </div>
          {addError && <ErrorBanner message={addError} />}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '2 1 220px' }}>
              <div style={{ fontSize: 11, color: C.textTer, marginBottom: 4 }}>Email</div>
              <Input value={addForm.email} placeholder="user@company.com" onChange={(e) => setAddForm(p => ({ ...p, email: e.target.value }))} />
            </div>
            <div style={{ flex: '2 1 220px' }}>
              <div style={{ fontSize: 11, color: C.textTer, marginBottom: 4 }}>Applications</div>
              <AppAccessPicker value={addForm.apps} catalog={appCatalog} onChange={(v) => setAddForm(p => ({ ...p, apps: v }))} />
            </div>
            <Btn variant="primary" onClick={handleAddUser} disabled={adding}>
              {adding ? <><Spinner size={13} /> Saving…</> : 'Grant access'}
            </Btn>
          </div>
        </Card>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {[{ value: 'all', label: 'All', color: C.textSec }, ...ROLES.map(r => ({ value: r.value, label: r.label, color: r.color }))].map(tab => {
          const active = roleFilter === tab.value;
          const count = tab.value === 'all' ? roleCounts.all : (roleCounts[tab.value] || 0);
          return (
            <button
              key={tab.value}
              onClick={() => setRoleFilter(tab.value)}
              style={{
                padding: '4px 11px', borderRadius: 20, fontSize: 11.5, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit',
                background: active ? `${tab.color}16` : 'transparent',
                color: active ? tab.color : C.textTer,
                border: `1px solid ${active ? `${tab.color}50` : C.border}`,
              }}
            >
              {tab.label} <span style={{ opacity: 0.75 }}>({count})</span>
            </button>
          );
        })}
      </div>
      <Input value={search} placeholder="Search users by email…" onChange={e => setSearch(e.target.value)} style={{ maxWidth: 280, marginBottom: 14 }} />

      <Card>
        {loadError && <div style={{ padding: 14 }}><ErrorBanner message={loadError} /></div>}
        {loading ? (
          <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : users.length === 0 ? (
          <Empty message="No users found." />
        ) : filteredUsers.length === 0 ? (
          <Empty message="No users match the current filter or search." />
        ) : (
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '8px 18px', borderBottom: `1px solid ${C.border}`,
              fontSize: 10, fontWeight: 600, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.5,
            }}>
              <div style={{ width: 30, flexShrink: 0 }} />
              <div style={{ width: 190, flexShrink: 0 }}>User</div>
              <div style={{ width: 120, flexShrink: 0 }}>Role</div>
              <div style={{ width: 140, flexShrink: 0 }}>Applications</div>
              <div style={{ width: 100, flexShrink: 0 }}>Team</div>
              <div style={{ flex: 1 }}>&nbsp;</div>
            </div>

            {filteredUsers.map(u => {
              const isOpen = manageEmail === u.email;
              const isSaving = savingEmail === u.email;
              const status = rowStatus[u.email];
              const appsCount = u.apps?.[0] === 'ALL' ? 'All apps' : `${(u.apps || []).length} app${(u.apps || []).length === 1 ? '' : 's'}`;
              const team = teamByEmail[u.email.toLowerCase()];
              return (
                <div key={u.email}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px',
                    borderBottom: isOpen ? 'none' : `1px solid ${C.border}`, fontSize: 12,
                    background: isOpen ? C.tint : 'transparent',
                  }}>
                    <div style={{ width: 30, flexShrink: 0 }}><Avatar email={u.email} color={(ROLE_META[u.role] || ROLE_META.none).color} /></div>
                    <div style={{ width: 190, flexShrink: 0, color: C.ink, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.email}>{u.email}</div>
                    <div style={{ width: 120, flexShrink: 0 }}><RoleBadge role={u.role} /></div>
                    <div style={{ width: 140, flexShrink: 0, color: C.textSec, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{appsCount}</div>
                    <div style={{ width: 100, flexShrink: 0, color: C.textTer, fontSize: 11.5 }}>{team || '—'}</div>
                    <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
                      {status && <SaveStatus status={status} />}
                      <Btn variant="default" size="sm" onClick={() => openManage(u)}>
                        Manage {isOpen ? <IconChevronUp size={11} color={C.textSec} /> : <IconChevronDown size={11} color={C.textSec} />}
                      </Btn>
                    </div>
                  </div>

                  {isOpen && (
                    <div style={{ padding: '14px 18px 18px 60px', background: C.tint, borderBottom: `1px solid ${C.border}` }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 14 }}>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Role</div>
                          <RoleBadge role={u.role} />
                          <div style={{ marginTop: 8 }}>
                            <Btn variant="ghost" size="sm" onClick={() => setShowRoleInfo(s => !s)}>Change Role</Btn>
                          </div>
                          {showRoleInfo && (
                            <div style={{ marginTop: 8, fontSize: 11, color: C.textSec, lineHeight: 1.6, maxWidth: 320 }}>
                              Role comes from Cognito group membership — add or remove <b>{u.email}</b> from
                              {' '}<code style={{ fontFamily: 'var(--font-mono)' }}>runstack-admins</code> / <code style={{ fontFamily: 'var(--font-mono)' }}>runstack-operators</code> / <code style={{ fontFamily: 'var(--font-mono)' }}>runstack-readonly</code> in Cognito to change this.
                            </div>
                          )}
                        </div>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Team membership</div>
                          <div style={{ fontSize: 12.5, color: C.ink }}>{team || 'Not on any team'}</div>
                        </div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Application access</div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', maxWidth: 480 }}>
                          <AppAccessPicker value={manageAppsText} disabled={isSaving} catalog={appCatalog} onChange={setManageAppsText} />
                          <Btn variant="primary" size="sm" onClick={() => saveManageApps(u.email)} disabled={isSaving || manageAppsText === appsToText(u.apps)}>
                            {isSaving ? <Spinner size={12} /> : 'Save'}
                          </Btn>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TAB 2 — Application Access
// ══════════════════════════════════════════════════════════════════════════
function AppAccessTab({ users, loading, appCatalog, onSaveApps, savingEmail, rowStatus }) {
  const [grantEmail, setGrantEmail] = React.useState('');
  const [grantApps, setGrantApps] = React.useState('');
  const [granting, setGranting] = React.useState(false);
  const [grantError, setGrantError] = React.useState(null);
  const [manageEmail, setManageEmail] = React.useState(null);
  const [manageAppsText, setManageAppsText] = React.useState('');

  const usersWithApps = users.filter(u => (u.apps || []).length > 0);
  const userEmails = users.map(u => u.email);

  async function grant() {
    const email = grantEmail.trim();
    if (!email) { setGrantError('Select or enter a user.'); return; }
    const appsList = parseApps(grantApps);
    if (appsList.length === 0) { setGrantError('Select at least one application.'); return; }
    setGranting(true);
    setGrantError(null);
    try {
      const existing = users.find(u => u.email.toLowerCase() === email.toLowerCase());
      const merged = [...new Set([...(existing?.apps || []), ...appsList])];
      await onSaveApps(email, appsToText(merged), true);
      setGrantEmail('');
      setGrantApps('');
    } catch (e) {
      setGrantError(e.message);
    } finally {
      setGranting(false);
    }
  }

  function openManage(u) {
    setManageEmail(manageEmail === u.email ? null : u.email);
    setManageAppsText(appsToText(u.apps));
  }

  return (
    <div>
      <Card style={{ marginBottom: 20 }}>
        <CardHead>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconGrid size={13} color={C.textSec} />
            <span style={{ fontSize: 12, fontWeight: 600, color: C.ink }}>Grant application access</span>
          </div>
        </CardHead>
        <div style={{ padding: 16 }}>
          {grantError && <ErrorBanner message={grantError} />}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 220px' }}>
              <div style={{ fontSize: 11, color: C.textTer, marginBottom: 4 }}>User</div>
              <PickOrCreate value={grantEmail} onChange={setGrantEmail} options={userEmails} placeholder="Select a user" newLabel="+ New user" />
            </div>
            <div style={{ flex: '2 1 260px' }}>
              <div style={{ fontSize: 11, color: C.textTer, marginBottom: 4 }}>Applications</div>
              <AppAccessPicker value={grantApps} catalog={appCatalog} onChange={setGrantApps} />
            </div>
            <Btn variant="primary" onClick={grant} disabled={granting}>
              {granting ? <><Spinner size={13} /> Granting…</> : 'Grant access'}
            </Btn>
          </div>
        </div>
      </Card>

      <div style={{ fontSize: 13, fontWeight: 700, color: C.ink, marginBottom: 10 }}>
        Existing assignments {usersWithApps.length > 0 && `(${usersWithApps.length})`}
      </div>
      <Card>
        {loading ? (
          <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        ) : usersWithApps.length === 0 ? (
          <Empty message="No application access grants yet." />
        ) : (
          <div>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '8px 18px', borderBottom: `1px solid ${C.border}`,
              fontSize: 10, fontWeight: 600, color: C.textTer, textTransform: 'uppercase', letterSpacing: 0.5,
            }}>
              <div style={{ width: 210, flexShrink: 0 }}>User</div>
              <div style={{ flex: 1 }}>Applications</div>
              <div style={{ width: 100, flexShrink: 0, textAlign: 'right' }}>Actions</div>
            </div>
            {usersWithApps.map(u => {
              const isOpen = manageEmail === u.email;
              const isSaving = savingEmail === u.email;
              const status = rowStatus[u.email];
              return (
                <div key={u.email}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px', borderBottom: isOpen ? 'none' : `1px solid ${C.border}`, fontSize: 12, background: isOpen ? C.tint : 'transparent' }}>
                    <div style={{ width: 210, flexShrink: 0, color: C.ink, fontWeight: 500 }}>{u.email}</div>
                    <div style={{ flex: 1, color: C.textSec, fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{appsToText(u.apps)}</div>
                    <div style={{ width: 100, flexShrink: 0, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
                      {status && <SaveStatus status={status} />}
                      <Btn variant="default" size="sm" onClick={() => openManage(u)}>
                        Manage {isOpen ? <IconChevronUp size={11} color={C.textSec} /> : <IconChevronDown size={11} color={C.textSec} />}
                      </Btn>
                    </div>
                  </div>
                  {isOpen && (
                    <div style={{ padding: '12px 18px 16px', background: C.tint, borderBottom: `1px solid ${C.border}`, display: 'flex', gap: 8, alignItems: 'center' }}>
                      <div style={{ flex: 1, maxWidth: 480 }}>
                        <AppAccessPicker value={manageAppsText} disabled={isSaving} catalog={appCatalog} onChange={setManageAppsText} />
                      </div>
                      <Btn variant="primary" size="sm" onClick={() => onSaveApps(u.email, manageAppsText)} disabled={isSaving || manageAppsText === appsToText(u.apps)}>
                        {isSaving ? <Spinner size={12} /> : 'Save'}
                      </Btn>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// TAB 3 — Team Capabilities
// ══════════════════════════════════════════════════════════════════════════
function TeamCapabilitiesTab({ capabilities, teamsMeta, loading, loadError, load, cognitoGroups }) {
  const [openTeam, setOpenTeam] = React.useState(null);
  const [showAdd, setShowAdd] = React.useState(false);

  const [form, setForm] = React.useState({ team: '', capability: '', enabled: true, scopeType: 'ALL', scopeText: '' });
  const [formError, setFormError] = React.useState(null);
  const [saving, setSaving] = React.useState(false);

  const [metaTeam, setMetaTeam] = React.useState(null);
  const [metaForm, setMetaForm] = React.useState({ cognitoGroup: '', description: '' });
  const [metaSaving, setMetaSaving] = React.useState(false);

  const teams = [...new Set([...capabilities.map(c => c.team), ...teamsMeta.map(t => t.team)])].sort();
  const knownCapabilities = [...new Set(capabilities.map(c => c.capability))].sort();
  const metaByTeam = Object.fromEntries(teamsMeta.map(t => [t.team, t]));

  async function addOrUpdateCapability() {
    const team = form.team.trim();
    const capability = form.capability.trim();
    if (!team || !capability) { setFormError('Team and capability are both required.'); return; }
    if (capability === '_meta') { setFormError('"_meta" is reserved — use the Cognito group editor instead.'); return; }
    let scope = 'ALL';
    if (form.scopeType === 'list') {
      scope = form.scopeText.split(',').map(s => s.trim()).filter(Boolean);
      if (scope.length === 0) { setFormError('Enter at least one resource ID, or switch scope to "All resources".'); return; }
    }
    setFormError(null);
    setSaving(true);
    try {
      await setTeamCapability(team, capability, { enabled: form.enabled, scope });
      await load();
      setForm({ team: '', capability: '', enabled: true, scopeType: 'ALL', scopeText: '' });
      setShowAdd(false);
      setOpenTeam(team);
    } catch (e) {
      setFormError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(row) {
    try { await setTeamCapability(row.team, row.capability, { enabled: !row.enabled }); await load(); }
    catch (e) { setFormError(e.message); }
  }
  async function removeCapability(row) {
    try { await deleteTeamCapability(row.team, row.capability); await load(); }
    catch (e) { setFormError(e.message); }
  }

  function openMetaEditor(team) {
    const meta = metaByTeam[team];
    setMetaForm({ cognitoGroup: meta?.cognito_group || `runstack-team-${team}`, description: meta?.description || '' });
    setMetaTeam(team);
  }
  async function saveMeta() {
    setMetaSaving(true);
    try { await setTeamMeta(metaTeam, { cognitoGroup: metaForm.cognitoGroup.trim(), description: metaForm.description.trim() }); await load(); setMetaTeam(null); }
    catch (e) { setFormError(e.message); }
    finally { setMetaSaving(false); }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>Teams {teams.length > 0 && `(${teams.length})`}</div>
        <Btn variant="primary" size="sm" onClick={() => setShowAdd(s => !s)}>
          <IconPlus size={12} color="#fff" /> Add Team Capability
        </Btn>
      </div>

      {loadError && <ErrorBanner message={loadError} />}
      {formError && <ErrorBanner message={formError} />}

      {showAdd && (
        <Card style={{ marginBottom: 20, padding: 16 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 6 }}>
            <div style={{ flex: '1 1 160px' }}>
              <div style={{ fontSize: 11, color: C.textTer, marginBottom: 4 }}>Team</div>
              <PickOrCreate value={form.team} onChange={v => setForm(p => ({ ...p, team: v }))} options={teams} placeholder="Select a team" newLabel="+ New team" />
            </div>
            <div style={{ flex: '1 1 200px' }}>
              <div style={{ fontSize: 11, color: C.textTer, marginBottom: 4 }}>Capability</div>
              <PickOrCreate value={form.capability} onChange={v => setForm(p => ({ ...p, capability: v }))} options={knownCapabilities} placeholder="Select a capability" newLabel="+ New capability" />
            </div>
            <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 8 }}>
              <input type="checkbox" id="cap-enabled" checked={form.enabled} onChange={e => setForm(p => ({ ...p, enabled: e.target.checked }))} />
              <label htmlFor="cap-enabled" style={{ fontSize: 12, color: C.textSec }}>Enabled</label>
            </div>
            <div style={{ flex: '1 1 150px' }}>
              <div style={{ fontSize: 11, color: C.textTer, marginBottom: 4 }}>Scope</div>
              <Select value={form.scopeType} onChange={e => setForm(p => ({ ...p, scopeType: e.target.value }))}>
                <option value="ALL">All resources</option>
                <option value="list">Specific resource IDs</option>
              </Select>
            </div>
            {form.scopeType === 'list' && (
              <div style={{ flex: '2 1 220px' }}>
                <div style={{ fontSize: 11, color: C.textTer, marginBottom: 4 }}>Resource IDs (comma-separated)</div>
                <Input value={form.scopeText} placeholder="SANDBOX-GDBA-AG, i-0abc123" onChange={e => setForm(p => ({ ...p, scopeText: e.target.value }))} />
              </div>
            )}
            <Btn variant="primary" onClick={addOrUpdateCapability} disabled={saving}>
              {saving ? <><Spinner size={13} /> Saving…</> : 'Save capability'}
            </Btn>
          </div>
        </Card>
      )}

      {loading ? (
        <div style={{ padding: 32, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
      ) : teams.length === 0 ? (
        <Empty message='No teams yet — click "Add Team Capability" to create one.' />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
          {teams.map(team => {
            const rows = capabilities.filter(c => c.team === team);
            const enabledCount = rows.filter(r => r.enabled).length;
            const isOpen = openTeam === team;
            const meta = metaByTeam[team];
            return (
              <Card key={team} style={{ padding: 16, gridColumn: isOpen ? '1 / -1' : undefined }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <IconUsers size={13} color={C.royal} />
                      <span style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{team}</span>
                    </div>
                    <div style={{ fontSize: 11, color: C.textTer, marginTop: 2 }}>
                      {rows.length} capabilit{rows.length === 1 ? 'y' : 'ies'} · {enabledCount} enabled
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 12 }}>
                  {rows.length === 0 ? (
                    <span style={{ fontSize: 11, color: C.textTer }}>No capabilities yet</span>
                  ) : rows.map(r => (
                    <span key={r.capability} style={{
                      fontSize: 10.5, fontWeight: 600, padding: '3px 9px', borderRadius: 12,
                      background: r.enabled ? C.greenBg : C.canvas, color: r.enabled ? C.green : C.textTer,
                      border: `1px solid ${r.enabled ? C.greenBorder : C.border}`, fontFamily: 'var(--font-mono)',
                    }}>
                      {r.capability}
                    </span>
                  ))}
                </div>
                <Btn variant="default" size="sm" onClick={() => setOpenTeam(isOpen ? null : team)}>
                  Manage Capabilities {isOpen ? <IconChevronUp size={11} color={C.textSec} /> : <IconChevronDown size={11} color={C.textSec} />}
                </Btn>

                {isOpen && (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <span style={{ fontSize: 11, color: C.textTer }}>Cognito group:</span>
                      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: C.textSec }}>
                        {meta ? meta.cognito_group : `runstack-team-${team} (default)`}
                      </code>
                      <Btn variant="ghost" size="sm" onClick={() => openMetaEditor(team)}>Edit group</Btn>
                    </div>

                    {metaTeam === team && (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 12, padding: 10, background: C.tint, border: `1px solid ${C.border}`, borderRadius: 'var(--radius-md)' }}>
                        <div style={{ flex: '1 1 200px' }}>
                          <div style={{ fontSize: 10.5, color: C.textTer, marginBottom: 4 }}>Cognito group</div>
                          <PickOrCreate value={metaForm.cognitoGroup} onChange={v => setMetaForm(p => ({ ...p, cognitoGroup: v }))} options={cognitoGroups} placeholder="Select a group" newLabel="+ Type manually" />
                        </div>
                        <div style={{ flex: '1 1 200px' }}>
                          <div style={{ fontSize: 10.5, color: C.textTer, marginBottom: 4 }}>Description</div>
                          <Input value={metaForm.description} onChange={e => setMetaForm(p => ({ ...p, description: e.target.value }))} />
                        </div>
                        <Btn variant="primary" size="sm" onClick={saveMeta} disabled={metaSaving}>{metaSaving ? <Spinner size={12} /> : 'Save'}</Btn>
                        <Btn variant="ghost" size="sm" onClick={() => setMetaTeam(null)}>Cancel</Btn>
                      </div>
                    )}

                    {rows.length > 0 && (
                      <div style={{ border: `1px solid ${C.border}`, borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: 12 }}>
                        {rows.map(row => (
                          <div key={row.capability} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: `1px solid ${C.canvas}`, fontSize: 12 }}>
                            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: C.royal, background: '#EBF2FF', padding: '2px 7px', borderRadius: 4 }}>{row.capability}</code>
                            <span onClick={() => toggleEnabled(row)} style={{
                              cursor: 'pointer', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                              background: row.enabled ? C.greenBg : C.redBg, color: row.enabled ? C.green : C.red,
                              border: `1px solid ${row.enabled ? C.greenBorder : C.redBorder}`,
                            }}>
                              {row.enabled ? 'Enabled' : 'Disabled'}
                            </span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.textTer }}>
                              {row.scope === 'ALL' ? <><IconGlobe size={11} color={C.textTer} /> all resources</> : `→ ${(row.scope || []).join(', ')}`}
                            </span>
                            <Btn variant="ghost" size="sm" style={{ marginLeft: 'auto', color: C.red }} onClick={() => removeCapability(row)}>
                              <IconTrash size={12} color={C.red} />
                            </Btn>
                          </div>
                        ))}
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                      <div style={{ flex: '1 1 200px' }}>
                        <div style={{ fontSize: 11, color: C.textTer, marginBottom: 4 }}>New capability</div>
                        <PickOrCreate value={form.team === team ? form.capability : ''} onChange={v => setForm({ team, capability: v, enabled: true, scopeType: 'ALL', scopeText: '' })} options={knownCapabilities} placeholder="Capability name" newLabel="+ New capability" />
                      </div>
                      <Btn variant="default" size="sm" onClick={() => { setForm(p => ({ ...p, team })); setShowAdd(true); }}>
                        Configure & save →
                      </Btn>
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// Main page
// ══════════════════════════════════════════════════════════════════════════
export default function UsersRoles() {
  const [users, setUsers] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [savingEmail, setSavingEmail] = React.useState(null);
  const [rowStatus, setRowStatus] = React.useState({});
  const statusTimers = React.useRef({});

  const [appCatalog, setAppCatalog] = React.useState([]);
  const [cognitoGroups, setCognitoGroups] = React.useState([]);

  const [capabilities, setCapabilities] = React.useState([]);
  const [teamsMeta, setTeamsMeta] = React.useState([]);
  const [capLoading, setCapLoading] = React.useState(true);
  const [capError, setCapError] = React.useState(null);

  const [teamByEmail, setTeamByEmail] = React.useState({});

  const [activeTab, setActiveTab] = React.useState('roles');

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchUsers();
      setUsers(res.users || []);
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadCapabilities = React.useCallback(async () => {
    setCapLoading(true);
    setCapError(null);
    try {
      const res = await fetchTeamCapabilities();
      setCapabilities(res.capabilities || []);
      setTeamsMeta(res.teams_meta || []);
    } catch (e) {
      setCapError(e.message);
    } finally {
      setCapLoading(false);
    }
  }, []);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => { loadCapabilities(); }, [loadCapabilities]);
  React.useEffect(() => () => { Object.values(statusTimers.current).forEach(clearTimeout); }, []);

  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetchAppInstances();
        const ids = [...new Set((res.instances || []).map(i => i.app_id).filter(Boolean))].sort();
        setAppCatalog(ids);
      } catch (e) {
        console.warn('Could not load app catalog:', e.message);
      }
    })();
    (async () => {
      try {
        const res = await fetchCognitoGroups();
        setCognitoGroups((res.groups || []).map(g => g.group_name));
      } catch (e) {
        console.warn('Could not load Cognito groups:', e.message);
      }
    })();
  }, []);

  // Team membership per user — needed for the "Team" column. Not previously
  // computed anywhere; derived here by checking real membership of each
  // known team's Cognito group (same fetchCognitoGroupMembers already used
  // elsewhere), once team-capabilities has loaded.
  React.useEffect(() => {
    if (capLoading) return;
    const teams = [...new Set([...capabilities.map(c => c.team), ...teamsMeta.map(t => t.team)])];
    if (teams.length === 0) { setTeamByEmail({}); return; }
    const metaByTeam = Object.fromEntries(teamsMeta.map(t => [t.team, t]));
    (async () => {
      const map = {};
      await Promise.all(teams.map(async team => {
        const group = metaByTeam[team]?.cognito_group || `runstack-team-${team}`;
        try {
          const res = await fetchCognitoGroupMembers(group);
          (res.members || []).forEach(m => {
            const key = (m.email || '').toLowerCase();
            if (!key) return;
            map[key] = map[key] ? `${map[key]}, ${team}` : team;
          });
        } catch (e) {
          console.warn(`Could not load members of ${group}:`, e.message);
        }
      }));
      setTeamByEmail(map);
    })();
  }, [capLoading, capabilities, teamsMeta]);

  function showRowStatus(email, status, ttl = 2200) {
    setRowStatus(prev => ({ ...prev, [email]: status }));
    if (statusTimers.current[email]) clearTimeout(statusTimers.current[email]);
    if (status && status.type === 'success') {
      statusTimers.current[email] = setTimeout(() => {
        setRowStatus(prev => { const next = { ...prev }; delete next[email]; return next; });
      }, ttl);
    }
  }

  // Shared save-apps handler used by all three tabs.
  async function saveApps(email, appsText, silent = false) {
    setSavingEmail(email);
    if (!silent) showRowStatus(email, null);
    try {
      const res = await setUserRole(email, { apps: parseApps(appsText) });
      setUsers(prev => {
        const exists = prev.some(u => u.email === email);
        if (exists) return prev.map(u => u.email === email ? { ...u, apps: res.apps ?? u.apps } : u);
        return [...prev, { email, role: 'none', apps: res.apps ?? [] }];
      });
      showRowStatus(email, { type: 'success' });
    } catch (err) {
      showRowStatus(email, { type: 'error', message: err.message || 'Save failed' });
      throw err;
    } finally {
      setSavingEmail(null);
    }
  }

  const totalCapabilities = capabilities.length;
  const teamNames = [...new Set(capabilities.map(c => c.team))];
  const appExamples = appCatalog.slice(0, 3).length > 0 ? appCatalog.slice(0, 3) : ['500067', '500579', '700001'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.canvas }}>
      <Topbar
        title="Users & Access"
        subtitle="Manage user roles, application access, and team-specific capabilities."
        actions={<Btn variant="default" size="sm" onClick={() => { load(); loadCapabilities(); }}>Refresh</Btn>}
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>

        {/* ── Summary cards ─────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 14, marginBottom: 22, flexWrap: 'wrap' }}>
          <SummaryCard
            icon={IconShield} iconColor={C.orange} title="User Roles"
            blurb="Controls what users can do — set via Cognito group membership."
            examples={['Admin', 'Operator', 'Viewer']}
            actionLabel="Manage Users" onAction={() => setActiveTab('roles')}
          />
          <SummaryCard
            icon={IconGrid} iconColor={C.royal} title="Application Access"
            blurb="Controls which applications a user can act on."
            examples={appExamples}
            actionLabel="Manage App Access" onAction={() => setActiveTab('apps')}
          />
          <SummaryCard
            icon={IconLayers} iconColor={C.green} title="Team Capabilities"
            blurb={`Controls specialized team functions — ${totalCapabilities} capabilit${totalCapabilities === 1 ? 'y' : 'ies'} configured.`}
            examples={teamNames.length > 0 ? teamNames : ['GDBA', 'SAP', 'Tidal']}
            actionLabel="Manage Capabilities" onAction={() => setActiveTab('capabilities')}
          />
        </div>

        <Tabs
          active={activeTab}
          onChange={setActiveTab}
          tabs={[
            { value: 'roles', label: 'Users & Roles' },
            { value: 'apps', label: 'Application Access' },
            { value: 'capabilities', label: 'Team Capabilities' },
          ]}
        />

        {activeTab === 'roles' && (
          <UsersRolesTab
            users={users} loading={loading} loadError={loadError} appCatalog={appCatalog}
            teamByEmail={teamByEmail} onSaveApps={saveApps} savingEmail={savingEmail} rowStatus={rowStatus} load={load}
          />
        )}
        {activeTab === 'apps' && (
          <AppAccessTab
            users={users} loading={loading} appCatalog={appCatalog}
            onSaveApps={saveApps} savingEmail={savingEmail} rowStatus={rowStatus}
          />
        )}
        {activeTab === 'capabilities' && (
          <TeamCapabilitiesTab
            capabilities={capabilities} teamsMeta={teamsMeta} loading={capLoading} loadError={capError}
            load={loadCapabilities} cognitoGroups={cognitoGroups}
          />
        )}
      </div>
    </div>
  );
}
