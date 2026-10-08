// Run: CI=true npx react-scripts test --watchAll=false src/utils/jobs.test.js
import { jobsToCsv, pageRangeLabel, presetStart, rangeToQuery, runBreakdown, statusGroup } from './jobs';

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

test('run rows: per-server breakdown and CSV columns', () => {
  expect(runBreakdown({ PENDING: 0, RUNNING: 1, COMPLETED: 2, FAILED: 1 })).toBe('1 running · 2 completed · 1 failed');
  expect(runBreakdown({})).toBe('—');
  const csv = jobsToCsv([
    { job_id: 'a1', is_run: true, execution_group_id: 'grp-hcui-1', server_count: 2, run_counts: { COMPLETED: 2 }, status: 'COMPLETED' },
    { job_id: 'c1', status: 'FAILED' },
  ]).split('\n');
  expect(csv[0].startsWith('job_id,row_type,execution_group_id,servers,server_breakdown,')).toBe(true);
  expect(csv[1]).toContain('"run","grp-hcui-1","2","2 completed"');
  expect(csv[2]).toContain('"job","","1",""');
});

describe('job title and subtitle', () => {
  const { jobTitle, jobSubtitle } = require('./jobs');
  test('automation name first, document label underneath', () => {
    const j = { automation_name: 'SQL DB  Instance Version CMDB Update', automation_label: 'Run Remote Script', automation_type: 'SSM-RunCommand' };
    expect(jobTitle(j)).toBe('SQL DB Instance Version CMDB Update');
    expect(jobSubtitle(j)).toBe('Run Remote Script');
  });
  test('no name: document label, then automation type', () => {
    const j = { automation_label: 'Run Remote Script', automation_type: 'SSM-RunCommand' };
    expect(jobTitle(j)).toBe('Run Remote Script');
    expect(jobSubtitle(j)).toBe('SSM-RunCommand');
  });
});
