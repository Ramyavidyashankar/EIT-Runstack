// src/pages/UsersRoles.jsx — Users & Access
//
// Three different kinds of access, kept visibly separate:
//   Platform role      — Cognito role group, synced from Azure AD. Read-only
//                        here (set_user_role rejects role changes).
//   EC2 applications   — runstack-app-access rows. Only affects EC2 actions.
//   Team permissions   — team Cognito group + runstack-team-capabilities.
//                        Only affects SQL / SAP / Tidal actions.
//
// "Assigned" and "can use" are shown separately. Whether an assignment is
// usable comes from the backend (process_messages/access_review.py), which
// applies the same rules as authorize_action — the UI never decides that
// an assignment grants access on its own.
//
// Colours: blue = actions, selection, roles and user chips (neutral — an
// assigned user is not a status); green = confirmed active; amber =
// assigned but inactive / name unavailable; red = can never work; grey = none.
// Every status colour is shown with a text label.

import React from 'react';
import ReactDOM from 'react-dom';
import { Topbar } from '../components/Layout';
import { Badge, Btn, Empty, ErrorBanner, Input, Select, Spinner } from '../components/ui';
import Tabs, { tabPanelProps } from '../components/Tabs';
import { Callout } from '../components/sections';
import {
  fetchUsers, setUserRole, fetchTeamCapabilities, setTeamCapability, deleteTeamCapability,
  setTeamMeta, fetchCognitoGroups,
} from '../api/client';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { usePersistentState } from '../hooks/useNavigation';
import { copyText } from '../utils/jobs';

// ─── Status vocabulary ───────────────────────────────────────────────────────
const TONE = {
  active:       { fg: '#0B6E4C', bg: '#E4F8F0', border: '#A9E7CD', dot: '#0F9D6D' },
  partial:      { fg: '#92400E', bg: '#FEF3E2', border: '#FBDCA0', dot: '#D97706' },
  inactive:     { fg: '#92400E', bg: '#FEF3E2', border: '#FBDCA0', dot: '#D97706' },
  invalid:      { fg: '#B91C1C', bg: '#FDECEC', border: '#F7B9B9', dot: '#DC2626' },
  none:         { fg: '#52647A', bg: '#F4F6FA', border: '#D7E0EB', dot: '#52647A' },
  not_enforced: { fg: '#52647A', bg: '#F4F6FA', border: '#D7E0EB', dot: '#52647A' },
  read_only:    { fg: '#52647A', bg: '#F4F6FA', border: '#D7E0EB', dot: '#52647A' },
};
const STATUS_LABEL = {
  active: 'Active', partial: 'Partly active', inactive: 'Inactive', invalid: 'Needs fixing',
  none: 'No access', not_enforced: 'Not enforced', read_only: 'Read-only',
};
const ITEM_LABEL = { active: 'Active', inactive: 'Inactive', invalid: 'Needs fixing', not_enforced: 'Not enforced' };
const STATUS_FILTERS = ['all', 'active', 'partial', 'inactive', 'invalid', 'read_only', 'none'];
const TEAL = 'var(--brand)';

function StatusPill({ status, label, title }) {
  const t = TONE[status] || TONE.none;
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 9px', borderRadius: 999,
      fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
      color: t.fg, background: t.bg, border: `1px solid ${t.border}`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.dot }} />
      {label || STATUS_LABEL[status] || status}
    </span>
  );
}

function Mono({ children, dim }) {
  return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: dim ? '#52647A' : '#52647A' }}>{children}</span>;
}

function CopyInline({ value }) {
  const [done, setDone] = React.useState(false);
  if (!value) return null;
  return (
    <button type="button" onClick={async (e) => { e.stopPropagation(); if (await copyText(value)) { setDone(true); setTimeout(() => setDone(false), 1400); } }}
      title={`Copy ${value}`} aria-label={`Copy ${value}`}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: TEAL, fontSize: 12, fontWeight: 600, padding: '0 4px' }}>
      {done ? '✓ Copied' : 'Copy'}
    </button>
  );
}

