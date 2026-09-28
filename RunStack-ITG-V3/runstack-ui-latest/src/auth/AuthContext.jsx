// src/auth/AuthContext.jsx
//
// Startup order (AuthGate shows a spinner until `loading` is false):
//   1. Session in this tab's sessionStorage (normal refresh, or a duplicated
//      tab — browsers copy sessionStorage when duplicating).
//   2. Otherwise ask other open RunStack tabs for theirs (new tab / pasted
//      URL). See tokenStorage.js.
//   3. If the access token has expired, refresh it with the refresh token.
//   4. Only if all of that fails is the login page shown. The page the user
//      asked for (path + query) is remembered and restored after sign-in.
//
// While signed in, tokens are refreshed shortly before they expire, and an
// expired access token alone no longer counts as "signed out" as long as a
// refresh token exists — previously an idle tab dropped to the login page
// on its next render after the 1-hour access token lapsed.
import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { generateRandomString, generateCodeChallenge } from './pkce';
import {
  saveSession,
  storeSession,
  getSession,
  clearSession,
  isSessionExpired,
  isSessionUsable,
  requestSessionFromOtherTabs,
  broadcastSessionUpdate,
  broadcastLogout,
  listenForOtherTabs,
  safeReturnPath,
  getRoleFromIdToken,
  getEmailFromIdToken,
  getGroupsFromIdToken,
} from './tokenStorage';

import { setAccessTokenProvider, setAuthFailureHandler } from '../api/client';

const COGNITO_DOMAIN = process.env.REACT_APP_COGNITO_HOSTED_UI_DOMAIN || '';
const USER_CLIENT_ID = process.env.REACT_APP_COGNITO_USER_CLIENT_ID || '';
const REDIRECT_URI = process.env.REACT_APP_COGNITO_REDIRECT_URI || `${window.location.origin}/auth/callback`;
const LOGOUT_REDIRECT_URI = process.env.REACT_APP_COGNITO_LOGOUT_REDIRECT_URI || window.location.origin;

const PKCE_VERIFIER_KEY = 'runstack_pkce_verifier';
const POST_LOGIN_REDIRECT_KEY = 'runstack_post_login_redirect';
const REFRESH_AHEAD_MS = 2 * 60_000;

const AuthContext = createContext(null);

