// src/auth/tokenStorage.js
// Session storage for the logged-in user's tokens. Deliberately sessionStorage,
// not localStorage — tokens shouldn't outlive the browser tab.

const STORAGE_KEY = 'runstack_auth_session';

export function saveSession({ accessToken, idToken, refreshToken, expiresIn }) {
  const session = {
    accessToken,
    idToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  return session;
}

export function getSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearSession() {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function isSessionExpired(session, skewMs = 30_000) {
  if (!session) return true;
  return Date.now() >= session.expiresAt - skewMs;
}

/** Decode a JWT payload without verifying the signature — fine for reading
 *  claims client-side, since the token's authenticity was already verified
 *  by Cognito at exchange time and by API Gateway on every backend call. */
export function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function getRoleFromIdToken(idToken) {
  const claims = decodeJwt(idToken);
  return claims?.['runstack:role'] || 'none';
}

export function getEmailFromIdToken(idToken) {
  const claims = decodeJwt(idToken);
  return claims?.email || claims?.username || claims?.['cognito:username'] || '';
}

/** Team/group membership, from the runstack:groups claim (every Cognito
 *  group the user is in — not just role-mapped ones like runstack-admins).
 *  Used for capability-based access (e.g. GDBA DR failover) that's layered
 *  alongside, not instead of, the role system. */
export function getGroupsFromIdToken(idToken) {
  const claims = decodeJwt(idToken);
  const raw = claims?.['runstack:groups'] || '';
  return raw.split(',').map((g) => g.trim()).filter(Boolean);
}