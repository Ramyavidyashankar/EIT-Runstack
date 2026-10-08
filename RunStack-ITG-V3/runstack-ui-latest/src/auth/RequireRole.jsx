// src/auth/RequireRole.jsx
import React from 'react';
import { useAuth } from './AuthContext';
import { canAccess } from './access';
import { Callout } from '../components/sections';
import { Topbar } from '../components/Layout';
import { teamsText } from '../utils/identity';

/**
 * Wraps a page and renders a "no permission" state instead of the page
 * content if the signed-in user's role doesn't meet minRole. This is a
 * UX backstop, not the real security boundary — the backend's own
 * require_role()/require_gdba_capability() checks are what actually
 * enforce this; this just avoids showing a user a page full of buttons
 * that will all 403.
 *
 * `orGroup` (optional): also let the page through if the user's Cognito
 * groups include this one (a string, or an array of alternatives), even
 * if their role is below minRole — for pages gated by a team capability
 * rather than by role alone. This is a coarse "can they see the page at
 * all" check; per-action / per-AG scoping still happens server-side.
 */
const ROLE_NAME = { admin: 'Administrator', operator: 'Operator', app_operator: 'App operator', viewer: 'Viewer' };

/**
 * title / reason (optional): page-specific wording for the no-access panel,
 * e.g. title="Triggers & Schedules" reason="Creating and changing EventBridge
 * rules affects automations for every team."
 */
export default function RequireRole({ minRole, orGroup, title, reason, children }) {
  const { role, groups } = useAuth();

  if (canAccess({ role, groups }, { minRole, orGroups: orGroup })) {
    return children;
  }
  const groupLabel = Array.isArray(orGroup) ? orGroup.join(' or ') : orGroup;
  const teams = teamsText(groups);
  const needed = ROLE_NAME[minRole] || minRole;

  return (
    <div className="rs-page">
      <Topbar title={title || 'No access'} />
      <div className="rs-page-body">
      <div className="rs-page-content">
        <Callout tone="info" title={title ? `You don't have access to ${title}` : "You don't have access to this page"}>
          <div style={{ display: 'grid', gap: 6 }}>
            {reason && <div>{reason}</div>}
            <div>
              It needs {minRole === 'viewer' ? <>a <strong>RunStack role</strong> (any)</> : <>the <strong>{needed}</strong> role{minRole !== 'admin' ? ' or higher' : ''}</>}
              {groupLabel ? <> (or membership in <strong>{groupLabel}</strong>)</> : null}.
              {' '}You have {role && role !== 'none' ? <>the <strong>{ROLE_NAME[role] || role}</strong> role</> : 'no platform role'}
              {teams ? <> and team access to <strong>{teams}</strong></> : null}.
            </div>
            <div>Roles come from Azure AD groups. Contact a RunStack administrator if you need access.</div>
          </div>
        </Callout>
      </div>
      </div>
    </div>
  );
}