const currentPath = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => getSession());
  const [loading, setLoading] = useState(true);
  const [signedOutReason, setSignedOutReason] = useState(null); // 'expired' | null
  const refreshing = useRef(null);

  // One refresh at a time per tab: several API calls hitting an expired
  // token together share the same refresh request.
  const refreshNow = useCallback(async () => {
    const current = getSession();
    if (!current?.refreshToken) throw new Error('Session expired');
    if (!refreshing.current) {
      refreshing.current = refreshAccessToken(current.refreshToken)
        .then((next) => { setSession(next); broadcastSessionUpdate(next); return next; })
        .finally(() => { refreshing.current = null; });
    }
    return refreshing.current;
  }, []);

  const endSession = useCallback((reason) => {
    clearSession();
    setSession(null);
    setSignedOutReason(reason || null);
  }, []);

  // Startup: this tab → other tabs → refresh → login.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let existing = getSession();
      // The sign-in callback page completes login itself — don't race it.
      const onCallback = window.location.pathname.startsWith('/auth/callback');
      if (!isSessionUsable(existing) && !onCallback) {
        const fromTab = await requestSessionFromOtherTabs();
        if (fromTab) existing = storeSession(fromTab);
      }
      if (existing && isSessionExpired(existing) && existing.refreshToken) {
        try {
          existing = await refreshNow();
        } catch {
          existing = null;
          clearSession();
          if (!cancelled) setSignedOutReason('expired');
        }
      } else if (existing && isSessionExpired(existing)) {
        existing = null;
        clearSession();
        if (!cancelled) setSignedOutReason('expired');
      }
      // A sign-in that finished while this ran wins over "no session".
      const latest = getSession();
      if (!existing && isSessionUsable(latest)) existing = latest;
      if (!cancelled) { setSession(existing); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [refreshNow]);

  // Answer other tabs, adopt their newer tokens, follow their sign-out.
  useEffect(() => listenForOtherTabs({
    onUpdated: (incoming) => {
      const mine = getSession();
      if (!mine || incoming.expiresAt > mine.expiresAt) { storeSession(incoming); setSession(incoming); }
    },
    onLogout: () => endSession(null),
  }), [endSession]);

  // Refresh ahead of expiry while the tab is open.
  useEffect(() => {
    if (!session?.refreshToken) return undefined;
    const wait = Math.max(5_000, session.expiresAt - Date.now() - REFRESH_AHEAD_MS);
    const id = setTimeout(() => { refreshNow().catch(() => { /* next API call retries or signs out */ }); }, wait);
    return () => clearTimeout(id);
  }, [session, refreshNow]);

  const login = useCallback(async () => {
    const verifier = generateRandomString(64);
    const challenge = await generateCodeChallenge(verifier);
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, safeReturnPath(currentPath()));

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: USER_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'openid email runstack-api/notify',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    window.location.href = `https://${COGNITO_DOMAIN}/oauth2/authorize?${params}`;
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setSession(null);
    broadcastLogout();
    const params = new URLSearchParams({
      client_id: USER_CLIENT_ID,
      logout_uri: LOGOUT_REDIRECT_URI,
    });
    window.location.href = `https://${COGNITO_DOMAIN}/logout?${params}`;
  }, []);

  /** Called by AuthCallback after exchanging the authorization code. */
  const completeLogin = useCallback((tokens) => {
    const saved = saveSession(tokens);
    setSession(saved);
    setSignedOutReason(null);
    broadcastSessionUpdate(saved);
    const redirectTo = safeReturnPath(sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY) || '/');
    sessionStorage.removeItem(POST_LOGIN_REDIRECT_KEY);
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);
    return redirectTo;
  }, []);

  /** Ensures the caller always gets a non-expired access token, refreshing
   *  first if needed. Used by client.js on every API call. Throws if the
   *  session can't be refreshed — caller should treat that as "must log in
   *  again", not retry. */
  const getValidAccessToken = useCallback(async () => {
    let current = getSession();
    if (!current) throw new Error('Not signed in');
    if (isSessionExpired(current)) {
      if (!current.refreshToken) throw new Error('Session expired');
      current = await refreshNow();
    }
    return current.accessToken;
  }, [refreshNow]);

  // Register this context's token getter with client.js, so apiFetch can
  // always pull a fresh, valid token without client.js needing React hooks.
  // A 401, or a refresh that fails, ends the session: the login page is
  // shown and returns the user to this page after signing in.
  useEffect(() => {
    setAccessTokenProvider(getValidAccessToken);
    setAuthFailureHandler(() => endSession('expired'));
  }, [getValidAccessToken, endSession]);

  const role = session ? getRoleFromIdToken(session.idToken) : 'none';
  const email = session ? getEmailFromIdToken(session.idToken) : '';
  const groups = session ? getGroupsFromIdToken(session.idToken) : [];
  const isAuthenticated = isSessionUsable(session);

  return (
    <AuthContext.Provider
      value={{ session, role, email, groups, isAuthenticated, loading, signedOutReason, login, logout, completeLogin, getValidAccessToken }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Exchanges an authorization code for tokens using PKCE — no client secret
 *  needed, since the code_verifier proves possession instead. */
export async function exchangeCodeForTokens(code) {
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  if (!verifier) throw new Error('Missing PKCE verifier — login flow was not started from this browser session');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: USER_CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const res = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: USER_CLIENT_ID,
    refresh_token: refreshToken,
  });

  let res;
  try {
    res = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (e) {
    // Network problem — the session may still be fine; don't sign out.
    throw new Error(`Could not reach the sign-in service: ${e.message}`);
  }

  if (!res.ok) {
    // 400 invalid_grant etc.: the refresh token is expired or revoked.
    const err = new Error('Your session has expired. Sign in again.');
    err.permanent = res.status >= 400 && res.status < 500;
    throw err;
  }

  const data = await res.json();
  // Cognito returns a new refresh_token only when refresh-token rotation is
  // enabled; otherwise keep using the one we already have.
  return saveSession({
    accessToken: data.access_token,
    idToken: data.id_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in,
  });
}
