import { buildEntries, categoryForAuth, categoryForLocation, entryForLocation, CATEGORIES } from './automationCatalog';

const doc = (name, auth, extra = {}) => ({ name, display_name: name, auth, available: true, description: `${name} doc`, ...extra });
const DOCS = [
  doc('Automation-var-cleanup', 'app', { display_name: '/var Cleanup' }),
  doc('SAP-Status-Check', 'sap_status_check'),
  doc('Tidal-Restart', 'tidal_action'),
  doc('SQL-Index-Rebuild', 'sql_healthcheck'),
  doc('Broken-Doc', 'app', { available: false, reason: 'Not found in us-east-1.' }),
];
const keys = (entries, category) => entries.filter((e) => !category || e.category === category).map((e) => e.key);

test('exactly three categories', () => {
  expect(CATEGORIES.map((c) => c.id)).toEqual(['operations', 'database', 'applications']);
});

test.each([
  ['app', 'operations'], [undefined, 'operations'], ['sql_healthcheck', 'database'], ['sql_dr_failover', 'database'],
  ['sap_status_check', 'applications'], ['sap_start_stop', 'applications'], ['tidal_action', 'applications'], ['something_else', 'operations'],
])('auth %s → %s', (auth, cat) => expect(categoryForAuth(auth)).toBe(cat));

describe('EC2 Start/Stop is gated by application access, never by role or team', () => {
  test('operator WITHOUT app access does not see EC2', () => {
    const e = buildEntries({ user: { role: 'operator', groups: [] }, documents: DOCS, ec2Allowed: false });
    expect(keys(e)).not.toContain('page:ec2');
  });
  test('team member (SQL/SAP/Tidal) without app access does not see EC2', () => {
    const e = buildEntries({ user: { role: 'none', groups: ['runstack-team-gdba-sql', 'runstack-team-sap', 'runstack-team-tidal'] }, documents: DOCS, ec2Allowed: false });
    expect(keys(e)).not.toContain('page:ec2');
  });
  test('application team member with app access sees EC2 under Applications', () => {
    const e = buildEntries({ user: { role: 'app_operator', groups: [] }, documents: DOCS, hasAppAccess: true });
    expect(keys(e, 'applications')).toContain('page:ec2');
  });
  test('viewer with app access: no EC2 (backend refuses viewers)', () => {
    const e = buildEntries({ user: { role: 'viewer', groups: [] }, documents: DOCS, hasAppAccess: true });
    expect(keys(e)).not.toContain('page:ec2');
    expect(keys(e)).not.toContain('doc:Automation-var-cleanup');
  });
  test('admin sees EC2', () => {
    const e = buildEntries({ user: { role: 'admin', groups: [] }, documents: DOCS, ec2Allowed: false });
    expect(keys(e, 'applications')).toContain('page:ec2');
  });
});

describe('SQL pages keep their existing access rule (operator+, or GDBA groups)', () => {
  test('viewer without GDBA group: no SQL pages', () => {
    const e = buildEntries({ user: { role: 'viewer', groups: [] }, documents: [], ec2Allowed: false });
    expect(keys(e, 'database')).toEqual([]);
  });
  test('GDBA SQL member: both SQL pages', () => {
    const e = buildEntries({ user: { role: 'none', groups: ['runstack-team-gdba-sql'] }, documents: [], ec2Allowed: false });
    expect(keys(e, 'database')).toEqual(['page:sql-health-check', 'page:sql-dr-switchover']);
  });
});

test('documents are placed by their team action', () => {
  const e = buildEntries({ user: { role: 'admin', groups: [] }, documents: DOCS, ec2Allowed: true });
  expect(keys(e, 'operations')).toEqual(['doc:Automation-var-cleanup', 'doc:Broken-Doc']);
  expect(keys(e, 'database')).toEqual(['page:sql-health-check', 'page:sql-dr-switchover', 'doc:SQL-Index-Rebuild']);
  expect(keys(e, 'applications')).toEqual(['page:ec2', 'doc:SAP-Status-Check', 'doc:Tidal-Restart']);
  const broken = e.find((x) => x.key === 'doc:Broken-Doc');
  expect(broken.available).toBe(false);
  expect(broken.description).toBe('Not found in us-east-1.');
  expect(e.find((x) => x.key === 'doc:Automation-var-cleanup').to).toBe('/automations?category=operations&doc=Automation-var-cleanup');
});

describe('location → category / entry', () => {
  const e = buildEntries({ user: { role: 'admin', groups: [] }, documents: DOCS, ec2Allowed: true });
  test('specialised pages', () => {
    expect(categoryForLocation(e, '/ec2', '')).toBe('applications');
    expect(entryForLocation(e, '/database/dr-switchover', '').key).toBe('page:sql-dr-switchover');
  });
  test('page category is known even before the entry list loads', () => {
    expect(categoryForLocation([], '/database/sql-health-check', '')).toBe('database');
  });
  test('document: its own category wins over a mismatched ?category=', () => {
    expect(categoryForLocation(e, '/automations', '?category=operations&doc=Tidal-Restart')).toBe('applications');
  });
  test('category only / nothing / bad category', () => {
    expect(categoryForLocation(e, '/automations', '?category=database')).toBe('database');
    expect(entryForLocation(e, '/automations', '?category=database')).toBeNull();
    expect(categoryForLocation(e, '/automations', '')).toBeNull();
    expect(categoryForLocation(e, '/automations', '?category=finance')).toBeNull();
  });
});

describe('only automations the user is authorized to run are listed', () => {
  test('operator without app access: team documents yes, app documents no', () => {
    const e = buildEntries({ user: { role: 'operator', groups: [] }, documents: DOCS, hasAppAccess: false });
    expect(keys(e, 'operations')).toEqual([]);
    expect(keys(e, 'applications')).toEqual(['doc:SAP-Status-Check', 'doc:Tidal-Restart']);
  });
  test('SAP team member (no role): only SAP documents', () => {
    const e = buildEntries({ user: { role: 'none', groups: ['runstack-team-sap'] }, documents: DOCS, hasAppAccess: false });
    expect(keys(e)).toEqual(['doc:SAP-Status-Check']);
  });
  test('GDBA SQL member: SQL pages and SQL documents only', () => {
    const e = buildEntries({ user: { role: 'none', groups: ['runstack-team-gdba-sql'] }, documents: DOCS, hasAppAccess: false });
    expect(keys(e)).toEqual(['page:sql-health-check', 'page:sql-dr-switchover', 'doc:SQL-Index-Rebuild']);
  });
  test('app team with app access: Operations app documents and EC2, no team documents', () => {
    const e = buildEntries({ user: { role: 'app_operator', groups: [] }, documents: DOCS, hasAppAccess: true });
    expect(keys(e)).toEqual(['page:ec2', 'doc:Automation-var-cleanup', 'doc:Broken-Doc']);
  });
});
