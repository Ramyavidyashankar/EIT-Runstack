// src/components/Layout.jsx
import React from 'react';
import ReactDOM from 'react-dom';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { canAccess, DR_SWITCHOVER_ACCESS } from '../auth/access';
import { requestPageRefresh } from '../hooks/usePageRefresh';
import { getUnsavedChangesMessage } from '../hooks/useNavigation';
import { getApiActivity, subscribeApiActivity } from '../api/client';
import { Btn } from './ui';

// Sidebar sections. Each item's visibility rule is { minRole, orGroups } —
// see auth/access.js. Visibility is a convenience, not authorization: the
// backend authorizes every API call on these pages independently.
const NAV = [
  { group: 'Monitor', items: [
    { to: '/',          label: 'Dashboard',             icon: IconGrid  },
    { to: '/jobs',      label: 'Automation Executions', icon: IconList  },
    { to: '/dlq',       label: 'Dead Letter Queue',     icon: IconAlert, badge: '!', badgeColor: '#DC2626', minRole: 'operator' },
  ]},
  { group: 'Automate', items: [
    { to: '/trigger',   label: 'Run Automation',        icon: IconPlay  },
    { to: '/schedules', label: 'Triggers & Schedules',  icon: IconClock, minRole: 'operator' },
    { to: '/accounts',  label: 'Registered Targets',    icon: IconCloud },
  ]},
  // Database-level operations. Only features that exist are listed —
  // e.g. add { to: '/database/health-checks', label: 'Database Health
  // Checks', ... } here once that page and its backend ship.
  { group: 'Database Operations', items: [
    { to: '/database/dr-switchover', label: 'DR Switchover', icon: IconSwitch, ...DR_SWITCHOVER_ACCESS },
  ]},
  { group: 'Config', items: [
    { to: '/docs',      label: 'SSM Documents',         icon: IconDoc   },
    { to: '/uploads',   label: 'Uploads',               icon: IconUpload, minRole: 'admin' },
    { to: '/users',     label: 'Users & Access',         icon: IconUsers, minRole: 'admin' },
    { to: '/settings',  label: 'Settings',              icon: IconGear  },
  ]},
];

// ── Navigation behaviour ─────────────────────────────────────────────────────
// • Sidebar item for another page: navigate in-app (no browser reload); the
//   page fetches its latest data when it mounts. The page's last query
//   string (e.g. Automation Executions filters) is restored.
// • Sidebar item for the page already open: that page refreshes its data in
//   place (usePageRefresh) — filters, selections and scroll are kept.
// • Either way a thin teal bar shows while the resulting API calls run.
// • If the open page has work that leaving would discard (useUnsavedChanges),
//   the user is asked first.
// • Scroll position is remembered per page and restored on return.
// • Ctrl/Cmd/middle-click keeps the browser's "open in new tab" behaviour.

const lastSearch = new Map();   // pathname → last location.search
const scrollMemory = new Map(); // pathname → { chain: number[], top }

