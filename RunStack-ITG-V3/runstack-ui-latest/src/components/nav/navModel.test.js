import { activeNavId, visibleNav } from './navModel';

const ids = (items) => items.map((i) => i.id);

describe('header navigation visibility (same rules as the old sidebar)', () => {
  test('admin sees every page', () => {
    const { primary, admin } = visibleNav({ role: 'admin', groups: [] });
    expect(ids(primary)).toEqual(['dashboard', 'run', 'executions', 'schedules', 'docs']);
    expect(ids(admin)).toEqual(['accounts', 'users', 'uploads', 'dlq', 'trigger', 'settings']);
  });

  test('operator: schedules and DLQ, but no admin-only tools', () => {
    const { primary, admin } = visibleNav({ role: 'operator', groups: [] });
    expect(ids(primary)).toContain('schedules');
    expect(ids(admin)).toEqual(['accounts', 'dlq', 'settings']);
  });

  test('viewer: no schedules, no DLQ, no Advanced Run', () => {
    const { primary, admin } = visibleNav({ role: 'viewer', groups: [] });
    expect(ids(primary)).toEqual(['dashboard', 'run', 'executions', 'docs']);
    expect(ids(admin)).toEqual(['accounts', 'settings']);
  });

  test('team membership alone never unlocks role-gated items', () => {
    const { primary, admin } = visibleNav({ role: 'none', groups: ['runstack-team-gdba-sql', 'runstack-team-sap'] });
    expect(ids(primary)).not.toContain('schedules');
    expect(ids(admin)).not.toEqual(expect.arrayContaining(['users', 'uploads', 'dlq', 'trigger']));
  });
});

describe('active header item', () => {
  test.each([
    ['/', 'dashboard'],
    ['/automations', 'run'],
    ['/ec2', 'run'],
    ['/database/sql-health-check', 'run'],
    ['/database/dr-switchover', 'run'],
    ['/jobs', 'executions'],
    ['/jobs/abc-123', 'executions'],
    ['/schedules', 'schedules'],
    ['/docs', 'docs'],
    ['/users', 'admin'],
    ['/dlq', 'admin'],
    ['/trigger', 'admin'],
    ['/settings', 'admin'],
    ['/accounts', 'admin'],
    ['/uploads', 'admin'],
    ['/nope', null],
  ])('%s → %s', (path, id) => {
    expect(activeNavId(path)).toBe(id);
  });
});
