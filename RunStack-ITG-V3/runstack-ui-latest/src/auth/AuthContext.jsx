// src/auth/AuthContext.jsx
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { generateRandomString, generateCodeChallenge } from './pkce';
import {
  saveSession,
  getSession,
  clearSession,
  isSessionExpired,
  getRoleFromIdToken,
  getEmailFromIdToken,
  getGroupsFromIdToken,
} from './tokenStorage';

import { setAccessTokenProvider } from '../api/client';

const COGNITO_DOMAIN = process.env.REACT_APP_COGNITO_HOSTED_UI_DOMAIN || '';
const USER_CLIENT_ID = process.env.REACT_APP_COGNITO_USER_CLIENT_ID || '';
const REDIRECT_URI = process.env.REACT_APP_COGNITO_REDIRECT_URI || `${window.location.origin}/auth/callback`;
const LOGOUT_REDIRECT_URI = process.env.REACT_APP_COGNITO_LOGOUT_REDIRECT_URI || window.location.origin;

const PKCE_VERIFIER_KEY = 'runstack_pkce_verifier';
const POST_LOGIN_REDIRECT_KEY = 'runstack_post_login_redirect';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => getSession());
  const [loading, setLoading] = useState(true);

  // On mount: validate any existing session, attempt a silent refresh if expired.
  useEffect(() => {
    (async () => {
      const existing = getSession();
      if (existing && isSessionExpired(existing) && existing.refreshToken) {
        try {
          const refreshed = await refreshAccessToken(existing.refreshToken);
          setSession(refreshed);
        } catch {
          clearSession();
          setSession(null);
        }
      } else if (existing && isSessionExpired(existing)) {
        clearSession();
        setSession(null);
      }
      setLoading(false);
    })();
  }, []);

  const login = useCallback(async () => {
    const verifier = generateRandomString(64);
    const challenge = await generateCodeChallenge(verifier);
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
    sessionStorage.setItem(POST_LOGIN_REDIRECT_KEY, window.location.pathname);

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
    const redirectTo = sessionStorage.getItem(POST_LOGIN_REDIRECT_KEY) || '/';
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
      current = await refreshAccessToken(current.refreshToken);
      setSession(current);
    }
    return current.accessToken;
  }, []);

  // Register this context's token getter with client.js, so apiFetch can
  // always pull a fresh, valid token without client.js needing React hooks.
  useEffect(() => {
    setAccessTokenProvider(getValidAccessToken);
  }, [getValidAccessToken]);

  const role = session ? getRoleFromIdToken(session.idToken) : 'none';
  const email = session ? getEmailFromIdToken(session.idToken) : '';
  const groups = session ? getGroupsFromIdToken(session.idToken) : [];
  const isAuthenticated = Boolean(session) && !isSessionExpired(session);

  return (
    <AuthContext.Provider
      value={{ session, role, email, groups, isAuthenticated, loading, login, logout, completeLogin, getValidAccessToken }}
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

  const res = await fetch(`https://${COGNITO_DOMAIN}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) throw new Error('Token refresh failed');

  const data = await res.json();
  // Cognito's refresh response doesn't return a new refresh_token by default —
  // keep using the one we already have.
  return saveSession({
    accessToken: data.access_token,
    idToken: data.id_token,
    refreshToken,
    expiresIn: data.expires_in,
  });
}
