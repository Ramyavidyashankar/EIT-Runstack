// Run: CI=true npx react-scripts test --watchAll=false src/utils/schedule.test.js
import {
  toCronUtc, fromCronUtc, nextRuns, describeSpec, describeUtc, describeExpression, summarizeEventPattern,
  tzOffsetMinutes, observesDst, zonedToUtc,
} from './schedule';

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';
const NOW = new Date(Date.UTC(2026, 8, 25, 6, 0)); // Fri 25 Sep 2026 06:00 UTC (11:30 IST)
const WINTER = new Date(Date.UTC(2026, 0, 15, 12, 0));

describe('offsets', () => {
  test('IST is +5:30 and has no DST', () => {
    expect(tzOffsetMinutes(IST, NOW)).toBe(330);
    expect(observesDst(IST)).toBe(false);
    expect(observesDst(NY)).toBe(true);
  });
  test('zonedToUtc', () => {
    expect(zonedToUtc(2026, 9, 26, 6, 30, IST).toISOString()).toBe('2026-09-26T01:00:00.000Z');
  });
});

describe('local → UTC cron', () => {
  test('daily 6:30 AM IST → 1:00 UTC', () => {
    const r = toCronUtc({ frequency: 'daily', time: '06:30' }, IST, NOW);
    expect(r.expression).toBe('cron(0 1 * * ? *)');
    expect(describeUtc(r.expression)).toBe('1:00 AM UTC');
  });
  test('daily 1:00 AM IST crosses to previous UTC day but daily cron is unaffected', () => {
    expect(toCronUtc({ frequency: 'daily', time: '01:00' }, IST, NOW).expression).toBe('cron(30 19 * * ? *)');
  });
  test('weekly Mon+Thu 1:00 AM IST → Sun+Wed 19:30 UTC (day moves back)', () => {
    const r = toCronUtc({ frequency: 'weekly', time: '01:00', days: [1, 4] }, IST, NOW);
    expect(r.expression).toBe('cron(30 19 ? * SUN,WED *)');
    expect(r.shift).toBe(-1);
  });
  test('weekly Sun 1:00 AM IST wraps to Sat UTC', () => {
    expect(toCronUtc({ frequency: 'weekly', time: '01:00', days: [0] }, IST, NOW).expression).toBe('cron(30 19 ? * SAT *)');
  });
  test('weekly Fri 9 PM New York (EDT) moves forward to Sat 01:00 UTC', () => {
    expect(toCronUtc({ frequency: 'weekly', time: '21:00', days: [5] }, NY, NOW).expression).toBe('cron(0 1 ? * SAT *)');
  });
  test('monthly day 1 at 2:00 AM IST → last day of previous month UTC', () => {
    expect(toCronUtc({ frequency: 'monthly', time: '02:00', monthDay: 1 }, IST, NOW).expression).toBe('cron(30 20 L * ? *)');
  });
  test('monthly day 15 at 2:00 AM IST → day 14 UTC', () => {
    expect(toCronUtc({ frequency: 'monthly', time: '02:00', monthDay: 15 }, IST, NOW).expression).toBe('cron(30 20 14 * ? *)');
  });
  test('monthly last day 11 PM New York → day 1 UTC', () => {
    expect(toCronUtc({ frequency: 'monthly', time: '23:00', monthDay: 'L' }, NY, NOW).expression).toBe('cron(0 3 1 * ? *)');
  });
  test('monthly day 30 at 11 PM New York cannot be expressed exactly', () => {
    const r = toCronUtc({ frequency: 'monthly', time: '23:00', monthDay: 30 }, NY, NOW);
    expect(r.expression).toBeNull();
    expect(r.error).toMatch(/doesn't exist in every month/);
  });
  test('monthly last day at 1 AM IST cannot be expressed exactly', () => {
    expect(toCronUtc({ frequency: 'monthly', time: '01:00', monthDay: 'L' }, IST, NOW).expression).toBeNull();
  });
  test('hourly at :00 IST → :30 UTC (half-hour zone)', () => {
    expect(toCronUtc({ frequency: 'hourly', time: '00:00' }, IST, NOW).expression).toBe('cron(30 * * * ? *)');
  });
  test('DST zone uses the offset at the reference date', () => {
    expect(toCronUtc({ frequency: 'daily', time: '09:00' }, NY, NOW).expression).toBe('cron(0 13 * * ? *)');    // EDT
    expect(toCronUtc({ frequency: 'daily', time: '09:00' }, NY, WINTER).expression).toBe('cron(0 14 * * ? *)'); // EST
  });
});

describe('UTC cron → local (edit)', () => {
  test('cron(0 1 * * ? *) → daily 6:30 AM IST', () => {
    const s = fromCronUtc('cron(0 1 * * ? *)', IST, NOW);
    expect(s).toEqual({ frequency: 'daily', time: '06:30' });
    expect(describeSpec(s, IST, NOW)).toBe('Daily at 6:30 AM IST');
  });
  test('weekly Sun,Wed 19:30 UTC → Mon,Thu 1:00 AM IST', () => {
    expect(fromCronUtc('cron(30 19 ? * SUN,WED *)', IST, NOW)).toEqual({ frequency: 'weekly', time: '01:00', days: [1, 4] });
  });
  test('numeric day-of-week (1=SUN) is understood', () => {
    expect(fromCronUtc('cron(30 19 ? * 1,4 *)', IST, NOW)).toEqual({ frequency: 'weekly', time: '01:00', days: [1, 4] });
  });
  test('monthly L at 20:30 UTC → 1st at 2:00 AM IST', () => {
    expect(fromCronUtc('cron(30 20 L * ? *)', IST, NOW)).toEqual({ frequency: 'monthly', time: '02:00', monthDay: 1 });
  });
  test('round trip for many specs (edit without changes keeps the same cron)', () => {
    const specs = [
      { frequency: 'daily', time: '00:00' }, { frequency: 'daily', time: '23:59' }, { frequency: 'daily', time: '05:29' },
      { frequency: 'weekly', time: '05:15', days: [0, 6] }, { frequency: 'weekly', time: '18:45', days: [1, 2, 3, 4, 5] },
      { frequency: 'monthly', time: '03:00', monthDay: 1 }, { frequency: 'monthly', time: '12:00', monthDay: 'L' },
      { frequency: 'monthly', time: '10:00', monthDay: 28 }, { frequency: 'hourly', time: '00:15' },
    ];
    for (const tz of [IST, 'UTC', 'Asia/Tokyo', NY, 'Europe/London']) {
      for (const s of specs) {
        const r = toCronUtc(s, tz, NOW);
        if (!r.expression) continue;
        expect({ tz, s: fromCronUtc(r.expression, tz, NOW) }).toEqual({ tz, s });
      }
    }
  });
  test.each([
    'cron(0/15 * * * ? *)', 'cron(0 9-17 ? * MON-FRI *)', 'cron(0 10 ? * 6#3 *)', 'cron(0 1 1 JAN ? *)',
    'cron(0 1 * * ? 2027)', 'cron(0 1,13 * * ? *)',
  ])('%s is kept in advanced mode', (expr) => {
    expect(fromCronUtc(expr, IST, NOW)).toBeNull();
  });
  test('a UTC day 31 that would become local day 32 stays advanced', () => {
    expect(fromCronUtc('cron(0 20 31 * ? *)', IST, NOW)).toBeNull();
  });
});

describe('next runs (UTC)', () => {
  test('daily', () => {
    const r = nextRuns('cron(0 1 * * ? *)', 3, NOW).map((d) => d.toISOString());
    expect(r).toEqual(['2026-09-26T01:00:00.000Z', '2026-09-27T01:00:00.000Z', '2026-09-28T01:00:00.000Z']);
  });
  test('weekly Sun,Wed 19:30 UTC lands on Mon/Thu 1:00 IST', () => {
    const r = nextRuns('cron(30 19 ? * SUN,WED *)', 2, NOW);
    expect(r.map((d) => d.toISOString())).toEqual(['2026-09-27T19:30:00.000Z', '2026-09-30T19:30:00.000Z']);
    const localDays = r.map((d) => new Date(d.getTime() + 330 * 60000).getUTCDay());
    expect(localDays).toEqual([1, 4]); // Mon, Thu in IST
  });
  test('last day of month', () => {
    expect(nextRuns('cron(30 20 L * ? *)', 2, NOW).map((d) => d.toISOString()))
      .toEqual(['2026-09-30T20:30:00.000Z', '2026-10-31T20:30:00.000Z']);
  });
  test('ranges, steps, nth weekday', () => {
    expect(nextRuns('cron(0/30 9-10 ? * MON-FRI *)', 4, NOW).length).toBe(4);
    expect(nextRuns('cron(0 10 ? * 6#3 *)', 1, NOW)[0].toISOString()).toBe('2026-10-16T10:00:00.000Z');
  });
  test('rate() has no predictable next run', () => {
    expect(nextRuns('rate(5 minutes)', 3, NOW)).toBeNull();
  });
});

describe('descriptions', () => {
  test('rows', () => {
    expect(describeExpression('cron(0 1 * * ? *)', IST, NOW).text).toBe('Daily at 6:30 AM IST');
    expect(describeExpression('cron(30 3 ? * MON-FRI *)', IST, NOW).text).toBe('Weekdays at 9:00 AM IST');
    expect(describeExpression('cron(0 9-17 ? * MON-FRI *)', IST, NOW).text).toBe('Custom schedule');
    expect(describeExpression('cron(30 3 ? * MON,TUE,WED,THU,FRI *)', IST, NOW).text).toBe('Weekdays at 9:00 AM IST');
    expect(describeExpression('rate(15 minutes)', IST, NOW).text).toBe('Every 15 minutes');
  });
  test('event patterns', () => {
    const s = summarizeEventPattern(JSON.stringify({
      source: ['aws.securityhub'], 'detail-type': ['Security Hub Findings - Imported'],
      detail: { findings: { Severity: { Label: ['CRITICAL', 'HIGH'] } } },
    }));
    expect(s.summary).toBe('When a Security Hub finding is imported (1 condition)');
    expect(s.conditions[0]).toEqual({ path: 'findings.Severity.Label', text: 'CRITICAL or HIGH' });
    expect(summarizeEventPattern('{"source":["custom.app"],"detail-type":["Deploy Done"]}').summary)
      .toBe('When custom.app sends “Deploy Done”');
    expect(summarizeEventPattern('{bad').valid).toBe(false);
  });
});
