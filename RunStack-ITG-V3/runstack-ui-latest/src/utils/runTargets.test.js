// Run: CI=true npx react-scripts test --watchAll=false src/utils/runTargets.test.js
import {
  appLabel, appSummaries, documentBlockReason, ec2ActionBlock, facetOptions, facetValues, filterInstances, sortInstances, fmtBytes, locationSummary, paramErrors,
  parseVarCleanup, waveSummary, ec2StateInfo, mergeTargets, appsLabel, inApps, selectionSummary, keepSelectedInApps,
  keepSelectedCompatible, carryParameters, paginate, osOf, accountLabel,
} from './runTargets';

const I = [
  { instance_id: 'i-1', server_name: 'lnx-01', account_id: '111', region: 'us-east-1', environment: 'Development', app_name: 'Billing', app_id: '100' },
  { instance_id: 'i-2', server_name: 'lnx-02', account_id: '111', region: 'us-west-2', environment: 'ITG', app_id: '200' },
  { instance_id: 'i-3', name: 'win-03', account_id: '222', region: 'us-east-1', environment: 'Development', app_name: 'Billing', app_id: '100' },
];

test('filters by search and exact account/region/environment', () => {
  expect(filterInstances(I, { q: 'lnx' }).map((i) => i.instance_id)).toEqual(['i-1', 'i-2']);
  expect(filterInstances(I, { q: 'billing' }).map((i) => i.instance_id)).toEqual(['i-1', 'i-3']);
  expect(filterInstances(I, { account: '111', region: 'us-west-2' }).map((i) => i.instance_id)).toEqual(['i-2']);
  expect(filterInstances(I, { environment: 'Development' })).toHaveLength(2);
  expect(facetValues(I, 'region')).toEqual(['us-east-1', 'us-west-2']);
});

test('document region compatibility and location summary', () => {
  const doc = { regions_available: ['us-east-1'] };
  expect(documentBlockReason(doc, I[1])).toBe('Not available in us-west-2');
  expect(documentBlockReason(doc, I[0])).toBeNull();
  expect(locationSummary(I)).toBe('1 in 111 / us-east-1 · 1 in 111 / us-west-2 · 1 in 222 / us-east-1');
  expect(locationSummary([I[0], I[0], I[2]])).toBe('2 in 111 / us-east-1 · 1 in 222 / us-east-1');
});

test('parameter errors use the document definition', () => {
  const specs = [{ name: 'mountPoint', type: 'String', required: true, allowed_values: ['/var'] }, { name: 'n', type: 'Integer', required: false }];
  expect(paramErrors(specs, {})).toEqual({ mountPoint: 'Required.' });
  expect(paramErrors(specs, { mountPoint: '/etc', n: 'x' })).toEqual({ mountPoint: 'Must be one of: /var.', n: 'Must be a whole number.' });
  expect(paramErrors(specs, { mountPoint: '/var' })).toEqual({});
});

test('wave summary reflects backend limits', () => {
  expect(waveSummary(10, { wave_size: 25, wave_seconds: 60 })).toBe('All selected servers are dispatched together.');
  expect(waveSummary(60, { wave_size: 25, wave_seconds: 60 })).toBe('Dispatched in 3 batches of up to 25 servers, 60s apart.');
  expect(waveSummary(60, { dispatch_batch_size: 50, dispatch_interval_seconds: 30 })).toBe('Dispatched in 2 batches of up to 50 servers, 30s apart.');
});

test('EC2 action blocked by live state only when known', () => {
  expect(ec2ActionBlock('start', 'running')).toBe('Already running');
  expect(ec2ActionBlock('stop', 'stopped')).toBe('Already stopped');
  expect(ec2ActionBlock('stop', 'stopping')).toBe('Currently stopping');
  expect(ec2ActionBlock('start', 'stopped')).toBeNull();
  expect(ec2ActionBlock('start', null)).toBeNull();
});

const VAR_OUT = `Space before zipping logs:
Filesystem                 Size  Used Avail Use% Mounted on
/dev/mapper/rootvg-varlv  8.0G  7.2G  0.8G  90% /var
Files found to zip:
/var/log/messages-20260920
/var/log/secure-20260920
Files have been zipped.
Space after zipping logs:
Filesystem                 Size  Used Avail Use% Mounted on
/dev/mapper/rootvg-varlv  8.0G  5.6G  2.4G  70% /var`;

