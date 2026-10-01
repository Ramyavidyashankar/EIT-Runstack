// Run: CI=true npx react-scripts test --watchAll=false src/utils/executionLogs.test.js
import {
  appendBounded, backoffMs, classifyFetchError, eventsToLines, filterLines, linesToText, logFileName, prependBounded,
  progressOf, targetElapsed,
} from './executionLogs';

test('progress counts failures, cancellations and timeouts as finished, not successful', () => {
  const p = progressOf({ total: 10, pending: 1, running: 2, success: 4, failed: 1, cancelled: 1, timed_out: 1 });
  expect(p.finished).toBe(7);
  expect(p.successful).toBe(4);
  expect(p.unsuccessful).toBe(3);
  expect(p.finishedPct).toBe(70);
  expect(p.successPct).toBe(40);
  expect(p.label).toBe('7 of 10 finished · 4 succeeded, 3 did not succeed');
  expect(progressOf({}).label).toBe('No targets');
});

test('multi-line events become separate console lines with their stream', () => {
  const lines = eventsToLines([
    { ts: 1, stream: 'stdout', message: 'a\nb\n' },
    { ts: 2, stream: 'stderr', message: 'oops', truncated: true },
  ]);
  expect(lines.map((l) => [l.text, l.stream])).toEqual([['a', 'stdout'], ['b', 'stdout'], ['oops', 'stderr']]);
  expect(lines[2].truncated).toBe(true);
  expect(new Set(lines.map((l) => l.id)).size).toBe(3);
  expect(filterLines(lines, 'stderr').map((l) => l.text)).toEqual(['oops']);
  expect(filterLines(lines, 'all')).toHaveLength(3);
});

test('console buffer stays bounded: new output evicts the oldest, older output never evicts', () => {
  const mk = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i, text: String(from + i) }));
  const { lines, dropped } = appendBounded(mk(8), mk(5, 8), 10);
  expect(lines.map((l) => l.id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  expect(dropped).toBe(3);
  const full = prependBounded(lines, mk(3, -3), 10);
  expect(full.kept).toBe(0);
  expect(full.lines).toBe(lines);
  const some = prependBounded(mk(8), mk(5, -5), 10);
  expect(some.kept).toBe(2);
  expect(some.lines.map((l) => l.id)).toEqual([-2, -1, 0, 1, 2, 3, 4, 5, 6, 7]);
});

test('copy / download text', () => {
  const lines = [{ ts: Date.parse('2026-09-30T10:11:12Z'), stream: 'stderr', text: 'bad' }, { ts: null, stream: 'stdout', text: 'ok' }];
  expect(linesToText(lines)).toBe('10:11:12Z ERR bad\n--:--:--Z OUT ok');
  expect(linesToText(lines, { withMeta: false })).toBe('bad\nok');
  expect(logFileName({ server_name: 'APP SRV/01', job_id: 'abcdef123456' }, new Date('2026-09-30T10:11:12Z')))
    .toBe('runstack-APP-SRV-01-abcdef12-2026-09-30-10-11-12.log');
});

test('fetch errors: retrieval problems are classified, aborts are ignored, throttling backs off harder', () => {
  expect(classifyFetchError({ name: 'AbortError' }).kind).toBe('aborted');
  expect(classifyFetchError({ status: 404 }).kind).toBe('not_found');
  expect(classifyFetchError({ status: 429 }).kind).toBe('throttled');
  expect(classifyFetchError({ status: 500, message: 'API error 500' }).kind).toBe('error');
  expect(backoffMs(5000, 0)).toBe(5000);
  expect(backoffMs(5000, 1)).toBe(10000);
  expect(backoffMs(5000, 1, { throttled: true })).toBe(30000);
  expect(backoffMs(5000, 10)).toBe(60000);
});

test('elapsed time is live for active targets and fixed for finished ones', () => {
  const now = Date.parse('2026-09-30T10:00:30Z');
  expect(targetElapsed({ status: 'running', started_at: '2026-09-30T10:00:00Z', elapsed_seconds: 5 }, now)).toBe(30);
  expect(targetElapsed({ status: 'success', started_at: '2026-09-30T10:00:00Z', elapsed_seconds: 12 }, now)).toBe(12);
});
