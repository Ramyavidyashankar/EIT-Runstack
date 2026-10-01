// src/utils/runTargets.js — helpers for Run Automations / EC2 Start/Stop.
// Pure functions (no React) so they can be unit tested.

import { validateParam } from './sqlHealthcheck';

export const serverLabel = (i) => i?.server_name || i?.name || i?.instance_id || '—';

/** "GDS Cloud Database Service (DXC) · 206065", or just the ID. */
export const appLabel = (i) => (i?.app_name && i?.app_id && i.app_name !== i.app_id
  ? `${i.app_name} · ${i.app_id}` : (i?.app_name || i?.app_id || 'No application'));

// Filter keys → instance fields. Application filters on app_id (stable),
// shown with its name.
export const FILTER_FIELDS = { app: 'app_id', environment: 'environment', account: 'account_id', region: 'region' };

/** Account name from the catalog's AccountName column (stored as
 *  account_name), or '' when the catalog doesn't record one. */
export const accountNameOf = (i) => String(i?.account_name || '').trim();

/** "dxc-eit-itg · 975050354211", or just the ID when no name is recorded. */
export const accountLabel = (i) => {
  const id = String(i?.account_id || '');
  const name = accountNameOf(i);
  return name && id ? `${name} · ${id}` : (name || id || 'No account');
};

// Catalog columns that may record a server's OS (same list as runs.py OS_FIELDS).
export const OS_FIELDS = ['os_type', 'operating_system', 'os', 'OS', 'platform'];

/** The OS the catalog records for a server, or '' when it records none. */
export const osOf = (i) => {
  const k = OS_FIELDS.find((f) => i?.[f]);
  return k ? String(i[k]).trim() : '';
};

/** Applications a server belongs to: [{ app_id, label }]. A merged target
 *  (mergeTargets) can belong to several; a plain catalog row to one. */
export const appsOf = (i) => (i?.apps?.length ? i.apps
  : (i?.app_id ? [{ app_id: String(i.app_id), app_name: i.app_name, label: appLabel(i) }] : []));
export const appIdsOf = (i) => appsOf(i).map((a) => String(a.app_id));

/** "Billing · 100, Payroll · 200" — every application a server belongs to. */
export const appsLabel = (i) => appsOf(i).map((a) => a.label).join(', ') || 'No application';

/**
 * The catalog keys rows by instance + application, so a server shared by
 * two applications arrives twice. One target per instance ID, with every
 * application it belongs to in `apps` (first row's other fields kept).
 */
export function mergeTargets(rows) {
  const byId = new Map();
  (rows || []).forEach((r) => {
    if (!r?.instance_id) return;
    const app = r.app_id ? { app_id: String(r.app_id), app_name: r.app_name, label: appLabel(r) } : null;
    const cur = byId.get(r.instance_id);
    if (!cur) {
      byId.set(r.instance_id, { ...r, apps: app ? [app] : [] });
    } else if (app && !cur.apps.some((a) => a.app_id === app.app_id)) {
      cur.apps = [...cur.apps, app];
    }
  });
  return [...byId.values()];
}

/** Search + exact-match filters over the authorized instance list. `app`
 *  matches any application a server belongs to. */
export function filterInstances(instances, { q = '', app = '', account = '', region = '', environment = '' } = {}) {
  const needle = q.trim().toLowerCase();
  return (instances || []).filter((i) => {
    if (app && !appIdsOf(i).includes(app)) return false;
    if (account && String(i.account_id || '') !== account) return false;
    if (region && String(i.region || '') !== region) return false;
    if (environment && String(i.environment || '') !== environment) return false;
    if (!needle) return true;
    return [i.server_name, i.name, i.instance_id, i.account_id, accountNameOf(i), i.region, i.environment, osOf(i),
      ...appsOf(i).flatMap((a) => [a.app_name, a.app_id])]
      .some((v) => String(v || '').toLowerCase().includes(needle));
  });
}

/** Servers belonging to at least one of the given applications. */
export const inApps = (instances, appIds) => {
  const want = new Set((appIds || []).map(String));
  return (instances || []).filter((i) => appIdsOf(i).some((a) => want.has(a)));
};

/** Distinct, sorted values of one field (for filter dropdowns). */
export function facetValues(instances, key) {
  return [...new Set((instances || []).map((i) => i[key]).filter((v) => v !== undefined && v !== null && v !== ''))]
    .map(String).sort((a, b) => a.localeCompare(b));
}

/**
 * Options for one filter, counted against the OTHER active filters (and the
 * search), so every option shown leads to at least one server. The value
 * currently selected is always kept (with its count, possibly 0).
 * Returns [{ value, label, count }] sorted by label.
 */
