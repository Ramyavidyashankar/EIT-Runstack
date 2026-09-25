// src/auth/RequireRole.jsx
import React from 'react';
import { useAuth } from './AuthContext';
import { canAccess } from './access';

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
export default function RequireRole({ minRole, orGroup, children }) {
  const { role, groups } = useAuth();

  if (canAccess({ role, groups }, { minRole, orGroups: orGroup })) {
    return children;
  }
  const groupLabel = Array.isArray(orGroup) ? orGroup.join(' or ') : orGroup;

  return (
    <div style={{ padding: 48, textAlign: 'center' }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', marginBottom: 6 }}>
        You don't have permission to view this page
      </div>
      <div style={{ fontSize: 12, color: '#64748B' }}>
        This page requires the <strong>{minRole}</strong> role or higher
        {groupLabel ? <> (or membership in <strong>{groupLabel}</strong>)</> : null}. Your role: {role}.
        Contact a RunStack administrator if you believe this is incorrect.
      </div>
    </div>
  );
}
