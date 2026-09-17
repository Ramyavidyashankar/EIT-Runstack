// src/auth/RequireRole.jsx
import React from 'react';
import { useAuth } from './AuthContext';

const ROLE_RANK = { admin: 3, operator: 2, viewer: 1, none: 0 };

/**
 * Wraps a page and renders a "no permission" state instead of the page
 * content if the signed-in user's role doesn't meet minRole. This is a
 * UX backstop, not the real security boundary — the backend's own
 * require_role()/require_gdba_capability() checks are what actually
 * enforce this; this just avoids showing a user a page full of buttons
 * that will all 403.
 *
 * `orGroup` (optional): also let the page through if the user's Cognito
 * groups include this one, even if their role is below minRole — for
 * pages gated by a team capability (e.g. GDBA + runstack-gdba-access)
 * rather than by role alone. This is a coarse "can they see the page at
 * all" check; per-action / per-AG scoping still happens server-side.
 */
export default function RequireRole({ minRole, orGroup, children }) {
  const { role, groups } = useAuth();

  if (ROLE_RANK[role] >= ROLE_RANK[minRole]) {
    return children;
  }
  if (orGroup && groups?.includes(orGroup)) {
    return children;
  }

  return (
    <div style={{ padding: 48, textAlign: 'center' }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#0E1020', marginBottom: 6 }}>
        You don't have permission to view this page
      </div>
      <div style={{ fontSize: 12, color: '#7A7D95' }}>
        This page requires the <strong>{minRole}</strong> role or higher
        {orGroup ? <> (or membership in <strong>{orGroup}</strong>)</> : null}. Your role: {role}.
        Contact a RunStack administrator if you believe this is incorrect.
      </div>
    </div>
  );
}
