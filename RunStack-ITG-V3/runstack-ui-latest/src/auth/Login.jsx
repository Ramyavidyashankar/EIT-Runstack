// src/auth/Login.jsx
import React from 'react';
import { useAuth } from './AuthContext';
import { Btn } from '../components/ui';

const TEAL = '#0F766E';
const TEAL_DARK = '#0B5C56';

function NetworkBg() {
  return (
    <svg width="480" height="480" viewBox="0 0 480 480" fill="none" aria-hidden="true" style={{ position: 'absolute', right: -80, bottom: -80, opacity: 0.35, pointerEvents: 'none' }}>
      {[[60, 80], [140, 40], [220, 110], [300, 60], [380, 130], [100, 200], [260, 220], [400, 260], [180, 320], [340, 360], [60, 380]].map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r="2.5" fill="#CBD5E1" />
      ))}
      <path d="M60 80L140 40M140 40L220 110M220 110L300 60M300 60L380 130M100 200L220 110M100 200L260 220M260 220L400 260M260 220L180 320M180 320L340 360M180 320L60 380" stroke="#E2E8F0" strokeWidth="1" />
    </svg>
  );
}

function Icon(props) {
  return (
    <svg width={props.size || 16} height={props.size || 16} viewBox="0 0 16 16" fill="none" aria-hidden="true" stroke={props.color || 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {props.children}
    </svg>
  );
}
function ShieldIcon(p) { return <Icon size={p.size} color={p.color}><path d="M8 1.5l5.5 2v4.2c0 3.4-2.3 5.9-5.5 6.8-3.2-0.9-5.5-3.4-5.5-6.8V3.5l5.5-2z" /><path d="M5.5 8l1.8 1.8L10.5 6.2" /></Icon>; }
function UsersIcon(p) { return <Icon size={p.size} color={p.color}><circle cx="5.5" cy="5" r="2" /><path d="M1.5 13c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5" /><circle cx="11" cy="5.5" r="1.6" /><path d="M10 9.7c1.7.1 3 1.3 3 3.3" /></Icon>; }
function AuditIcon(p) { return <Icon size={p.size} color={p.color}><path d="M3 2h7l3 3v9H3V2z" /><path d="M10 2v3h3" /><path d="M6 8h4M6 11h3" /></Icon>; }
function GearIcon(p) { return <Icon size={p.size} color={p.color}><circle cx="8" cy="8" r="2.5" /><path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M3.4 12.6l.7-.7M11.9 4.1l.7-.7" /></Icon>; }
function ChartIcon(p) { return <Icon size={p.size} color={p.color}><path d="M2 13.5h12" /><rect x="3.5" y="8" width="2" height="5" fill={p.color || 'currentColor'} stroke="none" /><rect x="7" y="5" width="2" height="8" fill={p.color || 'currentColor'} stroke="none" /><rect x="10.5" y="9.5" width="2" height="3.5" fill={p.color || 'currentColor'} stroke="none" /></Icon>; }
function CloudIcon(p) { return <Icon size={p.size} color={p.color}><path d="M4 11a3 3 0 0 1 0-6 4 4 0 0 1 8 1 3 3 0 0 1 0 5" /></Icon>; }
function LockIcon(p) { return <Icon size={p.size} color={p.color}><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></Icon>; }
function ChatIcon(p) { return <Icon size={p.size} color={p.color}><path d="M2 3h12v8H6l-3 2.5V11H2V3z" /></Icon>; }
function SSOGridIcon(p) {
  const size = p.size || 15;
  const color = p.color || '#fff';
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="5.5" height="5.5" fill={color} />
      <rect x="9" y="1.5" width="5.5" height="5.5" fill={color} opacity="0.85" />
      <rect x="1.5" y="9" width="5.5" height="5.5" fill={color} opacity="0.85" />
      <rect x="9" y="9" width="5.5" height="5.5" fill={color} opacity="0.7" />
    </svg>
  );
}

const FEATURES = [
  { icon: ShieldIcon, text: 'Secure enterprise authentication' },
  { icon: UsersIcon, text: 'Role-based access control' },
  { icon: AuditIcon, text: 'Controlled and auditable automation execution' },
];

const STACK = [
  { icon: GearIcon, label: 'Automate' },
  { icon: ChartIcon, label: 'Optimize' },
  { icon: CloudIcon, label: 'Scale' },
  { icon: ShieldIcon, label: 'Reliable' },
];

export default function Login() {
  const { login } = useAuth();

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#F5F3EF', fontFamily: 'var(--font-sans)', position: 'relative', overflow: 'hidden' }}>
      <NetworkBg />

      <div style={{ height: 56, flexShrink: 0, position: 'relative', zIndex: 2, background: '#12151C', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', borderBottom: '3px solid #EE6C24' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <img src="/dxc-logo-color.svg" alt="DXC" style={{ height: 22, display: 'block' }} />
          <div style={{ marginLeft: 16, paddingLeft: 16, borderLeft: '1px solid rgba(255,255,255,0.15)', fontSize: 15, fontWeight: 600, color: '#FFFFFF', letterSpacing: 0.2 }}>
            EIT RunStack
          </div>
        </div>
        <div className="rs-header-links" style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 12.5, color: 'rgba(226,232,240,0.65)', fontWeight: 500 }}>
          <span>Automate</span>
          <span style={{ color: 'rgba(226,232,240,0.25)' }}>|</span>
          <span>Optimize</span>
          <span style={{ color: 'rgba(226,232,240,0.25)' }}>|</span>
          <span>Empower</span>
        </div>
      </div>

      <div className="rs-margin-text rs-margin-left" aria-hidden="true" style={{ position: 'absolute', left: 40, top: 96, zIndex: 1, fontSize: 11.5, fontWeight: 700, color: 'rgba(122,125,149,0.55)', letterSpacing: 1, textTransform: 'uppercase', lineHeight: 1.7 }}>
        Automation<br />for a stronger<br />tomorrow
        <div style={{ width: 26, height: 2, background: '#EE6C24', marginTop: 8 }} />
      </div>

      <div className="rs-margin-text rs-margin-right" aria-hidden="true" style={{ position: 'absolute', right: 40, top: 96, zIndex: 1, textAlign: 'right', fontSize: 11.5, fontWeight: 700, color: 'rgba(122,125,149,0.55)', letterSpacing: 1, textTransform: 'uppercase', lineHeight: 1.7 }}>
        People<br />Technology<br />Outcomes
        <div style={{ width: 26, height: 2, background: '#EE6C24', marginTop: 8, marginLeft: 'auto' }} />
      </div>

      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, position: 'relative', zIndex: 2 }}>
        <div className="rs-login-card" style={{ display: 'flex', width: '100%', maxWidth: 980, minHeight: 520, background: '#FFFFFF', borderRadius: 14, border: '1px solid #E2DDD8', boxShadow: '0 8px 32px rgba(18,21,28,0.10)', overflow: 'hidden' }}>

          <div className="rs-login-left" style={{ flex: '0 0 52%', position: 'relative', overflow: 'hidden', background: 'linear-gradient(160deg, #12151C 0%, #0D1526 100%)', padding: '40px 40px 32px', display: 'flex', flexDirection: 'column', color: '#FFFFFF' }}>
            <img src="/dxc-logo-color.svg" alt="DXC" style={{ height: 18, display: 'block', marginBottom: 22 }} />

            <h1 style={{ fontSize: 25, fontWeight: 700, margin: 0, letterSpacing: 0.2 }}>EIT RunStack</h1>

            <div style={{ fontSize: 12.5, fontWeight: 600, color: '#5EEAD4', textTransform: 'uppercase', letterSpacing: 1, marginTop: 6 }}>
              Enterprise Automation Platform
            </div>

            <p style={{ fontSize: 13, lineHeight: 1.6, color: 'rgba(226,232,240,0.75)', marginTop: 16, marginBottom: 24, maxWidth: 300 }}>
              Securely execute and manage infrastructure and application automations through a centralized platform.
            </p>

            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}>
              {FEATURES.map((f) => (
                <li key={f.text} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0, background: 'rgba(94,234,212,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {f.icon({ size: 13, color: '#5EEAD4' })}
                  </span>
                  <span style={{ fontSize: 12.5, color: 'rgba(226,232,240,0.9)' }}>{f.text}</span>
                </li>
              ))}
            </ul>

            <div className="rs-stack" style={{ marginTop: 'auto', paddingTop: 28, position: 'relative' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 220 }}>
                {STACK.map((s, i) => (
                  <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(94,234,212,0.18)', marginLeft: i * 18 }}>
                    {s.icon({ size: 13, color: '#7FA8FF' })}
                    <span style={{ fontSize: 11.5, color: 'rgba(226,232,240,0.85)', fontWeight: 500 }}>{s.label}</span>
                  </div>
                ))}
              </div>

              <svg width="100%" height="20" viewBox="0 0 300 20" preserveAspectRatio="none" aria-hidden="true" style={{ display: 'block', marginTop: 14 }}>
                <defs>
                  <linearGradient id="glow" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#EE6C24" stopOpacity="0" />
                    <stop offset="50%" stopColor="#EE6C24" stopOpacity="0.9" />
                    <stop offset="100%" stopColor="#EE6C24" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path d="M0 10 Q150 -6 300 10" stroke="url(#glow)" strokeWidth="1.5" fill="none" />
              </svg>

              <div style={{ textAlign: 'center', fontSize: 11, fontWeight: 600, color: 'rgba(226,232,240,0.55)', letterSpacing: 0.6, marginTop: 10 }}>
                Build. Automate. Accelerate.
              </div>
            </div>
          </div>

          <div className="rs-login-right" style={{ flex: '1 1 48%', padding: '40px 48px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ maxWidth: 320, margin: '0 auto', width: '100%' }}>
              <h2 style={{ fontSize: 20, fontWeight: 700, color: '#12151C', margin: 0, lineHeight: 1.3 }}>
                Welcome to<br />EIT RunStack
              </h2>

              <p style={{ fontSize: 13.5, color: '#7A7D95', marginTop: 12, marginBottom: 28, lineHeight: 1.6 }}>
                Sign in with your corporate account to continue.
              </p>

              <Btn
                onClick={login}
                style={{ width: '100%', justifyContent: 'center', gap: 10, padding: '13px 20px', fontSize: 14.5, fontWeight: 600, borderRadius: 8, border: 'none', color: '#fff', background: TEAL }}
                onMouseEnter={(e) => { e.currentTarget.style.background = TEAL_DARK; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = TEAL; }}
              >
                <SSOGridIcon size={14} />
                Sign in with SSO →
              </Btn>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 16, fontSize: 11.5, color: '#7A7D95' }}>
                <LockIcon size={12} />
                Secured with enterprise SSO
              </div>

              <div style={{ height: 1, background: '#EFEBE5', margin: '28px 0 20px' }} />

              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <span style={{ width: 24, height: 24, borderRadius: 7, flexShrink: 0, background: '#F4F0E9', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <ChatIcon size={12} color="#7A7D95" />
                </span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#3D4160' }}>Need help?</div>
                  <a href="mailto:eit-ai-ops-runstack@dxc.com" style={{ fontSize: 12, color: TEAL, fontWeight: 500, textDecoration: 'none' }}>
                    Contact EIT RunStack Support
                  </a>
                </div>
              </div>

            </div>
          </div>

        </div>
      </main>

      <div style={{ textAlign: 'center', padding: '16px 0', flexShrink: 0, fontSize: 11, color: '#A39E94', position: 'relative', zIndex: 2 }}>
        DXC Internal | EIT RunStack Automation Platform
      </div>

      <style>{`
        @media (max-width: 1100px) {
          .rs-margin-text { display: none; }
        }
        @media (max-width: 900px) {
          .rs-header-links { display: none; }
        }
        @media (max-width: 760px) {
          .rs-login-card { flex-direction: column; min-height: 0 !important; }
          .rs-login-left { flex: none !important; padding: 32px 28px !important; }
          .rs-login-right { flex: none !important; padding: 32px 28px !important; }
          .rs-stack { display: none; }
        }
      `}</style>
    </div>
  );
}
