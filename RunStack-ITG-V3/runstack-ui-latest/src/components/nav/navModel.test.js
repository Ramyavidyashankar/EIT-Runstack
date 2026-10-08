import { activeNavId, visibleNav } from './navModel';

const ids = (items) => items.map((i) => i.id);

describe('header navigation visibility (same rules as the old sidebar)', () => {
  test('admin sees every page', () => {
    const { primary, admin } = visibleNav({ role: 'admin', groups: [] }, { hasAppAccess: true });
    expect(ids(primary)).toEqual(['dashboard', 'run', 'executions', 'schedules', 'docs']);
    expect(ids(admin)).toEqual(['accounts', 'users', 'uploads', 'dlq', 'trigger', 'settings']);
  });

  test('operator: schedules and DLQ, but no admin-only tools', () => {
    const { primary, admin } = visibleNav({ role: 'operator', groups: [] }, { hasAppAccess: true });
    expect(ids(primary)).toContain('schedules');
    expect(ids(admin)).toEqual(['accounts', 'dlq', 'settings']);
  });

  test('viewer: no schedules, no DLQ, no Advanced Run', () => {
    const { primary, admin } = visibleNav({ role: 'viewer', groups: [] }, { hasAppAccess: true });
    expect(ids(primary)).toEqual(['dashboard', 'run', 'executions', 'schedules', 'docs']);
    expect(primary.find((i) => i.id === 'schedules').locked).toBe(true);
    expect(ids(admin)).toEqual(['accounts', 'settings']);
  });

  test('team membership alone never unlocks role-gated items', () => {
    const { primary, admin } = visibleNav({ role: 'none', groups: ['runstack-team-gdba-sql', 'runstack-team-sap'] });
    expect(primary.find((i) => i.id === 'schedules').locked).toBe(true);
    expect(admin).toEqual([]);
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

describe('Registered Targets needs application access', () => {
  const has = (user, hasAppAccess) => visibleNav(user, { hasAppAccess }).admin.some((x) => x.id === 'accounts');
  test('team-only user (no role): not listed', () => {
    expect(has({ role: 'none', groups: ['runstack-team-gdba-sql'] }, false)).toBe(false);
  });
  test('listed while application access is still loading', () => {
    expect(has({ role: 'operator', groups: [] }, null)).toBe(true);
  });
  test('operator without applications: not listed; with applications: listed', () => {
    expect(has({ role: 'operator', groups: [] }, false)).toBe(false);
    expect(has({ role: 'operator', groups: [] }, true)).toBe(true);
  });
  test('admin: listed', () => {
    expect(has({ role: 'admin', groups: [] }, true)).toBe(true);
  });
});

test('team-only user: no Administration items (menu shows one no-access message)', () => {
  const { admin, primary } = visibleNav({ role: 'none', groups: ['runstack-team-gdba-sql', 'runstack-team-sap'] }, { hasAppAccess: false });
  expect(admin).toEqual([]);
  expect(ids(primary)).toEqual(['dashboard', 'run', 'executions', 'schedules', 'docs']);
});

test('Triggers & Schedules: unlocked for operator and admin', () => {
  ['operator', 'admin'].forEach((role) => {
    const s = visibleNav({ role, groups: [] }, { hasAppAccess: true }).primary.find((i) => i.id === 'schedules');
    expect(s.locked).toBeUndefined();
  });
});
