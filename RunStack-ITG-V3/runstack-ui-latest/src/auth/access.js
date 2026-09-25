// src/auth/access.js
//
// Single place for the UI's page-visibility rules, shared by the sidebar
// (Layout.jsx) and the route guard (RequireRole.jsx) so the two can no
// longer drift apart.
//
// This is UI visibility ONLY. Every action on these pages is still
// authorized server-side (e.g. authorize_action("sql_dr_failover") for DR
// Switchover: Azure AD group → runstack-team-capabilities gdba-sql /
// sql-dr-failover → per-AG scope). Hiding a link never grants or removes
// access to the API.

export const ROLE_RANK = { admin: 3, operator: 2, viewer: 1, none: 0 };

// DR Switchover: operators/admins, or GDBA SQL team members.
// "runstack-team-gdba-sql" is what the pre-token Lambda maps the
// "Runstack-700067-GDBA MS SQL-Operators" Azure AD group to today.
// "runstack-team-gdba" is the older Cognito group still created by
// template.yaml — kept so existing members are not locked out of the page.
// Previously the sidebar checked only the first and the route only the
// second, so a GDBA viewer could see the link but not open the page.
export const DR_SWITCHOVER_ACCESS = {
  minRole: 'operator',
  orGroups: ['runstack-team-gdba-sql', 'runstack-team-gdba'],
};

/** True when the user meets minRole, or belongs to any of orGroups. */
export function canAccess({ role, groups }, { minRole, orGroups } = {}) {
  if (!minRole) return true;
  if ((ROLE_RANK[role] ?? 0) >= ROLE_RANK[minRole]) return true;
  const list = Array.isArray(orGroups) ? orGroups : orGroups ? [orGroups] : [];
  return list.some(g => groups?.includes(g));
}
