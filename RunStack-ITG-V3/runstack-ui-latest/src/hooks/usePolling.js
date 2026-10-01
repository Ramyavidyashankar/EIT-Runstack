// src/hooks/usePolling.js — sequential polling for live views.
//
// Differs from useAutoRefresh (setInterval) in the ways a live console
// needs:
//   • never overlaps: the next poll is scheduled only after the previous
//     one settles, and a manual refresh while one is in flight is dropped
//   • each poll gets an AbortSignal; navigating away (unmount) or turning
//     polling off aborts the request in flight
//   • backs off after errors (longer for 429 throttling), then returns to
//     the normal interval after a success
//   • pauses while the browser tab is hidden and polls once as soon as it
//     is visible again
//   • `task` may return { nextDelayMs } to ask for an earlier/later poll
//     (e.g. "more output is waiting"), or { stop: true } to end automatic
//     polling (manual refresh still works)
//
// Pausing here only stops the page asking for updates — the automation
// itself keeps running in AWS.

import { useCallback, useEffect, useRef, useState } from 'react';
import { backoffMs, classifyFetchError } from '../utils/executionLogs';

/**
 * @param {(signal: AbortSignal) => Promise<void | {nextDelayMs?: number}>} task
 * @param {{ intervalMs: number, enabled?: boolean, key?: any }} opts
 *   enabled=false stops automatic polling (manual refresh still works);
 *   changing `key` restarts the loop immediately (e.g. a new selection).
 */
export function usePolling(task, { intervalMs, enabled = true, key } = {}) {
  const [state, setState] = useState({ refreshing: false, lastSuccess: null, error: null, failures: 0 });
  const taskRef = useRef(task);
  taskRef.current = task;
  const inFlight = useRef(null);      // AbortController of the running poll
  const timer = useRef(null);
  const failures = useRef(0);
  const mounted = useRef(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;

  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const runRef = useRef(null);
  const schedule = (ms) => {
    clearTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      if (document.hidden) return;         // resumed by visibilitychange
      runRef.current?.();
    }, Math.max(250, ms));
  };

  const run = useCallback(async ({ manual = false } = {}) => {
    if (inFlight.current) return;
    clearTimer();
    const ctrl = new AbortController();
    inFlight.current = ctrl;
    if (mounted.current) setState((s) => ({ ...s, refreshing: true }));
    let nextDelay = intervalRef.current;
    try {
      const res = await taskRef.current(ctrl.signal);
      failures.current = 0;
      if (res && typeof res.nextDelayMs === 'number') nextDelay = res.nextDelayMs;
      if (res && res.stop) nextDelay = null;      // task says automatic polling is done
      // The task finished; an abort that arrives after that (e.g. polling was
      // switched off by the data it just loaded) doesn't undo the success.
      if (mounted.current) setState({ refreshing: false, lastSuccess: new Date(), error: null, failures: 0 });
    } catch (e) {
      const info = classifyFetchError(e);
      if (info?.kind === 'aborted' || ctrl.signal.aborted) {
        if (mounted.current) setState((s) => ({ ...s, refreshing: false }));
        return;
      }
      failures.current += 1;
      nextDelay = backoffMs(intervalRef.current, failures.current, { throttled: info?.kind === 'throttled' });
      if (mounted.current) setState((s) => ({ ...s, refreshing: false, error: info, failures: failures.current }));
      if (info?.kind === 'auth' || info?.kind === 'not_found') nextDelay = null;   // retrying won't help
    } finally {
      if (inFlight.current === ctrl) inFlight.current = null;
    }
    if (mounted.current && enabledRef.current && nextDelay != null) schedule(manual ? intervalRef.current : nextDelay);
  }, []); // eslint-disable-line
  runRef.current = run;

  // Start / restart when enabled or key changes; stop (and abort) otherwise.
  useEffect(() => {
    mounted.current = true;
    if (enabled) {
      inFlight.current?.abort();
      inFlight.current = null;
      failures.current = 0;
      run();
    }
    return () => {
      clearTimer();
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [enabled, key, run]);

  useEffect(() => () => { mounted.current = false; }, []);

  // Hidden tab: stop asking. Visible again: poll now.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) { clearTimer(); return; }
      if (enabledRef.current && !inFlight.current) run();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [run]);

  const refresh = useCallback(() => run({ manual: true }), [run]);
  return { ...state, refresh };
}
