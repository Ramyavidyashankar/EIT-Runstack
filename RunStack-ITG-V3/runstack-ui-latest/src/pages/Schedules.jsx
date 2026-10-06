import React, { useState, useEffect } from 'react';
import { Topbar } from '../components/Layout';
import { Card, CardHead, Spinner, ErrorBanner, Empty, Btn, TypeTag } from '../components/ui';
import { useAuth } from '../auth/AuthContext';
import { fetchSchedules, createSchedule, updateSchedule, deleteSchedule, fetchDlqMessages } from '../api/client';
import { usePageRefresh } from '../hooks/usePageRefresh';
import { fmtClock } from '../components/sections';
import { setDlqStatus } from '../utils/dlqStatus';

// ─── Shared styles ────────────────────────────────────────────────────────────
const td = { fontSize: 14, padding:'10px 14px', borderBottom:'1px solid var(--border)', verticalAlign:'middle' };

const selectStyle = {
  padding:'6px 12px', borderRadius:'var(--radius-md)',
  border:'1px solid var(--border-md)', background:'var(--bg-card)',
  color:'var(--text-primary)', fontSize:14, fontFamily:'inherit',
};

const inputStyle = {
  width:'100%', padding:'8px 12px', borderRadius:'var(--radius-md)',
  border:'1px solid var(--border-md)', background:'var(--bg-card)',
  color:'var(--text-primary)', fontSize:14, fontFamily:'inherit',
  boxSizing:'border-box',
};

