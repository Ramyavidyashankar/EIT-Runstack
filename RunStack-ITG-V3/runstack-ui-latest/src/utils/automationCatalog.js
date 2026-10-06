// src/utils/automationCatalog.js
//
// What "Run Automations" offers, grouped into exactly three categories.
// Nothing here is invented — every entry is either an existing RunStack page
// or a document returned by GET /ssm/documents?approved=true.
//
//   Operations    approved documents authorized by application access
//                 (auth "app", e.g. /var Cleanup)
//   Database      SQL Health Check and SQL DR Switchover (their own pages),
//                 plus approved documents whose team action is sql_*
//   Applications  EC2 Start/Stop (its own page), plus approved documents
//                 whose team action is sap_* or tidal_*
//
// `auth` is set by the backend (process_messages/runs.parse_approved_entries):
// "app", or an ACTION_AUTH_CONFIG key that has a team capability
// (sql_healthcheck, sql_dr_failover, sap_status_check, sap_start_stop,
// tidal_action). An unrecognised key falls back to Operations.
//
// Only automations the user is authorized to run are listed. The rules
// mirror the backend's own checks (process_messages/shared.authorize_action
// and runs._authorize_caller); the backend still decides every run.
//
//   EC2 Start/Stop and application-access documents (auth "app")
//     authorize_action("ec2_stop_start"): a RunStack role other than viewer,
//     then per-server application access. Listed for admins, and for other
//     non-viewer roles whose GET /app-instances returns servers. That list
//     comes strictly from runstack-app-access (allow_team_visibility=False),
//     so an operator role or Operations / SQL / SAP / Tidal team membership
//     never makes EC2 appear. EC2_ALLOWED_ENVIRONMENTS still applies per run.
//   Team documents (sql_* / sap_* / tidal_*)
//     require_team_capability: operator or admin role, or membership of the
//     team's Cognito group. Capability enabled/scope is checked per server.
//   SQL Health Check / SQL DR Switchover pages
//     their existing route rules (auth/access.js).

import { canAccess, DR_SWITCHOVER_ACCESS, SQL_HEALTHCHECK_ACCESS } from '../auth/access';
import { fetchApprovedAutomations, fetchAppInstances } from '../api/client';
import { mergeTargets } from './runTargets';

export const CATEGORIES = [
  { id: 'operations', label: 'Operations', description: 'Operational and maintenance automations.' },
  { id: 'database', label: 'Database', description: 'SQL Health Check, SQL DR Switchover and other database automations.' },
  { id: 'applications', label: 'Applications', description: 'EC2 Start/Stop, SAP and Tidal automations.' },
];
export const categoryById = (id) => CATEGORIES.find((c) => c.id === id) || null;

export function categoryForAuth(auth) {
  const a = String(auth || 'app').toLowerCase();
  if (a.startsWith('sql_')) return 'database';
  if (a.startsWith('sap_') || a.startsWith('tidal_')) return 'applications';
  return 'operations';
}

/** Team named by a team action, for the option's secondary label. */
export function teamForAuth(auth) {
  const a = String(auth || '').toLowerCase();
  if (a.startsWith('sql_')) return 'SQL';
  if (a.startsWith('sap_')) return 'SAP';
  if (a.startsWith('tidal_')) return 'Tidal';
  return null;
}

export const documentPath = (category, name) =>
  `/automations?category=${encodeURIComponent(category)}&doc=${encodeURIComponent(name)}`;

// Existing specialised pages.
const PAGES = [
  { key: 'page:ec2', category: 'applications', to: '/ec2', label: 'EC2 Start/Stop',
    description: 'Start or stop EC2 instances in applications you have access to.', rule: 'app' },
  { key: 'page:sql-health-check', category: 'database', to: '/database/sql-health-check', label: 'SQL Health Check',
    description: 'Check SQL Server health on one or many servers, including bulk checks.', access: SQL_HEALTHCHECK_ACCESS },
  { key: 'page:sql-dr-switchover', category: 'database', to: '/database/dr-switchover', label: 'SQL DR Switchover',
    description: 'Plan, review and run an availability-group switchover.', access: DR_SWITCHOVER_ACCESS },
];

// Cognito groups the pre-token Lambda gives each team (runstack-team-{team};
// "runstack-team-gdba" is the older GDBA group still created by template.yaml).
const TEAM_GROUPS = {
  sql_: ['runstack-team-gdba-sql', 'runstack-team-gdba'],
  sap_: ['runstack-team-sap'],
  tidal_: ['runstack-team-tidal'],
};

