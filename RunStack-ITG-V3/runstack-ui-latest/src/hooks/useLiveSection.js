// src/hooks/useLiveSection.js — one independently loaded, auto-refreshed page section.
//
// Each Dashboard section (cards, chart, recent executions) uses its own
// instance, so a slow or failing request only affects that section:
//   • first load shows the section's own spinner
//   • background refreshes keep the last good data on screen
//   • a failed refresh keeps the data and reports the error + its time
//   • changing `deps` (e.g. chart range) reloads; stale responses are ignored
import { useCallback, useEffect, useRef, useState } from 'react';

export function useLiveSection(load, deps, { intervalMs = 15000, enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true, refreshing: false, updatedAt: null });
  const gen = useRef(0);
  const busy = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async (background) => {
    if (background && busy.current) return;
    const g = ++gen.current;
    busy.current = true;
    setState((s) => ({ ...s, loading: !background, refreshing: true }));
    try {
      const data = await loadRef.current();
      if (g !== gen.current) return;
      setState({ data, error: null, loading: false, refreshing: false, updatedAt: new Date() });
    } catch (e) {
      if (g !== gen.current) return;
      setState((s) => ({ ...s, error: e.message || String(e), loading: false, refreshing: false }));
    } finally {
      if (g === gen.current) busy.current = false;
    }
  }, deps); // eslint-disable-line

  useEffect(() => { if (enabled) run(false); }, [run, enabled]);

  useEffect(() => {
    if (!enabled || !intervalMs) return undefined;
    const tick = () => { if (!document.hidden) run(true); };
    const id = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [run, intervalMs, enabled]);

  const refresh = useCallback(() => run(true), [run]);
  return { ...state, refresh };
}
