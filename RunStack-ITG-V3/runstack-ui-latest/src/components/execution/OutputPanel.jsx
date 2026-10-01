// src/components/execution/OutputPanel.jsx
//
// Output tab of Execution Details: the selected server's stdout/stderr from
// CloudWatch Logs (GET /jobs/{jobId}/logs).
//
// How output arrives
//   The SSM Agent uploads output to CloudWatch in batches (typically about
//   every 30 seconds), and scripts that buffer their own output add more
//   delay — so this is "near live", not a keystroke-level terminal.
//
// Behaviour
//   • incremental: only new events are fetched, using the opaque cursor the
//     API returned; older output is loaded on request with the older cursor
//   • each server keeps its own buffer (up to MAX_CONSOLE_LINES lines, last
//     few servers only), so switching servers doesn't lose what was loaded
//   • after the server finishes, polling continues for a short grace period
//     to catch the final batch, then stops; Refresh still works
//   • "Pause updates" only stops this page asking; the script keeps running
//   • a failure to READ output is shown as such, never as a script failure

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fetchExecutionLogs } from '../../api/client';
import { usePolling } from '../../hooks/usePolling';
import { Btn, Spinner } from '../ui';
import { Callout } from '../sections';
import { CopyButton } from '../JobDetail';
import { downloadText } from '../../utils/jobs';
import {
  MAX_CONSOLE_LINES, appendBounded, eventsToLines, filterLines, isActiveTarget, linesToText, logFileName, prependBounded,
} from '../../utils/executionLogs';

const FINISHED_GRACE_MS = 90_000;      // keep collecting delayed final output this long
const FINISHED_POLL_MS = 15_000;
const UNAVAILABLE_POLL_MS = 30_000;
const MAX_BUFFERS = 5;
const DOWNLOAD_MAX_PAGES = 60;

function newBuffer() {
  return { lines: [], seq: 0, olderBatch: 0, nextCursor: null, olderCursor: null, started: false, dropped: 0, meta: null, finishedAt: null, stopped: false };
}

/** Per-target buffers that survive switching servers (LRU, bounded). */
export function useLogBuffers() {
  const ref = useRef(new Map());
  return useCallback((key) => {
    const m = ref.current;
    let b = m.get(key);
    if (b) { m.delete(key); m.set(key, b); return b; }
    b = newBuffer();
    m.set(key, b);
    while (m.size > MAX_BUFFERS) m.delete(m.keys().next().value);
    return b;
  }, []);
}

const VIEWS = [{ v: 'all', l: 'Combined' }, { v: 'stdout', l: 'stdout' }, { v: 'stderr', l: 'stderr' }];

