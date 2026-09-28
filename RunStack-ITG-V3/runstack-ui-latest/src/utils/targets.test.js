// Run: CI=true npx react-scripts test --watchAll=false src/utils/targets.test.js
import { normalizeRecords, groupTargets, groupByApplication, totals, filterOptions, applyFilters, isAccountId } from './targets';

const A = '975050354211';
const B = '246314649749';
const rows = [
  // Rundeck: 2 instances in A/us-east-1, one row repeated exactly
  { account_id: A, region: 'us-east-1', app_id: '500579', app_name: 'EIT Rundeck', instance_id: 'i-1', server_name: 'EC2_LNX_01', environment: 'ITG' },
  { account_id: A, region: 'us-east-1', app_id: '500579', app_name: 'EIT Rundeck', instance_id: 'i-1', server_name: 'EC2_LNX_01', environment: 'ITG' },
  { account_id: A, region: 'us-east-1', app_id: '500579', app_name: 'EIT Rundeck', instance_id: 'i-2', name: 'ec2-rundeck-02', environment: 'ITG' },
  // i-2 is also registered under a second app (catalog key is instance_id+app_id)
  { account_id: A, region: 'us-east-1', app_id: '700067', app_name: 'RunStack Platform', instance_id: 'i-2', environment: 'ITG' },
  // Same account, other region
  { account_id: A, region: 'us-west-2', app_id: '500579', app_name: 'EIT Rundeck', instance_id: 'i-3', environment: 'DR' },
  // Other account, whitespace + missing environment
  { account_id: ` ${B} `, region: 'us-east-1 ', app_id: '501122', app_name: 'Compass', instance_id: 'i-4' },
  { account_id: B, region: 'us-east-1', app_id: '501122', app_name: 'Compass', instance_id: 'i-5', environment: 'PROD' },
  // No instance ID → ignored
  { account_id: B, region: 'us-east-1', app_id: '501122' },
];

test('repeated records do not inflate counts', () => {
  const recs = normalizeRecords(rows);
  expect(recs).toHaveLength(6); // 8 rows − 1 exact repeat − 1 without instance
  const g = groupTargets(recs);
  expect(g.map((x) => [x.accountId, x.region, x.appCount, x.instanceCount, x.environments.join(',')])).toEqual([
    [B, 'us-east-1', 1, 2, 'PROD'],
    [A, 'us-east-1', 2, 2, 'ITG'],   // i-2 under two apps still counts as ONE instance
    [A, 'us-west-2', 1, 1, 'DR'],
  ]);
  expect(totals(recs)).toEqual({ accounts: 2, groups: 3, regions: 2, invalidAccounts: 0, apps: 3, instances: 5 });
});

test('expanded rows list apps with their instances; server name falls back to name', () => {
  const g = groupTargets(normalizeRecords(rows)).find((x) => x.accountId === A && x.region === 'us-east-1');
  expect(g.apps.map((a) => [a.appName, a.appId, a.instances.map((i) => `${i.serverName}:${i.instanceId}`).join(' ')])).toEqual([
    ['EIT Rundeck', '500579', 'EC2_LNX_01:i-1 ec2-rundeck-02:i-2'],
    ['RunStack Platform', '700067', ':i-2'],
  ]);
});

test('filters rebuild counts from matching records', () => {
  const recs = normalizeRecords(rows);
  expect(totals(applyFilters(recs, { account: A })).instances).toBe(3);
  expect(totals(applyFilters(recs, { environment: 'ITG' }))).toEqual({ accounts: 1, groups: 1, regions: 1, invalidAccounts: 0, apps: 2, instances: 2 });
  expect(totals(applyFilters(recs, { app: '500579', region: 'us-west-2' })).instances).toBe(1);
  expect(totals(applyFilters(recs, { search: 'lnx_01' })).instances).toBe(1);
  expect(totals(applyFilters(recs, { search: 'compass' })).instances).toBe(2);
  expect(applyFilters(recs, { search: 'nothing-matches' })).toHaveLength(0);
});

test('filter options are distinct and sorted', () => {
  const o = filterOptions(normalizeRecords(rows));
  expect(o.accounts.map((a) => a.id)).toEqual([B, A]);
  expect(o.regions).toEqual(['us-east-1', 'us-west-2']);
  expect(o.environments).toEqual(['DR', 'ITG', 'PROD']);
  expect(o.apps.map((a) => a.id)).toEqual(['501122', '500579', '700067']);
});

test('account ID format check', () => {
  expect(isAccountId(A)).toBe(true);
  expect(isAccountId('75050354211')).toBe(false); // leading zero lost in a spreadsheet
});

test('environment case variants merge; damaged account IDs are counted', () => {
  const recs = normalizeRecords([
    { account_id: '1.2057E+11', region: 'us-east-1', app_id: '1', instance_id: 'i-a', environment: 'Production' },
    { account_id: '1.2057E+11', region: 'us-east-1', app_id: '1', instance_id: 'i-b', environment: 'production' },
    { account_id: '975050354211', region: 'us-east-1', app_id: '2', instance_id: 'i-c', environment: 'itg' },
    { account_id: '975050354211', region: 'us-east-1', app_id: '2', instance_id: 'i-d', environment: 'ITG' },
  ]);
  const g = groupTargets(recs);
  expect(g.map((x) => x.environments)).toEqual([['Production'], ['itg']]);
  expect(filterOptions(recs).environments).toEqual(['itg', 'Production'].sort());
  expect(totals(applyFilters(recs, { environment: 'itg' })).instances).toBe(2);
  expect(totals(recs).invalidAccounts).toBe(1);
});

test('application rows: one per app + account + region, with account name and distinct instances', () => {
  const recs = normalizeRecords([
    { account_id: '975050354211', account_name: 'dxc-eit-itg', region: 'us-east-1', app_id: '500579', app_name: 'EIT Rundeck', instance_id: 'i-1', environment: 'ITG' },
    { account_id: '975050354211', account_name: 'dxc-eit-itg', region: 'us-east-1', app_id: '500579', app_name: 'EIT Rundeck', instance_id: 'i-1', environment: 'ITG' },
    { account_id: '975050354211', account_name: 'dxc-eit-itg', region: 'us-east-1', app_id: '500579', app_name: 'EIT Rundeck', instance_id: 'i-2', environment: 'itg' },
    { account_id: '975050354211', account_name: 'dxc-eit-itg', region: 'us-west-2', app_id: '500579', app_name: 'EIT Rundeck', instance_id: 'i-3', environment: 'DR' },
    { account_id: '246314649749', region: 'us-east-1', app_id: '501122', app_name: 'Compass', instance_id: 'i-4', environment: 'Production' },
  ]);
  const rows = groupByApplication(recs);
  expect(rows.map((r) => [r.appName, r.appId, r.accountId, r.accountName, r.instanceCount, r.environments.join(','), r.region])).toEqual([
    ['Compass', '501122', '246314649749', '', 1, 'Production', 'us-east-1'],
    ['EIT Rundeck', '500579', '975050354211', 'dxc-eit-itg', 2, 'ITG', 'us-east-1'],
    ['EIT Rundeck', '500579', '975050354211', 'dxc-eit-itg', 1, 'DR', 'us-west-2'],
  ]);
  expect(filterOptions(recs).accounts).toEqual([{ id: '246314649749', name: '' }, { id: '975050354211', name: 'dxc-eit-itg' }]);
  expect(totals(applyFilters(recs, { search: 'eit-itg' })).instances).toBe(3);
});
