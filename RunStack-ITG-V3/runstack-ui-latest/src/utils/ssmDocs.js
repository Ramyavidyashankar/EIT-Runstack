// src/utils/ssmDocs.js — list filtering and summaries for the SSM Documents page.
// Rows come from GET /ssm/documents?regions=all: one row per document per region.

export const REGION_STYLE = {
  'us-east-1': { label: 'us-east-1', fg: '#0B5C56', bg: '#E6F5F3', border: '#BEE3DE', dot: '#0F766E' },
  'us-west-2': { label: 'us-west-2', fg: '#3730A3', bg: '#EEF0FB', border: '#C9CDF2', dot: '#4F46E5' },
};
export const regionStyle = (r) => REGION_STYLE[r] || { label: r, fg: '#334155', bg: '#F1F5F9', border: '#E2E8F0', dot: '#64748B' };

export function statusTone(status) {
  if (!status) return 'gray';
  if (status === 'Active') return 'green';
  if (status === 'Failed') return 'red';
  if (['Creating', 'Updating', 'Deleting'].includes(status)) return 'amber';
  return 'gray';
}

/** Search matches name, display name or description; region '' = all. */
export function filterDocuments(rows, { search = '', region = '' } = {}) {
  const q = search.trim().toLowerCase();
  return (rows || []).filter((d) => (!region || d.region === region)
    && (!q || [d.name, d.display_name, d.description].some((v) => (v || '').toLowerCase().includes(q))));
}

/** Configured regions a document is missing from. */
export function missingRegions(doc, regions) {
  return (regions || []).filter((r) => !(doc.available_in || []).includes(r));
}

export function summarize(rows, regions) {
  const names = new Set((rows || []).map((d) => d.name));
  const perRegion = Object.fromEntries((regions || []).map((r) => [r, new Set(rows.filter((d) => d.region === r).map((d) => d.name)).size]));
  const oneRegionOnly = new Set(rows.filter((d) => missingRegions(d, regions).length > 0).map((d) => d.name)).size;
  const notDefaultLatest = rows.filter((d) => d.default_version && d.latest_version && d.default_version !== d.latest_version).length;
  return { documents: names.size, perRegion, oneRegionOnly, notDefaultLatest };
}

/** "v3 · default · latest" for the version picker. */
export function versionLabel(v) {
  const tags = [];
  if (v.is_default) tags.push('default');
  if (v.is_latest) tags.push('latest');
  return `Version ${v.version}${v.version_name ? ` (${v.version_name})` : ''}${tags.length ? ` · ${tags.join(' · ')}` : ''}`;
}

/** Safe file name for a YAML download: name-v3-us-west-2.yaml */
export function downloadName(name, version, region, format = 'YAML') {
  const base = String(name || 'document').replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${base}-v${version || 'default'}-${region || 'region'}.${String(format).toUpperCase() === 'JSON' ? 'json' : 'yaml'}`;
}