export default function OutputPanel({ jobId, target, paused, getBuffer, isEc2 }) {
  const key = target.key;
  const buf = getBuffer(key);
  const [, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);
  const [view, setView] = useState('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [showTimes, setShowTimes] = useState(false);
  const [olderState, setOlderState] = useState({ loading: false, error: null });
  const [download, setDownload] = useState(null);
  const box = useRef(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  const targetActive = isActiveTarget(target.status);
  if (!targetActive && !buf.finishedAt) buf.finishedAt = Date.now();
  if (targetActive) { buf.finishedAt = null; buf.stopped = false; }

  const task = useCallback(async (signal) => {
    const b = getBuffer(key);
    const res = await fetchExecutionLogs(jobId, { target: key, cursor: b.nextCursor || undefined }, { signal });
    if (keyRef.current !== key) return { stop: true };
    b.meta = res;
    if (res.replace) {
      // Final output from Systems Manager (running output unavailable):
      // the whole output, so replace rather than append.
      b.lines = eventsToLines(res.events || [], 0).slice(-MAX_CONSOLE_LINES);
      b.seq = b.lines.length;
      b.olderCursor = null;
      b.stopped = true;
      bump();
      return { stop: true };
    }
    if (res.events?.length) {
      const lines = eventsToLines(res.events, b.seq);
      b.seq = lines.length ? lines[lines.length - 1].id : b.seq;
      const { lines: next, dropped } = appendBounded(b.lines, lines);
      b.lines = next;
      b.dropped += dropped;
    }
    if (res.next_cursor) b.nextCursor = res.next_cursor;
    if (!b.started && res.status === 'ok') {
      b.olderCursor = res.older_cursor || null;
      b.started = true;
    }
    bump();
    if (res.more) return { nextDelayMs: 1000 };
    if (res.status === 'unavailable') return { nextDelayMs: UNAVAILABLE_POLL_MS };
    if (res.status === 'not_configured' || res.status === 'no_output') {
      if (!res.is_active) { b.stopped = true; return { stop: true }; }
    }
    if (!res.is_active) {
      const since = b.finishedAt || Date.now();
      if (Date.now() - since > FINISHED_GRACE_MS) { b.stopped = true; bump(); return { stop: true }; }
      return { nextDelayMs: FINISHED_POLL_MS };
    }
    return { nextDelayMs: res.poll_interval_ms || 10000 };
  }, [jobId, key, getBuffer]);

  const outputPossible = target.output_mode !== 'none';
  const poll = usePolling(task, {
    intervalMs: 10000, key,
    enabled: !paused && outputPossible && !buf.stopped,
  });

  // Load older output (prepended; never evicts what's on screen).
  const loadOlder = async () => {
    if (!buf.olderCursor) return;
    setOlderState({ loading: true, error: null });
    try {
      const res = await fetchExecutionLogs(jobId, { target: key, direction: 'backward', cursor: buf.olderCursor });
      if (keyRef.current !== key) return;
      buf.olderBatch += 1;
      const lines = eventsToLines(res.events, 0).map((l, i) => ({ ...l, id: `older-${buf.olderBatch}-${i}` }));
      const { lines: next, kept } = prependBounded(buf.lines, lines);
      buf.lines = next;
      buf.olderCursor = kept < lines.length ? buf.olderCursor : (res.older_cursor || null);
      setOlderState({ loading: false, error: kept < lines.length ? `Console is at its ${MAX_CONSOLE_LINES.toLocaleString()}-line limit — download the log to see everything.` : null });
      setAutoScroll(false);
      bump();
    } catch (e) {
      setOlderState({ loading: false, error: e.message || String(e) });
    }
  };

  // Download: everything loaded, plus all older pages when the console
  // hasn't trimmed anything (so the file is complete and in order).
  const downloadLog = async () => {
    const stamp = new Date();
    if (!buf.olderCursor || buf.dropped) {
      downloadText(linesToText(buf.lines), logFileName(target, stamp), 'text/plain');
      return;
    }
    setDownload({ pages: 0 });
    try {
      let older = [];
      let cursor = buf.olderCursor;
      let pages = 0;
      while (cursor && pages < DOWNLOAD_MAX_PAGES) {
        const res = await fetchExecutionLogs(jobId, { target: key, direction: 'backward', cursor });
        older = eventsToLines(res.events, 0).concat(older);
        cursor = res.older_cursor;
        pages += 1;
        setDownload({ pages });
      }
      const header = cursor ? `# Truncated: first part of the log not included (download limit reached)\n` : '';
      downloadText(header + linesToText(older.concat(buf.lines)), logFileName(target, stamp), 'text/plain');
    } catch (e) {
      setOlderState({ loading: false, error: `Download failed: ${e.message || e}` });
    } finally {
      setDownload(null);
    }
  };

  const shown = useMemo(() => filterLines(buf.lines, view), [buf.lines, view]); // eslint-disable-line

  // Auto-scroll: follow new output unless the user scrolled up.
  useLayoutEffect(() => {
    if (autoScroll && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown.length, autoScroll, key]);
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom && autoScroll) setAutoScroll(false);
  };

  useEffect(() => { setOlderState({ loading: false, error: null }); }, [key]);

  const meta = buf.meta;
  const status = meta?.status;
  const hasLines = buf.lines.length > 0;

  if (!outputPossible) {
    return (
      <div style={{ padding: 16 }}>
        <Callout tone="info" title="No console output for this target">
          {isEc2
            ? 'EC2 status checks call the EC2 API directly; there is no script output.'
            : "This execution's steps don't run commands on the server, so there is no running output. Step status and outputs are on the Steps tab."}
        </Callout>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid #E2E8F0', background: '#FFFFFF' }}>
        <div role="group" aria-label="Streams" style={{ display: 'inline-flex', border: '1px solid #CBD5E1', borderRadius: 8, overflow: 'hidden' }}>
          {VIEWS.map((x) => (
            <button key={x.v} type="button" onClick={() => setView(x.v)} aria-pressed={view === x.v} style={{
              padding: '4px 10px', fontSize: 11.5, fontWeight: 600, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              background: view === x.v ? 'var(--brand)' : '#FFFFFF', color: view === x.v ? '#FFFFFF' : '#334155',
            }}>{x.l}</button>
          ))}
        </div>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: '#334155', cursor: 'pointer' }}>
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /> Auto-scroll
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: '#334155', cursor: 'pointer' }}>
          <input type="checkbox" checked={showTimes} onChange={(e) => setShowTimes(e.target.checked)} /> Times
        </label>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {poll.refreshing && <Spinner size={12} />}
          <CopyButton value={hasLines ? linesToText(shown, { withMeta: false }) : ''} label="Copy output" size="md" />
          <Btn size="sm" variant="default" onClick={downloadLog} disabled={!hasLines || !!download}>
            {download ? <><Spinner size={12} /> {download.pages} pages…</> : '↓ Download'}
          </Btn>
          <Btn size="sm" variant="default" onClick={poll.refresh} disabled={poll.refreshing}>Refresh</Btn>
        </span>
      </div>

      {/* State messages */}
      <div style={{ display: 'grid', gap: 8, padding: (poll.error || status === 'unavailable' || status === 'not_configured' || status === 'final_only' || (!hasLines && meta)) ? '10px 12px 0' : 0 }}>
        {poll.error && (
          <Callout tone="warning" title="Couldn't fetch new output">
            {poll.error.message} This is a problem reading the logs, not a failure of the script. Retrying automatically.
          </Callout>
        )}
        {status === 'unavailable' && (
          <Callout tone="warning" title="Output temporarily unavailable">
            {meta.message}
            {meta.retrieval_error && (
              <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 11.5, wordBreak: 'break-word' }}>
                {meta.retrieval_error.code}{meta.retrieval_error.message ? `: ${meta.retrieval_error.message}` : ''}
              </div>
            )}
          </Callout>
        )}
        {status === 'final_only' && <Callout tone="info" title="Final output (not live)" />}
        {status === 'not_configured' && (
          <Callout tone="info" title="Running output isn't available for this command">{meta.message}</Callout>
        )}
        {!hasLines && (status === 'waiting' || (!meta && poll.refreshing)) && (
          <Callout tone="info" title="Waiting for script output">
            {meta?.batching_note || 'Systems Manager uploads output in batches, usually about every 30 seconds.'}
          </Callout>
        )}
        {!hasLines && (status === 'no_logs' || status === 'no_output') && (
          <Callout tone="info">{meta.message}</Callout>
        )}
      </div>

      {status === 'not_configured' && meta.final_output?.length > 0 && (
        <div style={{ padding: '10px 12px 0', display: 'grid', gap: 8 }}>
          {meta.final_output.map((p, i) => (
            <div key={i}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 4 }}>
                Final output preview · {p.step || p.plugin} <span style={{ fontWeight: 400, color: '#94A3B8' }}>(first 2,500 characters, from Systems Manager)</span>
              </div>
              <pre style={consoleStyle(false)}>{p.text}</pre>
            </div>
          ))}
        </div>
      )}

      {/* Console */}
      {(hasLines || status === 'ok') && (
        <div style={{ flex: 1, minHeight: 160, display: 'flex', flexDirection: 'column', padding: '10px 12px 12px' }}>
          {(buf.olderCursor || olderState.error || buf.dropped > 0) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, fontSize: 11.5, color: '#64748B' }}>
              {buf.olderCursor && !buf.dropped && (
                <Btn size="sm" variant="ghost" onClick={loadOlder} disabled={olderState.loading}>
                  {olderState.loading ? <><Spinner size={12} /> Loading…</> : '↑ Load older output'}
                </Btn>
              )}
              {buf.dropped > 0 && <span>Oldest {buf.dropped.toLocaleString()} lines were removed from the console to save memory.</span>}
              {olderState.error && <span style={{ color: '#B45309' }}>{olderState.error}</span>}
            </div>
          )}
          <div ref={box} onScroll={onScroll} role="log" aria-live="off" aria-label="Script output"
            style={{ ...consoleStyle(true), flex: 1, minHeight: 160, overflow: 'auto' }}>
            {shown.length === 0
              ? <span style={{ color: '#94A3B8' }}>{view === 'all' ? 'No output yet.' : `No ${view} output.`}</span>
              : shown.map((l) => (
                <div key={l.id} style={{ color: l.stream === 'stderr' ? '#FCA5A5' : '#E2E8F0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {showTimes && <span style={{ color: '#64748B', userSelect: 'none' }}>{l.ts ? new Date(l.ts).toISOString().slice(11, 19) : '--:--:--'} </span>}
                  {l.text || ' '}{l.truncated && <span style={{ color: '#F59E0B' }}> [line truncated]</span>}
                </div>
              ))}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6, fontSize: 11, color: '#64748B', flexWrap: 'wrap' }}>
            <span>{buf.lines.length.toLocaleString()} lines loaded{meta?.log_group ? ` · ${meta.log_group}` : ''}</span>
            <span>·</span>
            <span>
              {paused ? 'Updates paused — the script keeps running.'
                : buf.stopped ? 'Finished — automatic updates stopped. Use Refresh for late output.'
                  : targetActive ? 'Output arrives in batches, usually about every 30 seconds.'
                    : 'Collecting any final output…'}
            </span>
            {!autoScroll && hasLines && (
              <Btn size="sm" variant="ghost" onClick={() => setAutoScroll(true)} style={{ marginLeft: 'auto' }}>↓ Jump to latest</Btn>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function consoleStyle(dark) {
  return {
    margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.55, borderRadius: 8, padding: 12,
    background: dark ? 'var(--slate-950)' : '#F8FAFC', color: dark ? '#E2E8F0' : '#0F172A',
    border: `1px solid ${dark ? '#1E293B' : '#E2E8F0'}`, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    maxHeight: dark ? 'none' : 240, overflowY: 'auto',
  };
}

