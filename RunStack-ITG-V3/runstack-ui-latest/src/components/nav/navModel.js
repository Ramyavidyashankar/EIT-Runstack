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
  { id: 'schedules', to: '/schedules', label: 'Triggers & Schedules', minRole: 'operator', match: startsWith('/schedules') },
  { id: 'docs', to: '/docs', label: 'SSM Documents', match: startsWith('/docs') },
];

// Administration ▾ — management tools, each with its existing access rule.
export const ADMIN_NAV = [
  { id: 'accounts', to: '/accounts', label: 'Registered Targets', hint: 'Servers in the instance catalog' },
  { id: 'users', to: '/users', label: 'Users & Access', hint: 'Roles, application access, team capabilities', minRole: 'admin' },
  { id: 'uploads', to: '/uploads', label: 'Uploads', hint: 'Files for automations', minRole: 'admin' },
  { id: 'dlq', to: '/dlq', label: 'Dead Letter Queue', hint: 'Failed messages', minRole: 'operator', alerts: 'dlq' },
  { id: 'trigger', to: '/trigger', label: 'Advanced Run', hint: 'Single target, raw parameters', minRole: 'admin' },
  { id: 'settings', to: '/settings', label: 'Settings', hint: 'Runtime configuration' },
].map((item) => ({ ...item, match: startsWith(item.to) }));

/** Items the user may see, in display order. */
export function visibleNav(user) {
  return {
    primary: PRIMARY_NAV.filter((i) => canAccess(user, i)),
    admin: ADMIN_NAV.filter((i) => canAccess(user, i)),
  };
}

/** id of the nav entry that owns pathname ('admin' for any Administration page). */
export function activeNavId(pathname) {
  const primary = PRIMARY_NAV.find((i) => i.match(pathname));
  if (primary) return primary.id;
  return ADMIN_NAV.some((i) => i.match(pathname)) ? 'admin' : null;
}
