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
