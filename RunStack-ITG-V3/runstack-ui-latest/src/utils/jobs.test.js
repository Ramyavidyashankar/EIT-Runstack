// Run: CI=true npx react-scripts test --watchAll=false src/utils/jobs.test.js
import { pageRangeLabel, presetStart, rangeToQuery, statusGroup } from './jobs';

test('page range label uses the backend total, not loaded rows', () => {
  expect(pageRangeLabel({ pageIndex: 0, pageSize: 50, returned: 50, total: 15246 })).toBe('Showing 1–50 of 15,246 executions');
  expect(pageRangeLabel({ pageIndex: 2, pageSize: 50, returned: 17, total: 117 })).toBe('Showing 101–117 of 117 executions');
  expect(pageRangeLabel({ pageIndex: 0, pageSize: 50, returned: 50, total: 900, complete: false })).toBe('Showing 1–50 of at least 900 executions');
  expect(pageRangeLabel({ pageIndex: 0, pageSize: 50, returned: 1, total: 1 })).toBe('Showing 1–1 of 1 execution');
  expect(pageRangeLabel({ pageIndex: 0, pageSize: 50, returned: 0, total: 0 })).toBe('No executions on this page (of 0 matching)');
});

test('presets start on a UTC hour so the backend can use its hourly counters', () => {
  const now = Date.parse('2026-09-28T14:37:12Z');
  expect(presetStart(24, now).toISOString()).toBe('2026-09-27T15:00:00.000Z');
  expect(rangeToQuery('7d', '', '', now)).toEqual({ from: '2026-09-21T15:00:00.000Z' });
  expect(rangeToQuery('all', '', '', now)).toEqual({});
});

test('status groups', () => {
  expect(statusGroup('TIMED_OUT')).toBe('FAILED');
  expect(statusGroup('SUCCEEDED')).toBe('COMPLETED');
  expect(statusGroup(undefined)).toBe('PENDING');
});
