import { rangeText, rangeWindow } from './dateRange';

const now = Date.UTC(2026, 9, 8, 3, 17); // 08 Oct 2026 03:17 UTC

describe('rangeWindow matches the backend job-counter windows', () => {
  test('24h / 7d are hour-aligned', () => {
    expect(rangeWindow({ range: '24h' }, now)).toEqual({ from: '2026-10-07T04:00:00.000Z' });
    expect(rangeWindow({ range: '7d' }, now)).toEqual({ from: '2026-10-01T04:00:00.000Z' });
  });
  test('30d / 90d start at UTC midnight (today included)', () => {
    expect(rangeWindow({ range: '30d' }, now)).toEqual({ from: '2026-09-09T00:00:00.000Z' });
    expect(rangeWindow({ range: '90d' }, now)).toEqual({ from: '2026-07-11T00:00:00.000Z' });
  });
  test('all time has no limit', () => {
    expect(rangeWindow({ range: 'all' }, now)).toEqual({});
  });
  test('custom UTC days, both included (to is exclusive)', () => {
    expect(rangeWindow({ range: 'custom', from_day: '2026-09-01', to_day: '2026-09-30' }, now))
      .toEqual({ from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' });
  });
  test('older custom links with local date-times still work', () => {
    const w = rangeWindow({ range: 'custom', to: '2026-10-08T07:30' }, now);
    expect(w.from).toBeUndefined();
    expect(new Date(w.to).getTime()).toBe(new Date('2026-10-08T07:30').getTime());
  });
});

test('rangeText', () => {
  expect(rangeText({ range: '90d' })).toBe('Last 90 days');
  expect(rangeText({ range: 'custom', from_day: '2026-09-01', to_day: '2026-09-30' })).toBe('01 Sep – 30 Sep 2026 (UTC)');
});