function elementChain(root, el) {
  const chain = [];
  let node = el;
  while (node && node !== root) {
    const parent = node.parentElement;
    if (!parent) return null;
    chain.unshift(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return node === root ? chain : null;
}
function elementAt(root, chain) {
  let node = root;
  for (const i of chain) { node = node?.children?.[i]; if (!node) return null; }
  return node;
}

export default function Layout({ children }) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const contentRef = React.useRef(null);
  const [busy, setBusy] = React.useState(false);
  const busyTimer = React.useRef(null);
  const [pendingLeave, setPendingLeave] = React.useState(null); // { to, message }

  React.useEffect(() => { lastSearch.set(pathname, search); }, [pathname, search]);

  // Loading bar: shown right after a navigation/refresh until the API calls
  // it triggered have finished (min 300 ms so it doesn't flicker, max 15 s).
  const startBusy = React.useCallback(() => {
    setBusy(true);
    const started = Date.now();
    clearTimeout(busyTimer.current);
    let unsubscribe = () => {};
    const finish = () => {
      unsubscribe();
      busyTimer.current = setTimeout(() => setBusy(false), Math.max(0, 300 - (Date.now() - started)));
    };
    busyTimer.current = setTimeout(() => {
      if (getApiActivity() === 0) { finish(); return; }
      unsubscribe = subscribeApiActivity((n) => { if (n === 0) finish(); });
      busyTimer.current = setTimeout(finish, 15_000);
    }, 150);
  }, []);
  React.useEffect(() => () => clearTimeout(busyTimer.current), []);

  // Scroll memory: record the scrolled element inside the content area.
  React.useEffect(() => {
    const root = contentRef.current;
    if (!root) return undefined;
    const onScroll = (e) => {
      const el = e.target === document ? null : e.target;
      if (!el || !root.contains(el)) return;
      const chain = elementChain(root, el);
      if (chain) scrollMemory.set(window.location.pathname, { chain, top: el.scrollTop });
    };
    root.addEventListener('scroll', onScroll, true);
    return () => root.removeEventListener('scroll', onScroll, true);
  }, []);

  // …and restore it once the page has rendered enough content.
  React.useEffect(() => {
    const saved = scrollMemory.get(pathname);
    if (!saved || !saved.top) return undefined;
    let tries = 0;
    const id = setInterval(() => {
      tries += 1;
      const el = elementAt(contentRef.current, saved.chain);
      if (el && el.scrollHeight - el.clientHeight >= saved.top) { el.scrollTop = saved.top; clearInterval(id); }
      else if (tries > 40) clearInterval(id);
    }, 50);
    return () => clearInterval(id);
  }, [pathname]);

  const go = React.useCallback((to) => {
    if (to === pathname) {
      startBusy();
      requestPageRefresh(to);
      return;
    }
    const message = getUnsavedChangesMessage();
    if (message) { setPendingLeave({ to, message }); return; }
    startBusy();
    navigate(`${to}${lastSearch.get(to) || ''}`);
  }, [pathname, navigate, startBusy]);

  const leaveAnyway = () => {
    const to = pendingLeave.to;
    setPendingLeave(null);
    startBusy();
    navigate(`${to}${lastSearch.get(to) || ''}`);
  };

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden' }}>
      <Sidebar onNavigate={go} />
      <div ref={contentRef} style={{ flex:1, display:'flex', flexDirection:'column', overflowY:'auto', overflowX:'hidden', position:'relative' }}>
        <div className={`rs-nav-progress${busy ? ' is-busy' : ''}`} role="progressbar" aria-hidden={!busy} aria-label="Loading" />
        {children}
      </div>
      {pendingLeave && ReactDOM.createPortal(
        <>
          <div onClick={() => setPendingLeave(null)} aria-hidden style={{ position:'fixed', inset:0, background:'rgba(15,23,42,0.28)', zIndex:60 }} />
          <div role="alertdialog" aria-modal="true" aria-labelledby="rs-leave-title" style={{
            position:'fixed', top:'22vh', left:'50%', transform:'translateX(-50%)', width:'min(440px, 92vw)', zIndex:61,
            background:'#FFFFFF', borderRadius:12, padding:18, boxShadow:'var(--shadow-lg)', display:'grid', gap:12,
          }}>
            <div id="rs-leave-title" style={{ fontSize:15, fontWeight:700, color:'#0F172A' }}>Leave this page?</div>
            <div style={{ fontSize:13, color:'#334155', lineHeight:1.55 }}>{pendingLeave.message}</div>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
              <Btn variant="default" onClick={leaveAnyway}>Leave page</Btn>
              <Btn variant="primary" onClick={() => setPendingLeave(null)}>Stay on this page</Btn>
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

function Sidebar({ onNavigate }) {
  const { role, email, groups, logout } = useAuth();
  const { pathname } = useLocation();

  const visibleNav = NAV
    .map(group => ({
      ...group,
      items: group.items.filter(item => canAccess({ role, groups }, item)),
    }))
    .filter(group => group.items.length > 0);

  // Plain left clicks are handled by Layout (refresh / in-app navigation /
  // unsaved-work prompt). Modified clicks open a new tab as usual — the new
  // tab picks up the session from this one (auth/tokenStorage.js).
  const onNavClick = (e, to) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onNavigate(to);
  };

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
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className="rs-navlink"
                onClick={(e) => onNavClick(e, item.to)}
                title={pathname === item.to ? `Refresh ${item.label}` : undefined}
                style={({ isActive }) => ({
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
// Two opposing arrows — a planned role swap between replicas.
function IconSwitch({ size, color }) {
  return <Icon size={size} color={color}>
    <path d="M2.5 5h10"/>
    <path d="M10 2.5L12.5 5 10 7.5"/>
    <path d="M13.5 11h-10"/>
    <path d="M6 8.5L3.5 11 6 13.5"/>
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
