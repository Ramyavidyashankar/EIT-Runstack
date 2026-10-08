// src/utils/identity.js — how the signed-in user and environment are shown
// in the header.
//
// Display name: the Azure AD SAML provider in template.yaml maps only
// `email` into Cognito, so the ID token normally has no name claim. We use
// `name` (or given_name + family_name) when a token does carry them, and
// otherwise derive a readable name from the email address:
//   priya.sharma@dxc.com → "Priya Sharma",  ramyav@dxc.com → "Ramyav".
//
// Environment: the old sidebar hard-coded "RunStack ITG". The label now
// comes from REACT_APP_RUNSTACK_ENV (e.g. ITG, PROD) with ITG as the default
// so an ITG build that doesn't set it looks exactly as before.

const title = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

export function displayNameFromClaims(claims, email) {
  const c = claims || {};
  const full = String(c.name || '').trim();
  if (full) return full;
  const parts = [c.given_name, c.family_name].map((x) => String(x || '').trim()).filter(Boolean);
  if (parts.length) return parts.join(' ');
  const local = String(email || '').split('@')[0].replace(/^AzureAD_/i, '');
  const words = local.split(/[._\-\s]+/).filter((w) => w && !/^\d+$/.test(w));
  return words.length ? words.map(title).join(' ') : (email || 'Signed in');
}

export function initialsFor(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const ROLE_LABEL = { admin: 'Administrator', operator: 'Operator', app_operator: 'App operator', viewer: 'Viewer', none: 'No RunStack role' };
export const roleLabel = (role) => ROLE_LABEL[role] || (role ? title(String(role)) : 'No RunStack role');

export function environmentLabel(env = process.env.REACT_APP_RUNSTACK_ENV) {
  return String(env || 'ITG').trim().toUpperCase() || 'ITG';
}

/** PROD gets a warning tone so it is never mistaken for a test environment. */
export const isProductionEnv = (label) => /^PROD/.test(label);

// ── Team membership (display only) ──────────────────────────────────────────
// Team groups (runstack-team-*) are not platform roles: they grant SQL / SAP
// / Tidal actions through team capabilities (shared.require_team_capability).
// Labels match process_messages/access_review.TEAM_LABELS. Shown in the
// header so a team-only user doesn't just see "No RunStack role"; never
// used for authorization.
// Short names, in display order. runstack-team-gdba-ora has no Azure AD
// mapping in the pre-token Lambda yet; it's listed so the label is ready
// when an Oracle team group is added.
const TEAM_GROUP_LABELS = {
  'runstack-team-gdba-sql': 'GDBA SQL',
  'runstack-team-gdba': 'GDBA SQL',   // older group still created by template.yaml
  'runstack-team-gdba-ora': 'GDBA ORA',
  'runstack-team-sap': 'SAP App',
  'runstack-team-tidal': 'Tidal',
};
const TEAM_ORDER = ['GDBA SQL', 'GDBA ORA', 'SAP App', 'Tidal'];

/** Distinct team labels for the user's groups, e.g. ['GDBA SQL']. */
export function teamLabels(groups) {
  const out = [];
  (groups || []).forEach((g) => {
    const label = TEAM_GROUP_LABELS[g] || (g.startsWith('runstack-team-') ? g.slice('runstack-team-'.length).split('-').filter(Boolean).map(title).join(' ') : null);
    if (label && !out.includes(label)) out.push(label);
  });
  const rank = (l) => { const i = TEAM_ORDER.indexOf(l); return i < 0 ? TEAM_ORDER.length : i; };
  return out.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** "GDBA SQL" / "GDBA SQL · SAP App", or null. */
export function teamsText(groups) {
  const t = teamLabels(groups);
  return t.length ? t.join(' · ') : null;
}

/** Header subtitle: the platform role, or the team(s) when there is no role. */
export function accessLabel(role, groups) {
  if (role && role !== 'none') return roleLabel(role);
  return teamsText(groups) || roleLabel('none');
}
