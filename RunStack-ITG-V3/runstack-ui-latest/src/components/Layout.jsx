// src/components/Layout.jsx
import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const NAV = [
  { group: 'Monitor', items: [
    { to: '/',          label: 'Dashboard',        icon: IconGrid  },
    //{ to: '/jobs',      label: 'Jobs',             icon: IconList  },
    { to: '/jobs',      label: 'Automation Executions', icon: IconList  },
    { to: '/dlq',       label: 'Dead Letter Queue', icon: IconAlert, badge: '!', badgeColor: '#DC2626', minRole: 'operator' },
  ]},
  { group: 'Automate', items: [
    { to: '/trigger',   label: 'Run Automation',      icon: IconPlay  },
    { to: '/schedules', label: 'Schedules',        icon: IconClock, minRole: 'operator' },
    { to: '/accounts',  label: 'Target Accounts',  icon: IconCloud },
    //{ to: '/dr-failover', label: 'DR Failover',    icon: IconShield, minRole: 'operator', orGroup: 'runstack-team-gdba' },*/},
    { to: '/dr-failover', label: 'DR Failover',    icon: IconShield, minRole: 'operator', orGroup: 'runstack-team-gdba-sql' },
  ]},
  { group: 'Config', items: [
    { to: '/docs',      label: 'SSM Documents',    icon: IconDoc   },
    { to: '/uploads',   label: 'Uploads',          icon: IconUpload, minRole: 'admin' },
    { to: '/users',     label: 'Users & Roles',    icon: IconUsers, minRole: 'admin' },
    { to: '/settings',  label: 'Settings',         icon: IconGear  },
  ]},
];

const ROLE_RANK = { admin: 3, operator: 2, viewer: 1, none: 0 };

export default function Layout({ children }) {
  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden' }}>
      <Sidebar />
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflowY:'auto', overflowX:'hidden' }}>
        {children}
      </div>
    </div>
  );
}

