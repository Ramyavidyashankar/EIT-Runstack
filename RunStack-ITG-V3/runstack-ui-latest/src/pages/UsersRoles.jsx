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
// Colours: teal = actions/selection; green = confirmed active; amber =
// assigned but inactive; red = can never work / needs fixing; grey = none.

import React from 'react';
import ReactDOM from 'react-dom';
import { Topbar } from '../components/Layout';
import { Btn, Card, Empty, ErrorBanner, Input, Select, Spinner } from '../components/ui';
import { Callout } from '../components/sections';
import {
  fetchUsers, setUserRole, fetchTeamCapabilities, setTeamCapability, deleteTeamCapability,
  setTeamMeta, fetchCognitoGroups,
} from '../api/client';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { copyText } from '../utils/jobs';

// ─── Status vocabulary ───────────────────────────────────────────────────────
const TONE = {
  active:       { fg: '#0B6E4C', bg: '#E4F8F0', border: '#A9E7CD', dot: '#0F9D6D' },
  partial:      { fg: '#92400E', bg: '#FEF3E2', border: '#FBDCA0', dot: '#D97706' },
  inactive:     { fg: '#92400E', bg: '#FEF3E2', border: '#FBDCA0', dot: '#D97706' },
  invalid:      { fg: '#B91C1C', bg: '#FDECEC', border: '#F7B9B9', dot: '#DC2626' },
  none:         { fg: '#475569', bg: '#F1F5F9', border: '#E2E8F0', dot: '#94A3B8' },
  not_enforced: { fg: '#475569', bg: '#F1F5F9', border: '#E2E8F0', dot: '#94A3B8' },
  read_only:    { fg: '#475569', bg: '#F1F5F9', border: '#E2E8F0', dot: '#94A3B8' },
};
const STATUS_LABEL = {
  active: 'Active', partial: 'Partly active', inactive: 'Inactive', invalid: 'Needs fixing',
  none: 'No access', not_enforced: 'Not enforced', read_only: 'Read-only',
};
const ITEM_LABEL = { active: 'Active', inactive: 'Inactive', invalid: 'Needs fixing', not_enforced: 'Not enforced' };
const STATUS_FILTERS = ['all', 'active', 'partial', 'inactive', 'invalid', 'read_only', 'none'];
const TEAL = '#0F766E';
const TEAL_DARK = '#0B5C56';

function StatusPill({ status, label, title }) {
  const t = TONE[status] || TONE.none;
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 9px', borderRadius: 999,
      fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
      color: t.fg, background: t.bg, border: `1px solid ${t.border}`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: t.dot }} />
      {label || STATUS_LABEL[status] || status}
    </span>
  );
}

function Mono({ children, dim }) {
  return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: dim ? '#94A3B8' : '#64748B' }}>{children}</span>;
}

function CopyInline({ value }) {
  const [done, setDone] = React.useState(false);
  if (!value) return null;
  return (
    <button type="button" onClick={async (e) => { e.stopPropagation(); if (await copyText(value)) { setDone(true); setTimeout(() => setDone(false), 1400); } }}
      title={`Copy ${value}`} aria-label={`Copy ${value}`}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: TEAL, fontSize: 11, fontWeight: 600, padding: '0 4px' }}>
      {done ? '✓ Copied' : 'Copy'}
    </button>
  );
}

