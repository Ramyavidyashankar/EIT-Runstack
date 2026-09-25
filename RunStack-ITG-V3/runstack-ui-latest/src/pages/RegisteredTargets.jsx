// src/pages/RegisteredTargets.jsx
//
// Registered Targets — replaces the old "Target Accounts" page, which showed
// hardcoded sample accounts, aliases and "reachable" badges.
//
// Data source: runstack-instance-catalog via GET /app-instances (the same
// endpoint Run Automation uses). That endpoint already applies RunStack's
// app-access scoping: admins get the whole catalog, everyone else only the
// applications assigned to them in runstack-app-access. This page adds no
// authorization of its own and shows exactly what the API returns.
//
// What this page does NOT claim:
//   - RunStack has no separate list of onboarded accounts, so an account
//     appears here only if it has at least one catalog entry.
//   - A catalog entry doesn't prove the cross-account role exists or can be
//     assumed. RunStack has no live role/connectivity check today, so Role
//     readiness is always "Not checked".
//   - Nothing here is an AWS account alias; only catalog values are shown.

import React from 'react';
import { Topbar } from '../components/Layout';
import { Card, Empty, ErrorBanner, Input, Select, Spinner } from '../components/ui';
import { Callout, Chip, RefreshControl, SummaryTile } from '../components/sections';
import { useAuth } from '../auth/AuthContext';
import { fetchAppInstances } from '../api/client';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { applyFilters, filterOptions, groupByApplication, isAccountId, normalizeRecords, totals } from '../utils/targets';

const TEAL = '#0F766E';
const mono = { fontFamily: 'var(--font-mono)', fontSize: 12 };
const EMPTY_FILTERS = { search: '', account: '', region: '', environment: '', app: '' };