function Sidebar() {
  const { role, email, groups, logout } = useAuth();

  const visibleNav = NAV
    .map(group => ({
      ...group,
      items: group.items.filter(item => {
        if (!item.minRole) return true;
        if (ROLE_RANK[role] >= ROLE_RANK[item.minRole]) return true;
        if (item.orGroup && groups?.includes(item.orGroup)) return true;
        return false;
      }),
    }))
    .filter(group => group.items.length > 0);

  return (
    <aside style={{
      width:'var(--sidebar-w)', minWidth:'var(--sidebar-w)',
      background:'linear-gradient(180deg, var(--slate-950) 0%, #0D1526 100%)',
      borderRight:'1px solid rgba(255,255,255,0.06)',
      display:'flex', flexDirection:'column', overflow:'hidden',
    }}>

      {/* ── Logo + Product name ── */}
      <div style={{
        padding:'20px 18px 16px',
        borderBottom:'1px solid rgba(255,255,255,0.06)',
      }}>
        <img
          src="/dxc-logo-color.svg"
          alt="DXC"
          style={{ width:85, height:'auto', display:'block', marginBottom:10 }}
        />
        {/* Divider line */}
        <div style={{
          height:1, background:'rgba(148,163,184,0.18)', marginBottom:10,
        }}/>
        {/* Product name */}
        <div style={{
          fontSize:12, fontWeight:700, color:'#7FA8FF',
          letterSpacing:1.4, textTransform:'uppercase',
        }}>
          RunStack ITG
        </div>
        <div style={{ fontSize:10, color:'rgba(148,163,184,0.6)', marginTop:2 }}>
          Automation Platform
        </div>
      </div>

      {/* ── Navigation ── */}
      <nav style={{ flex:1, overflowY:'auto', padding:'8px 8px' }}>
        {visibleNav.map(group => (
          <div key={group.group} style={{ marginBottom:4 }}>
            {/* Group label */}
            <div style={{
              fontSize:10, fontWeight:600,
              color:'rgba(148,163,184,0.4)',
              letterSpacing:1, textTransform:'uppercase',
              padding:'10px 10px 4px',
            }}>
              {group.group}
            </div>

            {group.items.map(item => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className="rs-navlink" style={({ isActive }) => ({
                display:'flex', alignItems:'center', gap:9,
                padding:'7px 10px', borderRadius:'var(--radius-md)',
                fontSize:13, fontWeight: isActive ? 600 : 400,
                color: isActive ? '#7FA8FF' : 'rgba(226,232,240,0.75)',
                background: isActive ? 'rgba(37,84,224,0.22)' : 'transparent',
                textDecoration:'none', transition:'all 0.12s',
                marginBottom:1,
                borderLeft: isActive ? '2px solid #5C87F2' : '2px solid transparent',
              })}>
                {({ isActive }) => (
                  <>
                    <item.icon
                      size={15}
                      color={isActive ? '#7FA8FF' : 'rgba(226,232,240,0.45)'}
                    />
                    <span style={{ flex:1 }}>{item.label}</span>
                    {item.badge && (
                      <span style={{
                        fontSize:10, fontWeight:700, padding:'1px 5px',
                        borderRadius:10,
                        background: item.badgeColor || '#DC2626',
                        color:'#fff', lineHeight:1.4,
                      }}>
                        {item.badge}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* ── Footer ── */}
      <div style={{
        padding:'12px 18px',
        borderTop:'1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{
          display:'flex', alignItems:'center', justifyContent:'space-between',
          marginBottom:8, paddingBottom:8, borderBottom:'1px solid rgba(255,255,255,0.06)',
        }}>
          <div style={{ display:'flex', alignItems:'center', gap:9, minWidth:0 }}>
            <div style={{
              width:26, height:26, borderRadius:'50%', flexShrink:0,
              background:'rgba(37,84,224,0.22)', color:'#7FA8FF',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:11, fontWeight:700, border:'1px solid rgba(37,84,224,0.4)',
            }}>
              {(email || '?').trim().charAt(0).toUpperCase()}
            </div>
            <div style={{ minWidth:0 }}>
              <div style={{
                fontSize:11, color:'rgba(226,232,240,0.85)', fontWeight:500,
                overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
              }}>
                {email || 'Signed in'}
              </div>
              <div style={{ fontSize:10, color:'rgba(148,163,184,0.5)', marginTop:1, textTransform:'capitalize' }}>
                {role}
              </div>
            </div>
          </div>
          <button
            onClick={logout}
            style={{
              fontSize:11, color:'rgba(148,163,184,0.7)', background:'none',
              border:'none', cursor:'pointer', padding:'4px 6px', flexShrink:0,
            }}
          >
            Sign out
          </button>
        </div>
        <div style={{ fontSize:11, color:'rgba(148,163,184,0.5)', lineHeight:1.6 }}>
          {process.env.REACT_APP_SOLUTION_NAME || 'runstack-custom-automation'}
        </div>
        <div style={{ fontSize:10, color:'rgba(148,163,184,0.3)', marginTop:2 }}>
          Serverless · AWS SAM
        </div>
      </div>
    </aside>
  );
}

// ── Topbar ────────────────────────────────────────────────────────────────────
export function Topbar({ title, subtitle, actions }) {
  return (
    <div style={{
      height:'var(--topbar-h)', minHeight:'var(--topbar-h)',
      background:'var(--bg-surface)',
      borderBottom:'1px solid var(--border)',
      boxShadow:'var(--shadow-sm)',
      padding:'0 24px',
      display:'flex', alignItems:'center', justifyContent:'space-between',
      position:'sticky', top:0, zIndex:5,
    }}>
      <div>
        <div style={{
          fontSize:15, fontWeight:700, color:'var(--text-primary)',
        }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:1 }}>
            {subtitle}
          </div>
        )}
      </div>
      {actions && (
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          {actions}
        </div>
      )}
    </div>
  );
}

// ── Icons (stroke-based, neutral) ─────────────────────────────────────────────
function Icon({ size=16, color='currentColor', children }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

function IconGrid({ size, color }) {
  return <Icon size={size} color={color}>
    <rect x="1.5" y="1.5" width="5" height="5" rx="1"/>
    <rect x="9.5" y="1.5" width="5" height="5" rx="1"/>
    <rect x="1.5" y="9.5" width="5" height="5" rx="1"/>
    <rect x="9.5" y="9.5" width="5" height="5" rx="1"/>
  </Icon>;
}
function IconList({ size, color }) {
  return <Icon size={size} color={color}>
    <path d="M2 4h12M2 8h9M2 12h11"/>
  </Icon>;
}
function IconAlert({ size, color }) {
  return <Icon size={size} color={color}>
    <path d="M8 1.5L14.5 13.5H1.5L8 1.5z"/>
    <path d="M8 6v3.5"/>
    <circle cx="8" cy="11.5" r="0.5" fill={color}/>
  </Icon>;
}
function IconPlay({ size, color }) {
  return <Icon size={size} color={color}>
    <path fill={color} stroke="none" d="M3.5 2.5l10 5.5-10 5.5z"/>
  </Icon>;
}
function IconClock({ size, color }) {
  return <Icon size={size} color={color}>
    <circle cx="8" cy="8" r="6"/>
    <path d="M8 5v3.5l2.5 1.5"/>
  </Icon>;
}
function IconShield({ size, color }) {
  return <Icon size={size} color={color}>
    <path d="M8 1.5l5.5 2v4.2c0 3.4-2.3 5.9-5.5 6.8-3.2-0.9-5.5-3.4-5.5-6.8V3.5l5.5-2z"/>
    <path d="M5.5 8l1.8 1.8L10.5 6.2"/>
  </Icon>;
}
function IconCloud({ size, color }) {
  return <Icon size={size} color={color}>
    <path d="M4 11a3 3 0 0 1 0-6 4 4 0 0 1 8 1 3 3 0 0 1 0 5"/>
  </Icon>;
}
function IconDoc({ size, color }) {
  return <Icon size={size} color={color}>
    <path d="M3 2h7l3 3v9H3V2z"/>
    <path d="M10 2v3h3"/>
    <path d="M6 8h4M6 11h3"/>
  </Icon>;
}

function IconUpload({ size, color }) {
  return <Icon size={size} color={color}>
    <path d="M8 11V3"/>
    <path d="M5 6l3-3 3 3"/>
    <path d="M3 11v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2"/>
  </Icon>;
}

function IconUsers({ size, color }) {
  return <Icon size={size} color={color}>
    <circle cx="5.5" cy="5" r="2"/>
    <path d="M1.5 13c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5"/>
    <circle cx="11" cy="5.5" r="1.6"/>
    <path d="M10 9.7c1.7.1 3 1.3 3 3.3"/>
  </Icon>;
}
function IconGear({ size, color }) {
  return <Icon size={size} color={color}>
    <circle cx="8" cy="8" r="2.5"/>
    <path d="M8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M3.4 12.6l.7-.7M11.9 4.1l.7-.7"/>
  </Icon>;
}
