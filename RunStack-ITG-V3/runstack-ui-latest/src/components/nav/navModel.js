// src/components/nav/navModel.js
//
// The header navigation as data: which pages exist, who sees them, and
// which item is "current" for a given URL. Kept free of React so the rules
// can be unit-tested (navModel.test.js).
//
// Visibility rules are the SAME rules the old sidebar used (auth/access.js
// canAccess with { minRole, orGroups }) and the same rules RequireRole
// applies on each route. This is UI visibility only — every API call on
// these pages is still authorized by the backend.

import { canAccess } from '../../auth/access';

// Routes that make up "Run Automations": the category/automation chooser and
// every specialised run form it leads to.
export const RUN_PATHS = ['/automations', '/ec2', '/database/sql-health-check', '/database/dr-switchover'];

const startsWith = (prefix) => (p) => p === prefix || p.startsWith(`${prefix}/`);

export const PRIMARY_NAV = [
  { id: 'dashboard', to: '/', label: 'Dashboard', match: (p) => p === '/' },
  { id: 'run', to: '/automations', label: 'Run Automations', match: (p) => RUN_PATHS.some((r) => startsWith(r)(p)) },
  { id: 'executions', to: '/jobs', label: 'Executions', match: startsWith('/jobs') },
  // Always listed; below Operator it shows a lock and the page explains that
  // the Operator role is needed (route: RequireRole minRole="operator").
  { id: 'schedules', to: '/schedules', label: 'Triggers & Schedules', minRole: 'operator', showLocked: true, match: startsWith('/schedules') },
  { id: 'docs', to: '/docs', label: 'SSM Documents', match: startsWith('/docs') },
];

// Administration ▾ — management tools, each with its existing access rule.
// Only usable items are listed. The Administration menu itself is always
// shown; when nothing in it is usable it opens a single "no access" message
// (Sidebar). Pages opened directly still explain no access (RequireRole /
// the Registered Targets message).
export const ADMIN_NAV = [
  // Lists servers from GET /app-instances, which only application access
  // opens (team membership never does) — see hooks/useAppAccess.js.
  { id: 'accounts', to: '/accounts', label: 'Registered Targets', hint: 'Servers in the instance catalog', needsAppAccess: true },
  { id: 'users', to: '/users', label: 'Users & Access', hint: 'Roles, application access, team capabilities', minRole: 'admin' },
  { id: 'uploads', to: '/uploads', label: 'Uploads', hint: 'Files for automations', minRole: 'admin' },
  { id: 'dlq', to: '/dlq', label: 'Dead Letter Queue', hint: 'Failed messages', minRole: 'operator', alerts: 'dlq' },
  { id: 'trigger', to: '/trigger', label: 'Advanced Run', hint: 'Single target, raw parameters', minRole: 'admin' },
  // UI build configuration (API URL, Cognito client). Needs a platform role
  // (any, viewer included).
  { id: 'settings', to: '/settings', label: 'Settings', hint: 'Runtime configuration', minRole: 'viewer' },
].map((item) => ({ ...item, match: startsWith(item.to) }));

/**
 * Items the user may see, in display order.
 *   user          { role, groups }
 *   hasAppAccess  true / false, or null while unknown (hidden until known)
 */
const ROLE_NAME = { admin: 'Administrator', operator: 'Operator', app_operator: 'App operator', viewer: 'Viewer' };

/** Why an item is locked, for its tooltip / menu hint. */
export function lockReason(item, user) {
  if (item.minRole && !canAccess(user, item)) {
    return item.minRole === 'viewer' ? 'Needs a RunStack role' : `Needs the ${ROLE_NAME[item.minRole] || item.minRole} role`;
  }
  if (item.needsAppAccess) return 'Needs an application assigned';
  return 'No access';
}

export function visibleNav(user, { hasAppAccess = null } = {}) {
  // Application access still loading (null) isn't treated as "no access", so
  // the item doesn't flash locked for users who have it.
  // GET /app-instances refuses users with no platform role outright.
  const appOk = user?.role && user.role !== 'none' && hasAppAccess !== false;
  const ok = (i) => canAccess(user, i) && (!i.needsAppAccess || appOk);
  // showLocked items stay in the menu with locked: true and a reason.
  const pick = (list) => list
    .filter((i) => ok(i) || i.showLocked)
    .map((i) => (ok(i) ? i : { ...i, locked: true, lockReason: lockReason(i, user) }));
  return {
    primary: pick(PRIMARY_NAV),
    admin: pick(ADMIN_NAV),
  };
}

/** id of the nav entry that owns pathname ('admin' for any Administration page). */
export function activeNavId(pathname) {
  const primary = PRIMARY_NAV.find((i) => i.match(pathname));
  if (primary) return primary.id;
  return ADMIN_NAV.some((i) => i.match(pathname)) ? 'admin' : null;
}
