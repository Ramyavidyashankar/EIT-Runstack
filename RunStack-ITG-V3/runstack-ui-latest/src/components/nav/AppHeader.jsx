// src/components/nav/AppHeader.jsx — the dark navy header that replaces the
// vertical sidebar.
//
// Three areas, full width with 24 px side padding (index.css .rs-header-inner):
//
//   [DXC | RunStack]   Dashboard · Run Automations · … · Administration ▾   [ITG] [RV Name/Role ▾]
//    left: branding            centre: navigation                    right: environment, profile
//
// • Items come from navModel.js; visibility uses the same canAccess rules the
//   sidebar and RequireRole use. UI visibility only — the backend authorizes
//   every request.
// • Plain clicks go through Layout's onNavigate (in-app navigation, refresh
//   when the page is already open, unsaved-work prompt). Ctrl/Cmd/middle
//   click keeps the browser's open-in-new-tab behaviour.
// • Below 1240 px the links move into a "Menu" panel (in the right area) so the
//   three areas never overlap or wrap.

import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { activeNavId, visibleNav } from './navModel';
import DropdownMenu from './DropdownMenu';
import { environmentLabel, initialsFor, isProductionEnv, roleLabel } from '../../utils/identity';
import { getDlqStatus, subscribeDlqStatus } from '../../utils/dlqStatus';

const isPlainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

function useDlqStatus() {
  const [s, setS] = useState(getDlqStatus);
  useEffect(() => subscribeDlqStatus(setS), []);
  return s;
}

function Caret() {
  return <svg className="rs-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function EnvironmentBadge() {
  const env = environmentLabel();
  const prod = isProductionEnv(env);
  return (
    <span className={`rs-env-badge${prod ? ' rs-env-badge--prod' : ''}`} title={`You are working in the RunStack ${env} environment`}>
      <span className="rs-env-dot" aria-hidden />
      <span className="rs-visually-hidden">Environment: </span>{env}
    </span>
  );
}

function ProfileMenu() {
  const { displayName, email, role, logout } = useAuth();
  const name = displayName || email || 'Signed in';
  return (
    <DropdownMenu align="right" menuLabel="Account" buttonClassName="rs-profile-btn"
      buttonLabel={`Account: ${name}, ${roleLabel(role)}`}
      buttonContent={(
        <>
          <span className="rs-avatar" aria-hidden>{initialsFor(name)}</span>
          <span className="rs-profile-text" aria-hidden>
            <span className="rs-profile-name">{name}</span>
            <span className="rs-profile-role">{roleLabel(role)}</span>
          </span>
          <Caret />
        </>
      )}>
      {() => (
        <>
          <div className="rs-menu-head" role="presentation">
            <div className="rs-menu-head-name">{name}</div>
            <div className="rs-menu-head-email">{email || '—'}</div>
            <div className="rs-menu-head-role">{roleLabel(role)} · {environmentLabel()}</div>
          </div>
          <div className="rs-menu-sep" role="separator" />
          <button type="button" role="menuitem" tabIndex={-1} className="rs-menu-item" onClick={logout}>Sign out</button>
        </>
      )}
    </DropdownMenu>
  );
}

function AlertDot({ label }) {
  return <span className="rs-alert-dot" role="img" aria-label={label} />;
}

export default function AppHeader({ onNavigate }) {
  const { role, groups } = useAuth();
  const { pathname } = useLocation();
  const { primary, admin } = visibleNav({ role, groups });
  const active = activeNavId(pathname);
  const [mobileOpen, setMobileOpen] = useState(false);
  const dlq = useDlqStatus();
  const dlqAlert = admin.some((i) => i.alerts === 'dlq') && dlq && dlq.visible > 0;
  const dlqText = dlqAlert ? `${dlq.visible} failed message${dlq.visible === 1 ? '' : 's'} in the dead letter queue` : '';

  useEffect(() => { setMobileOpen(false); }, [pathname]);
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { setMobileOpen(false); document.getElementById('rs-menu-toggle')?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  const click = (to, after) => (e) => {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    after?.();
    onNavigate(to);
  };
  const isCurrent = (item) => item.match(pathname);
  // "page" for the exact page, "true" for its section (e.g. Run Automations on /ec2).
  const current = (item) => (pathname === item.to ? 'page' : isCurrent(item) ? 'true' : undefined);

  const link = (item, className) => (
    <a key={item.id} href={item.to} className={className} onClick={click(item.to)}
      aria-current={current(item)} data-active={active === item.id || undefined}
      title={pathname === item.to ? `Refresh ${item.label}` : undefined}>
      {item.label}
    </a>
  );

  const adminItems = (close) => admin.map((item) => (
    <a key={item.id} href={item.to} role="menuitem" tabIndex={-1} className="rs-menu-item"
      aria-current={current(item)} onClick={click(item.to, () => close())}>
      <span className="rs-menu-item-label">
        {item.label}
        {item.alerts === 'dlq' && dlqAlert && <span className="rs-count-badge" aria-label={dlqText}>{dlq.visible}</span>}
      </span>
      {item.hint && <span className="rs-menu-item-hint">{item.hint}</span>}
    </a>
  ));

  return (
    <header className="rs-header">
      <div className="rs-header-inner">
        <a href="/" className="rs-brand" onClick={click('/')} aria-label="RunStack home">
          <img src="/dxc-logo-color.svg" alt="DXC" className="rs-brand-logo" />
          <span className="rs-brand-rule" aria-hidden />
          <span className="rs-brand-name">EIT RunStack</span>
        </a>

        <nav className="rs-hnav" aria-label="Main">
          {primary.map((item) => link(item, 'rs-hnav-link'))}
          {admin.length > 0 && (
            <DropdownMenu menuLabel="Administration" buttonClassName="rs-hnav-link rs-hnav-menu"
              buttonProps={{ 'data-active': active === 'admin' || undefined }}
              buttonLabel={dlqAlert ? `Administration, ${dlqText}` : undefined}
              buttonContent={<>Administration{dlqAlert && <AlertDot label={dlqText} />}<Caret /></>}>
              {adminItems}
            </DropdownMenu>
          )}
        </nav>

        <div className="rs-header-right">
          <EnvironmentBadge />
          <ProfileMenu />
          <button id="rs-menu-toggle" type="button" className="rs-menu-toggle" aria-expanded={mobileOpen} aria-controls="rs-mobile-nav"
            onClick={() => setMobileOpen((o) => !o)}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d={mobileOpen ? 'M4 4l8 8M12 4l-8 8' : 'M2.5 4h11M2.5 8h11M2.5 12h11'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" /></svg>
            Menu{dlqAlert && !mobileOpen && <AlertDot label={dlqText} />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <nav id="rs-mobile-nav" className="rs-mobile-nav" aria-label="Main">
          {primary.map((item) => link(item, 'rs-mobile-link'))}
          {admin.length > 0 && (
            <div className="rs-mobile-group" role="group" aria-labelledby="rs-mobile-admin">
              <div id="rs-mobile-admin" className="rs-mobile-group-label">Administration</div>
              {admin.map((item) => (
                <a key={item.id} href={item.to} className="rs-mobile-link rs-mobile-link--sub" onClick={click(item.to)}
                  aria-current={current(item)}>
                  {item.label}
                  {item.alerts === 'dlq' && dlqAlert && <span className="rs-count-badge" aria-label={dlqText}>{dlq.visible}</span>}
                </a>
              ))}
            </div>
          )}
        </nav>
      )}
    </header>
  );
}