// ─── Tabs ────────────────────────────────────────────────────────────────────
function Tabs({ tabs, active, onChange }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: 2, borderBottom: '1px solid #E2E8F0', marginBottom: 16 }}>
      {tabs.map((t) => {
        const on = t.value === active;
        return (
          <button key={t.value} role="tab" aria-selected={on} type="button" onClick={() => onChange(t.value)}
            style={{
              padding: '10px 16px', fontSize: 13, fontWeight: 700, fontFamily: 'inherit', background: 'none', border: 'none',
              borderBottom: `2px solid ${on ? TEAL : 'transparent'}`, color: on ? TEAL_DARK : '#64748B', cursor: 'pointer', marginBottom: -1,
            }}>
            {t.label}{t.count != null && <span style={{ marginLeft: 6, fontSize: 11, color: on ? TEAL : '#94A3B8' }}>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ─── Application picker (friendly names, IDs secondary) ──────────────────────
function AppPicker({ value, onChange, applications, disabled }) {
  const [q, setQ] = React.useState('');
  const isAll = value.length === 1 && value[0] === 'ALL';
  const list = applications.filter((a) => `${a.app_name || ''} ${a.app_id}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value.filter((v) => v !== 'ALL'), id]);
  return (
    <div style={{ border: '1px solid #CBD5E1', borderRadius: 8, background: '#FFFFFF', opacity: disabled ? 0.6 : 1 }}>
      <div style={{ padding: 8, borderBottom: '1px solid #F1F5F9', display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter applications…" style={{ fontSize: 12.5, padding: '6px 9px' }} disabled={disabled} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, whiteSpace: 'nowrap', color: '#334155' }}>
          <input type="checkbox" checked={isAll} disabled={disabled} onChange={() => onChange(isAll ? [] : ['ALL'])} /> All applications
        </label>
      </div>
      <div style={{ maxHeight: 220, overflowY: 'auto', padding: '4px 0' }}>
        {list.length === 0 && <div style={{ padding: '8px 12px', fontSize: 12, color: '#94A3B8' }}>No applications match.</div>}
        {list.map((a) => (
          <label key={a.app_id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 12px', fontSize: 12.5, cursor: disabled || isAll ? 'default' : 'pointer', opacity: isAll ? 0.5 : 1 }}>
            <input type="checkbox" checked={isAll || value.includes(a.app_id)} disabled={disabled || isAll} onChange={() => toggle(a.app_id)} />
            <span style={{ flex: 1, color: '#0F172A' }}>{a.app_name || a.app_id}</span>
            <Mono>{a.app_id}</Mono>
            <span style={{ fontSize: 11, color: '#94A3B8', width: 70, textAlign: 'right' }}>{a.server_count} server{a.server_count === 1 ? '' : 's'}</span>
          </label>
        ))}
        {value.filter((v) => v !== 'ALL' && !applications.some((a) => a.app_id === v)).map((id) => (
          <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '5px 12px', fontSize: 12.5 }}>
            <input type="checkbox" checked onChange={() => toggle(id)} disabled={disabled} />
            <span style={{ flex: 1, color: '#B91C1C' }}>Unknown application</span><Mono>{id}</Mono>
          </label>
        ))}
      </div>
    </div>
  );
}

// ─── Review access panel ─────────────────────────────────────────────────────
function Section({ title, status, statusLabel, children, action }) {
  return (
    <section style={{ border: '1px solid #E2E8F0', borderRadius: 10, background: '#FFFFFF' }}>
      <header style={{ padding: '10px 14px', background: '#F8FAFC', borderBottom: '1px solid #E2E8F0', borderRadius: '10px 10px 0 0', display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>{title}</h3>
        {status && <StatusPill status={status} label={statusLabel} />}
        {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </header>
      <div style={{ padding: '12px 14px', display: 'grid', gap: 10 }}>{children}</div>
    </section>
  );
}
function Label({ children }) {
  return <div style={{ fontSize: 10.5, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.6 }}>{children}</div>;
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
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(640px, 100vw)', background: '#F8FAFC', zIndex: 41,
        boxShadow: '-12px 0 32px rgba(15,23,42,0.18)', display: 'flex', flexDirection: 'column', animation: 'slideIn 0.18s ease both',
      }}>
        <div style={{ padding: '14px 18px', background: '#FFFFFF', borderBottom: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 11, color: '#64748B', fontWeight: 600 }}>Review access</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.email}</div>
          </div>
          <StatusPill status={a.status} label={a.summary} />
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 22, color: '#64748B', cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'grid', gap: 14, alignContent: 'start' }}>
          {a.reasons.length > 0 && (
            <Callout tone={a.status === 'invalid' ? 'danger' : 'warning'} title="Why some access isn't usable">
              <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{a.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            </Callout>
          )}

          {/* Platform role */}
          <Section title="Platform role" status={pr.role === 'none' ? 'none' : 'active'} statusLabel={pr.label}>
            <div>
              <Label>Assigned</Label>
              <div style={{ fontSize: 13, color: '#0F172A', marginTop: 3 }}>
                {pr.role === 'none' ? 'No platform role' : pr.label}
                {pr.cognito_group && <> · <Mono>{pr.cognito_group}</Mono></>}
              </div>
              {pr.reason && <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{pr.reason}</div>}
            </div>
            <div>
              <Label>What this role allows</Label>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5, color: '#334155', lineHeight: 1.7 }}>
                {pr.can_do.map((c) => <li key={c}>{c}</li>)}
              </ul>
            </div>
            <div style={{ fontSize: 12, color: '#475569', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 8, padding: '8px 10px' }}>
              <strong>How to change:</strong> roles come from Azure AD group membership and can't be edited here.
              {pr.ad_group
                ? <> Current group: <Mono>{pr.ad_group}</Mono><CopyInline value={pr.ad_group} /></>
                : <> To grant a role, request <Mono>Runstack-700067-Automation-Operator</Mono>, <Mono>Runstack-700067-EC2 Admin-Operator</Mono> or <Mono>Runstack-700067-Automation-Admin</Mono>.</>}
            </div>
          </Section>

          {/* EC2 applications */}
          <Section title="EC2 application access" status={a.ec2.status} statusLabel={a.ec2.status === 'none' ? 'None' : a.ec2.summary}
            action={!editing && <Btn variant="default" size="sm" onClick={() => setEditing(true)}>Edit applications</Btn>}>
            <div style={{ fontSize: 12, color: '#64748B' }}>Controls EC2 start / stop only. It has no effect on SQL, SAP or Tidal permissions.</div>
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
              <div style={{ fontSize: 12.5, color: '#334155' }}>
                {a.ec2.covers_all ? 'No applications assigned — not needed: the Admin role covers every application.' : 'No applications assigned.'}
              </div>
            ) : (
              <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden' }}>
                {a.ec2.apps.map((app) => (
                  <div key={app.app_id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, padding: '9px 12px', borderTop: '1px solid #F1F5F9' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{app.app_name || 'Unknown application'} <Mono dim>{app.app_id !== 'ALL' ? app.app_id : ''}</Mono></div>
                      <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{app.reason}</div>
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
            <div style={{ fontSize: 12, color: '#64748B' }}>SQL, SAP and Tidal actions. Membership comes from Azure AD team groups; permissions are switched on per team, for everyone in it.</div>
            <div>
              <Label>Team membership</Label>
              <div style={{ fontSize: 13, color: '#0F172A', marginTop: 3 }}>
                {a.team.memberships.length ? a.team.memberships.map((t) => a.team.items.find((i) => i.team === t)?.team_label || t).join(', ') : 'Not in any team'}
              </div>
            </div>
            {a.team.via_role && (
              <Callout tone="success" title={`Every SQL, SAP and Tidal action is allowed by the ${pr.label} role`}>
                Team membership and the team on/off settings aren't checked for this role.
              </Callout>
            )}
            {a.team.items.length > 0 && (
              <div style={{ border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden' }}>
                {a.team.items.map((it) => (
                  <div key={`${it.team}-${it.capability || it.action_label}`} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, padding: '9px 12px', borderTop: '1px solid #F1F5F9' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>
                        {it.team_label} · {it.action_label} {it.capability && <Mono dim>{it.capability}</Mono>}
                      </div>
                      <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{it.reason}</div>
                    </div>
                    <span style={{ alignSelf: 'center' }}><StatusPill status={it.status} label={ITEM_LABEL[it.status]} /></span>
                  </div>
                ))}
              </div>
            )}
            {!a.team.via_role && a.team.memberships.length === 0 && (
              <div style={{ fontSize: 12.5, color: '#334155' }}>
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

// ─── Users tab ───────────────────────────────────────────────────────────────
function UsersTab({ users, search, onReview }) {
  const [filter, setFilter] = React.useState('all');
  const counts = React.useMemo(() => {
    const c = { all: users.length };
    users.forEach((u) => { c[u.access.status] = (c[u.access.status] || 0) + 1; });
    return c;
  }, [users]);
  const q = search.trim().toLowerCase();
  const visible = users.filter((u) => (filter === 'all' || u.access.status === filter) && (!q || u.email.toLowerCase().includes(q)));
  const th = { textAlign: 'left', padding: '9px 12px', fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6, background: '#F8FAFC', borderBottom: '1px solid #E2E8F0', whiteSpace: 'nowrap' };
  const td = { padding: '10px 12px', borderBottom: '1px solid #F1F5F9', verticalAlign: 'middle', fontSize: 12.5 };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div role="group" aria-label="Filter by access status" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {STATUS_FILTERS.filter((f) => f === 'all' || counts[f]).map((f) => {
          const on = filter === f;
          return (
            <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={on} style={{
              padding: '4px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              background: on ? TEAL : '#FFFFFF', color: on ? '#FFFFFF' : '#334155', border: `1px solid ${on ? TEAL : '#E2E8F0'}`,
            }}>
              {f === 'all' ? 'All' : STATUS_LABEL[f]} <span style={{ opacity: 0.75 }}>{counts[f] || 0}</span>
            </button>
          );
        })}
      </div>
      <Card>
        {visible.length === 0 ? <Empty message={users.length ? 'No users match this search or filter.' : 'No users yet.'} /> : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
              <thead><tr>
                <th style={th}>User</th><th style={th}>Platform role</th><th style={th}>EC2 applications</th>
                <th style={th}>Team permissions</th><th style={th}>Access status</th><th style={{ ...th, textAlign: 'right' }}> </th>
              </tr></thead>
              <tbody>
                {visible.map((u) => {
                  const a = u.access;
                  return (
                    <tr key={u.email} className="rs-exec-row" onClick={() => onReview(u)} style={{ cursor: 'pointer' }}>
                      <td style={{ ...td, fontWeight: 600, color: '#0F172A', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={u.email}>{u.email}</td>
                      <td style={td}>
                        {u.role === 'none'
                          ? <span style={{ color: '#64748B' }}>No platform role</span>
                          : <span style={{ fontWeight: 600, color: '#0F172A' }}>{a.platform_role.label}</span>}
                      </td>
                      <td style={td}>
                        <div style={{ color: '#0F172A' }}>{a.ec2.status === 'none' ? <span style={{ color: '#94A3B8' }}>None</span> : a.ec2.summary}</div>
                        {a.ec2.apps.length > 0 && a.ec2.apps[0].app_id !== 'ALL' && (
                          <div style={{ fontSize: 11, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
                            {a.ec2.apps.map((x) => x.app_name || x.app_id).join(', ')}
                          </div>
                        )}
                      </td>
                      <td style={td}>
                        {a.team.status === 'none' ? <span style={{ color: '#94A3B8' }}>None</span> : <span style={{ color: '#0F172A' }}>{a.team.summary}</span>}
                      </td>
                      <td style={td} title={a.reasons.join('\n') || undefined}>
                        <StatusPill status={a.status} label={a.summary} />
                        {a.reasons.length > 0 && <div style={{ fontSize: 11, color: '#64748B', marginTop: 3, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.reasons[0]}</div>}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <Btn variant="default" size="sm" onClick={(e) => { e.stopPropagation(); onReview(u); }}>Review access</Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── EC2 Application Access tab ──────────────────────────────────────────────
function Ec2Tab({ users, applications, search, onReview, onAssign }) {
  const q = search.trim().toLowerCase();
  const rows = React.useMemo(() => {
    const byApp = new Map(applications.map((a) => [a.app_id, { ...a, users: [] }]));
    users.forEach((u) => u.access.ec2.apps.forEach((app) => {
      if (!byApp.has(app.app_id)) byApp.set(app.app_id, { app_id: app.app_id, app_name: app.app_id === 'ALL' ? 'All applications' : null, server_count: null, users: [] });
      byApp.get(app.app_id).users.push({ user: u, status: app.status, reason: app.reason });
    }));
    return [...byApp.values()]
      .filter((r) => !q || `${r.app_name || ''} ${r.app_id}`.toLowerCase().includes(q) || r.users.some((x) => x.user.email.toLowerCase().includes(q)))
      .sort((a, b) => (b.users.length - a.users.length) || (a.app_name || a.app_id).localeCompare(b.app_name || b.app_id));
  }, [users, applications, q]);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 12.5, color: '#475569', flex: 1 }}>
          Which applications each person can run EC2 start / stop on. Assignments only work for users with the Operator or App Operator role; Admins already cover every application.
        </div>
        <Btn variant="primary" size="sm" onClick={onAssign}>+ Assign applications</Btn>
      </div>
      <Card>
        {rows.length === 0 ? <Empty message="No applications match." /> : rows.map((r) => (
          <div key={r.app_id} style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) 1fr', gap: 16, padding: '11px 14px', borderBottom: '1px solid #F1F5F9' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: r.app_name ? '#0F172A' : '#B91C1C' }}>{r.app_name || 'Unknown application'}</div>
              <div style={{ fontSize: 11, color: '#64748B' }}>
                {r.app_id !== 'ALL' && <Mono>{r.app_id}</Mono>}{r.server_count != null && ` · ${r.server_count} server${r.server_count === 1 ? '' : 's'}`}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {r.users.length === 0 && <span style={{ fontSize: 12, color: '#94A3B8' }}>No one assigned</span>}
              {r.users.map(({ user, status, reason }) => (
                <button key={user.email} type="button" onClick={() => onReview(user)} title={reason}
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                  <StatusPill status={status} label={user.email} />
                </button>
              ))}
            </div>
          </div>
        ))}
      </Card>
      <div style={{ fontSize: 11.5, color: '#64748B' }}>
        <StatusPill status="active" label="Active" /> can use now · <StatusPill status="inactive" label="Inactive" /> assigned but blocked (hover for why) · <StatusPill status="invalid" label="Needs fixing" /> can never match
      </div>
    </div>
  );
}

// ─── Team Permissions tab ────────────────────────────────────────────────────
function TeamsTab({ teams, capabilities, teamsMeta, users, search, reload, focusTeam }) {
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(null);
  const [adding, setAdding] = React.useState(null); // team
  const [form, setForm] = React.useState({ capability: '', enabled: true, scopeType: 'ALL', scopeText: '' });
  const [metaTeam, setMetaTeam] = React.useState(null);
  const [metaForm, setMetaForm] = React.useState({ cognitoGroup: '', description: '' });
  const [cognitoGroups, setCognitoGroups] = React.useState([]);
  const refs = React.useRef({});

  React.useEffect(() => { if (focusTeam && refs.current[focusTeam]) refs.current[focusTeam].scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [focusTeam]);
  React.useEffect(() => { fetchCognitoGroups().then((r) => setCognitoGroups((r.groups || []).map((g) => g.group_name))).catch(() => {}); }, []);

  const run = async (key, fn) => { setBusy(key); setError(null); try { await fn(); await reload(); } catch (e) { setError(e.message || String(e)); } finally { setBusy(null); } };
  const q = search.trim().toLowerCase();
  const metaByTeam = Object.fromEntries(teamsMeta.map((t) => [t.team, t]));

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ fontSize: 12.5, color: '#475569' }}>
        What each team can do in SQL, SAP and Tidal. Team membership comes from Azure AD; switching a permission here applies to <strong>everyone in that team</strong>. Admins and Operators can run these actions without being in a team.
      </div>
      {error && <ErrorBanner message={error} />}
      {teams.filter((t) => !q || `${t.label} ${t.team}`.toLowerCase().includes(q)).map((t) => {
        const rows = capabilities.filter((c) => c.team === t.team);
        const known = new Set(t.actions.map((x) => x.capability));
        const extra = rows.filter((r) => !known.has(r.capability));
        const members = users.filter((u) => (u.teams || []).includes(t.team));
        return (
          <Card key={t.team} style={{ overflow: 'visible' }}>
            <div ref={(el) => { refs.current[t.team] = el; }} style={{ padding: '12px 14px', borderBottom: '1px solid #E2E8F0', display: 'flex', gap: 12, alignItems: 'flex-start', background: focusTeam === t.team ? '#F4FAF9' : '#F8FAFC' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{t.label} <span style={{ fontSize: 12, fontWeight: 500, color: '#64748B' }}>· {members.length} member{members.length === 1 ? '' : 's'}</span></div>
                <div style={{ fontSize: 11.5, color: '#64748B', marginTop: 2 }}>
                  Azure AD group {t.ad_group ? <Mono>{t.ad_group}</Mono> : 'not mapped'} → Cognito <Mono>{t.cognito_group}</Mono>
                  <button type="button" onClick={() => { setMetaTeam(t.team); setMetaForm({ cognitoGroup: t.cognito_group || '', description: metaByTeam[t.team]?.description || '' }); }}
                    style={{ marginLeft: 8, background: 'none', border: 'none', color: TEAL, fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>Edit group</button>
                </div>
              </div>
              <Btn variant="default" size="sm" onClick={() => { setAdding(adding === t.team ? null : t.team); setForm({ capability: t.actions.find((x) => !rows.some((r) => r.capability === x.capability))?.capability || '', enabled: true, scopeType: 'ALL', scopeText: '' }); }}>+ Add permission</Btn>
            </div>

            {metaTeam === t.team && (
              <div style={{ padding: 12, borderBottom: '1px solid #E2E8F0', display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', background: '#FFFFFF' }}>
                <label style={{ display: 'grid', gap: 4, fontSize: 11, color: '#64748B', flex: '1 1 220px' }}>Cognito group
                  <Select value={metaForm.cognitoGroup} onChange={(e) => setMetaForm((p) => ({ ...p, cognitoGroup: e.target.value }))}>
                    {[...new Set([metaForm.cognitoGroup, ...cognitoGroups])].filter(Boolean).map((g) => <option key={g} value={g}>{g}</option>)}
                  </Select>
                </label>
                <label style={{ display: 'grid', gap: 4, fontSize: 11, color: '#64748B', flex: '1 1 220px' }}>Description
                  <Input value={metaForm.description} onChange={(e) => setMetaForm((p) => ({ ...p, description: e.target.value }))} />
                </label>
                <Btn variant="primary" size="sm" disabled={busy === `meta-${t.team}`} onClick={() => run(`meta-${t.team}`, async () => { await setTeamMeta(t.team, { cognitoGroup: metaForm.cognitoGroup, description: metaForm.description }); setMetaTeam(null); })}>Save</Btn>
                <Btn variant="ghost" size="sm" onClick={() => setMetaTeam(null)}>Cancel</Btn>
              </div>
            )}

            {adding === t.team && (
              <div style={{ padding: 12, borderBottom: '1px solid #E2E8F0', display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', background: '#FFFFFF' }}>
                <label style={{ display: 'grid', gap: 4, fontSize: 11, color: '#64748B', flex: '1 1 220px' }}>Permission
                  <Select value={form.capability} onChange={(e) => setForm((p) => ({ ...p, capability: e.target.value }))}>
                    <option value="" disabled>Select a permission</option>
                    {t.actions.map((x) => <option key={x.capability} value={x.capability}>{x.label} ({x.capability})</option>)}
                  </Select>
                </label>
                <label style={{ display: 'grid', gap: 4, fontSize: 11, color: '#64748B', flex: '0 1 170px' }}>Applies to
                  <Select value={form.scopeType} onChange={(e) => setForm((p) => ({ ...p, scopeType: e.target.value }))}>
                    <option value="ALL">All resources</option>
                    <option value="list" disabled={!t.actions.find((x) => x.capability === form.capability)?.resource}>Specific resources</option>
                  </Select>
                </label>
                {form.scopeType === 'list' && (
                  <label style={{ display: 'grid', gap: 4, fontSize: 11, color: '#64748B', flex: '1 1 200px' }}>
                    {t.actions.find((x) => x.capability === form.capability)?.resource || 'Resource'} names (comma-separated)
                    <Input value={form.scopeText} onChange={(e) => setForm((p) => ({ ...p, scopeText: e.target.value }))} placeholder="SANDBOX-GDBA-AG" />
                  </label>
                )}
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#334155', paddingBottom: 8 }}>
                  <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((p) => ({ ...p, enabled: e.target.checked }))} /> Turned on
                </label>
                <Btn variant="primary" size="sm" disabled={!form.capability || busy === `add-${t.team}`}
                  onClick={() => run(`add-${t.team}`, async () => {
                    const scope = form.scopeType === 'ALL' ? 'ALL' : form.scopeText.split(',').map((s) => s.trim()).filter(Boolean);
                    if (scope !== 'ALL' && scope.length === 0) throw new Error('Enter at least one resource, or choose All resources.');
                    await setTeamCapability(t.team, form.capability, { enabled: form.enabled, scope });
                    setAdding(null);
                  })}>Save permission</Btn>
              </div>
            )}

            {t.actions.map((act) => {
              const row = rows.find((r) => r.capability === act.capability);
              let status; let note;
              if (!act.wired) { status = 'not_enforced'; note = 'No RunStack action checks this yet, so turning it on has no effect.'; }
              else if (!row) { status = 'inactive'; note = 'Not set up — team members are denied.'; }
              else if (!row.enabled) { status = 'inactive'; note = 'Turned off — team members are denied.'; }
              else if (row.scope !== 'ALL' && !act.resource) { status = 'invalid'; note = "Limited to specific resources, but this action doesn't check a resource, so it's always denied. Set it to All resources."; }
              else { status = 'active'; note = row.scope === 'ALL' ? 'All resources' : `Only: ${row.scope.join(', ')}`; }
              return (
                <div key={act.capability} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #F1F5F9' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{act.label} <Mono dim>{act.capability}</Mono></div>
                    <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>{note}</div>
                  </div>
                  <StatusPill status={status} label={status === 'active' ? 'On' : status === 'inactive' ? (row ? 'Off' : 'Not set up') : STATUS_LABEL[status]} />
                  <div style={{ display: 'flex', gap: 6 }}>
                    {row ? (
                      <>
                        {status === 'invalid' && (
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
                </div>
              );
            })}
            {extra.map((row) => (
              <div key={row.capability} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #F1F5F9' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}><Mono>{row.capability}</Mono></div>
                  <div style={{ fontSize: 12, color: '#64748B', marginTop: 2 }}>No RunStack action checks this permission.</div>
                </div>
                <StatusPill status="not_enforced" />
                <Btn variant="ghost" size="sm" onClick={() => run(`d-${t.team}-${row.capability}`, () => deleteTeamCapability(t.team, row.capability))}>Remove</Btn>
              </div>
            ))}
            <div style={{ padding: '9px 14px', fontSize: 12, color: '#475569' }}>
              <strong>Members:</strong> {members.length ? members.map((m) => m.email).join(', ') : 'none yet — add people to the Azure AD group above.'}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ─── Assign applications (Add user) ─────────────────────────────────────────
function AssignDialog({ users, applications, onClose, onSave, initialEmail = '' }) {
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
      <div role="dialog" aria-modal="true" aria-label="Add user" style={{
        position: 'fixed', top: '8vh', left: '50%', transform: 'translateX(-50%)', width: 'min(620px, 94vw)', zIndex: 41,
        background: '#FFFFFF', borderRadius: 12, boxShadow: 'var(--shadow-lg)', display: 'grid', gap: 12, padding: 18,
      }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>Add user · EC2 application access</div>
        <Callout tone="info">
          RunStack users come from Azure AD. Here you can assign EC2 applications. The person also needs the <strong>Operator</strong> or <strong>App Operator</strong> role
          (Azure AD group <Mono>Runstack-700067-EC2 Admin-Operator</Mono>) for these to become active. SQL, SAP and Tidal access is managed through team groups instead.
        </Callout>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: '#334155', fontWeight: 600 }}>Email
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@dxc.com" list="rs-user-emails" autoFocus />
          <datalist id="rs-user-emails">{users.map((u) => <option key={u.email} value={u.email} />)}</datalist>
        </label>
        {existing && (
          <div style={{ fontSize: 12, color: '#475569' }}>
            Existing user · {existing.access.platform_role.label} · currently {existing.apps.length || 'no'} application{existing.apps.length === 1 ? '' : 's'}. Saving replaces their application list.
          </div>
        )}
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ fontSize: 12, color: '#334155', fontWeight: 600 }}>Applications</div>
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
  const [tab, setTab] = React.useState('users');
  const [search, setSearch] = React.useState('');
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Topbar
        title="Users & Access"
        subtitle="Who can use RunStack and what they can do: platform role, EC2 applications and team permissions."
        actions={<Btn variant="default" size="sm" onClick={() => { setLoading(true); load(); }} disabled={loading}>{loading ? <Spinner size={12} /> : '↺'} Refresh</Btn>}
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px 24px' }}>
        <div style={{ maxWidth: 1400, margin: '0 auto' }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14 }}>
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder={tab === 'teams' ? 'Search teams…' : tab === 'ec2' ? 'Search applications or users…' : 'Search users by email…'}
              aria-label="Search" style={{ maxWidth: 360, fontSize: 13 }} />
            <span style={{ flex: 1 }} />
            <Btn variant="primary" onClick={() => setAssignOpen(true)} disabled={!hasAccessModel}>+ Add user</Btn>
          </div>

          <Tabs active={tab} onChange={(v) => { setTab(v); setFocusTeam(null); }} tabs={[
            { value: 'users', label: 'Users', count: users.length || null },
            { value: 'ec2', label: 'EC2 Application Access' },
            { value: 'teams', label: 'Team Permissions' },
          ]} />

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
            <>
              {tab === 'users' && <UsersTab users={users} search={search} onReview={(u) => setReviewEmail(u.email)} />}
              {tab === 'ec2' && <Ec2Tab users={users} applications={applications} search={search} onReview={(u) => setReviewEmail(u.email)} onAssign={() => setAssignOpen(true)} />}
              {tab === 'teams' && <TeamsTab teams={teams} capabilities={caps.capabilities || []} teamsMeta={caps.teams_meta || []} users={users} search={search} reload={load} focusTeam={focusTeam} />}
            </>
          )}
        </div>
      </div>

      {reviewUser && (
        <ReviewPanel user={reviewUser} applications={applications} onClose={() => setReviewEmail(null)} onSaveApps={saveApps}
          onOpenTeamTab={() => { setFocusTeam(reviewUser.teams?.[0] || null); setReviewEmail(null); setTab('teams'); }} />
      )}
      {assignOpen && <AssignDialog users={users} applications={applications} onClose={() => setAssignOpen(false)} onSave={saveApps} />}
    </div>
  );
}
