// Run: CI=true npx react-scripts test --watchAll=false src/utils/executionStatus.test.js
import {
  OVERALL_STATUS, TARGET_STATUS, fmtPct, outputActionLabel, statusFilters, summaryBuckets, triggerSource,
} from './executionStatus';
import { TARGET_STATUS as REEXPORTED } from './executionLogs';
import { fetchAllTargets, targetsToCsv } from './exportTargets';

test('summary cards count timed out under Failed and keep Succeeded terminology', () => {
  const cards = summaryBuckets({ total: 500, success: 310, running: 40, pending: 145, failed: 3, timed_out: 2, cancelled: 0 });
  expect(cards.map((c) => [c.key, c.label, c.value])).toEqual([
    ['success', 'Succeeded', 310], ['running', 'Running', 40], ['pending', 'Pending', 145], ['failed', 'Failed', 5],
  ]);
  expect(cards[3].note).toBe('incl. 2 timed out');
  expect(cards[0].pct).toBe('62%');
  expect(cards.reduce((n, c) => n + c.value, 0)).toBe(500);
});

test('cancelled card only appears when something was cancelled', () => {
  expect(summaryBuckets({ total: 3, success: 2, cancelled: 1 }).map((c) => c.key)).toContain('cancelled');
  expect(summaryBuckets({ total: 3, success: 3 }).map((c) => c.key)).not.toContain('cancelled');
  expect(summaryBuckets({ total: 3, failed: 1 })[3].note).toBeNull();
});

test('percentages never show 0% for a non-zero count', () => {
  expect(fmtPct(1, 500)).toBe('<1%');
  expect(fmtPct(0, 500)).toBe('0%');
  expect(fmtPct(5, 0)).toBe('—');
});

test('filter chips map to exact backend statuses; timed out/cancelled only when present', () => {
  const chips = statusFilters({ total: 10, running: 1, pending: 2, success: 6, failed: 1 });
  expect(chips.map((c) => c.value)).toEqual(['', 'running', 'pending', 'success', 'failed']);
  expect(statusFilters({ total: 2, timed_out: 1 }).map((c) => c.value)).toContain('timed_out');
  expect(statusFilters({ total: 2 }, 'cancelled').map((c) => c.value)).toContain('cancelled');
});

test('trigger source is derived from initiated_by', () => {
  expect(triggerSource('schedule:weekly-oracle-cleanup')).toEqual({ kind: 'scheduled', label: 'Scheduled run', by: 'Schedule weekly-oracle-cleanup' });
  expect(triggerSource('schedule').by).toBe('Schedule');
  expect(triggerSource('client:abc123')).toEqual({ kind: 'client', label: 'API client', by: 'abc123' });
  expect(triggerSource('ramyav@dxc.com')).toEqual({ kind: 'user', label: 'User', by: 'ramyav@dxc.com' });
  expect(triggerSource(null).kind).toBe('unknown');
});

test('running is blue, timed out keeps its own status, old import path still works', () => {
  expect(TARGET_STATUS.running.dot).toBe('#2563EB');
  expect(TARGET_STATUS.running.color).not.toBe(TARGET_STATUS.pending.color);
  expect(TARGET_STATUS.timed_out.label).toBe('Timed out');
  expect(OVERALL_STATUS.success.label).toBe('Succeeded');
  expect(REEXPORTED).toBe(TARGET_STATUS);
});

test('output action label per status', () => {
  expect(outputActionLabel('running')).toBe('Live status');
  expect(outputActionLabel('success')).toBe('View output');
  expect(outputActionLabel('timed_out')).toBe('View error');
  expect(outputActionLabel('pending')).toBeNull();
});

test('export follows cursors until the last page', async () => {
  const pages = [
    { targets: [{ job_id: 'a' }, { job_id: 'b' }], next_cursor: 'c1', total_matching: 3 },
    { targets: [{ job_id: 'c' }], next_cursor: null, total_matching: 3 },
  ];
  const calls = [];
  const res = await fetchAllTargets(async (p) => { calls.push(p); return pages[calls.length - 1]; }, { status: 'failed' });
  expect(res.complete).toBe(true);
  expect(res.rows.map((r) => r.job_id)).toEqual(['a', 'b', 'c']);
  expect(calls[0]).toMatchObject({ limit: 200, status: 'failed' });
  expect(calls[1].cursor).toBe('c1');
});

test('CSV escapes quotes/commas and neutralises spreadsheet formulas', () => {
  const csv = targetsToCsv([{ server_name: '=cmd|x', status: 'timed_out', status_detail: 'a, "b"', account_id: '123456789012' }]);
  const row = csv.split('\r\n')[1];
  expect(row.startsWith("'=cmd|x,")).toBe(true);
  expect(row).toContain('Timed out');
  expect(row).toContain('"a, ""b"""');
});