// ─── Modal ────────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children, width = 560 }) {
  return (
    <div style={{
      position:'fixed', inset:0, zIndex:1000,
      background:'rgba(0,0,0,0.55)', display:'flex',
      alignItems:'center', justifyContent:'center', padding:24,
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background:'var(--bg-card)', borderRadius:'var(--radius-lg)',
        border:'1px solid var(--border)', width:'100%', maxWidth:width,
        maxHeight:'85vh', display:'flex', flexDirection:'column',
        boxShadow:'0 24px 60px rgba(0,0,0,0.4)',
      }}>
        <div style={{
          display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'16px 20px', borderBottom:'1px solid var(--border)',
        }}>
          <span style={{ fontWeight:600, fontSize:14 }}>{title}</span>
          <button onClick={onClose} style={{
            background:'none', border:'none', cursor:'pointer',
            color:'var(--text-tertiary)', fontSize:18, lineHeight:1, padding:4,
          }}>✕</button>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'20px' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── Cron Builder ─────────────────────────────────────────────────────────────
function CronBuilder({ value, onChange }) {
  // Parse existing cron expression
  function parseCron(expr) {
    if (!expr) return { minutes:'0', hours:'1', dayOfMonth:'*', month:'*', dayOfWeek:'?', year:'*' };
    const m = expr.match(/cron\(([^)]+)\)/);
    if (m) {
      const parts = m[1].split(' ');
      return {
        minutes: parts[0]||'0', hours: parts[1]||'1',
        dayOfMonth: parts[2]||'*', month: parts[3]||'*',
        dayOfWeek: parts[4]||'?', year: parts[5]||'*',
      };
    }
    return { minutes:'0', hours:'1', dayOfMonth:'*', month:'*', dayOfWeek:'?', year:'*' };
  }

  const [mode, setMode] = React.useState(value?.startsWith('rate(') ? 'rate' : 'cron');
  const [cron, setCron] = React.useState(parseCron(value));
  const [rate, setRate] = React.useState(() => {
    const m = value?.match(/rate\((\d+)\s+(\w+)\)/);
    return m ? { value: m[1], unit: m[2].replace(/s$/, '') } : { value:'1', unit:'hour' };
  });

  function updateCron(key, val) {
    const next = { ...cron, [key]: val };
    setCron(next);
    onChange(`cron(${next.minutes} ${next.hours} ${next.dayOfMonth} ${next.month} ${next.dayOfWeek} ${next.year})`);
  }

  function updateRate(key, val) {
    const next = { ...rate, [key]: val };
    setRate(next);
    const n = parseInt(next.value) || 1;
    const unit = n === 1 ? next.unit : next.unit + 's';
    onChange(`rate(${n} ${unit})`);
  }

  const fieldStyle = {
    ...inputStyle, width:'100%', textAlign:'center', padding:'8px 6px',
  };
  const labelStyle = {
    fontSize:12, color:'var(--text-tertiary)', fontWeight:600, textAlign:'center',
    display:'block', marginTop:4,
  };

  return (
    <div style={{ background:'var(--bg-page)', border:'1px solid var(--border)', borderRadius:'var(--radius-md)', padding:16 }}>
      {/* Mode selector */}
      <div style={{ display:'flex', gap:10, marginBottom:16 }}>
        {[['cron','Specific time (cron)'],['rate','Regular rate']].map(([m, label]) => (
          <label key={m} style={{
            flex:1, display:'flex', alignItems:'center', gap:8, cursor:'pointer',
            padding:'10px 14px', borderRadius:'var(--radius-md)',
            border:`1px solid ${mode===m ? 'var(--accent)' : 'var(--border)'}`,
            background: mode===m ? 'var(--accent-bg)' : 'var(--bg-card)',
            fontSize:14,
          }}>
            <input type="radio" checked={mode===m} onChange={() => {
              setMode(m);
              if (m==='cron') onChange(`cron(${cron.minutes} ${cron.hours} ${cron.dayOfMonth} ${cron.month} ${cron.dayOfWeek} ${cron.year})`);
              else { const n=parseInt(rate.value)||1; onChange(`rate(${n} ${n===1?rate.unit:rate.unit+'s'})`); }
            }} style={{ accentColor:'var(--accent)' }}/>
            {label}
          </label>
        ))}
      </div>

      {mode === 'cron' ? (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:8, marginBottom:8 }}>
            {[
              ['Minutes', 'minutes', '27'],
              ['Hours', 'hours', '7'],
              ['Day of month', 'dayOfMonth', '*'],
              ['Month', 'month', '*'],
              ['Day of week', 'dayOfWeek', '?'],
              ['Year', 'year', '*'],
            ].map(([label, key, ph]) => (
              <div key={key}>
                <input style={fieldStyle} value={cron[key]} onChange={e => updateCron(key, e.target.value)} placeholder={ph}/>
                <span style={labelStyle}>{label}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize:12, color:'var(--text-tertiary)', marginTop:8 }}>
            Result: <code style={{ fontFamily:'var(--font-mono)', color:'var(--text-secondary)' }}>
              cron({cron.minutes} {cron.hours} {cron.dayOfMonth} {cron.month} {cron.dayOfWeek} {cron.year})
            </code>
          </div>
          <div style={{ fontSize:12, color:'var(--text-tertiary)', marginTop:4 }}>
            Use <code style={{ fontFamily:'var(--font-mono)' }}>*</code> for any · <code style={{ fontFamily:'var(--font-mono)' }}>?</code> for no value · <code style={{ fontFamily:'var(--font-mono)' }}>1,6,15</code> for multiple
          </div>
        </>
      ) : (
        <div style={{ display:'flex', gap:10, alignItems:'flex-end' }}>
          <div style={{ flex:1 }}>
            <label style={{ fontSize:13, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>Every</label>
            <input style={inputStyle} type="number" min="1" value={rate.value} onChange={e => updateRate('value', e.target.value)} placeholder="1"/>
          </div>
          <div style={{ flex:2 }}>
            <label style={{ fontSize:13, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>Unit</label>
            <select style={{ ...selectStyle, width:'100%' }} value={rate.unit} onChange={e => updateRate('unit', e.target.value)}>
              <option value="minute">Minute(s)</option>
              <option value="hour">Hour(s)</option>
              <option value="day">Day(s)</option>
            </select>
          </div>
          <div style={{ flex:2, paddingBottom:1 }}>
            <div style={{ fontSize:12, color:'var(--text-tertiary)' }}>
              Result: <code style={{ fontFamily:'var(--font-mono)' }}>{`rate(${rate.value||1} ${(parseInt(rate.value)||1)===1?rate.unit:rate.unit+'s'})`}</code>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Schedule Form ────────────────────────────────────────────────────────────
function ScheduleForm({ initial = {}, lambdaFunctions = [], onSave, onCancel, saving }) {
  const [form, setForm] = useState({
    name: initial.name || '',
    schedule_expression: initial.schedule_expression || 'cron(0 1 * * ? *)',
    description: initial.description || '',
    state: initial.state || 'ENABLED',
    target_arn: initial.targets?.[0]?.arn || '',
    target_input: initial.targets?.[0]?.input
      ? (typeof initial.targets[0].input === 'string'
          ? initial.targets[0].input
          : JSON.stringify(initial.targets[0].input, null, 2))
      : '',
  });
  const [inputError, setInputError] = useState(null);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  function validateAndSave() {
    if (form.target_input.trim()) {
      try { JSON.parse(form.target_input); }
      catch (e) { setInputError('Target input must be valid JSON'); return; }
    }
    setInputError(null);
    onSave(form);
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

      {/* Rule Name */}
      <div>
        <label style={{ fontSize:13, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>
          Rule Name {!initial.name && <span style={{ color:'var(--red)' }}>*</span>}
        </label>
        <input
          style={{ ...inputStyle, ...(initial.name ? { background:'var(--bg-page)', color:'var(--text-tertiary)' } : {}) }}
          value={form.name} onChange={e => set('name', e.target.value)}
          disabled={!!initial.name} placeholder="e.g. runstack-sql-cleanup"
        />
        {initial.name && <div style={{ fontSize:12, color:'var(--text-tertiary)', marginTop:4 }}>Rule name cannot be changed after creation.</div>}
      </div>

      {/* Schedule Expression — cron builder */}
      <div>
        <label style={{ fontSize:13, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>
          Schedule <span style={{ color:'var(--red)' }}>*</span>
        </label>
        <CronBuilder value={form.schedule_expression} onChange={v => set('schedule_expression', v)}/>
      </div>

      {/* Description */}
      <div>
        <label style={{ fontSize:13, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>Description</label>
        <input style={inputStyle} value={form.description} onChange={e => set('description', e.target.value)} placeholder="Optional description"/>
      </div>

      {/* State */}
      <div>
        <label style={{ fontSize:13, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>State</label>
        <select style={{ ...selectStyle, width:'100%' }} value={form.state} onChange={e => set('state', e.target.value)}>
          <option value="ENABLED">Enabled</option>
          <option value="DISABLED">Disabled</option>
        </select>
      </div>

      {/* Target section */}
      <div style={{ borderTop:'1px solid var(--border)', paddingTop:16 }}>
        <div style={{ fontSize:13, fontWeight:600, color:'var(--text-secondary)', marginBottom:12 }}>Target — Lambda function</div>

        {/* Lambda dropdown */}
        <div style={{ marginBottom:12 }}>
          <label style={{ fontSize:13, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>
            Function
          </label>
          <select
            style={{ ...selectStyle, width:'100%' }}
            value={form.target_arn}
            onChange={e => set('target_arn', e.target.value)}
          >
            <option value="">— Select Lambda function —</option>
            {lambdaFunctions.map(fn => (
              <option key={fn.arn} value={fn.arn}>{fn.name}</option>
            ))}
            <option value="__custom__">Enter ARN manually…</option>
          </select>
        </div>

        {/* Manual ARN input if custom selected */}
        {form.target_arn === '__custom__' && (
          <div style={{ marginBottom:12 }}>
            <label style={{ fontSize:13, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>Lambda ARN</label>
            <input style={inputStyle} placeholder="arn:aws:lambda:us-east-1:246314649749:function:my-function"
              onChange={e => set('target_arn', e.target.value)}/>
          </div>
        )}

        {/* Target input JSON */}
        <div>
          <label style={{ fontSize:13, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>
            Input — Constant JSON
          </label>
          <textarea
            style={{ ...inputStyle, height:180, resize:'vertical', fontFamily:'var(--font-mono)', fontSize:13 }}
            value={form.target_input}
            onChange={e => { set('target_input', e.target.value); setInputError(null); }}
            placeholder={`{\n  "id": "my-schedule-notification",\n  "region": "us-east-1",\n  "account_id": "246314649749",\n  "automation_type": "SSM-Automation",\n  "automation_data": {\n    "DocumentName": "My-Document",\n    "Parameters": {}\n  }\n}`}
            spellCheck={false}
          />
          {inputError && <div style={{ fontSize:12, color:'var(--red)', marginTop:4 }}>{inputError}</div>}
          <div style={{ fontSize:12, color:'var(--text-tertiary)', marginTop:4 }}>
            Constant JSON passed to the Lambda — same payload format as POST /notify.
          </div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display:'flex', gap:10, justifyContent:'flex-end', marginTop:8 }}>
        <Btn variant="default" size="sm" onClick={onCancel} disabled={saving}>Cancel</Btn>
        <Btn variant="primary" size="sm" onClick={validateAndSave} disabled={saving || !form.name || !form.schedule_expression}>
          {saving ? 'Saving…' : (initial.name ? 'Save changes' : 'Create rule')}
        </Btn>
      </div>
    </div>
  );
}

// ─── Schedules Page ───────────────────────────────────────────────────────────
export default function Schedules() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [lambdaFunctions, setLambdaFunctions] = useState([]);

  async function loadLambdas() {
    try {
      // Fetch Lambda functions via existing API — uses aws-sdk from process_messages
      // Fallback to known runstack lambdas if endpoint not available
      setLambdaFunctions([
        { name: 'runstack-job-scheduler',    arn: `arn:aws:lambda:us-east-1:246314649749:function:runstack-job-scheduler` },
        { name: 'runstack-process-messages', arn: `arn:aws:lambda:us-east-1:246314649749:function:runstack-process-messages` },
        { name: 'runstack-process-jobs',     arn: `arn:aws:lambda:us-east-1:246314649749:function:runstack-process-jobs` },
      ]);
    } catch (e) {
      console.warn('Could not load Lambda list:', e.message);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSchedules({ prefix: '' });
      setSchedules(data.schedules || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); loadLambdas(); }, []);

  async function handleCreate(form) {
    setSaving(true);
    setActionError(null);
    try {
      await createSchedule(form);
      setModal(null);
      await load();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(form) {
    setSaving(true);
    setActionError(null);
    try {
      await updateSchedule(form.name, {
        schedule_expression: form.schedule_expression,
        description: form.description,
        state: form.state,
      });
      setModal(null);
      await load();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(name) {
    setSaving(true);
    setActionError(null);
    try {
      await deleteSchedule(name);
      setModal(null);
      await load();
    } catch (e) {
      setActionError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rs-page">
      <Topbar title="Schedules" subtitle="EventBridge rules"
        actions={
          <div style={{ display:'flex', gap:8 }}>
            <Btn variant="default" size="sm" onClick={load}>↺ Refresh</Btn>
            {isAdmin && <Btn variant="primary" size="sm" onClick={() => { setActionError(null); setModal('create'); }}>+ New rule</Btn>}
          </div>
        }
      />
      <div className="rs-page-body">
        {error && <ErrorBanner message={error}/>}
        <Card>
          {loading ? (
            <div style={{ padding:40, display:'flex', justifyContent:'center' }}><Spinner/></div>
          ) : schedules.length === 0 ? (
            <Empty message="No EventBridge rules found."/>
          ) : (
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:14 }}>
              <thead>
                <tr>
                  {['Name','Schedule','State','Targets','Description', ...(isAdmin ? ['Actions'] : [])].map(h => (
                    <th key={h} style={{
                      textAlign:'left', padding:'9px 14px',
                      fontSize:12, fontWeight:600, color:'var(--text-tertiary)',
                      borderBottom:'1px solid var(--border)'
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {schedules.map((s, i) => (
                  <tr key={i}
                    onMouseEnter={e => e.currentTarget.style.background='var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background=''}>
                    <td style={td}><span style={{ fontWeight:500 }}>{s.name}</span></td>
                    <td style={td}>
                      <code style={{ fontSize:12, background:'var(--bg-page)', padding:'2px 7px',
                        borderRadius:4, border:'1px solid var(--border)' }}>
                        {s.schedule_expression || s.event_pattern || '—'}
                      </code>
                    </td>
                    <td style={td}>
                      <span style={{
                        padding:'3px 9px', borderRadius:10, fontSize:12, fontWeight:600,
                        background: s.state === 'ENABLED' ? 'var(--green-bg)' : 'var(--amber-bg)',
                        color: s.state === 'ENABLED' ? 'var(--green)' : 'var(--amber)',
                      }}>{s.state}</span>
                    </td>
                    <td style={td}>
                      <span style={{ fontSize:12, color:'var(--text-secondary)' }}>
                        {s.targets?.length || 0} target{s.targets?.length !== 1 ? 's' : ''}
                      </span>
                    </td>
                    <td style={td}>
                      <span style={{ fontSize:12, color:'var(--text-tertiary)' }}>{s.description || '—'}</span>
                    </td>
                    {isAdmin && (
                      <td style={td}>
                        <div style={{ display:'flex', gap:6 }}>
                          <Btn variant="default" size="sm" onClick={() => { setActionError(null); setModal({ edit: s }); }}>Edit</Btn>
                          <Btn variant="danger" size="sm" onClick={() => { setActionError(null); setModal({ delete: s }); }}>Delete</Btn>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {modal === 'create' && (
        <Modal title="Create EventBridge rule" onClose={() => setModal(null)} width={640}>
          {actionError && <div style={{ marginBottom:12, padding:'8px 12px', borderRadius:'var(--radius-md)', background:'var(--red-bg)', color:'var(--red)', fontSize:13 }}>{actionError}</div>}
          <ScheduleForm lambdaFunctions={lambdaFunctions} onSave={handleCreate} onCancel={() => setModal(null)} saving={saving}/>
        </Modal>
      )}

      {modal?.edit && (
        <Modal title={`Edit rule — ${modal.edit.name}`} onClose={() => setModal(null)} width={640}>
          {actionError && <div style={{ marginBottom:12, padding:'8px 12px', borderRadius:'var(--radius-md)', background:'var(--red-bg)', color:'var(--red)', fontSize:13 }}>{actionError}</div>}
          <ScheduleForm initial={modal.edit} lambdaFunctions={lambdaFunctions} onSave={handleEdit} onCancel={() => setModal(null)} saving={saving}/>
        </Modal>
      )}

      {/* Delete confirmation modal */}
      {modal?.delete && (
        <Modal title="Delete rule" onClose={() => setModal(null)} width={420}>
          <div style={{ fontSize:14, color:'var(--text-secondary)', marginBottom:20 }}>
            Are you sure you want to delete <strong style={{ color:'var(--text-primary)' }}>{modal.delete.name}</strong>?
            This will remove all targets and cannot be undone.
          </div>
          {actionError && <div style={{ marginBottom:12, padding:'8px 12px', borderRadius:'var(--radius-md)', background:'var(--red-bg)', color:'var(--red)', fontSize:13 }}>{actionError}</div>}
          <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
            <Btn variant="default" size="sm" onClick={() => setModal(null)} disabled={saving}>Cancel</Btn>
            <Btn variant="danger" size="sm" onClick={() => handleDelete(modal.delete.name)} disabled={saving}>
              {saving ? 'Deleting…' : 'Delete rule'}
            </Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}


// ─── DLQ Page ─────────────────────────────────────────────────────────────────
// ─── Dead Letter Queue ────────────────────────────────────────────────────────
// Real data from GET /jobs/dlq (operator+). This page previously showed three
// hard-coded sample messages with Purge / Reprocess / Delete buttons that did
// nothing; those are gone. The backend reads with SQS receive_message and a
// 30-second visibility timeout, so:
//   • the page loads once when opened and on Refresh — it never polls;
//   • Refresh is held for 30 s after a read, because the messages just read
//     are hidden from every reader (including this page) until then;
//   • the count is reported to the header and Dashboard (utils/dlqStatus.js).
const DLQ_HOLD_SECONDS = 30;

function fmtEpochMs(v) {
  const n = Number(v);
  if (!n) return '—';
  return new Date(n).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function DLQ() {
  const [state, setState] = useState({ loading: true, error: null, data: null, readAt: null });
  const [now, setNow] = useState(Date.now());

  const load = React.useCallback(() => {
    setState((st) => ({ ...st, loading: true, error: null }));
    fetchDlqMessages()
      .then((data) => {
        const visible = Number(data.total_visible || 0);
        const inFlight = Number(data.total_in_flight || 0);
        // Messages this read just received are counted as in flight.
        setDlqStatus({ visible: visible + inFlight, inFlight });
        setState({ loading: false, error: null, data, readAt: Date.now() });
      })
      .catch((e) => setState((st) => ({ ...st, loading: false, error: e?.body?.error || e?.body?.message || e.message || String(e) })));
  }, []);
  useEffect(() => { load(); }, [load]);
  usePageRefresh(() => { if (!state.readAt || Date.now() - state.readAt >= DLQ_HOLD_SECONDS * 1000) load(); });

  const holdLeft = state.readAt ? Math.max(0, DLQ_HOLD_SECONDS - Math.floor((now - state.readAt) / 1000)) : 0;
  useEffect(() => {
    if (!holdLeft) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [holdLeft]);

  const d = state.data;
  const messages = d?.messages || [];
  const total = d ? Number(d.total_visible || 0) + Number(d.total_in_flight || 0) : null;

  return (
    <div className="rs-page">
      <Topbar title="Dead Letter Queue"
        subtitle="Messages RunStack could not process after retries — read-only view"
        actions={(
          <Btn variant="default" size="sm" onClick={load} disabled={state.loading || holdLeft > 0}>
            {state.loading ? <Spinner size={13} /> : '↻'} {holdLeft > 0 ? `Refresh in ${holdLeft}s` : 'Refresh'}
          </Btn>
        )}
      />
      <div className="rs-page-body">
        <div className="rs-page-content">
          {state.error && <ErrorBanner message={`Could not read the dead letter queue: ${state.error}`} />}
          {state.loading && !d && <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>}
          {d && (
            <div role="status" style={{
              padding: '10px 16px', borderRadius: 'var(--radius-md)', fontSize: 14,
              background: total ? 'var(--red-bg)' : 'var(--success-bg)', border: `1px solid ${total ? 'var(--red-border)' : 'var(--success-border)'}`,
              color: total ? '#9A1E1E' : '#0B6E4C',
            }}>
              {total
                ? <>About <strong>{total}</strong> message{total === 1 ? '' : 's'} in the queue (SQS approximate count). Showing up to 10. Investigate the cause in the related execution before anything is resubmitted.</>
                : 'The dead letter queue is empty.'}
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                Read at {fmtClock(new Date(state.readAt))}. Messages shown here stay hidden from other readers for {DLQ_HOLD_SECONDS} seconds after each read.
              </div>
            </div>
          )}
          {d && !messages.length && total > 0 && (
            <Empty message="No messages were returned on this read — they may be held by another reader for up to 30 seconds. Try Refresh shortly." />
          )}
          {messages.map((m) => (
            <Card key={m.id}>
              <CardHead>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
                  <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: '#9A1E1E', overflowWrap: 'anywhere' }}>{m.id}</code>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Sent {fmtEpochMs(m.sent_at)} · received {m.receive_count}×</span>
                </div>
              </CardHead>
              <div style={{ padding: '14px 18px' }}>
                <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600, marginBottom: 5 }}>Message body</div>
                <pre style={{
                  fontFamily: 'var(--font-mono)', fontSize: 12, background: 'var(--bg-tint)', padding: 12,
                  borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', overflow: 'auto', margin: 0,
                  color: 'var(--slate-700)', maxHeight: 360,
                }}>
                  {typeof m.body === 'string' ? m.body : JSON.stringify(m.body, null, 2)}
                </pre>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}


// ─── Settings Page ────────────────────────────────────────────────────────────
export function Settings() {
  const fields = [
    ['API Gateway URL',      process.env.REACT_APP_API_BASE_URL || '(not set — check .env)'],
    ['Cognito token URL',    process.env.REACT_APP_COGNITO_TOKEN_URL || '(not set)'],
    ['Cognito client ID',    process.env.REACT_APP_COGNITO_CLIENT_ID || '(not set)'],
    ['OAuth scope',          process.env.REACT_APP_COGNITO_SCOPE || '(not set)'],
    ['Solution name',        process.env.REACT_APP_SOLUTION_NAME || 'runstack'],
    ['Environment badge',    process.env.REACT_APP_RUNSTACK_ENV || 'ITG (default)'],
  ];
  return (
    <div className="rs-page">
      <Topbar title="Settings" subtitle="Runtime configuration (set via .env file)"/>
      <div className="rs-page-body">
        <Card style={{ maxWidth:600 }}>
          <CardHead><span style={{ fontWeight:600, fontSize:'var(--fs-section-title)' }}>Environment configuration</span></CardHead>
          <div style={{ padding:'16px 18px' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:14 }}>
              {fields.map(([k, v]) => (
                <tr key={k}>
                  <td style={{ padding:'9px 0', color:'var(--text-secondary)', borderBottom:'1px solid var(--border)', width:180 }}>{k}</td>
                  <td style={{ padding:'9px 0 9px 16px', borderBottom:'1px solid var(--border)' }}>
                    <code style={{ fontFamily:'var(--font-mono)', fontSize:12,
                      color: v.includes('not set') ? 'var(--red)' : 'var(--text-mono)' }}>
                      {v}
                    </code>
                  </td>
                </tr>
              ))}
            </table>
            <div style={{ marginTop:16, fontSize:13, color:'var(--text-tertiary)', lineHeight:1.7 }}>
              Edit <code style={{ fontFamily:'var(--font-mono)', fontSize:12 }}>.env</code> in the project root and rebuild
              (<code style={{ fontFamily:'var(--font-mono)', fontSize:12 }}>npm run build</code>) for changes to take effect.
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}


// Target Accounts page removed — replaced by pages/RegisteredTargets.jsx,
// which reads runstack-instance-catalog instead of hardcoded sample accounts.


// SSM Documents page moved to pages/SSMDocuments.jsx.
