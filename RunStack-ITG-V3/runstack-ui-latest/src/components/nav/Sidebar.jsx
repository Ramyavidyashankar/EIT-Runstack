// src/components/nav/Sidebar.jsx — collapsible left navigation.
//
//   Expanded (232 px)   icon + label; Administration opens as a submenu.
//   Collapsed (64 px)   icons only; the name shows as a tooltip on hover and
//                       keyboard focus; Administration opens as a flyout menu.
//   Small screens       a drawer over the page, opened from the header's Menu
//                       button and closed by choosing a page, Esc or the
//                       backdrop (Layout.jsx).
//
// Items, visibility and locks come from navModel.js — the same canAccess
// rules RequireRole applies on each route. UI visibility only: the backend
// still authorizes every request. Plain clicks go through Layout's
// onNavigate (in-app navigation, unsaved-work prompt, refresh when the page
// is already open); Ctrl/Cmd/middle click keeps open-in-new-tab.

import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { activeNavId, visibleNav } from './navModel';
import DropdownMenu from './DropdownMenu';
import useAppAccess from '../../hooks/useAppAccess';
import { teamsText } from '../../utils/identity';
import { getDlqStatus, subscribeDlqStatus } from '../../utils/dlqStatus';

const isPlainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

// 18 px stroke icons (currentColor).
const ICON_PATHS = {
  dashboard: 'M3 3h6v8H3zM11 3h6v5h-6zM11 10h6v7h-6zM3 13h6v4H3z',
  run: 'M6 4l10 6-10 6z',
  executions: 'M7 5h10M7 10h10M7 15h10M3.5 5h.01M3.5 10h.01M3.5 15h.01',
  schedules: 'M10 3a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM10 6v4l3 2',
  docs: 'M5 2.5h7l4 4v11H5zM12 2.5v4h4M7.5 10h6M7.5 13h6',
  admin: 'M10 7a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM10 2v2.2M10 15.8V18M2 10h2.2M15.8 10H18M4.3 4.3l1.6 1.6M14.1 14.1l1.6 1.6M4.3 15.7l1.6-1.6M14.1 5.9l1.6-1.6',
};
export function NavIcon({ name }) {
  return (
    <svg className="rs-side-icon" width="18" height="18" viewBox="0 0 20 20" aria-hidden>
      <path d={ICON_PATHS[name] || ICON_PATHS.docs} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const ICON_FOR = { dashboard: 'dashboard', run: 'run', executions: 'executions', schedules: 'schedules', docs: 'docs' };

function LockIcon() {
  return (
    <svg className="rs-lock" width="11" height="11" viewBox="0 0 12 12" aria-hidden>
      <rect x="2" y="5.5" width="8" height="5.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
function Chevron({ dir = 'down' }) {
  const d = { down: 'M3 4.5l3 3 3-3', left: 'M7.5 3l-3 3 3 3', right: 'M4.5 3l3 3-3 3' }[dir];
  return <svg className="rs-side-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden><path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function useDlqStatus() {
  const [s, setS] = useState(getDlqStatus);
  useEffect(() => subscribeDlqStatus(setS), []);
  return s;
}

export const ADMIN_NO_ACCESS_TEXT = 'These tools need a RunStack role (Administrator or Operator) or an application assigned. Contact a RunStack administrator if you need access.';

/** Shown in place of the Administration items when none are available. */
function AdminNoAccess({ teams, onGo, menu }) {
  return (
    <div className="rs-menu-empty" role="none">
      <div className="rs-menu-empty-title">No access to Administration</div>
      <div className="rs-menu-empty-text">{ADMIN_NO_ACCESS_TEXT}</div>
      {teams && (
        <a href="/automations" role={menu ? 'menuitem' : undefined} tabIndex={menu ? -1 : undefined}
          className={menu ? 'rs-menu-item rs-menu-empty-link' : 'rs-text-link'} onClick={onGo}>
          Your team automations ({teams}) →
        </a>
      )}
    </div>
  );
}

export default function Sidebar({ onNavigate, collapsed, onToggleCollapsed, drawer = false, onClose }) {
  const { role, groups } = useAuth();
  const { pathname } = useLocation();
  const hasAppAccess = useAppAccess();
  const { primary, admin } = visibleNav({ role, groups }, { hasAppAccess });
  const active = activeNavId(pathname);
  const dlq = useDlqStatus();
  const dlqAlert = admin.some((i) => i.alerts === 'dlq') && dlq && dlq.visible > 0;
  const dlqText = dlqAlert ? `${dlq.visible} failed message${dlq.visible === 1 ? '' : 's'} in the dead letter queue` : '';
  const teams = teamsText(groups);
  const [adminOpen, setAdminOpen] = useState(active === 'admin');
  useEffect(() => { if (active === 'admin') setAdminOpen(true); }, [active]);

  const iconsOnly = collapsed && !drawer;
  const click = (to, after) => (e) => {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    after?.();
    onClose?.();
    onNavigate(to);
  };
  // "page" for the exact page, "true" for its section (e.g. Run Automations on /ec2).
  const current = (item) => (pathname === item.to ? 'page' : item.match(pathname) ? 'true' : undefined);

  const link = (item, { sub = false } = {}) => (
    <a href={item.to} className={`rs-side-link${sub ? ' rs-side-link--sub' : ''}${item.locked ? ' is-locked' : ''}`}
      onClick={click(item.to)} aria-current={current(item)} data-active={(sub ? item.match(pathname) : active === item.id) || undefined}
      data-tip={iconsOnly ? `${item.label}${item.locked ? ` — ${item.lockReason}` : ''}` : undefined}
      aria-label={iconsOnly ? item.label : undefined}
      title={!iconsOnly && item.locked ? item.lockReason : undefined}>
      {!sub && <NavIcon name={ICON_FOR[item.id]} />}
      <span className="rs-side-label">{item.label}</span>
      {item.alerts === 'dlq' && dlqAlert && <span className="rs-count-badge" aria-label={dlqText}>{dlq.visible}</span>}
      {item.locked && <><LockIcon /><span className="rs-visually-hidden"> (no access)</span></>}
    </a>
  );

  const adminMenuItems = (close) => (admin.length ? admin.map((item) => (
    <a key={item.id} href={item.to} role="menuitem" tabIndex={-1} className="rs-menu-item"
      aria-current={current(item)} onClick={click(item.to, () => close())}>
      <span className="rs-menu-item-label">
        {item.label}
        {item.alerts === 'dlq' && dlqAlert && <span className="rs-count-badge" aria-label={dlqText}>{dlq.visible}</span>}
      </span>
      {item.hint && <span className="rs-menu-item-hint">{item.hint}</span>}
    </a>
  )) : <AdminNoAccess menu teams={teams} onGo={click('/automations', () => close())} />);

  return (
    <aside className={`rs-sidebar${iconsOnly ? ' is-collapsed' : ''}${drawer ? ' is-drawer' : ''}`} aria-label="Main navigation">
      <nav className="rs-side-nav" aria-label="Main">
        <ul className="rs-side-list">
          {primary.map((item) => <li key={item.id}>{link(item)}</li>)}
        </ul>

        <div className="rs-side-sep" role="separator" />

        {iconsOnly ? (
          <DropdownMenu menuLabel="Administration" menuClassName="rs-menu--flyout"
            buttonClassName="rs-side-link"
            buttonProps={{ 'data-active': active === 'admin' || undefined, 'data-tip': 'Administration' }}
            buttonLabel={dlqAlert ? `Administration, ${dlqText}` : 'Administration'}
            buttonContent={<><NavIcon name="admin" />{dlqAlert && <span className="rs-alert-dot rs-side-dot" />}</>}>
            {adminMenuItems}
          </DropdownMenu>
        ) : (
          <div className="rs-side-group">
            <button type="button" className="rs-side-link" aria-expanded={adminOpen} aria-controls="rs-side-admin"
              data-active={(active === 'admin' && !adminOpen) || undefined} onClick={() => setAdminOpen((v) => !v)}>
              <NavIcon name="admin" />
              <span className="rs-side-label">Administration</span>
              {dlqAlert && !adminOpen && <span className="rs-alert-dot" role="img" aria-label={dlqText} />}
              <Chevron dir="down" />
            </button>
            {adminOpen && (
              <ul id="rs-side-admin" className="rs-side-sub">
                {admin.length
                  ? admin.map((item) => <li key={item.id}>{link(item, { sub: true })}</li>)
                  : <li><AdminNoAccess teams={teams} onGo={click('/automations')} /></li>}
              </ul>
            )}
          </div>
        )}
      </nav>

      {!drawer && (
        <button type="button" className="rs-side-collapse" onClick={onToggleCollapsed} aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'} data-tip={iconsOnly ? 'Expand navigation' : undefined}>
          <Chevron dir={collapsed ? 'right' : 'left'} />
          <span className="rs-side-label">Collapse</span>
        </button>
      )}
    </aside>
  );
}
