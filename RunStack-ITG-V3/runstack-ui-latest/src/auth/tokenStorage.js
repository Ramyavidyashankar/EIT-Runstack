// src/auth/tokenStorage.js
// Session storage for the logged-in user's tokens. Deliberately sessionStorage,
// not localStorage — tokens shouldn't be written to disk or outlive the
// browser session.
//
// sessionStorage belongs to one tab, so a tab opened with "Open in new tab"
// or by typing the URL starts empty. Instead of sending that tab to the
// login page, it asks the other open RunStack tabs for the current session
// over a BroadcastChannel (same-origin only: other sites cannot join the
// channel, and nothing goes into a URL or cookie). If no other RunStack tab
// is open, the user signs in as usual. Closing every RunStack tab still ends
// the session, exactly as before.
//
// The same channel carries two more messages:
//   updated — a tab refreshed its tokens; others adopt the newer ones (so a
//             refresh-token rotation in one tab can't strand the others)
//   logout  — signing out in one tab signs out every tab

const STORAGE_KEY = 'runstack_auth_session';
const CHANNEL = 'runstack-auth';

export function saveSession({ accessToken, idToken, refreshToken, expiresIn }) {
  return storeSession({
    accessToken,
    idToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  });
}

/** Stores an already-built session object (e.g. one received from another tab). */
export function storeSession(session) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* storage blocked — memory only */ }
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
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export function isSessionExpired(session, skewMs = 30_000) {
  if (!session) return true;
  return Date.now() >= session.expiresAt - skewMs;
}

/** A session is usable if its access token is valid, or it can be refreshed. */
export function isSessionUsable(session) {
  return Boolean(session && (!isSessionExpired(session) || session.refreshToken));
}

function isWellFormed(s) {
  return Boolean(s && typeof s === 'object' && typeof s.accessToken === 'string' && typeof s.idToken === 'string'
    && typeof s.expiresAt === 'number');
}

// ── Cross-tab handoff ────────────────────────────────────────────────────────
let channel = null;
function getChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  try { channel = new BroadcastChannel(CHANNEL); } catch { channel = null; }
  return channel;
}

/** Ask other open RunStack tabs for their session. Resolves to a session or
 *  null after timeoutMs. Only well-formed, usable sessions are accepted. */
export function requestSessionFromOtherTabs(timeoutMs = 500) {
  const ch = getChannel();
  if (!ch) return Promise.resolve(null);
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const done = (value) => { ch.removeEventListener('message', onMessage); clearTimeout(timer); resolve(value); };
    const onMessage = (e) => {
      const m = e.data;
      if (m?.type === 'session' && m.id === id && isWellFormed(m.session) && isSessionUsable(m.session)) done(m.session);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    ch.addEventListener('message', onMessage);
    ch.postMessage({ type: 'request', id });
  });
}

/** Tell other tabs about new tokens, or that the user signed out. */
export function broadcastSessionUpdate(session) {
  getChannel()?.postMessage({ type: 'updated', session });
}
export function broadcastLogout() {
  getChannel()?.postMessage({ type: 'logout' });
}

/** Answers other tabs' requests with this tab's current session and reports
 *  their updates/logouts. Returns an unsubscribe function. */
export function listenForOtherTabs({ onUpdated, onLogout }) {
  const ch = getChannel();
  if (!ch) return () => {};
  const onMessage = (e) => {
    const m = e.data;
    if (m?.type === 'request') {
      const s = getSession();
      if (isWellFormed(s) && isSessionUsable(s)) ch.postMessage({ type: 'session', id: m.id, session: s });
    } else if (m?.type === 'updated' && isWellFormed(m.session)) {
      onUpdated?.(m.session);
    } else if (m?.type === 'logout') {
      onLogout?.();
    }
  };
  ch.addEventListener('message', onMessage);
  return () => ch.removeEventListener('message', onMessage);
}

// ── Post-login return path ───────────────────────────────────────────────────
/** Only same-app relative paths are allowed as a post-login destination, so a
 *  crafted link can't bounce the user to another site after signing in. */
export function safeReturnPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return '/';
  if (path.startsWith('/auth/callback')) return '/';
  return path;
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