export function facetOptions(instances, filters, key) {
  const field = FILTER_FIELDS[key];
  const others = filterInstances(instances, { ...filters, [key]: '' });
  const counts = new Map();
  const labels = new Map();
  const add = (k, label) => {
    counts.set(k, (counts.get(k) || 0) + 1);
    if (label && !labels.has(k)) labels.set(k, label);
  };
  others.forEach((i) => {
    if (key === 'app') { appsOf(i).forEach((a) => add(String(a.app_id), a.label)); return; }
    const v = i[field];
    if (v === undefined || v === null || v === '') return;
    add(String(v), key === 'account' && accountNameOf(i) ? accountLabel(i) : undefined);
  });
  const current = filters[key];
  if (current && !counts.has(current)) {
    counts.set(current, 0);
    if (key === 'app') {
      const any = (instances || []).flatMap(appsOf).find((a) => String(a.app_id) === current);
      labels.set(current, any ? any.label : current);
    } else if (key === 'account') {
      const any = (instances || []).find((i) => String(i.account_id) === current && accountNameOf(i));
      if (any) labels.set(current, accountLabel(any));
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: labels.get(value) || value, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Servers sorted for display: application, environment, then name. */
export function sortInstances(instances) {
  return [...(instances || [])].sort((a, b) => appLabel(a).localeCompare(appLabel(b))
    || String(a.environment || '').localeCompare(String(b.environment || ''))
    || serverLabel(a).localeCompare(serverLabel(b)));
}

/** Applications in the list with server counts, for an app picker. A
 *  server shared by several applications counts once in each. */
export function appSummaries(instances) {
  const m = new Map();
  (instances || []).forEach((i) => {
    appsOf(i).forEach((a) => {
      const k = String(a.app_id || '');
      if (!k) return;
      const e = m.get(k) || { app_id: k, label: a.label, count: 0, environments: new Set() };
      e.count += 1;
      if (i.environment) e.environments.add(String(i.environment));
      m.set(k, e);
    });
  });
  return [...m.values()].map((e) => ({ ...e, environments: [...e.environments].sort() }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Map of parameter name → error message, using the shared validator. */
export function paramErrors(specs, form) {
  const out = {};
  (specs || []).forEach((p) => {
    const value = p.type === 'StringList'
      ? String(form[p.name] || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : form[p.name];
    const err = validateParam(p, value);
    if (err) out[p.name] = err;
  });
  return out;
}

/** Why a server can't run the chosen document, or null. Mirrors the
 *  backend's region and OS checks (runs.py); the backend still decides. An
 *  OS the catalog doesn't record never blocks. */
export function documentBlockReason(doc, inst) {
  if (!doc || !inst) return null;
  if (doc.regions_available?.length && !doc.regions_available.includes(inst.region)) {
    return `Not available in ${inst.region || 'this region'}`;
  }
  const os = osOf(inst).toLowerCase();
  const wanted = (doc.platform_types || []).map((p) => String(p).toLowerCase());
  if (os && wanted.length) {
    const isWindows = os.includes('win');
    if (isWindows && !wanted.includes('windows')) return 'Windows server — this automation supports ' + doc.platform_types.join(', ');
    if (!isWindows && wanted.length === 1 && wanted[0] === 'windows') return 'Only supports Windows servers';
  }
  return null;
}

/** "N servers selected across M applications" (only applications in
 *  `appIds` count, when given). */
export function selectionSummary(instances, selectedIds, appIds) {
  const ids = new Set(selectedIds || []);
  const scope = appIds ? new Set(appIds.map(String)) : null;
  const chosen = (instances || []).filter((i) => ids.has(i.instance_id));
  const apps = new Set(chosen.flatMap(appIdsOf).filter((a) => !scope || scope.has(a)));
  const n = ids.size;
  const s = `${n} server${n === 1 ? '' : 's'} selected`;
  return apps.size ? `${s} across ${apps.size} application${apps.size === 1 ? '' : 's'}` : s;
}

/** After applications change: keep selected servers that still belong to
 *  one of `appIds`; report the rest (they belonged only to removed apps). */
export function keepSelectedInApps(instances, selectedIds, appIds) {
  const want = new Set((appIds || []).map(String));
  const byId = new Map((instances || []).map((i) => [i.instance_id, i]));
  const kept = []; const dropped = [];
  (selectedIds || []).forEach((id) => {
    const i = byId.get(id);
    if (i && appIdsOf(i).some((a) => want.has(a))) kept.push(id); else dropped.push(id);
  });
  return { kept, dropped };
}

/** After the automation changes: keep selected servers it can run on;
 *  report the rest with the reason. */
export function keepSelectedCompatible(instances, selectedIds, doc) {
  const byId = new Map((instances || []).map((i) => [i.instance_id, i]));
  const kept = []; const dropped = [];
  (selectedIds || []).forEach((id) => {
    const i = byId.get(id);
    const reason = !i ? 'Not available for this automation' : documentBlockReason(doc, i);
    if (reason) dropped.push({ instance_id: id, server: i ? serverLabel(i) : id, reason }); else kept.push(id);
  });
  return { kept, dropped };
}

/** Carry parameter values over to a newly chosen automation: values for
 *  parameters it also has are kept (and revalidated); the rest are dropped. */
export function carryParameters(form, specs) {
  const names = new Set((specs || []).map((p) => p.name));
  const next = {}; const dropped = [];
  Object.entries(form || {}).forEach(([k, v]) => {
    if (v === undefined || v === '') return;
    if (names.has(k)) next[k] = v; else dropped.push(k);
  });
  return { form: next, dropped };
}

/** One page of a list; page is clamped into range. */
export function paginate(list, page, size) {
  const total = (list || []).length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: (list || []).slice((p - 1) * size, p * size), page: p, pages, total };
}

/** "3 in 471112955032 / us-east-1 · 1 in 222222222222 / us-west-2". */
export function locationSummary(instances) {
  const counts = new Map();
  (instances || []).forEach((i) => {
    const k = `${accountNameOf(i) || i.account_id || '?'} / ${i.region || '?'}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} in ${k}`).join(' · ');
}

/** Plain description of staggered dispatch for n servers: RunStack
 *  releases up to `dispatch batch size` jobs every `interval` seconds. It
 *  paces start times; it is not a limit on how many run at once. */
export function waveSummary(n, limits) {
  const size = limits?.dispatch_batch_size || limits?.wave_size || 0;
  const secs = limits?.dispatch_interval_seconds || limits?.wave_seconds || 0;
  if (!n || !size || n <= size || !secs) return 'All selected servers are dispatched together.';
  const batches = Math.ceil(n / size);
  return `Dispatched in ${batches} batches of up to ${size} servers, ${secs}s apart.`;
}

// ── EC2 Start/Stop ──────────────────────────────────────────────────────────

/** How an EC2 state is shown: text label plus a badge tone. A missing
 *  state means RunStack couldn't read it — shown as Unknown, never guessed. */
export function ec2StateInfo(state) {
  const map = {
    running: ['Running', 'success'], stopped: ['Stopped', 'muted'], pending: ['Pending', 'running'],
    stopping: ['Stopping', 'running'], 'shutting-down': ['Shutting down', 'warning'], terminated: ['Terminated', 'danger'],
  };
  if (!state) return { label: 'Unknown', tone: 'muted' };
  const [label, tone] = map[state] || [state.charAt(0).toUpperCase() + state.slice(1), 'muted'];
  return { label, tone };
}

/** Whether an instance can take the chosen action given its live state. */
export function ec2ActionBlock(action, state) {
  if (!state) return null;                     // unknown — allowed, shown as unknown
  if (action === 'start' && state === 'running') return 'Already running';
  if (action === 'stop' && state === 'stopped') return 'Already stopped';
  if (['pending', 'stopping', 'shutting-down'].includes(state)) return `Currently ${state}`;
  if (state === 'terminated') return 'Terminated';
  return null;
}

// ── /var cleanup output ─────────────────────────────────────────────────────
// The /var cleanup script prints `df -h /var` before and after zipping old
// logs ("Space before zipping logs:" / "Space after zipping logs:"), or
// "No files found matching the specified pattern." Only what the output
// actually contains is returned — nothing is estimated.

const SIZE_RE = /^([\d.]+)\s*([KMGTP]?)i?B?$/i;
const UNIT = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };

export function parseSize(s) {
  const m = SIZE_RE.exec(String(s || '').trim());
  return m ? Number(m[1]) * UNIT[m[2].toUpperCase()] : null;
}

export function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(n); let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${n < 0 ? '-' : ''}${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function dfAfter(lines, marker) {
  const at = lines.findIndex((l) => l.includes(marker));
  if (at < 0) return null;
  for (let i = at + 1; i < Math.min(lines.length, at + 6); i += 1) {
    const parts = lines[i].trim().split(/\s+/);
    // Filesystem Size Used Avail Use% Mounted-on
    if (parts.length >= 6 && /%$/.test(parts[4]) && !/^filesystem$/i.test(parts[0])) {
      return { filesystem: parts[0], size: parts[1], used: parts[2], avail: parts[3],
        usePct: Number(parts[4].replace('%', '')), mount: parts.slice(5).join(' ') };
    }
  }
  return null;
}

export function parseVarCleanup(text) {
  const t = String(text || '');
  if (!/Space before zipping logs:|No files found matching the specified pattern/.test(t)) return null;
  const lines = t.split(/\r?\n/);
  const before = dfAfter(lines, 'Space before zipping logs:');
  const after = dfAfter(lines, 'Space after zipping logs:');
  const noFiles = /No files found matching the specified pattern/.test(t);
  let filesZipped = null;
  const start = lines.findIndex((l) => l.includes('Files found to zip:'));
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && /Files have been zipped|Space after zipping logs:/.test(l));
    filesZipped = lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => l.trim().startsWith('/')).length;
  }
  let reclaimedBytes = null;
  if (before && after) {
    const a = parseSize(before.used); const b = parseSize(after.used);
    if (a != null && b != null) reclaimedBytes = a - b;
  }
  return { before, after, noFiles, filesZipped, reclaimedBytes };
}