function InstanceList({ row }) {
  const th = { textAlign: 'left', padding: '6px 10px', fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #E2E8F0' };
  const td = { padding: '6px 10px', fontSize: 12.5, borderBottom: '1px solid #F1F5F9', verticalAlign: 'top' };
  return (
    <div style={{ padding: '10px 16px 14px 44px', background: '#F8FAFC', borderTop: '1px solid #E2E8F0' }}>
      <div style={{ background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>Server name</th><th style={th}>Instance ID</th><th style={th}>Environment</th></tr></thead>
          <tbody>
            {row.instances.map((i) => (
              <tr key={i.instanceId}>
                <td style={td}>{i.serverName || <span style={{ color: '#94A3B8' }}>—</span>}</td>
                <td style={{ ...td, ...mono }}>{i.instanceId}</td>
                <td style={td}>{i.environment || <span style={{ color: '#94A3B8' }}>—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function RegisteredTargets() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [records, setRecords] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [lastUpdated, setLastUpdated] = React.useState(null);
  const [filters, setFilters] = React.useState(EMPTY_FILTERS);
  const [open, setOpen] = React.useState(() => new Set());

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAppInstances();
      setRecords(normalizeRecords(res.instances || []));
      setLastUpdated(new Date());
    } catch (e) {
      setError(e.body?.message || e.body?.error || e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => { load(); }, [load]);
  usePageRefresh(load);

  const all = records || [];
  const options = React.useMemo(() => filterOptions(all), [all]);
  const filtered = React.useMemo(() => applyFilters(all, filters), [all, filters]);
  const groups = React.useMemo(() => groupByApplication(filtered), [filtered]);
  const sums = React.useMemo(() => totals(filtered), [filtered]);
  const filtering = Object.values(filters).some(Boolean);
  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (key) => setOpen((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const th = { textAlign: 'left', padding: '9px 12px', fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6, background: '#F8FAFC', borderBottom: '1px solid #E2E8F0', whiteSpace: 'nowrap' };
  const td = { padding: '10px 12px', borderBottom: '1px solid #F1F5F9', verticalAlign: 'middle', fontSize: 12.5 };
  const num = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Topbar
        title="Registered Targets"
        subtitle="Explore registered applications and servers by AWS account and region."
        actions={records && <RefreshControl onRefresh={load} refreshing={loading} lastUpdated={lastUpdated} error={records && error} />}
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px 24px' }}>
        <div style={{ maxWidth: 1400, margin: '0 auto', display: 'grid', gap: 14 }}>
          {!isAdmin && <div style={{ fontSize: 12, color: '#475569' }}>You're seeing targets for the applications assigned to you.</div>}

          {error && !records && <ErrorBanner message={error} />}

          {records && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
                <SummaryTile label="Accounts managed by RunStack" value={sums.accounts} sub={filtering ? 'matching filters' : 'in the instance catalog'} />
                <SummaryTile label="Regions" value={sums.regions} />
                <SummaryTile label="Applications" value={sums.apps} sub="distinct app IDs" />
                <SummaryTile label="Instances" value={sums.instances} sub="distinct instance IDs" />
              </div>

              {sums.invalidAccounts > 0 && (
                <Callout tone="warning" title={`${sums.invalidAccounts} account ID${sums.invalidAccounts === 1 ? '' : 's'} in the catalog ${sums.invalidAccounts === 1 ? "isn't" : "aren't"} a valid 12-digit AWS account ID`}>
                  Values like <span style={mono}>1.2057E+11</span> come from Excel's scientific notation and the missing digits can't be recovered,
                  so RunStack can't reach those instances. Format the AccountId column as a number with 0 decimal places (or as text) in the
                  source workbook, save the CSV again and re-upload it.
                </Callout>
              )}

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <Input type="search" value={filters.search} onChange={set('search')} placeholder="Search app, account, server or instance ID…" style={{ maxWidth: 300, fontSize: 12.5 }} aria-label="Search" />
                <Select value={filters.account} onChange={set('account')} style={{ width: 230, fontSize: 12.5 }} aria-label="Account">
                  <option value="">All accounts</option>
                  {options.accounts.map((a) => <option key={a.id} value={a.id}>{a.name ? `${a.id} · ${a.name}` : a.id}</option>)}
                </Select>
                <Select value={filters.region} onChange={set('region')} style={{ width: 140, fontSize: 12.5 }} aria-label="Region">
                  <option value="">All regions</option>
                  {options.regions.map((r) => <option key={r} value={r}>{r}</option>)}
                </Select>
                <Select value={filters.environment} onChange={set('environment')} style={{ width: 160, fontSize: 12.5 }} aria-label="Environment">
                  <option value="">All environments</option>
                  {options.environments.map((e) => <option key={e} value={e}>{e}</option>)}
                </Select>
                <Select value={filters.app} onChange={set('app')} style={{ width: 230, fontSize: 12.5 }} aria-label="Application">
                  <option value="">All applications</option>
                  {options.apps.map((a) => <option key={a.id} value={a.id}>{a.name ? `${a.name} (${a.id})` : a.id}</option>)}
                </Select>
                {filtering && (
                  <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} style={{ background: 'none', border: 'none', color: TEAL, fontWeight: 600, fontSize: 12.5, cursor: 'pointer' }}>
                    Clear filters
                  </button>
                )}
              </div>
            </>
          )}

          <Card>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid #E2E8F0', display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>Registered targets</span>
              {records && <span style={{ fontSize: 11.5, color: '#64748B' }}>One row per application in each account and region · {groups.length} row{groups.length === 1 ? '' : 's'}</span>}
            </div>
            {!records ? (
              loading ? <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div> : <Empty message="Couldn't load registered targets." />
            ) : groups.length === 0 ? (
              <Empty message={all.length ? 'No registered targets match these filters.' : 'The instance catalog has no entries you can see.'} />
            ) : (
              <div style={{ overflowX: 'auto', opacity: loading ? 0.6 : 1, transition: 'opacity 0.15s' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 860 }}>
                  <thead><tr>
                    <th style={{ ...th, width: 32 }} aria-label="Expand" />
                    <th style={th}>Application name</th>
                    <th style={th}>App ID</th>
                    <th style={th}>Account ID</th>
                    <th style={th} title="From the AccountName column of the instance catalog">Account name</th>
                    <th style={{ ...th, textAlign: 'right' }}>Instances</th>
                    <th style={th}>Environment</th>
                    <th style={th}>Region</th>
                  </tr></thead>
                  {groups.map((g) => {
                    const isOpen = open.has(g.key);
                    return (
                      <tbody key={g.key}>
                        <tr className="rs-exec-row" onClick={() => toggle(g.key)} style={{ cursor: 'pointer' }}>
                          <td style={{ ...td, textAlign: 'center' }}>
                            <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} instances for ${g.appName || g.appId} in ${g.accountId} ${g.region}`}
                              onClick={(e) => { e.stopPropagation(); toggle(g.key); }}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: TEAL, fontSize: 12, padding: 2 }}>{isOpen ? '▾' : '▸'}</button>
                          </td>
                          <td style={{ ...td, fontWeight: 600, color: '#0F172A' }}>{g.appName || <span style={{ color: '#94A3B8', fontWeight: 400 }}>No name in catalog</span>}</td>
                          <td style={{ ...td, ...mono }}>{g.appId || '—'}</td>
                          <td style={td}>
                            <span style={{ ...mono, color: '#0F172A' }}>{g.accountId || '—'}</span>
                            {g.accountId && !isAccountId(g.accountId) && (
                              <span style={{ marginLeft: 8 }}><Chip tone="red" title="AWS account IDs are 12 digits. This value was damaged in a spreadsheet, so RunStack can't reach these instances.">Invalid account ID</Chip></span>
                            )}
                          </td>
                          <td style={td}>{g.accountName || <span style={{ color: '#94A3B8' }}>—</span>}</td>
                          <td style={num}>{g.instanceCount}</td>
                          <td style={td}>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {g.environments.length ? g.environments.map((e) => <Chip key={e} tone="gray">{e}</Chip>) : <span style={{ color: '#94A3B8' }}>Not set</span>}
                            </div>
                          </td>
                          <td style={td}>{g.region || <span style={{ color: '#94A3B8' }}>—</span>}</td>
                        </tr>
                        {isOpen && <tr><td colSpan={8} style={{ padding: 0 }}><InstanceList row={g} /></td></tr>}
                      </tbody>
                    );
                  })}
                </table>
              </div>
            )}
          </Card>
          {records && (
            <div style={{ fontSize: 11.5, color: '#64748B', lineHeight: 1.6 }}>
              Source: <span style={mono}>runstack-instance-catalog</span>. Only accounts with at least one registered instance are listed.
              Totals count distinct application and instance IDs, so an instance under two applications counts once. Account name comes from the catalog's AccountName column.
              A registered target isn't proof that RunStack's cross-account role works in that account.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