test('/var cleanup: before/after, files and reclaimed space from the real output', () => {
  const r = parseVarCleanup(VAR_OUT);
  expect(r.before).toMatchObject({ usePct: 90, used: '7.2G', avail: '0.8G', mount: '/var' });
  expect(r.after).toMatchObject({ usePct: 70, used: '5.6G' });
  expect(r.filesZipped).toBe(2);
  expect(fmtBytes(r.reclaimedBytes)).toBe('1.6 GB');
  expect(r.noFiles).toBe(false);
});

test('/var cleanup: nothing to zip, and unrelated output', () => {
  const r = parseVarCleanup(`Space before zipping logs:\nFilesystem Size Used Avail Use% Mounted on\n/dev/sda1 8.0G 7.9G 100M 99% /var\nNo files found matching the specified pattern.`);
  expect(r.noFiles).toBe(true);
  expect(r.before.usePct).toBe(99);
  expect(r.after).toBeNull();
  expect(r.reclaimedBytes).toBeNull();
  expect(parseVarCleanup('uptime: 10 days')).toBeNull();
});

test('application filter and linked option counts never offer dead ends', () => {
  expect(filterInstances(I, { app: '100' }).map((i) => i.instance_id)).toEqual(['i-1', 'i-3']);
  expect(appLabel(I[0])).toBe('Billing · 100');
  expect(appLabel(I[1])).toBe('200');
  // With app=100 selected, only regions/accounts that app has are offered.
  expect(facetOptions(I, { app: '100' }, 'region')).toEqual([{ value: 'us-east-1', label: 'us-east-1', count: 2 }]);
  expect(facetOptions(I, { app: '100' }, 'account')).toEqual([
    { value: '111', label: '111', count: 1 }, { value: '222', label: '222', count: 1 }]);
  // The app list itself ignores the app filter but respects the others.
  expect(facetOptions(I, { region: 'us-west-2' }, 'app')).toEqual([{ value: '200', label: '200', count: 1 }]);
  // A selected value that no longer matches stays visible with 0.
  expect(facetOptions(I, { app: '200', environment: 'Development' }, 'environment'))
    .toEqual([{ value: 'Development', label: 'Development', count: 0 }, { value: 'ITG', label: 'ITG', count: 1 }]);
});

test('app summaries and display order', () => {
  expect(appSummaries(I)).toEqual([
    { app_id: '200', label: '200', count: 1, environments: ['ITG'] },
    { app_id: '100', label: 'Billing · 100', count: 2, environments: ['Development'] },
  ]);
  expect(sortInstances(I).map((i) => i.instance_id)).toEqual(['i-2', 'i-1', 'i-3']);
});

// ── Multiple applications ───────────────────────────────────────────────────

const ROWS = [
  { instance_id: 'i-1', server_name: 'lnx-01', app_id: '100', app_name: 'Billing', region: 'us-east-1', os_type: 'Linux' },
  { instance_id: 'i-1', server_name: 'lnx-01', app_id: '200', app_name: 'Payroll', region: 'us-east-1', os_type: 'Linux' },
  { instance_id: 'i-2', server_name: 'lnx-02', app_id: '100', app_name: 'Billing', region: 'us-west-2' },
  { instance_id: 'i-3', server_name: 'win-03', app_id: '200', app_name: 'Payroll', region: 'us-east-1', operating_system: 'Windows Server 2019' },
];
const M = mergeTargets(ROWS);

test('a server shared by two applications is one target with both memberships', () => {
  expect(M.map((i) => i.instance_id)).toEqual(['i-1', 'i-2', 'i-3']);
  expect(appsLabel(M[0])).toBe('Billing · 100, Payroll · 200');
  expect(inApps(M, ['200']).map((i) => i.instance_id)).toEqual(['i-1', 'i-3']);
  expect(filterInstances(M, { app: '200' }).map((i) => i.instance_id)).toEqual(['i-1', 'i-3']);
  expect(filterInstances(M, { q: 'payroll' }).map((i) => i.instance_id)).toEqual(['i-1', 'i-3']);
  expect(appSummaries(M).map((a) => [a.app_id, a.count])).toEqual([['100', 2], ['200', 2]]);
  expect(facetOptions(M, {}, 'app')).toEqual([
    { value: '100', label: 'Billing · 100', count: 2 }, { value: '200', label: 'Payroll · 200', count: 2 }]);
});

test('selection summary counts servers once and applications they belong to', () => {
  expect(selectionSummary(M, ['i-1', 'i-3'], ['100', '200'])).toBe('2 servers selected across 2 applications');
  expect(selectionSummary(M, ['i-3'], ['100', '200'])).toBe('1 server selected across 1 application');
  expect(selectionSummary(M, ['i-1'], ['100'])).toBe('1 server selected across 1 application');
  expect(selectionSummary(M, [], ['100'])).toBe('0 servers selected');
});

