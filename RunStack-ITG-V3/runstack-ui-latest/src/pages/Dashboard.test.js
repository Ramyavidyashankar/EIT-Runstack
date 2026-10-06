import { executionsLink } from './Dashboard';
import { presetStart } from '../utils/jobs';

describe('dashboard drill-down links use the dashboard period', () => {
  test('24h with status', () => {
    expect(executionsLink('24h', '2026-10-05T05:00:00Z', { status: 'FAILED' })).toBe('/jobs?range=24h&status=FAILED');
  });
  test('7d is the Executions default, so no range param', () => {
    expect(executionsLink('7d', '2026-09-29T06:00:00Z', {})).toBe('/jobs');
    expect(executionsLink('7d', '2026-09-29T06:00:00Z', { status: 'COMPLETED' })).toBe('/jobs?status=COMPLETED');
  });
  test('30d passes the counters\' exact start as a custom range', () => {
    const url = new URL(`http://x${executionsLink('30d', '2026-09-07T00:00:00Z', { status: 'FAILED' })}`);
    expect(url.searchParams.get('range')).toBe('custom');
    expect(url.searchParams.get('status')).toBe('FAILED');
    // Local wall-clock of the same instant (Executions parses it as local time).
    expect(new Date(url.searchParams.get('from')).toISOString()).toBe('2026-09-07T00:00:00.000Z');
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
