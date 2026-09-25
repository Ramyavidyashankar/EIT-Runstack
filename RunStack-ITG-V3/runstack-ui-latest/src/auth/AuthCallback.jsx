// src/auth/AuthCallback.jsx
import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth, exchangeCodeForTokens } from './AuthContext';
import { Spinner, ErrorBanner, Btn } from '../components/ui';

export default function AuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { completeLogin } = useAuth();
  const [error, setError] = useState(null);

  useEffect(() => {
    const code = searchParams.get('code');
    const errorParam = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    if (errorParam) {
      setError(errorDescription || errorParam);
      return;
    }
    if (!code) {
      setError('No authorization code in callback URL.');
      return;
    }

    (async () => {
      try {
        const tokens = await exchangeCodeForTokens(code);
        const redirectTo = completeLogin(tokens);
        navigate(redirectTo, { replace: true });
      } catch (e) {
        setError(e.message);
      }
    })();
  }, []);

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16,
      background: '#F1F5F9', padding: 24,
    }}>
      {error ? (
        <>
          <ErrorBanner message={`Sign-in failed: ${error}`} />
          <Btn variant="primary" onClick={() => navigate('/login', { replace: true })}>
            Back to sign in
          </Btn>
        </>
      ) : (
        <>
          <Spinner size={28} />
          <div style={{ fontSize: 13, color: '#64748B' }}>Signing you in…</div>
        </>
      )}
    </div>
  );
}