// ─── Application picker (friendly names, IDs secondary) ──────────────────────
function AppPicker({ value, onChange, applications, disabled }) {
  const [q, setQ] = React.useState('');
  const isAll = value.length === 1 && value[0] === 'ALL';
  const list = applications.filter((a) => `${a.app_name || ''} ${a.app_id}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value.filter((v) => v !== 'ALL'), id]);
  return (
    <div style={{ border: '1px solid #C3CFDD', borderRadius: 8, background: '#FFFFFF', opacity: disabled ? 0.6 : 1 }}>
      <div style={{ padding: 8, borderBottom: '1px solid #F4F6FA', display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter applications…" style={{ fontSize: 13, padding: '6px 9px' }} disabled={disabled} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, whiteSpace: 'nowrap', color: '#2F4258' }}>
          <input type="checkbox" checked={isAll} disabled={disabled} onChange={() => onChange(isAll ? [] : ['ALL'])} /> All applications
        </label>
      </div>
      <div style={{ maxHeight: 220, overflowY: 'auto', padding: '4px 0' }}>
        {list.length === 0 && <div style={{ padding: '8px 12px', fontSize: 13, color: '#52647A' }}>No applications match.</div>}
        {list.map((a) => (
          <label key={a.app_id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 12px', fontSize: 13, cursor: disabled || isAll ? 'default' : 'pointer', opacity: isAll ? 0.5 : 1 }}>
            <input type="checkbox" checked={isAll || value.includes(a.app_id)} disabled={disabled || isAll} onChange={() => toggle(a.app_id)} />
            <span style={{ flex: 1, color: '#172B4D' }}>{a.app_name || a.app_id}</span>
            <Mono>{a.app_id}</Mono>
            <span style={{ fontSize: 12, color: '#52647A', width: 70, textAlign: 'right' }}>{a.server_count} server{a.server_count === 1 ? '' : 's'}</span>
          </label>
        ))}
        {value.filter((v) => v !== 'ALL' && !applications.some((a) => a.app_id === v)).map((id) => (
          <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 12px', fontSize: 13 }}>
            <input type="checkbox" checked onChange={() => toggle(id)} disabled={disabled} />
            <span style={{ flex: 1, color: '#B91C1C' }}>Unknown application</span><Mono>{id}</Mono>
          </label>
        ))}
      </div>
    </div>
  );
}

// ─── Review access panel ─────────────────────────────────────────────────────
function Section({ title, status, statusLabel, badge, children, action }) {
  return (
    <section style={{ border: '1px solid var(--border)', borderRadius: 8, background: '#FFFFFF' }}>
      <header style={{ padding: '10px 14px', background: 'var(--section-head-bg)', borderBottom: '1px solid var(--border)', borderRadius: '8px 8px 0 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#172B4D' }}>{title}</h3>
        {badge}{status && <StatusPill status={status} label={statusLabel} />}
        {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </header>
      <div style={{ padding: '12px 14px', display: 'grid', gap: 10 }}>{children}</div>
    </section>
  );
}
function Label({ children }) {
  return <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',}}>{children}</div>;
}

function ReviewPanel({ user, applications, onClose, onSaveApps, onOpenTeamTab }) {
  const a = user.access;
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(user.apps || []);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState(null);
  const closeRef = React.useRef(null);
  React.useEffect(() => { setDraft(user.apps || []); setEditing(false); setSaveError(null); }, [user.email, user.apps]);
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey); closeRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true); setSaveError(null);
    try { await onSaveApps(user.email, draft); setEditing(false); } catch (e) { setSaveError(e.message || String(e)); } finally { setSaving(false); }
  };
  const pr = a.platform_role;
  const changed = JSON.stringify([...draft].sort()) !== JSON.stringify([...(user.apps || [])].sort());

  return ReactDOM.createPortal(
    <>
      <div onClick={onClose} aria-hidden style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.2)', zIndex: 40 }} />
      <aside role="dialog" aria-modal="true" aria-label={`Access for ${user.email}`} style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(640px, 100vw)', background: 'var(--bg-page)', zIndex: 41,
        boxShadow: '-12px 0 32px rgba(15,23,42,0.18)', display: 'flex', flexDirection: 'column', animation: 'slideIn 0.18s ease both',
      }}>
        <div style={{ padding: '14px 18px', background: '#FFFFFF', borderBottom: '1px solid #D7E0EB', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>Review access</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#172B4D', overflowWrap: 'anywhere' }}>{user.email}</div>
          </div>
          <StatusPill status={a.status} label={a.summary} />
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 22, color: '#52647A', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'grid', gap: 14, alignContent: 'start' }}>
          {a.reasons.length > 0 && (
            <Callout tone={a.status === 'invalid' ? 'danger' : 'warning'} title="Why some access isn't usable">
              <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{a.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            </Callout>
          )}

          {/* Platform role */}
          <Section title="Platform role" badge={pr.role === 'none' ? <StatusPill status="none" label="No platform role" /> : <Badge>{pr.label}</Badge>}>
            <div>
              <Label>Assigned</Label>
              <div style={{ fontSize: 14, color: '#172B4D', marginTop: 3 }}>
                {pr.role === 'none' ? 'No platform role' : pr.label}
                {pr.cognito_group && <> · <Mono>{pr.cognito_group}</Mono></>}
              </div>
              {pr.reason && <div style={{ fontSize: 13, color: '#52647A', marginTop: 2 }}>{pr.reason}</div>}
            </div>
            <div>
              <Label>What this role allows</Label>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13, color: '#2F4258', lineHeight: 1.7 }}>
                {pr.can_do.map((c) => <li key={c}>{c}</li>)}
              </ul>
            </div>
            <div style={{ fontSize: 13, color: '#52647A', background: '#F8FAFD', border: '1px solid #D7E0EB', borderRadius: 8, padding: '8px 10px' }}>
              <strong>How to change:</strong> roles come from Azure AD group membership and can't be edited here.
              {pr.ad_group
                ? <> Current group: <Mono>{pr.ad_group}</Mono><CopyInline value={pr.ad_group} /></>
                : <> To grant a role, request <Mono>Runstack-700067-Automation-Operator</Mono>, <Mono>Runstack-700067-EC2 Admin-Operator</Mono> or <Mono>Runstack-700067-Automation-Admin</Mono>.</>}
            </div>
          </Section>

          {/* EC2 applications */}
          <Section title="EC2 application access" status={a.ec2.status} statusLabel={a.ec2.status === 'none' ? 'None' : a.ec2.summary}
            action={!editing && <Btn variant="default" size="sm" onClick={() => setEditing(true)}>Edit applications</Btn>}>
            <div style={{ fontSize: 13, color: '#52647A' }}>Controls EC2 start / stop only. It has no effect on SQL, SAP or Tidal permissions.</div>
            {editing ? (
              <>
                <AppPicker value={draft} onChange={setDraft} applications={applications} disabled={saving} />
                {saveError && <ErrorBanner message={saveError} />}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <Btn variant="ghost" size="sm" onClick={() => { setDraft(user.apps || []); setEditing(false); }} disabled={saving}>Cancel</Btn>
                  <Btn variant="primary" size="sm" onClick={save} disabled={saving || !changed}>{saving ? <Spinner size={12} /> : 'Save applications'}</Btn>
                </div>
              </>
            ) : a.ec2.apps.length === 0 ? (
              <div style={{ fontSize: 13, color: '#2F4258' }}>
                {a.ec2.covers_all ? 'No applications assigned — not needed: the Admin role covers every application.' : 'No applications assigned.'}
              </div>
            ) : (
              <div style={{ border: '1px solid #D7E0EB', borderRadius: 8, overflow: 'hidden' }}>
                {a.ec2.apps.map((app) => (
                  <div key={app.app_id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, padding: '9px 12px', borderTop: '1px solid #F4F6FA' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#172B4D', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        {app.app_name || <Badge tone="warning">Name unavailable</Badge>} <Mono dim>{app.app_id !== 'ALL' ? app.app_id : ''}</Mono>
                      </div>
                      <div style={{ fontSize: 13, color: '#52647A', marginTop: 2 }}>{app.reason}</div>
                    </div>
                    <span style={{ alignSelf: 'center' }}><StatusPill status={app.status} label={ITEM_LABEL[app.status]} /></span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Team permissions */}
          <Section title="Team permissions" status={a.team.status}
            statusLabel={a.team.status === 'none' ? 'None' : a.team.via_role ? `Via ${pr.label} role` : STATUS_LABEL[a.team.status]}
            action={<Btn variant="default" size="sm" onClick={onOpenTeamTab}>Manage team permissions</Btn>}>
            <div style={{ fontSize: 13, color: '#52647A' }}>SQL, SAP and Tidal actions. Membership comes from Azure AD team groups; permissions are switched on per team, for everyone in it.</div>
            <div>
              <Label>Team membership</Label>
              <div style={{ fontSize: 14, color: '#172B4D', marginTop: 3 }}>
                {a.team.memberships.length ? a.team.memberships.map((t) => a.team.items.find((i) => i.team === t)?.team_label || t).join(', ') : 'Not in any team'}
              </div>
            </div>
            {a.team.via_role && (
              <Callout tone="success" title={`Every SQL, SAP and Tidal action is allowed by the ${pr.label} role`}>
                Team membership and the team on/off settings aren't checked for this role.
              </Callout>
            )}
            {a.team.items.length > 0 && (
              <div style={{ border: '1px solid #D7E0EB', borderRadius: 8, overflow: 'hidden' }}>
                {a.team.items.map((it) => (
                  <div key={`${it.team}-${it.capability || it.action_label}`} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, padding: '9px 12px', borderTop: '1px solid #F4F6FA' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: '#172B4D' }}>
                        {it.team_label} · {it.action_label} {it.capability && <Mono dim>{it.capability}</Mono>}
                      </div>
                      <div style={{ fontSize: 13, color: '#52647A', marginTop: 2 }}>{it.reason}</div>
                    </div>
                    <span style={{ alignSelf: 'center' }}><StatusPill status={it.status} label={ITEM_LABEL[it.status]} /></span>
                  </div>
                ))}
              </div>
            )}
            {!a.team.via_role && a.team.memberships.length === 0 && (
              <div style={{ fontSize: 13, color: '#2F4258' }}>
                No team membership. To add someone, request the team's Azure AD group, e.g. <Mono>Runstack-700067-SAP Basis-Operator</Mono>.
              </div>
            )}
          </Section>
        </div>
      </aside>
    </>,
    document.body,
  );
}

// ─── Explicit vs inherited access ────────────────────────────────────────────
// From the backend's access review (process_messages/access_review.py):
//   EC2   — Admin role covers every application (inherited); otherwise only
//           runstack-app-access rows count (explicit, "Assigned").
//   Teams — Operator/Admin role allows every SQL/SAP/Tidal action
//           (team.via_role, inherited); otherwise team group membership
//           (explicit, "Team member").
function SourceTag({ inherited, children }) {
  return <span className={`rs-source rs-source--${inherited ? 'inherited' : 'explicit'}`}>{children}</span>;
}

function ec2Cell(u) {
  const a = u.access;
  if (u.role === 'admin') {
    return { text: 'All applications', tag: <SourceTag inherited>From Admin role</SourceTag>, detail: null };
  }
  if (!a.ec2.apps.length) return { text: null };
  const names = a.ec2.apps.map((x) => (x.app_id === 'ALL' ? 'All applications' : x.app_name || x.app_id));
  return { text: a.ec2.summary, tag: <SourceTag>Assigned</SourceTag>, detail: names.join(', ') };
}

function teamCell(u, teamLabel) {
  const a = u.access;
  if (a.team.via_role) {
    return { text: 'All team actions', tag: <SourceTag inherited>From {a.platform_role.label} role</SourceTag>,
      detail: a.team.memberships.length ? `Also member of ${a.team.memberships.map(teamLabel).join(', ')}` : null };
  }
  if (!a.team.memberships.length) return { text: null };
  return { text: a.team.memberships.map(teamLabel).join(', '), tag: <SourceTag>Team member</SourceTag>,
    detail: a.team.status !== 'active' ? a.team.summary : null };
}

function AccessCell({ cell }) {
  if (!cell.text) return <span className="rs-muted">None</span>;
  return (
    <div style={{ display: 'grid', gap: 3, justifyItems: 'start', minWidth: 0 }}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 500, color: 'var(--text-primary)' }} className="rs-wrap">{cell.text}</span>{cell.tag}
      </span>
      {cell.detail && <span className="rs-muted rs-wrap" style={{ fontSize: 12 }}>{cell.detail}</span>}
    </div>
  );
}

// ─── Users tab ───────────────────────────────────────────────────────────────
function UsersTab({ users, teams, search, onReview }) {
  const [filter, setFilter] = usePersistentState('users.filter', 'all');
  const counts = React.useMemo(() => {
    const c = { all: users.length };
    users.forEach((u) => { c[u.access.status] = (c[u.access.status] || 0) + 1; });
    return c;
  }, [users]);
  const teamLabel = (t) => teams.find((x) => x.team === t)?.label || t;
  const q = search.trim().toLowerCase();
  const visible = users.filter((u) => (filter === 'all' || u.access.status === filter) && (!q || u.email.toLowerCase().includes(q)));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div role="group" aria-label="Filter by access status" className="rs-filter-row">
        {STATUS_FILTERS.filter((f) => f === 'all' || counts[f]).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f} className="rs-filter">
            {f === 'all' ? 'All users' : STATUS_LABEL[f]} <span className="rs-filter-count">{counts[f] || 0}</span>
          </button>
        ))}
      </div>
      <div className="rs-panel">
        {visible.length === 0 ? <Empty message={users.length ? 'No users match this search or filter.' : 'No users yet.'} /> : (
          <div className="rs-table-wrap">
            <table className="rs-table" style={{ width: '100%', minWidth: 980 }}>
              <thead><tr>
                <th scope="col">User</th><th scope="col">Platform role</th><th scope="col">EC2 access</th>
                <th scope="col">Team access</th><th scope="col">Status</th><th scope="col" style={{ textAlign: 'right' }}>Actions</th>
              </tr></thead>
              <tbody>
                {visible.map((u) => {
                  const a = u.access;
                  return (
                    <tr key={u.email}>
                      <td style={{ fontWeight: 600, minWidth: 220, maxWidth: 280 }}>
                        <span className="rs-wrap">{u.email}</span>
                        {u.signin_email && u.signin_email !== u.email && (
                          <div className="rs-muted rs-wrap" style={{ fontSize: 12, fontWeight: 400 }}>Signs in as {u.signin_email}</div>
                        )}
                      </td>
                      <td>{u.role === 'none' ? <span className="rs-muted">No platform role</span> : <Badge>{a.platform_role.label}</Badge>}</td>
                      <td style={{ maxWidth: 260 }}><AccessCell cell={ec2Cell(u)} /></td>
                      <td style={{ maxWidth: 260 }}><AccessCell cell={teamCell(u, teamLabel)} /></td>
                      <td style={{ maxWidth: 260 }}>
                        <StatusPill status={a.status} label={a.summary} />
                        {a.reasons.length > 0 && (
                          <div className="rs-muted rs-wrap" style={{ fontSize: 12, marginTop: 4 }}>
                            {a.reasons[0]}{a.reasons.length > 1 ? ` (+${a.reasons.length - 1} more in Review access)` : ''}
                          </div>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <Btn variant="default" size="sm" onClick={() => onReview(u)} aria-label={`Review access for ${u.email}`}>Review access</Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── EC2 Application Access tab ──────────────────────────────────────────────
const ITEM_FLAG = { inactive: { tone: 'warning', label: 'Inactive' }, invalid: { tone: 'danger', label: 'Needs fixing' } };

function UserChip({ user, status, reason, onReview }) {
  const flag = ITEM_FLAG[status];
  return (
    <button type="button" className="rs-chip" onClick={() => onReview(user)}
      title={reason ? `${user.email} — ${reason}` : user.email}
      aria-label={`${user.email}${flag ? `, ${flag.label}: ${reason}` : ''}. Review access`}>
      <span className="rs-chip-text">{user.email}</span>
      {flag && <span className={`rs-chip-flag rs-chip-flag--${flag.tone}`}>{flag.label}</span>}
    </button>
  );
}

function Ec2Tab({ users, applications, search, onReview }) {
  const q = search.trim().toLowerCase();
  const rows = React.useMemo(() => {
    const byApp = new Map(applications.map((a) => [a.app_id, { ...a, in_catalog: true, users: [] }]));
    users.forEach((u) => u.access.ec2.apps.forEach((app) => {
      if (!byApp.has(app.app_id)) byApp.set(app.app_id, { app_id: app.app_id, app_name: app.app_id === 'ALL' ? 'All applications' : null, server_count: null, in_catalog: false, users: [] });
      byApp.get(app.app_id).users.push({ user: u, status: app.status, reason: app.reason });
    }));
    return [...byApp.values()]
      .filter((r) => !q || `${r.app_name || ''} ${r.app_id}`.toLowerCase().includes(q) || r.users.some((x) => x.user.email.toLowerCase().includes(q)))
      .sort((a, b) => (b.users.length - a.users.length) || (a.app_name || a.app_id).localeCompare(b.app_name || b.app_id));
  }, [users, applications, q]);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <details className="rs-details">
        <summary>Access rules</summary>
        <div className="rs-details-body">
          <p style={{ margin: 0 }}>
            Which applications each person can run EC2 start / stop on. Assignments only work for users with the Operator or App Operator role; Admins already cover every application.
          </p>
          <p style={{ margin: 0 }}>
            EC2 access comes only from these application assignments. Team membership (SQL, SAP, Tidal) never grants EC2 access.
          </p>
          <div className="rs-chips" style={{ fontSize: 12 }}>
            <span className="rs-chip" style={{ cursor: 'default' }}>name@dxc.com</span> can use now ·
            <span className="rs-chip" style={{ cursor: 'default' }}>name@dxc.com <span className="rs-chip-flag rs-chip-flag--warning">Inactive</span></span> assigned but blocked (hover or open for why) ·
            <span className="rs-chip" style={{ cursor: 'default' }}>name@dxc.com <span className="rs-chip-flag rs-chip-flag--danger">Needs fixing</span></span> can never match
          </div>
        </div>
      </details>
      <div className="rs-panel">
        {rows.length === 0 ? <Empty message={applications.length ? 'No applications match.' : 'No applications in the instance catalog.'} /> : (
          <div className="rs-table-wrap">
            <table className="rs-table" style={{ width: '100%', minWidth: 820 }}>
              <thead><tr>
                <th scope="col">Application</th><th scope="col">App ID</th><th scope="col" className="rs-num">Servers</th><th scope="col">Assigned users</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.app_id}>
                    <td style={{ fontWeight: 600, maxWidth: 280 }}>
                      {r.app_name
                        ? <span className="rs-wrap">{r.app_name}</span>
                        : <Badge tone="warning" title="The instance catalog has no name for this application ID">Name unavailable</Badge>}
                    </td>
                    <td>{r.app_id === 'ALL' ? <span className="rs-muted">—</span> : <span className="rs-id">{r.app_id}</span>}</td>
                    <td className="rs-num">
                      {r.server_count != null ? r.server_count
                        : r.app_id === 'ALL' ? <span className="rs-muted">—</span>
                          : <span className="rs-muted" style={{ fontSize: 12 }}>Not in catalog</span>}
                    </td>
                    <td>
                      <div className="rs-chips">
                        {r.users.length === 0 && <span className="rs-muted" style={{ fontSize: 13 }}>No one assigned</span>}
                        {r.users.map(({ user, status, reason }) => (
                          <UserChip key={user.email} user={user} status={status} reason={reason} onReview={onReview} />
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Team Permissions tab ────────────────────────────────────────────────────
function permissionState(act, row) {
  if (!act.wired) return { status: 'not_enforced', label: STATUS_LABEL.not_enforced, note: 'No RunStack action checks this yet, so turning it on has no effect.' };
  if (!row) return { status: 'inactive', label: 'Not set up', note: 'Not set up — team members are denied.' };
  if (!row.enabled) return { status: 'inactive', label: 'Off', note: 'Turned off — team members are denied.' };
  if (row.scope !== 'ALL' && !act.resource) {
    return { status: 'invalid', label: STATUS_LABEL.invalid, note: "Limited to specific resources, but this action doesn't check a resource, so it's always denied. Set it to All resources." };
  }
  return { status: 'active', label: 'On', note: null };
}
const scopeText = (row) => (!row ? '—' : row.scope === 'ALL' ? 'All resources' : `Only: ${row.scope.join(', ')}`);

function TeamsTab({ teams, capabilities, teamsMeta, users, search, reload, focusTeam }) {
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [adding, setAdding] = React.useState(null); // team
  const [form, setForm] = React.useState({ capability: '', enabled: true, scopeType: 'ALL', scopeText: '' });
  const [metaTeam, setMetaTeam] = React.useState(null);
  const [metaForm, setMetaForm] = React.useState({ cognitoGroup: '', description: '' });
  const [cognitoGroups, setCognitoGroups] = React.useState([]);
  const [open, setOpen] = usePersistentState('users.teams.open', teams[0] ? [teams[0].team] : []);
  const refs = React.useRef({});

  React.useEffect(() => {
    if (!focusTeam) return;
    setOpen((o) => (o.includes(focusTeam) ? o : [...o, focusTeam]));
    setTimeout(() => refs.current[focusTeam]?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }, [focusTeam]); // eslint-disable-line
  React.useEffect(() => { fetchCognitoGroups().then((r) => setCognitoGroups((r.groups || []).map((g) => g.group_name))).catch(() => {}); }, []);

  const run = async (key, fn) => { setBusy(key); setError(null); try { await fn(); await reload(); } catch (e) { setError(e.message || String(e)); } finally { setBusy(null); } };
  const q = search.trim().toLowerCase();
  const metaByTeam = Object.fromEntries(teamsMeta.map((t) => [t.team, t]));
  const shown = teams.filter((t) => !q || `${t.label} ${t.team}`.toLowerCase().includes(q));
  const toggle = (team) => setOpen((o) => (o.includes(team) ? o.filter((x) => x !== team) : [...o, team]));
  const allOpen = shown.length > 0 && shown.every((t) => open.includes(t.team));

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Callout tone="info">
        What each team can do in SQL, SAP and Tidal. Team membership comes from Azure AD; switching a permission here applies to <strong>everyone in that team</strong>. Admins and Operators can run these actions without being in a team.
      </Callout>
      {error && <ErrorBanner message={error} />}
      {shown.length > 1 && (
        <div className="rs-toolbar">
          <span className="rs-muted" style={{ fontSize: 13 }}>{shown.length} teams · expand several to compare</span>
          <span className="rs-spacer" />
          <Btn variant="ghost" size="sm" onClick={() => setOpen(allOpen ? [] : shown.map((t) => t.team))}>{allOpen ? 'Collapse all' : 'Expand all'}</Btn>
        </div>
      )}
      {shown.length === 0 && <div className="rs-panel"><Empty message={teams.length ? 'No teams match.' : 'No teams are set up.'} /></div>}
      {shown.map((t) => {
        const rows = capabilities.filter((c) => c.team === t.team);
        const known = new Set(t.actions.map((x) => x.capability));
        const extra = rows.filter((r) => !known.has(r.capability));
        const members = users.filter((u) => (u.teams || []).includes(t.team));
        const states = t.actions.map((act) => permissionState(act, rows.find((r) => r.capability === act.capability)));
        const onCount = states.filter((x) => x.status === 'active').length;
        const permCount = t.actions.length + extra.length;
        const isOpen = open.includes(t.team);
        const bodyId = `rs-team-${t.team}`;
        return (
          <section key={t.team} ref={(el) => { refs.current[t.team] = el; }} className="rs-panel rs-team">
            <h3 className="rs-team-head-h">
              <button type="button" className="rs-team-head" aria-expanded={isOpen} aria-controls={bodyId} onClick={() => toggle(t.team)}>
                <span className="rs-team-caret" aria-hidden />
                <span className="rs-team-name">{t.label}</span>
                <span className="rs-team-counts">
                  {members.length} member{members.length === 1 ? '' : 's'} · {permCount} permission{permCount === 1 ? '' : 's'}
                  {t.actions.length > 0 && <> · {onCount} on</>}
                </span>
              </button>
            </h3>
            {isOpen && (
              <div id={bodyId} className="rs-team-body">
                {metaByTeam[t.team]?.description && <div className="rs-muted" style={{ fontSize: 13 }}>{metaByTeam[t.team].description}</div>}

                {adding === t.team ? (
                  <div className="rs-inline-form">
                    <label className="rs-field-label" style={{ flex: '1 1 220px' }}>Permission
                      <Select value={form.capability} onChange={(e) => setForm((p) => ({ ...p, capability: e.target.value }))}>
                        <option value="" disabled>Select a permission</option>
                        {t.actions.map((x) => <option key={x.capability} value={x.capability}>{x.label} ({x.capability})</option>)}
                      </Select>
                    </label>
                    <label className="rs-field-label" style={{ flex: '0 1 180px' }}>Applies to
                      <Select value={form.scopeType} onChange={(e) => setForm((p) => ({ ...p, scopeType: e.target.value }))}>
                        <option value="ALL">All resources</option>
                        <option value="list" disabled={!t.actions.find((x) => x.capability === form.capability)?.resource}>Specific resources</option>
                      </Select>
                    </label>
                    {form.scopeType === 'list' && (
                      <label className="rs-field-label" style={{ flex: '1 1 220px' }}>
                        {t.actions.find((x) => x.capability === form.capability)?.resource || 'Resource'} names (comma-separated)
                        <Input value={form.scopeText} onChange={(e) => setForm((p) => ({ ...p, scopeText: e.target.value }))} placeholder="SANDBOX-GDBA-AG" />
                      </label>
                    )}
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, color: 'var(--text-primary)', minHeight: 'var(--control-h)' }}>
                      <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((p) => ({ ...p, enabled: e.target.checked }))} /> Turned on
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Btn variant="primary" size="sm" disabled={!form.capability || busy === `add-${t.team}`}
                        onClick={() => run(`add-${t.team}`, async () => {
                          const scope = form.scopeType === 'ALL' ? 'ALL' : form.scopeText.split(',').map((x) => x.trim()).filter(Boolean);
                          if (scope !== 'ALL' && scope.length === 0) throw new Error('Enter at least one resource, or choose All resources.');
                          await setTeamCapability(t.team, form.capability, { enabled: form.enabled, scope });
                          setAdding(null);
                        })}>Save permission</Btn>
                      <Btn variant="ghost" size="sm" onClick={() => setAdding(null)}>Cancel</Btn>
                    </div>
                  </div>
                ) : null}

                <div className="rs-table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                  <table className="rs-table" style={{ width: '100%', minWidth: 760 }}>
                    <thead><tr>
                      <th scope="col">Permission</th><th scope="col">Resource scope</th><th scope="col">Status</th><th scope="col" style={{ textAlign: 'right' }}>Actions</th>
                    </tr></thead>
                    <tbody>
                      {t.actions.length === 0 && extra.length === 0 && (
                        <tr><td colSpan={4} className="rs-muted">No permissions are defined for this team.</td></tr>
                      )}
                      {t.actions.map((act, idx) => {
                        const row = rows.find((r) => r.capability === act.capability);
                        const st = states[idx];
                        return (
                          <tr key={act.capability}>
                            <td style={{ fontWeight: 600 }}>{act.label}</td>
                            <td className="rs-wrap" style={{ maxWidth: 260 }}>{scopeText(row)}</td>
                            <td style={{ maxWidth: 300 }}>
                              <StatusPill status={st.status} label={st.label} />
                              {st.note && <div className="rs-muted" style={{ fontSize: 12, marginTop: 4 }}>{st.note}</div>}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                {row ? (
                                  <>
                                    {st.status === 'invalid' && (
                                      <Btn variant="primary" size="sm" disabled={busy === `f-${t.team}-${act.capability}`}
                                        onClick={() => run(`f-${t.team}-${act.capability}`, () => setTeamCapability(t.team, act.capability, { scope: 'ALL' }))}>
                                        Set to all resources
                                      </Btn>
                                    )}
                                    <Btn variant="default" size="sm" disabled={busy === `t-${t.team}-${act.capability}`}
                                      onClick={() => run(`t-${t.team}-${act.capability}`, () => setTeamCapability(t.team, act.capability, { enabled: !row.enabled }))}>
                                      {row.enabled ? 'Turn off' : 'Turn on'}
                                    </Btn>
                                    <Btn variant="ghost" size="sm" disabled={busy === `d-${t.team}-${act.capability}`}
                                      onClick={() => { if (window.confirm(`Remove "${act.label}" from ${t.label}? Team members will be denied.`)) run(`d-${t.team}-${act.capability}`, () => deleteTeamCapability(t.team, act.capability)); }}>Remove</Btn>
                                  </>
                                ) : (
                                  <Btn variant="default" size="sm" disabled={busy === `s-${t.team}-${act.capability}`}
                                    onClick={() => run(`s-${t.team}-${act.capability}`, () => setTeamCapability(t.team, act.capability, { enabled: true, scope: 'ALL' }))}>Set up</Btn>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {extra.map((row) => (
                        <tr key={row.capability}>
                          <td><span className="rs-id">{row.capability}</span></td>
                          <td>{scopeText(row)}</td>
                          <td>
                            <StatusPill status="not_enforced" />
                            <div className="rs-muted" style={{ fontSize: 12, marginTop: 4 }}>No RunStack action checks this permission.</div>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <Btn variant="ghost" size="sm" onClick={() => run(`d-${t.team}-${row.capability}`, () => deleteTeamCapability(t.team, row.capability))}>Remove</Btn>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {adding !== t.team && (
                  <div>
                    <Btn variant="default" size="sm" onClick={() => { setAdding(t.team); setForm({ capability: t.actions.find((x) => !rows.some((r) => r.capability === x.capability))?.capability || '', enabled: true, scopeType: 'ALL', scopeText: '' }); }}>+ Add permission</Btn>
                  </div>
                )}

                <div style={{ display: 'grid', gap: 6 }}>
                  <div className="rs-field-label">Members ({members.length})</div>
                  {members.length
                    ? <div className="rs-chips">{members.map((m) => <span key={m.email} className="rs-chip" style={{ cursor: 'default' }}>{m.email}</span>)}</div>
                    : <div className="rs-muted" style={{ fontSize: 13 }}>None yet — add people to the Azure AD group (see Group details).</div>}
                </div>

                <details className="rs-details" open={metaTeam === t.team || undefined}>
                  <summary>Group details</summary>
                  <div className="rs-details-body">
                    <div>
                      Azure AD group {t.ad_group ? <><Mono>{t.ad_group}</Mono><CopyInline value={t.ad_group} /></> : 'not mapped'} → Cognito <Mono>{t.cognito_group}</Mono>
                    </div>
                    {(t.actions.length > 0 || extra.length > 0) && (
                      <div>
                        Permission IDs:{' '}
                        {[...t.actions.map((x) => x.capability), ...extra.map((x) => x.capability)].map((c, i) => (
                          <React.Fragment key={c}>{i > 0 && ', '}<Mono>{c}</Mono></React.Fragment>
                        ))}
                      </div>
                    )}
                    {metaTeam === t.team ? (
                      <div className="rs-inline-form" style={{ padding: 0, background: 'transparent', border: 'none' }}>
                        <label className="rs-field-label" style={{ flex: '1 1 220px' }}>Cognito group
                          <Select value={metaForm.cognitoGroup} onChange={(e) => setMetaForm((p) => ({ ...p, cognitoGroup: e.target.value }))}>
                            {[...new Set([metaForm.cognitoGroup, ...cognitoGroups])].filter(Boolean).map((g) => <option key={g} value={g}>{g}</option>)}
                          </Select>
                        </label>
                        <label className="rs-field-label" style={{ flex: '1 1 220px' }}>Description
                          <Input value={metaForm.description} onChange={(e) => setMetaForm((p) => ({ ...p, description: e.target.value }))} />
                        </label>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <Btn variant="primary" size="sm" disabled={busy === `meta-${t.team}`} onClick={() => run(`meta-${t.team}`, async () => { await setTeamMeta(t.team, { cognitoGroup: metaForm.cognitoGroup, description: metaForm.description }); setMetaTeam(null); })}>Save</Btn>
                          <Btn variant="ghost" size="sm" onClick={() => setMetaTeam(null)}>Cancel</Btn>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <Btn variant="default" size="sm" onClick={() => { setMetaTeam(t.team); setMetaForm({ cognitoGroup: t.cognito_group || '', description: metaByTeam[t.team]?.description || '' }); }}>Edit group</Btn>
                      </div>
                    )}
                  </div>
                </details>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ─── Assign applications (Add user) ─────────────────────────────────────────
function AssignDialog({ users, applications, onClose, onSave, initialEmail = '', title = 'Add user' }) {
  const [email, setEmail] = React.useState(initialEmail);
  const existing = users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
  const [apps, setApps] = React.useState(existing?.apps || []);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);
  React.useEffect(() => { setApps(existing?.apps || []); }, [existing?.email]); // eslint-disable-line

  const save = async () => {
    const e = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { setError('Enter the person\'s email address.'); return; }
    if (apps.length === 0) { setError('Choose at least one application.'); return; }
    setSaving(true); setError(null);
    try { await onSave(existing?.email || e, apps); onClose(); } catch (err) { setError(err.message || String(err)); } finally { setSaving(false); }
  };

  return ReactDOM.createPortal(
    <>
      <div onClick={onClose} aria-hidden style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.25)', zIndex: 40 }} />
      <div role="dialog" aria-modal="true" aria-label={title} style={{
        position: 'fixed', top: '8vh', left: '50%', transform: 'translateX(-50%)', width: 'min(620px, 94vw)', zIndex: 41,
        background: '#FFFFFF', borderRadius: 12, boxShadow: 'var(--shadow-lg)', display: 'grid', gap: 12, padding: 18,
      }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#172B4D' }}>{title} · EC2 application access</div>
        <Callout tone="info">
          RunStack users come from Azure AD. Here you can assign EC2 applications. The person also needs the <strong>Operator</strong> or <strong>App Operator</strong> role
          (Azure AD group <Mono>Runstack-700067-EC2 Admin-Operator</Mono>) for these to become active. SQL, SAP and Tidal access is managed through team groups instead.
        </Callout>
        <label style={{ display: 'grid', gap: 4, fontSize: 13, color: '#2F4258', fontWeight: 600 }}>Email
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@dxc.com" list="rs-user-emails" autoFocus />
          <datalist id="rs-user-emails">{users.map((u) => <option key={u.email} value={u.email} />)}</datalist>
        </label>
        {existing && (
          <div style={{ fontSize: 13, color: '#52647A' }}>
            Existing user · {existing.access.platform_role.label} · currently {existing.apps.length || 'no'} application{existing.apps.length === 1 ? '' : 's'}. Saving replaces their application list.
          </div>
        )}
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ fontSize: 13, color: '#2F4258', fontWeight: 600 }}>Applications</div>
          <AppPicker value={apps} onChange={setApps} applications={applications} disabled={saving} />
        </div>
        {error && <ErrorBanner message={error} />}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose} disabled={saving}>Cancel</Btn>
          <Btn variant="primary" onClick={save} disabled={saving}>{saving ? <Spinner size={13} /> : 'Save applications'}</Btn>
        </div>
      </div>
    </>,
    document.body,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
export default function UsersRoles() {
  const [data, setData] = React.useState(null);
  const [caps, setCaps] = React.useState({ capabilities: [], teams_meta: [] });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [tab, setTab] = usePersistentState('users.tab', 'users');
  const [search, setSearch] = usePersistentState('users.search', '');
  const [reviewEmail, setReviewEmail] = React.useState(null);
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [focusTeam, setFocusTeam] = React.useState(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const [u, c] = await Promise.all([fetchUsers(), fetchTeamCapabilities()]);
      setData(u); setCaps(c);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);
  usePageRefresh(load);

  const users = data?.users || [];
  const hasAccessModel = users.length === 0 || !!users[0]?.access;
  const applications = data?.applications || [];
  const teams = data?.teams || [];
  const reviewUser = users.find((u) => u.email === reviewEmail);

  const saveApps = async (email, apps) => {
    await setUserRole(email, { apps });
    await load();
  };

  return (
    <div className="rs-page">
      <Topbar
        title="Users & Access"
        subtitle="Platform roles, EC2 application access and team permissions for everyone who uses RunStack."
        actions={<Btn variant="default" size="sm" onClick={() => { setLoading(true); load(); }} disabled={loading}>{loading ? <Spinner size={12} /> : '↺'} Refresh</Btn>}
      />
      <div className="rs-page-body">
        <div className="rs-page-content rs-page-content--flow">
          <Tabs label="Users & Access sections" idPrefix="rs-ua" withPanels active={tab} onChange={(v) => { setTab(v); setFocusTeam(null); }} tabs={[
            { value: 'users', label: 'Users', count: data ? users.length : null },
            { value: 'ec2', label: 'EC2 Application Access', count: data ? applications.length : null },
            { value: 'teams', label: 'Team Permissions', count: data ? teams.length : null },
          ]} />

          <div className="rs-toolbar" style={{ margin: '14px 0' }}>
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder={tab === 'teams' ? 'Search teams…' : tab === 'ec2' ? 'Search applications or users…' : 'Search users by email…'}
              aria-label={tab === 'teams' ? 'Search teams' : tab === 'ec2' ? 'Search applications or users' : 'Search users by email'}
              style={{ maxWidth: 360, fontSize: 14 }} />
            <span className="rs-spacer" />
            {tab === 'users' && <Btn variant="primary" onClick={() => setAssignOpen(true)} disabled={!hasAccessModel}>+ Add user</Btn>}
            {tab === 'ec2' && <Btn variant="primary" onClick={() => setAssignOpen(true)} disabled={!hasAccessModel}>+ Assign applications</Btn>}
          </div>

          {error && <ErrorBanner message={`Could not load users: ${error}`} />}
          {(data?.warnings || []).map((w) => <Callout key={w} tone="warning">{w}. Some roles may be missing.</Callout>)}
          {!hasAccessModel && (
            <Callout tone="warning" title="Access review isn't available yet">
              The backend still returns the old user list. Deploy the updated process-messages Lambda (access_review.py) to see effective access.
            </Callout>
          )}

          {loading && !data ? (
            <div style={{ padding: 48, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
          ) : hasAccessModel && (
            <div {...tabPanelProps('rs-ua', tab)}>
              {tab === 'users' && <UsersTab users={users} teams={teams} search={search} onReview={(u) => setReviewEmail(u.email)} />}
              {tab === 'ec2' && <Ec2Tab users={users} applications={applications} search={search} onReview={(u) => setReviewEmail(u.email)} />}
              {tab === 'teams' && <TeamsTab teams={teams} capabilities={caps.capabilities || []} teamsMeta={caps.teams_meta || []} users={users} search={search} reload={load} focusTeam={focusTeam} />}
            </div>
          )}
        </div>
      </div>

      {reviewUser && (
        <ReviewPanel user={reviewUser} applications={applications} onClose={() => setReviewEmail(null)} onSaveApps={saveApps}
          onOpenTeamTab={() => { setFocusTeam(reviewUser.teams?.[0] || null); setReviewEmail(null); setTab('teams'); }} />
      )}
      {assignOpen && <AssignDialog users={users} applications={applications} onClose={() => setAssignOpen(false)} onSave={saveApps}
        title={tab === 'ec2' ? 'Assign applications' : 'Add user'} />}
    </div>
  );
}