/** authorize_action("ec2_stop_start") Layer 1 + application access. */
export function canRunAppAutomations(user, hasAppAccess) {
  const role = user?.role || 'none';
  if (role === 'admin') return true;
  return role !== 'none' && role !== 'viewer' && !!hasAppAccess;
}

/** Team action (sql_* / sap_* / tidal_*): operator+ role, or team member. */
export function canRunTeamAction(user, auth) {
  if (canAccess(user || {}, { minRole: 'operator' })) return true;
  const a = String(auth || '').toLowerCase();
  const prefix = Object.keys(TEAM_GROUPS).find((p) => a.startsWith(p));
  return !!prefix && TEAM_GROUPS[prefix].some((g) => user?.groups?.includes(g));
}

/**
 * Automations the user may choose, in display order (pages first, then
 * documents in the backend's configured order).
 *   user          { role, groups }
 *   documents     approved documents (may be null while loading)
 *   hasAppAccess  true when GET /app-instances returned servers
 */
export function buildEntries({ user, documents, hasAppAccess, ec2Allowed }) {
  const appAccess = hasAppAccess ?? ec2Allowed;
  const pages = PAGES.filter((p) => (p.rule === 'app' ? canRunAppAutomations(user, appAccess) : canAccess(user || {}, p.access)))
    .map(({ rule, access, ...p }) => ({ ...p, kind: 'page', available: true }));
  const docs = (documents || [])
    .filter((d) => (!d.auth || d.auth === 'app' ? canRunAppAutomations(user, appAccess) : canRunTeamAction(user, d.auth)))
    .map((d) => {
      const category = categoryForAuth(d.auth);
      return {
        key: `doc:${d.name}`, kind: 'document', category, doc: d, to: documentPath(category, d.name),
        label: d.display_name || d.name, description: d.available ? d.description : d.reason,
        available: !!d.available, team: teamForAuth(d.auth),
      };
    });
  return [...pages, ...docs];
}

/** The entry for the current URL, or null (e.g. /automations with no doc). */
export function entryForLocation(entries, pathname, search) {
  if (pathname !== '/automations') return entries.find((e) => e.kind === 'page' && e.to === pathname) || null;
  const doc = new URLSearchParams(search).get('doc');
  return doc ? entries.find((e) => e.kind === 'document' && e.doc.name === doc) || null : null;
}

/** Category for the current URL: the page's/document's own, else ?category=. */
export function categoryForLocation(entries, pathname, search) {
  const entry = entryForLocation(entries, pathname, search);
  if (entry) return entry.category;
  const page = PAGES.find((p) => p.to === pathname);
  if (page) return page.category;
  const c = new URLSearchParams(search).get('category');
  return categoryById(c) ? c : null;
}

// ── Shared, per-user cache of the two existing reads ─────────────────────────
// The chooser (on every run page) and RunAutomations both need the approved
// documents and the caller's application servers; this keeps it to one
// request each. `force` (Refresh, page re-click) always reloads.

const TTL_MS = 60_000;
const cache = { owner: null, docs: null, apps: null };

function cached(slot, owner, force, loader) {
  if (cache.owner !== owner) { cache.owner = owner; cache.docs = null; cache.apps = null; }
  const c = cache[slot];
  const age = c ? Date.now() - c.at : Infinity;
  // A forced reload that another caller started <1 s ago (e.g. the chooser
  // and the page both reacting to one header re-click) shares that request.
  if (c && (force ? age < 1000 : (c.pending || age < TTL_MS))) return c.promise;
  const promise = loader().finally(() => { if (cache[slot]?.promise === promise) cache[slot].pending = false; });
  cache[slot] = { promise, at: Date.now(), pending: true };
  promise.catch(() => { if (cache[slot]?.promise === promise) cache[slot] = null; }); // don't cache failures
  return promise;
}

/** → { documents, limits, configured } (GET /ssm/documents?approved=true) */
export function loadApprovedAutomations(owner, { force = false } = {}) {
  return cached('docs', owner, force, () => fetchApprovedAutomations()
    .then((r) => ({ documents: r.documents || [], limits: r.limits || null, configured: r.configured !== false })));
}

/** → { instances } (GET /app-instances — the caller's application access) */
export function loadAppAccess(owner, { force = false } = {}) {
  return cached('apps', owner, force, () => fetchAppInstances().then((r) => ({ instances: mergeTargets(r.instances) })));
}

export function clearAutomationCache() { cache.owner = null; cache.docs = null; cache.apps = null; }
