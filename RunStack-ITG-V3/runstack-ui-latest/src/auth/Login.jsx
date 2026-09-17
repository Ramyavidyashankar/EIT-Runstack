// src/auth/Login.jsx
import React from 'react';
import { useAuth } from './AuthContext';
import { Btn } from '../components/ui';

export default function Login() {
  const { login } = useAuth();

  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      background: '#F4F0E9', fontFamily: 'var(--font-sans)',
    }}>
      {/* ── Dark header bar, matches the intranet top bar ── */}
      <div style={{
        height: 56, flexShrink: 0,
        background: '#12151C',
        display: 'flex', alignItems: 'center',
        padding: '0 24px',
        borderBottom: '3px solid #EE6C24',
      }}>
        <img src="/dxc-logo-color.svg" alt="DXC" style={{ height: 22, display: 'block' }} />
        <div style={{
          marginLeft: 16, paddingLeft: 16,
          borderLeft: '1px solid rgba(255,255,255,0.15)',
          fontSize: 15, fontWeight: 600, color: '#FFFFFF',
          letterSpacing: 0.2,
        }}>
          EIT RunStack
        </div>
      </div>

      {/* ── Centered sign-in card ── */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}>
        <div style={{
          background: '#FFFFFF', borderRadius: 8,
          border: '1px solid #E2DDD8',
          padding: '40px 44px', width: 360, textAlign: 'center',
          boxShadow: '0 2px 16px rgba(18,21,28,0.06)',
        }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: '#12151C', marginBottom: 6 }}>
            Sign in to RunStack
          </div>
          <div style={{ fontSize: 13, color: '#7A7D95', marginBottom: 28, lineHeight: 1.6 }}>
            Use your company account to continue
          </div>
          <Btn variant="primary" onClick={login} style={{ width: '100%', justifyContent: 'center' }}>
            Sign in with SSO
          </Btn>
        </div>
      </div>

      {/* ── Footer ── */}
      <div style={{
        textAlign: 'center', padding: '16px 0', flexShrink: 0,
        fontSize: 11, color: '#A39E94',
      }}>
        DXC Internal · RunStack Automation Platform
      </div>
    </div>
  );
}
