// src/utils/targets.js
//
// Groups runstack-instance-catalog records (as returned by GET /app-instances)
// into "registered targets" by AWS account ID + region.
//
// The catalog is keyed by (instance_id, app_id), so the same instance can
// appear once per application, and a CSV re-import can briefly leave
// repeated rows. Every count here is therefore a count of DISTINCT IDs —
// never a count of records.
//
// Nothing here says anything about whether the cross-account role exists or
// works. The catalog only records that someone registered an instance.

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

// Catalog environments arrive as "Production", "production", "PRODUCTION"…
// Treat them as one value (the EC2 guardrail already compares upper-case)
// and display the first spelling seen.
const envKey = (e) => clean(e).toLowerCase();

/** One normalized record per (account, region, app_id, instance_id). */
export function normalizeRecords(items) {
  const seen = new Map();
  (items || []).forEach((it) => {
    const r = {
      accountId: clean(it.account_id),
      accountName: clean(it.account_name),   // catalog value (AccountName column), not an AWS alias
      region: clean(it.region),
      appId: clean(it.app_id),
      appName: clean(it.app_name),
      instanceId: clean(it.instance_id),
      serverName: clean(it.server_name) || clean(it.name),
      environment: clean(it.environment),
    };
    if (!r.instanceId) return;
    const key = [r.accountId, r.region, r.appId, r.instanceId].join('|');
    const prev = seen.get(key);
    if (!prev) { seen.set(key, r); return; }
    // Repeated record: keep the first, fill any blanks from the repeat.
    ['appName', 'serverName', 'environment', 'accountName'].forEach((f) => { if (!prev[f] && r[f]) prev[f] = r[f]; });
  });
  const recs = [...seen.values()];
  const firstSpelling = new Map();
  recs.forEach((r) => { if (r.environment && !firstSpelling.has(envKey(r.environment))) firstSpelling.set(envKey(r.environment), r.environment); });
  recs.forEach((r) => { if (r.environment) r.environment = firstSpelling.get(envKey(r.environment)); });
  return recs;
}

/** True for a well-formed 12-digit AWS account ID. */
export const isAccountId = (id) => /^\d{12}$/.test(id || '');

/** Group records into account+region rows with distinct counts. */
export function groupTargets(records) {
  const groups = new Map();
  records.forEach((r) => {
    const key = `${r.accountId}|${r.region}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, accountId: r.accountId, region: r.region, environments: new Set(), apps: new Map(), instanceIds: new Set() };
      groups.set(key, g);
    }
    if (r.environment) g.environments.add(r.environment);
    g.instanceIds.add(r.instanceId);
    const appKey = r.appId || '(no app ID)';
    let app = g.apps.get(appKey);
    if (!app) { app = { appId: r.appId, appNames: new Set(), instances: new Map() }; g.apps.set(appKey, app); }
    if (r.appName) app.appNames.add(r.appName);
    if (!app.instances.has(r.instanceId)) app.instances.set(r.instanceId, { instanceId: r.instanceId, serverName: r.serverName, environment: r.environment });
  });

  return [...groups.values()].map((g) => ({
    key: g.key,
    accountId: g.accountId,
    region: g.region,
    environments: [...g.environments].sort(),
    appCount: [...g.apps.values()].filter((a) => a.appId).length,
    instanceCount: g.instanceIds.size,
    apps: [...g.apps.values()]
      .map((a) => ({
        appId: a.appId,
        appName: [...a.appNames].sort().join(' / '),
        instances: [...a.instances.values()].sort((x, y) => (x.serverName || x.instanceId).localeCompare(y.serverName || y.instanceId)),
      }))
      .sort((x, y) => (x.appName || x.appId).localeCompare(y.appName || y.appId)),
  })).sort((a, b) => a.accountId.localeCompare(b.accountId) || a.region.localeCompare(b.region));
}

/** One row per application in each account + region, for the main table. */
export function groupByApplication(records) {
  const rows = new Map();
  records.forEach((r) => {
    const key = `${r.appId}|${r.accountId}|${r.region}`;
    let g = rows.get(key);
    if (!g) {
      g = { key, appId: r.appId, appNames: new Set(), accountId: r.accountId, accountNames: new Set(), region: r.region, environments: new Set(), instances: new Map() };
      rows.set(key, g);
    }
    if (r.appName) g.appNames.add(r.appName);
    if (r.accountName) g.accountNames.add(r.accountName);
    if (r.environment) g.environments.add(r.environment);
    if (!g.instances.has(r.instanceId)) g.instances.set(r.instanceId, { instanceId: r.instanceId, serverName: r.serverName, environment: r.environment });
  });
  return [...rows.values()].map((g) => ({
    key: g.key,
    appId: g.appId,
    appName: [...g.appNames].sort().join(' / '),
    accountId: g.accountId,
    accountName: [...g.accountNames].sort().join(' / '),
    region: g.region,
    environments: [...g.environments].sort(),
    instanceCount: g.instances.size,
    instances: [...g.instances.values()].sort((x, y) => (x.serverName || x.instanceId).localeCompare(y.serverName || y.instanceId)),
  })).sort((a, b) => (a.appName || a.appId).localeCompare(b.appName || b.appId)
    || a.accountId.localeCompare(b.accountId) || a.region.localeCompare(b.region));
}

/** Distinct totals across a set of records. */
export function totals(records) {
  const ids = (f) => new Set(records.map(f).filter(Boolean)).size;
  return {
    accounts: ids((r) => r.accountId),
    groups: ids((r) => (r.accountId || r.region ? `${r.accountId}|${r.region}` : '')),
    regions: ids((r) => r.region),
    invalidAccounts: new Set(records.map((r) => r.accountId).filter((a) => a && !isAccountId(a))).size,
    apps: ids((r) => r.appId),
    instances: ids((r) => r.instanceId),
  };
}

/** Filter options (distinct, sorted) from the unfiltered records. */
export function filterOptions(records) {
  const uniq = (f) => [...new Set(records.map(f).filter(Boolean))].sort();
  const appNames = new Map();
  records.forEach((r) => { if (r.appId && r.appName && !appNames.has(r.appId)) appNames.set(r.appId, r.appName); });
  const accountNames = new Map();
  records.forEach((r) => { if (r.accountId && r.accountName && !accountNames.has(r.accountId)) accountNames.set(r.accountId, r.accountName); });
  return {
    accounts: uniq((r) => r.accountId).map((id) => ({ id, name: accountNames.get(id) || '' })),
    regions: uniq((r) => r.region),
    environments: uniq((r) => r.environment),
    apps: uniq((r) => r.appId).map((id) => ({ id, name: appNames.get(id) || '' }))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
  };
}

/** Record-level filtering; groups and counts are then rebuilt from the result. */
export function applyFilters(records, { account, region, environment, app, search }) {
  const q = clean(search).toLowerCase();
  return records.filter((r) => (!account || r.accountId === account)
    && (!region || r.region === region)
    && (!environment || r.environment === environment)
    && (!app || r.appId === app)
    && (!q || [r.accountId, r.accountName, r.region, r.appId, r.appName, r.serverName, r.instanceId, r.environment].some((v) => v.toLowerCase().includes(q))));
}
