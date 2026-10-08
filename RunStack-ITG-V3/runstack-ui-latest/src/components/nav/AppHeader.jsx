// src/components/nav/AppHeader.jsx — the slim dark navy header.
//
//   [☰] [DXC | EIT RunStack]                                  [ITG] [RV Name/Role ▾]
//
// Global information only: branding, the environment and the account menu.
// Page navigation lives in the left sidebar (nav/Sidebar.jsx); the ☰ button
// shows on small screens, where the sidebar becomes a drawer.

import React from 'react';
import { useAuth } from '../../auth/AuthContext';
import DropdownMenu from './DropdownMenu';
import { accessLabel, environmentLabel, initialsFor, isProductionEnv, roleLabel, teamsText } from '../../utils/identity';

const isPlainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

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
  const { displayName, email, role, groups, logout } = useAuth();
  const label = accessLabel(role, groups);
  const teams = teamsText(groups);
  const name = displayName || email || 'Signed in';
  return (
    <DropdownMenu align="right" menuLabel="Account" buttonClassName="rs-profile-btn"
      buttonLabel={`Account: ${name}, ${label}`}
      buttonContent={(
        <>
          <span className="rs-avatar" aria-hidden>{initialsFor(name)}</span>
          <span className="rs-profile-text" aria-hidden>
            <span className="rs-profile-name">{name}</span>
            <span className="rs-profile-role">{label}</span>
          </span>
          <Caret />
        </>
      )}>
      {() => (
        <>
          <div className="rs-menu-head" role="presentation">
            <div className="rs-menu-head-name">{name}</div>
            <div className="rs-menu-head-email">{email || '—'}</div>
            <div className="rs-menu-head-role">
              {role === 'none' ? 'No platform role' : roleLabel(role)} · {environmentLabel()}
            </div>
            {teams && <div className="rs-menu-head-role">Teams: {teams}</div>}
          </div>
          <div className="rs-menu-sep" role="separator" />
          <button type="button" role="menuitem" tabIndex={-1} className="rs-menu-item" onClick={logout}>Sign out</button>
        </>
      )}
    </DropdownMenu>
  );
}

export default function AppHeader({ onNavigate, navOpen, onToggleNav }) {
  const click = (e) => {
    if (!isPlainClick(e)) return;
    e.preventDefault();
    onNavigate('/');
  };
  return (
    <header className="rs-header">
      <div className="rs-header-inner">
        <div className="rs-header-left">
          <button id="rs-menu-toggle" type="button" className="rs-menu-toggle" aria-expanded={!!navOpen} aria-controls="rs-side-drawer"
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'} onClick={onToggleNav}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d={navOpen ? 'M4 4l8 8M12 4l-8 8' : 'M2.5 4h11M2.5 8h11M2.5 12h11'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" /></svg>
          </button>
          <a href="/" className="rs-brand" onClick={click} aria-label="RunStack home">
            <img src="/dxc-logo-color.svg" alt="DXC" className="rs-brand-logo" />
            <span className="rs-brand-rule" aria-hidden />
            <span className="rs-brand-name">EIT RunStack</span>
          </a>
        </div>
        <div className="rs-header-right">
          <EnvironmentBadge />
          <ProfileMenu />
        </div>
      </div>
    </header>
  );
}
