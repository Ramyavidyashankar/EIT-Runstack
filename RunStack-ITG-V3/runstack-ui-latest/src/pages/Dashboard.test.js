import { bucketLabels, customLabel, customRangeError, executionsLink, sortAutomations } from './Dashboard';
import { presetStart } from '../utils/jobs';

const params = (url) => new URL(`http://x${url}`).searchParams;

describe('dashboard drill-down links use the dashboard window', () => {
  test('24h with status', () => {
    expect(executionsLink('24h', {}, { status: 'FAILED' })).toBe('/jobs?range=24h&status=FAILED');
  });
  test('7d is the Executions default, so no range param', () => {
    expect(executionsLink('7d', {}, {})).toBe('/jobs');
    expect(executionsLink('7d', {}, { status: 'COMPLETED' })).toBe('/jobs?status=COMPLETED');
  });
  test.each(['30d', '90d', 'all'])('%s uses the same named range', (period) => {
    expect(executionsLink(period, { from: '2026-09-07T00:00:00Z' }, { status: 'FAILED' })).toBe(`/jobs?range=${period}&status=FAILED`);
  });
  test('custom passes the UTC days', () => {
    expect(executionsLink('custom', { from_day: '2026-09-01', to_day: '2026-09-30' }, { automation: 'Run Remote Script' }))
      .toBe('/jobs?range=custom&from_day=2026-09-01&to_day=2026-09-30&automation=Run+Remote+Script');
  });
});

test('24h / 7d windows are identical on both pages (hour-aligned)', () => {
  // jobs_list.summary: start = (current hour + 1h) - N hours
  const now = Date.UTC(2026, 9, 6, 4, 37);
  const hourStart = Date.UTC(2026, 9, 6, 4, 0);
  [24, 168].forEach((hours) => {
    const backendFrom = hourStart + 3600_000 - hours * 3600_000;
    expect(presetStart(hours, now).getTime()).toBe(backendFrom);
  });
});

describe('custom range', () => {
  test('label', () => {
    expect(customLabel('2026-09-01', '2026-09-30')).toBe('01 Sep – 30 Sep 2026');
    expect(customLabel('2025-12-15', '2026-01-10')).toBe('15 Dec 2025 – 10 Jan 2026');
    expect(customLabel('2026-09-01', '2026-09-01')).toBe('01 Sep 2026');
    expect(customLabel('', '2026-09-01')).toBe('');
  });
  test('validation', () => {
    expect(customRangeError('2026-09-01', '2026-09-30', '2026-10-07')).toBeNull();
    expect(customRangeError('2026-09-30', '2026-09-01', '2026-10-07')).toMatch(/on or after/);
    expect(customRangeError('2026-10-09', '2026-10-10', '2026-10-07')).toMatch(/future/);
    expect(customRangeError('', '2026-10-01', '2026-10-07')).toMatch(/both dates/);
  });
});

test('trend bucket labels', () => {
  expect(bucketLabels({ start: '2026-09-07T00:00:00Z', end: '2026-09-08T00:00:00Z' }, 'day').label).toBe('07 Sep');
  const w = bucketLabels({ start: '2026-09-07T00:00:00Z', end: '2026-09-14T00:00:00Z' }, 'week');
  expect(w).toEqual({ label: '07 Sep', full: '07 Sep – 13 Sep 2026' });
  expect(bucketLabels({ start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' }, 'month').label).toBe('Sep 2026');
});

describe('automation summary sorting', () => {
  const rows = [
    { automation: 'B', total: 10, FAILED: 1, success_rate: 90, avg_duration_seconds: 30, last_at: '2026-10-07T10:00:00Z' },
    { automation: 'A', total: 25, FAILED: 0, success_rate: 100, avg_duration_seconds: null, last_at: '2026-10-07T12:00:00Z' },
    { automation: 'C', total: 10, FAILED: 4, success_rate: null, avg_duration_seconds: 300, last_at: '2026-10-06T09:00:00Z' },
  ];
  const names = (r) => r.map((x) => x.automation);
  test('default: total desc, ties by name', () => {
    expect(names(sortAutomations(rows))).toEqual(['A', 'B', 'C']);
  });
  test('failed, last execution, duration (missing values last)', () => {
    expect(names(sortAutomations(rows, 'FAILED', 'desc'))).toEqual(['C', 'B', 'A']);
    expect(names(sortAutomations(rows, 'last_at', 'desc'))).toEqual(['A', 'B', 'C']);
    expect(names(sortAutomations(rows, 'avg_duration_seconds', 'asc'))).toEqual(['B', 'C', 'A']);
    expect(names(sortAutomations(rows, 'success_rate', 'asc'))).toEqual(['B', 'A', 'C']);
  });
});

test('named automation rows link with the Automation name filter', () => {
  expect(executionsLink('all', { from: '2026-01-01T00:00:00Z' }, { name: 'SQL DB Instance Version CMDB Update', status: 'FAILED' }))
    .toBe('/jobs?range=all&name=SQL+DB+Instance+Version+CMDB+Update&status=FAILED');
});
