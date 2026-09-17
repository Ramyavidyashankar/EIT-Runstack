// src/pages/Jobs.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Topbar } from '../components/Layout';
import { StatusBadge, TypeTag, MonoField, Spinner, ErrorBanner, Btn, Card, CardHead, Empty } from '../components/ui';
import { fetchRecentJobs, fetchJob } from '../api/client';
import { fmtRelative, fmtDuration, fmtDateTime } from '../utils/helpers';

const FILTERS  = ['ALL', 'RUNNING', 'PENDING', 'COMPLETED', 'FAILED'];
const PAGE_SIZE = 50;

// ─── CSV Export ───────────────────────────────────────────────────────────────
function exportCSV(jobs) {
  const headers = ['job_id','notification_id','account_id','region','resource_id',
                   'automation_type','document_name','status','execution_id','created_at','updated_at','duration'];
  const rows = jobs.map(j => headers.map(h => {
    let v = '';
    if (h === 'document_name') v = j.automation_data?.DocumentName || '';
    else if (h === 'duration')  v = fmtDuration(j.created_at, j.updated_at);
    else v = j[h] || '';
    return `"${String(v).replace(/"/g, '""')}"`;
  }).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `runstack-jobs-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Jobs List ────────────────────────────────────────────────────────────────
export default function Jobs() {
  const nav = useNavigate();

  const [allJobs,     setAllJobs]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingAll,  setLoadingAll]  = useState(false);
  const [error,       setError]       = useState(null);
  const [lastKey,     setLastKey]     = useState(null);
  const [hasMore,     setHasMore]     = useState(true);
  const [filter,      setFilter]      = useState('ALL');
  const [search,      setSearch]      = useState('');
  const [page,        setPage]        = useState(1);

  // ── Initial load ─────────────────────────────────────────────────────────
  const loadJobs = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPage(1);
    try {
      const data = await fetchRecentJobs({ limit: 50 });
      setAllJobs(data.jobs || []);
      setLastKey(data.last_key || null);
      setHasMore(!!data.last_key);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  // ── Load next page ────────────────────────────────────────────────────────
  async function loadMore() {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await fetchRecentJobs({ limit: 50, lastKey });
      const jobs = data.jobs || [];
      setAllJobs(prev => {
        const ids = new Set(prev.map(j => j.job_id));
        return [...prev, ...jobs.filter(j => !ids.has(j.job_id))];
      });
      setLastKey(data.last_key || null);
      setHasMore(!!data.last_key);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }

  // ── Load ALL pages ────────────────────────────────────────────────────────
  async function loadAll() {
    setLoadingAll(true);
    let key = lastKey;
    let loaded = [...allJobs];
    try {
      while (key) {
        const data = await fetchRecentJobs({ limit: 50, lastKey: key });
        const jobs = data.jobs || [];
        const ids = new Set(loaded.map(j => j.job_id));
        loaded = [...loaded, ...jobs.filter(j => !ids.has(j.job_id))];
        key = data.last_key || null;
        setAllJobs([...loaded]);
        setLastKey(key);
        setHasMore(!!key);
        if (!key) break;
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingAll(false);
    }
  }

  // ── Filtered + searched ───────────────────────────────────────────────────
  const visible = React.useMemo(() => {
    let result = allJobs;
    if (filter !== 'ALL') result = result.filter(j => j.status === filter);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(j =>
        j.job_id?.toLowerCase().includes(q) ||
        j.notification_id?.toLowerCase().includes(q) ||
        j.account_id?.includes(q) ||
        j.resource_id?.toLowerCase().includes(q) ||
        j.automation_data?.DocumentName?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [allJobs, filter, search]);

  const pageCount = Math.ceil(visible.length / PAGE_SIZE);
  const paginated = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const counts = React.useMemo(() => {
    const c = { ALL: allJobs.length };
    FILTERS.slice(1).forEach(f => { c[f] = allJobs.filter(j => j.status === f).length; });
    return c;
  }, [allJobs]);

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>
      <Topbar title="Jobs" subtitle={`${allJobs.length} records loaded${hasMore ? ' — more available' : ' — all loaded'}`}
        actions={
          <div style={{ display:'flex', gap:8 }}>
            {hasMore && (
              <Btn variant="default" size="sm" onClick={loadAll} disabled={loadingAll || loadingMore}>
                {loadingAll ? <><Spinner size={12}/> Loading all…</> : '⬇ Load all'}
              </Btn>
            )}
            <Btn variant="default" size="sm" onClick={() => exportCSV(visible)} disabled={visible.length === 0}>
              ↓ Export CSV ({visible.length})
            </Btn>
            <Btn variant="default" size="sm" onClick={loadJobs} disabled={loading}>
              {loading ? <Spinner size={13}/> : '↺'} Refresh
            </Btn>
          </div>
        }
      />

      <div style={{ flex:1, overflowY:'auto', padding:24 }}>
        {error && <ErrorBanner message={error}/>}

        {/* Filter tabs */}
        <div style={{ display:'flex', gap:6, marginBottom:14, flexWrap:'wrap', alignItems:'center' }}>
          {FILTERS.map(f => (
            <button key={f} onClick={() => { setFilter(f); setPage(1); }} style={{
              padding:'5px 13px', borderRadius:20, fontSize:12, fontWeight:500,
              cursor:'pointer', transition:'all 0.12s', fontFamily:'inherit',
              border: filter === f ? '1px solid var(--blue)' : '1px solid var(--border-md)',
              background: filter === f ? 'var(--blue-bg)' : 'var(--bg-card)',
              color: filter === f ? 'var(--blue)' : 'var(--text-secondary)',
            }}>
              {f} <span style={{ fontSize:10, opacity:0.7 }}>({counts[f] || 0})</span>
            </button>
          ))}
          <input
            style={{
              marginLeft:'auto', padding:'5px 12px', borderRadius:20,
              border:'1px solid var(--border-md)', background:'var(--bg-card)',
              fontSize:12, color:'var(--text-primary)', fontFamily:'inherit',
              width:220, outline:'none',
            }}
            placeholder="Search job ID, account, document…"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
          />
        </div>

        <Card>
          {loading && allJobs.length === 0 ? (
            <div style={{ padding:40, display:'flex', justifyContent:'center' }}><Spinner/></div>
          ) : visible.length === 0 ? (
            <Empty message={`No ${filter === 'ALL' ? '' : filter.toLowerCase() + ' '}jobs found.`}/>
          ) : (
            <>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead>
                  <tr>
                    {['Job ID','Notification ID','Document','Type','Account','Region','Resource','Status','Created','Duration'].map(h => (
                      <th key={h} style={{
                        textAlign:'left', padding:'9px 12px',
                        fontSize:10, fontWeight:600, color:'var(--text-tertiary)',
                        textTransform:'uppercase', letterSpacing:0.5,
                        borderBottom:'1px solid var(--border)', whiteSpace:'nowrap',
                        background:'var(--bg-page)',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((j, idx) => (
                    <tr key={j.job_id || idx}
                      onClick={() => nav(`/jobs/${j.job_id}`)}
                      style={{ cursor:'pointer', transition:'background 0.1s' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}
                    >
                      <td style={td}><MonoField value={j.job_id?.slice(0,10) || '—'}/></td>
                      <td style={td}><span style={{ fontSize:11, color:'var(--text-secondary)' }}>{j.notification_id?.slice(0,28) || '—'}</span></td>
                      <td style={td}><span style={{ fontWeight:500 }}>{j.automation_data?.DocumentName || '—'}</span></td>
                      <td style={td}><TypeTag type={j.automation_type}/></td>
                      <td style={td}><MonoField value={j.account_id || '—'} dim/></td>
                      <td style={td}><span style={{ color:'var(--text-secondary)', fontSize:11 }}>{j.region}</span></td>
                      <td style={td}><MonoField value={j.resource_id?.slice(0,14) || '—'} dim/></td>
                      <td style={td}><StatusBadge status={j.status}/></td>
                      <td style={td}><span style={{ color:'var(--text-secondary)' }}>{fmtRelative(j.created_at)}</span></td>
                      <td style={td}><span style={{ color:'var(--text-tertiary)' }}>{fmtDuration(j.created_at, j.updated_at)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Footer */}
              <div style={{
                display:'flex', alignItems:'center', justifyContent:'space-between',
                padding:'11px 14px', borderTop:'1px solid var(--border)',
                background:'var(--bg-page)', fontSize:12, color:'var(--text-secondary)',
              }}>
                <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                  <span>
                    Showing {Math.min((page-1)*PAGE_SIZE+1, visible.length)}–{Math.min(page*PAGE_SIZE, visible.length)} of {visible.length}
                  </span>
                  {hasMore && (
                    <span>
                      <span
                        onClick={loadMore}
                        style={{ color:'var(--blue)', cursor: loadingMore ? 'default' : 'pointer', fontWeight:600 }}
                      >
                        {loadingMore ? 'Loading…' : `· Load more (${allJobs.length} loaded)`}
                      </span>
                      <span
                        onClick={loadAll}
                        style={{ color:'var(--blue)', cursor: loadingAll ? 'default' : 'pointer', fontWeight:600, marginLeft:8 }}
                      >
                        {loadingAll ? '' : '· Load all'}
                      </span>
                    </span>
                  )}
                  {!hasMore && (
                    <span style={{ color:'var(--green)', fontWeight:600 }}>✓ All {allJobs.length} jobs loaded</span>
                  )}
                </div>
                <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                  <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page===1}
                    style={{ padding:'4px 12px', borderRadius:5, border:'1px solid var(--border-md)',
                      background: page===1 ? 'var(--bg-page)' : 'var(--bg-card)',
                      color: page===1 ? 'var(--text-tertiary)' : 'var(--text-primary)',
                      fontSize:12, fontWeight:600, cursor: page===1 ? 'default' : 'pointer', fontFamily:'inherit' }}>
                    ‹ Prev
                  </button>
                  <span style={{ fontSize:12, color:'var(--text-secondary)', fontWeight:600 }}>
                    {page} / {pageCount || 1}
                  </span>
                  <button onClick={() => setPage(p => Math.min(pageCount, p+1))} disabled={page>=pageCount}
                    style={{ padding:'4px 12px', borderRadius:5, border:'1px solid var(--border-md)',
                      background: page>=pageCount ? 'var(--bg-page)' : 'var(--bg-card)',
                      color: page>=pageCount ? 'var(--text-tertiary)' : 'var(--text-primary)',
                      fontSize:12, fontWeight:600, cursor: page>=pageCount ? 'default' : 'pointer', fontFamily:'inherit' }}>
                    Next ›
                  </button>
                </div>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

const td = {
  padding:'10px 12px',
  borderBottom:'1px solid var(--border)',
  verticalAlign:'middle',
};

// ─── Job Detail ───────────────────────────────────────────────────────────────
export function JobDetail() {
  const { jobId } = useParams();
  const nav = useNavigate();
  const [job, setJob]       = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError]   = React.useState(null);

  React.useEffect(() => {
    setLoading(true);
    fetchJob(jobId)
      .then(data => { setJob(data); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [jobId]);

  const TRACE = [
    'API Gateway → SQS',
    'SQS → Lambda (process-messages)',
    'DynamoDB write (PENDING)',
    'DynamoDB stream → Lambda (process-jobs)',
    'Step Function start',
    'Cross-account role assumption',
    'SSM execution dispatch',
    'SSM polling / status check',
    'DynamoDB update (final status)',
  ];

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>
      <Topbar title="Job Detail"
        actions={<Btn variant="ghost" size="sm" onClick={() => nav('/jobs')}>← Back to jobs</Btn>}
      />
      <div style={{ flex:1, overflowY:'auto', padding:24 }}>
        {loading && <div style={{ display:'flex', justifyContent:'center', padding:48 }}><Spinner/></div>}
        {error && <ErrorBanner message={error}/>}
        {job && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 300px', gap:20 }}>
            {/* Left */}
            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              <Card>
                <CardHead>
                  <span style={{ fontWeight:600 }}>Job metadata</span>
                  <StatusBadge status={job.status}/>
                </CardHead>
                <div style={{ padding:'16px 18px' }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                    {[
                      ['Job ID',          <MonoField value={job.job_id}/>],
                      ['Notification ID', job.notification_id || '—'],
                      ['Status',          <StatusBadge status={job.status}/>],
                      ['Automation type', <TypeTag type={job.automation_type}/>],
                      ['Document',        job.automation_data?.DocumentName || '—'],
                      ['Target account',  <MonoField value={job.account_id}/>],
                      ['Region',          job.region],
                      ['Resource ID',     <MonoField value={job.resource_id}/>],
                      ['Execution ID',    job.execution_id ? <MonoField value={job.execution_id}/> : <span style={{ color:'var(--text-tertiary)' }}>—</span>],
                      ['Created',         fmtDateTime(job.created_at)],
                      ['Updated',         fmtDateTime(job.updated_at)],
                      ['Duration',        fmtDuration(job.created_at, job.updated_at)],
                    ].map(([k, v]) => (
                      <tr key={k}>
                        <td style={{ padding:'7px 0', color:'var(--text-secondary)', borderBottom:'1px solid var(--border)', width:130, verticalAlign:'middle' }}>{k}</td>
                        <td style={{ padding:'7px 0 7px 16px', borderBottom:'1px solid var(--border)', verticalAlign:'middle' }}>{v}</td>
                      </tr>
                    ))}
                  </table>
                </div>
              </Card>

              <Card>
                <CardHead><span style={{ fontWeight:600 }}>Automation payload</span></CardHead>
                <div style={{ padding:'14px 18px' }}>
                  <pre style={{
                    fontFamily:'var(--font-mono)', fontSize:12,
                    color:'var(--text-primary)', background:'var(--bg-surface)',
                    padding:14, borderRadius:'var(--radius-md)',
                    border:'1px solid var(--border)', overflow:'auto', margin:0,
                  }}>
                    {JSON.stringify(job.automation_data, null, 2)}
                  </pre>
                </div>
              </Card>
            </div>

            {/* Right — trace */}
            <div>
              <Card>
                <CardHead><span style={{ fontWeight:600 }}>Execution trace</span></CardHead>
                <div style={{ padding:'8px 14px' }}>
                  {TRACE.map((step, i) => {
                    const isLast    = i === TRACE.length - 1;
                    const done      = job.status === 'COMPLETED' || (job.status === 'FAILED' && i < TRACE.length - 2);
                    const isCurrent = job.status === 'RUNNING' && i === 6;
                    const isFailed  = job.status === 'FAILED' && i === TRACE.length - 2;
                    const color     = isFailed ? 'var(--red)' : isCurrent ? 'var(--blue)' : done ? 'var(--green)' : 'var(--text-tertiary)';
                    return (
                      <div key={i} style={{ display:'flex', gap:10, paddingBottom: isLast ? 8 : 0 }}>
                        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', paddingTop:10 }}>
                          <div style={{ width:8, height:8, borderRadius:'50%', background:color, flexShrink:0 }}/>
                          {!isLast && <div style={{ width:1, flex:1, background:'var(--border)', margin:'3px 0' }}/>}
                        </div>
                        <div style={{ padding:'8px 0', flex:1, borderBottom: isLast ? 'none' : '1px solid var(--border)' }}>
                          <div style={{ fontSize:12, color: done || isCurrent || isFailed ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
                            {step}
                          </div>
                          <div style={{ fontSize:10, color, marginTop:2 }}>
                            {isFailed ? 'Failed' : isCurrent ? 'In progress…' : done ? 'Complete' : 'Pending'}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}