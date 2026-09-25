// src/hooks/usePageRefresh.js
//
// Two small hooks that give every page the same refresh behaviour.
//
// 1. Sidebar "same page" refresh
//    Clicking the sidebar link for the page you're already on doesn't
//    navigate (React Router would just push a duplicate history entry).
//    Instead Layout calls requestPageRefresh(path), and the page that is
//    open re-fetches its own data in place via usePageRefresh(callback) —
//    filters, selections, scroll position and half-finished work are kept
//    because the component is not remounted.
//
// 2. useAutoRefresh — interval polling with a "Last updated" time
//    Polls `load` every intervalMs, pauses while the browser tab is hidden
//    (no point hammering /jobs/recent in a background tab) and catches up
//    as soon as the tab is visible again. Overlapping calls are skipped so
//    a slow API never stacks requests.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

const EVENT = 'runstack:page-refresh';

/** Called by the sidebar when the active item is clicked again. */
export function requestPageRefresh(path) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { path } }));
}

/** Runs `callback` when the sidebar asks the current page to refresh. */
export function usePageRefresh(callback) {
  const { pathname } = useLocation();
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    const onRefresh = (e) => {
      if (e.detail?.path === pathname) cbRef.current?.();
    };
    window.addEventListener(EVENT, onRefresh);
    return () => window.removeEventListener(EVENT, onRefresh);
  }, [pathname]);
}

/**
 * @param {() => Promise<void>} load  fetches and applies fresh data
 * @param {{ intervalMs?: number, enabled?: boolean, immediate?: boolean }} opts
 * @returns {{ refresh, refreshing, lastUpdated, error }}
 */
export function useAutoRefresh(load, { intervalMs = 15000, enabled = true, immediate = false } = {}) {
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (mounted.current) setRefreshing(true);
    try {
      await loadRef.current();
      if (mounted.current) { setLastUpdated(new Date()); setError(null); }
    } catch (e) {
      if (mounted.current) setError(e.message || String(e));
    } finally {
      inFlight.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    if (immediate) refresh();
    const tick = () => { if (!document.hidden) refresh(); };
    const id = setInterval(tick, intervalMs);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs, immediate, refresh]);

  return { refresh, refreshing, lastUpdated, error, setLastUpdated };
}