test('removing an application drops only servers that belonged only to it', () => {
  expect(keepSelectedInApps(M, ['i-1', 'i-2', 'i-3'], ['100'])).toEqual({ kept: ['i-1', 'i-2'], dropped: ['i-3'] });
  expect(keepSelectedInApps(M, ['i-1', 'i-2'], ['200'])).toEqual({ kept: ['i-1'], dropped: ['i-2'] });
  expect(keepSelectedInApps(M, ['i-1'], [])).toEqual({ kept: [], dropped: ['i-1'] });
});

test('OS compatibility: recorded OS blocks, unknown OS never does', () => {
  const linuxDoc = { regions_available: ['us-east-1', 'us-west-2'], platform_types: ['Linux'] };
  const winDoc = { regions_available: ['us-east-1'], platform_types: ['Windows'] };
  expect(osOf(M[2])).toBe('Windows Server 2019');
  expect(documentBlockReason(linuxDoc, M[2])).toMatch(/^Windows server/);
  expect(documentBlockReason(linuxDoc, M[0])).toBeNull();
  expect(documentBlockReason(linuxDoc, M[1])).toBeNull();            // no OS recorded
  expect(documentBlockReason(winDoc, M[0])).toBe('Only supports Windows servers');
  expect(documentBlockReason(winDoc, M[1])).toBe('Not available in us-west-2');
});

test('changing automation drops incompatible servers and revalidates parameters', () => {
  const winDoc = { regions_available: ['us-east-1'], platform_types: ['Windows'] };
  const r = keepSelectedCompatible(M, ['i-1', 'i-3', 'i-gone'], winDoc);
  expect(r.kept).toEqual(['i-3']);
  expect(r.dropped.map((d) => [d.instance_id, d.reason])).toEqual([
    ['i-1', 'Only supports Windows servers'], ['i-gone', 'Not available for this automation']]);
  expect(carryParameters({ mountPoint: '/var', retention: '7', empty: '' }, [{ name: 'mountPoint' }]))
    .toEqual({ form: { mountPoint: '/var' }, dropped: ['retention'] });
});

test('pagination clamps the page', () => {
  const list = Array.from({ length: 53 }, (_, n) => n);
  expect(paginate(list, 1, 25)).toMatchObject({ page: 1, pages: 3, total: 53 });
  expect(paginate(list, 3, 25).rows).toEqual([50, 51, 52]);
  expect(paginate(list, 9, 25).page).toBe(3);
  expect(paginate([], 1, 25)).toMatchObject({ page: 1, pages: 1, rows: [] });
});

test('EC2 state labels are text, with unknown never guessed', () => {
  expect(ec2StateInfo('running')).toEqual({ label: 'Running', tone: 'success' });
  expect(ec2StateInfo('stopping')).toEqual({ label: 'Stopping', tone: 'running' });
  expect(ec2StateInfo(null)).toEqual({ label: 'Unknown', tone: 'muted' });
  expect(ec2StateInfo('rebooting').label).toBe('Rebooting');
});

test('account name: filter labels, search and location use the catalog AccountName', () => {
  const rows = [
    { instance_id: 'i-1', server_name: 'a', account_id: '975050354211', account_name: 'dxc-eit-itg', region: 'us-east-1', app_id: '1' },
    { instance_id: 'i-2', server_name: 'b', account_id: '975050354211', account_name: 'dxc-eit-itg', region: 'us-east-1', app_id: '1' },
    { instance_id: 'i-3', server_name: 'c', account_id: '222222222222', region: 'us-west-2', app_id: '1' },
  ];
  expect(accountLabel(rows[0])).toBe('dxc-eit-itg · 975050354211');
  expect(accountLabel(rows[2])).toBe('222222222222');
  expect(facetOptions(rows, {}, 'account')).toEqual([
    { value: '222222222222', label: '222222222222', count: 1 },
    { value: '975050354211', label: 'dxc-eit-itg · 975050354211', count: 2 }]);
  expect(filterInstances(rows, { q: 'eit-itg' }).map((i) => i.instance_id)).toEqual(['i-1', 'i-2']);
  expect(facetOptions(rows, { account: '975050354211', region: 'us-west-2' }, 'account')
    .find((o) => o.value === '975050354211').label).toBe('dxc-eit-itg · 975050354211');
  expect(locationSummary(rows)).toBe('2 in dxc-eit-itg / us-east-1 · 1 in 222222222222 / us-west-2');
});
