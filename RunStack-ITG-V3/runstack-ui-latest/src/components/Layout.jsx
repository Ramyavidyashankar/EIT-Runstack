// src/components/Layout.jsx
//
// App shell: the dark navy header (components/nav/AppHeader.jsx) above one
// scrolling content area. The vertical sidebar this file used to render has
// been replaced by the header; the navigation behaviour below is unchanged.
import React from 'react';
import ReactDOM from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { requestPageRefresh } from '../hooks/usePageRefresh';
import { getUnsavedChangesMessage } from '../hooks/useNavigation';
import { getApiActivity, subscribeApiActivity } from '../api/client';
import { Btn } from './ui';
import AppHeader from './nav/AppHeader';
import { useRunHub } from './run/runHubContext';
import AutomationHub from './run/AutomationHub';

import { NavigationContext } from './nav/navigationContext';

export { useAppNavigate } from './nav/navigationContext';

// ── Navigation behaviour ─────────────────────────────────────────────────────
// • Header item for another page: navigate in-app (no browser reload); the
//   page fetches its latest data when it mounts. The page's last query
//   string (e.g. Automation Executions filters) is restored.
// • Header item for the page already open: that page refreshes its data in
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

  // `to` may carry its own query (e.g. the Run Automations chooser's
  // /automations?category=database); then the remembered query isn't added.
  const target = (to) => (to.includes('?') ? to : `${to}${lastSearch.get(to) || ''}`);

  const go = React.useCallback((to) => {
    if (to === pathname || to === `${pathname}${search}`) {
      startBusy();
      requestPageRefresh(pathname);
      return;
    }
    const message = getUnsavedChangesMessage();
    if (message) { setPendingLeave({ to, message }); return; }
    startBusy();
    navigate(target(to));
  }, [pathname, search, navigate, startBusy]); // eslint-disable-line

  const leaveAnyway = () => {
    const to = pendingLeave.to;
    setPendingLeave(null);
    startBusy();
    navigate(target(to));
  };

  return (
    <NavigationContext.Provider value={go}>
    <div className="rs-shell">
      <a href="#rs-main" className="rs-skip-link">Skip to content</a>
      <AppHeader onNavigate={go} />
      <main id="rs-main" ref={contentRef} tabIndex={-1} className="rs-shell-main">
        <div className={`rs-nav-progress${busy ? ' is-busy' : ''}`} role="progressbar" aria-hidden={!busy} aria-label="Loading" />
        {children}
      </main>
      {pendingLeave && ReactDOM.createPortal(
        <>
          <div onClick={() => setPendingLeave(null)} aria-hidden style={{ position:'fixed', inset:0, background:'rgba(15,23,42,0.28)', zIndex:60 }} />
          <div role="alertdialog" aria-modal="true" aria-labelledby="rs-leave-title" style={{
            position:'fixed', top:'22vh', left:'50%', transform:'translateX(-50%)', width:'min(440px, 92vw)', zIndex:61,
            background:'#FFFFFF', borderRadius:12, padding:18, boxShadow:'var(--shadow-lg)', display:'grid', gap:12,
          }}>
            <div id="rs-leave-title" style={{ fontSize:15, fontWeight:700, color:'#172B4D' }}>Leave this page?</div>
            <div style={{ fontSize:13, color:'#2F4258', lineHeight:1.55 }}>{pendingLeave.message}</div>
            <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
              <Btn variant="default" onClick={leaveAnyway}>Leave page</Btn>
              <Btn variant="primary" onClick={() => setPendingLeave(null)}>Stay on this page</Btn>
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
    </NavigationContext.Provider>
  );
}

// ── Topbar ────────────────────────────────────────────────────────────────────
export function Topbar({ title: pageTitle, subtitle: pageSubtitle, actions }) {
  let title = pageTitle;
  let subtitle = pageSubtitle;
  // Pages under Run Automations (EC2, SQL Health Check, SQL DR Switchover and
  // approved documents) share one title and the Category → Automation
  // chooser (components/run/AutomationHub.jsx); the chosen automation's name
  // and description are shown in the chooser. Page actions are kept.
  const inRunHub = useRunHub();
  if (inRunHub) {
    title = 'Run Automations';
    subtitle = 'Select an automation and configure its targets.';
  }
  return (
    <>
      <div className="rs-topbar">
        <div className="rs-topbar-inner">
          <div style={{ minWidth:0 }}>
            <h1 className="rs-topbar-title">{title}</h1>
            {subtitle && <div className="rs-topbar-sub">{subtitle}</div>}
          </div>
          {actions && (
            <div className="rs-topbar-actions">
              {actions}
            </div>
          )}
        </div>
      </div>
      {inRunHub && <AutomationHub />}
    </>
  );
}
