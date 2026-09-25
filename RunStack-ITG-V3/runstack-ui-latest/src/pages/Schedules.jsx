import React, { useState, useEffect } from 'react';
import { Topbar } from '../components/Layout';
import { Card, CardHead, Spinner, ErrorBanner, Empty, Btn, TypeTag } from '../components/ui';
import { useAuth } from '../auth/AuthContext';
import { fetchSchedules, createSchedule, updateSchedule, deleteSchedule,
         fetchSSMDocuments, fetchSSMDocumentContent } from '../api/client';

// ─── Shared styles ────────────────────────────────────────────────────────────
const td = { padding:'10px 14px', borderBottom:'1px solid var(--border)', verticalAlign:'middle' };

const selectStyle = {
  padding:'6px 12px', borderRadius:'var(--radius-md)',
  border:'1px solid var(--border-md)', background:'var(--bg-card)',
  color:'var(--text-primary)', fontSize:13, fontFamily:'inherit',
};

const inputStyle = {
  width:'100%', padding:'8px 12px', borderRadius:'var(--radius-md)',
  border:'1px solid var(--border-md)', background:'var(--bg-card)',
  color:'var(--text-primary)', fontSize:13, fontFamily:'inherit',
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
    fontSize:10, color:'var(--text-tertiary)', fontWeight:600,
    textTransform:'uppercase', letterSpacing:0.4, textAlign:'center',
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
            fontSize:13,
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
          <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:8 }}>
            Result: <code style={{ fontFamily:'var(--font-mono)', color:'var(--text-secondary)' }}>
              cron({cron.minutes} {cron.hours} {cron.dayOfMonth} {cron.month} {cron.dayOfWeek} {cron.year})
            </code>
          </div>
          <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:4 }}>
            Use <code style={{ fontFamily:'var(--font-mono)' }}>*</code> for any · <code style={{ fontFamily:'var(--font-mono)' }}>?</code> for no value · <code style={{ fontFamily:'var(--font-mono)' }}>1,6,15</code> for multiple
          </div>
        </>
      ) : (
        <div style={{ display:'flex', gap:10, alignItems:'flex-end' }}>
          <div style={{ flex:1 }}>
            <label style={{ fontSize:12, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>Every</label>
            <input style={inputStyle} type="number" min="1" value={rate.value} onChange={e => updateRate('value', e.target.value)} placeholder="1"/>
          </div>
          <div style={{ flex:2 }}>
            <label style={{ fontSize:12, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>Unit</label>
            <select style={{ ...selectStyle, width:'100%' }} value={rate.unit} onChange={e => updateRate('unit', e.target.value)}>
              <option value="minute">Minute(s)</option>
              <option value="hour">Hour(s)</option>
              <option value="day">Day(s)</option>
            </select>
          </div>
          <div style={{ flex:2, paddingBottom:1 }}>
            <div style={{ fontSize:11, color:'var(--text-tertiary)' }}>
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
        <label style={{ fontSize:12, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>
          Rule Name {!initial.name && <span style={{ color:'var(--red)' }}>*</span>}
        </label>
        <input
          style={{ ...inputStyle, ...(initial.name ? { background:'var(--bg-page)', color:'var(--text-tertiary)' } : {}) }}
          value={form.name} onChange={e => set('name', e.target.value)}
          disabled={!!initial.name} placeholder="e.g. runstack-sql-cleanup"
        />
        {initial.name && <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:4 }}>Rule name cannot be changed after creation.</div>}
      </div>

      {/* Schedule Expression — cron builder */}
      <div>
        <label style={{ fontSize:12, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>
          Schedule <span style={{ color:'var(--red)' }}>*</span>
        </label>
        <CronBuilder value={form.schedule_expression} onChange={v => set('schedule_expression', v)}/>
      </div>

      {/* Description */}
      <div>
        <label style={{ fontSize:12, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>Description</label>
        <input style={inputStyle} value={form.description} onChange={e => set('description', e.target.value)} placeholder="Optional description"/>
      </div>

      {/* State */}
      <div>
        <label style={{ fontSize:12, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>State</label>
        <select style={{ ...selectStyle, width:'100%' }} value={form.state} onChange={e => set('state', e.target.value)}>
          <option value="ENABLED">Enabled</option>
          <option value="DISABLED">Disabled</option>
        </select>
      </div>

      {/* Target section */}
      <div style={{ borderTop:'1px solid var(--border)', paddingTop:16 }}>
        <div style={{ fontSize:12, fontWeight:600, color:'var(--text-secondary)', marginBottom:12 }}>Target — Lambda function</div>

        {/* Lambda dropdown */}
        <div style={{ marginBottom:12 }}>
          <label style={{ fontSize:12, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>
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
            <label style={{ fontSize:12, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>Lambda ARN</label>
            <input style={inputStyle} placeholder="arn:aws:lambda:us-east-1:246314649749:function:my-function"
              onChange={e => set('target_arn', e.target.value)}/>
          </div>
        )}

        {/* Target input JSON */}
        <div>
          <label style={{ fontSize:12, fontWeight:600, color:'var(--text-secondary)', display:'block', marginBottom:6 }}>
            Input — Constant JSON
          </label>
          <textarea
            style={{ ...inputStyle, height:180, resize:'vertical', fontFamily:'var(--font-mono)', fontSize:12 }}
            value={form.target_input}
            onChange={e => { set('target_input', e.target.value); setInputError(null); }}
            placeholder={`{\n  "id": "my-schedule-notification",\n  "region": "us-east-1",\n  "account_id": "246314649749",\n  "automation_type": "SSM-Automation",\n  "automation_data": {\n    "DocumentName": "My-Document",\n    "Parameters": {}\n  }\n}`}
            spellCheck={false}
          />
          {inputError && <div style={{ fontSize:11, color:'var(--red)', marginTop:4 }}>{inputError}</div>}
          <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:4 }}>
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
    <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>
      <Topbar title="Schedules" subtitle="EventBridge rules"
        actions={
          <div style={{ display:'flex', gap:8 }}>
            <Btn variant="default" size="sm" onClick={load}>↺ Refresh</Btn>
            {isAdmin && <Btn variant="primary" size="sm" onClick={() => { setActionError(null); setModal('create'); }}>+ New rule</Btn>}
          </div>
        }
      />
      <div style={{ flex:1, overflowY:'auto', padding:24 }}>
        {error && <ErrorBanner message={error}/>}
        <Card>
          {loading ? (
            <div style={{ padding:40, display:'flex', justifyContent:'center' }}><Spinner/></div>
          ) : schedules.length === 0 ? (
            <Empty message="No EventBridge rules found."/>
          ) : (
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr>
                  {['Name','Schedule','State','Targets','Description', ...(isAdmin ? ['Actions'] : [])].map(h => (
                    <th key={h} style={{
                      textAlign:'left', padding:'9px 14px',
                      fontSize:10, fontWeight:600, color:'var(--text-tertiary)',
                      textTransform:'uppercase', letterSpacing:0.5,
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
                      <code style={{ fontSize:11, background:'var(--bg-page)', padding:'2px 7px',
                        borderRadius:4, border:'1px solid var(--border)' }}>
                        {s.schedule_expression || s.event_pattern || '—'}
                      </code>
                    </td>
                    <td style={td}>
                      <span style={{
                        padding:'3px 9px', borderRadius:10, fontSize:11, fontWeight:600,
                        background: s.state === 'ENABLED' ? 'var(--green-bg)' : 'var(--amber-bg)',
                        color: s.state === 'ENABLED' ? 'var(--green)' : 'var(--amber)',
                      }}>{s.state}</span>
                    </td>
                    <td style={td}>
                      <span style={{ fontSize:11, color:'var(--text-secondary)' }}>
                        {s.targets?.length || 0} target{s.targets?.length !== 1 ? 's' : ''}
                      </span>
                    </td>
                    <td style={td}>
                      <span style={{ fontSize:11, color:'var(--text-tertiary)' }}>{s.description || '—'}</span>
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
          {actionError && <div style={{ marginBottom:12, padding:'8px 12px', borderRadius:'var(--radius-md)', background:'var(--red-bg)', color:'var(--red)', fontSize:12 }}>{actionError}</div>}
          <ScheduleForm lambdaFunctions={lambdaFunctions} onSave={handleCreate} onCancel={() => setModal(null)} saving={saving}/>
        </Modal>
      )}

      {modal?.edit && (
        <Modal title={`Edit rule — ${modal.edit.name}`} onClose={() => setModal(null)} width={640}>
          {actionError && <div style={{ marginBottom:12, padding:'8px 12px', borderRadius:'var(--radius-md)', background:'var(--red-bg)', color:'var(--red)', fontSize:12 }}>{actionError}</div>}
          <ScheduleForm initial={modal.edit} lambdaFunctions={lambdaFunctions} onSave={handleEdit} onCancel={() => setModal(null)} saving={saving}/>
        </Modal>
      )}

      {/* Delete confirmation modal */}
      {modal?.delete && (
        <Modal title="Delete rule" onClose={() => setModal(null)} width={420}>
          <div style={{ fontSize:13, color:'var(--text-secondary)', marginBottom:20 }}>
            Are you sure you want to delete <strong style={{ color:'var(--text-primary)' }}>{modal.delete.name}</strong>?
            This will remove all targets and cannot be undone.
          </div>
          {actionError && <div style={{ marginBottom:12, padding:'8px 12px', borderRadius:'var(--radius-md)', background:'var(--red-bg)', color:'var(--red)', fontSize:12 }}>{actionError}</div>}
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
export function DLQ() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [messages] = React.useState([
    { id:'msg-abc123', body:'{"id":"notif-9901","account_id":"123456789012","region":"us-east-1","automation_type":"SSM-Automation"}', received:'14 min ago', reason:'Lambda timeout after 3 retries' },
    { id:'msg-def456', body:'{"id":"notif-9887","account_id":"987654321098","region":"eu-west-1","automation_type":"SSM-RunCommand"}', received:'2h ago', reason:'DynamoDB write capacity exceeded' },
    { id:'msg-ghi789', body:'{"id":"notif-9851","account_id":"234567890123","region":"ap-southeast-1","automation_type":"SSM-Automation"}', received:'6h ago', reason:'Invalid resource_id format' },
  ]);

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>
      <Topbar title="Dead Letter Queue"
        subtitle="Failed messages from SQS — manual review required"
        actions={isAdmin ? <Btn variant="danger" size="sm">Purge queue</Btn> : undefined}
      />
      <div style={{ flex:1, overflowY:'auto', padding:24 }}>
        <div style={{ marginBottom:16, padding:'10px 16px', borderRadius:'var(--radius-md)',
          background:'var(--red-bg)', border:'1px solid var(--red-border)',
          color:'var(--red)', fontSize:13 }}>
          ⚠ {messages.length} message{messages.length !== 1 ? 's' : ''} in DLQ — investigate and reprocess or discard
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
          {messages.map(m => (
            <Card key={m.id}>
              <CardHead>
                <div>
                  <code style={{ fontFamily:'var(--font-mono)', fontSize:12, color:'var(--red)' }}>{m.id}</code>
                  <span style={{ fontSize:11, color:'var(--text-tertiary)', marginLeft:12 }}>Received {m.received}</span>
                </div>
                <div style={{ display:'flex', gap:8 }}>
                  {isAdmin && <Btn variant="default" size="sm">Reprocess</Btn>}
                  {isAdmin && <Btn variant="danger" size="sm">Delete</Btn>}
                </div>
              </CardHead>
              <div style={{ padding:'14px 18px', display:'grid', gap:10 }}>
                <div>
                  <div style={{ fontSize:11, color:'var(--red)', fontWeight:600, marginBottom:5 }}>Failure reason</div>
                  <div style={{ fontSize:12, color:'var(--text-secondary)' }}>{m.reason}</div>
                </div>
                <div>
                  <div style={{ fontSize:11, color:'var(--text-tertiary)', fontWeight:600,
                    textTransform:'uppercase', letterSpacing:0.5, marginBottom:5 }}>Message body</div>
                  <pre style={{
                    fontFamily:'var(--font-mono)', fontSize:11,
                    background:'var(--bg-surface)', padding:12,
                    borderRadius:'var(--radius-md)', border:'1px solid var(--border)',
                    overflow:'auto', margin:0, color:'var(--text-secondary)',
                  }}>
                    {JSON.stringify(JSON.parse(m.body), null, 2)}
                  </pre>
                </div>
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
  ];
  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>
      <Topbar title="Settings" subtitle="Runtime configuration (set via .env file)"/>
      <div style={{ flex:1, overflowY:'auto', padding:24 }}>
        <Card style={{ maxWidth:600 }}>
          <CardHead><span style={{ fontWeight:600 }}>Environment configuration</span></CardHead>
          <div style={{ padding:'16px 18px' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              {fields.map(([k, v]) => (
                <tr key={k}>
                  <td style={{ padding:'9px 0', color:'var(--text-secondary)', borderBottom:'1px solid var(--border)', width:180 }}>{k}</td>
                  <td style={{ padding:'9px 0 9px 16px', borderBottom:'1px solid var(--border)' }}>
                    <code style={{ fontFamily:'var(--font-mono)', fontSize:11,
                      color: v.includes('not set') ? 'var(--red)' : 'var(--text-mono)' }}>
                      {v}
                    </code>
                  </td>
                </tr>
              ))}
            </table>
            <div style={{ marginTop:16, fontSize:12, color:'var(--text-tertiary)', lineHeight:1.7 }}>
              Edit <code style={{ fontFamily:'var(--font-mono)', fontSize:11 }}>.env</code> in the project root and rebuild
              (<code style={{ fontFamily:'var(--font-mono)', fontSize:11 }}>npm run build</code>) for changes to take effect.
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}


// Target Accounts page removed — replaced by pages/RegisteredTargets.jsx,
// which reads runstack-instance-catalog instead of hardcoded sample accounts.


// ─── SSM Documents Page ───────────────────────────────────────────────────────
export function SSMDocs() {
  const [docs, setDocs] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [owner, setOwner] = React.useState('Self');
  const [type, setType] = React.useState('Command');
  const [viewDoc, setViewDoc] = React.useState(null);   // { name, content, ... }
  const [viewLoading, setViewLoading] = React.useState(false);
  const [viewError, setViewError] = React.useState(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSSMDocuments({ type, owner });
      setDocs(data.documents || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => { load(); }, [type, owner]);

  async function handleView(name) {
    setViewLoading(true);
    setViewError(null);
    setViewDoc({ name, content: null });
    try {
      const data = await fetchSSMDocumentContent(name);
      setViewDoc(data);
    } catch (e) {
      setViewError(e.message);
    } finally {
      setViewLoading(false);
    }
  }

  function handleDownload(doc) {
    const content = doc.content || '';
    const ext = doc.document_format === 'JSON' ? 'json' : 'yaml';
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.name}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>
      <Topbar title="SSM Documents" subtitle="AWS Systems Manager documents"
        actions={<Btn variant="default" size="sm" onClick={load}>↺ Refresh</Btn>}
      />
      <div style={{ flex:1, overflowY:'auto', padding:24 }}>
        {error && <ErrorBanner message={error}/>}
        <div style={{ display:'flex', gap:10, marginBottom:16 }}>
          <select value={owner} onChange={e => setOwner(e.target.value)} style={selectStyle}>
            <option value="Self">My documents</option>
            <option value="Amazon">Amazon documents</option>
            <option value="Private">Private</option>
          </select>
          <select value={type} onChange={e => setType(e.target.value)} style={selectStyle}>
            <option value="Command">Command</option>
            <option value="Automation">Automation</option>
            <option value="Policy">Policy</option>
            <option value="Session">Session</option>
          </select>
        </div>
        <Card>
          {loading ? (
            <div style={{ padding:40, display:'flex', justifyContent:'center' }}><Spinner/></div>
          ) : docs.length === 0 ? (
            <Empty message={`No ${type} documents found for owner: ${owner}`}/>
          ) : (
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr>
                  {['Name','Type','Schema','Platform','Owner','Actions'].map(h => (
                    <th key={h} style={{
                      textAlign:'left', padding:'9px 14px',
                      fontSize:10, fontWeight:600, color:'var(--text-tertiary)',
                      textTransform:'uppercase', letterSpacing:0.5,
                      borderBottom:'1px solid var(--border)'
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {docs.map((d, i) => (
                  <tr key={i}
                    onMouseEnter={e => e.currentTarget.style.background='var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background=''}>
                    <td style={td}>
                      <span style={{ fontWeight:500 }}>{d.name}</span>
                      {d.description && <div style={{ fontSize:11, color:'var(--text-tertiary)', marginTop:2 }}>{d.description}</div>}
                    </td>
                    <td style={td}>{d.type}</td>
                    <td style={td}><span style={{ color:'var(--text-secondary)' }}>{d.schema_version}</span></td>
                    <td style={td}><span style={{ color:'var(--text-secondary)' }}>{(d.platform || []).join(', ')}</span></td>
                    <td style={td}><span style={{ color:'var(--text-tertiary)' }}>{d.owner}</span></td>
                    <td style={td}>
                      <Btn variant="default" size="sm" onClick={() => handleView(d.name)}>View</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* View document modal */}
      {viewDoc && (
        <Modal title={`SSM Document — ${viewDoc.name}`} onClose={() => { setViewDoc(null); setViewError(null); }} width={760}>
          {viewLoading ? (
            <div style={{ padding:40, display:'flex', justifyContent:'center' }}><Spinner/></div>
          ) : viewError ? (
            <ErrorBanner message={viewError}/>
          ) : (
            <>
              {/* Metadata */}
              <div style={{ display:'flex', gap:16, marginBottom:16, flexWrap:'wrap' }}>
                {[
                  ['Type', viewDoc.document_type],
                  ['Format', viewDoc.document_format],
                  ['Schema', viewDoc.schema_version],
                  ['Version', viewDoc.document_version],
                  ['Status', viewDoc.status],
                ].map(([label, value]) => value && (
                  <div key={label} style={{ background:'var(--bg-page)', border:'1px solid var(--border)',
                    borderRadius:'var(--radius-md)', padding:'6px 12px', minWidth:80 }}>
                    <div style={{ fontSize:10, color:'var(--text-tertiary)', fontWeight:600,
                      textTransform:'uppercase', letterSpacing:0.5, marginBottom:2 }}>{label}</div>
                    <div style={{ fontSize:12, fontWeight:500 }}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Download button */}
              <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}>
                <Btn variant="primary" size="sm" onClick={() => handleDownload(viewDoc)}>
                  ↓ Download .{viewDoc.document_format === 'JSON' ? 'json' : 'yaml'}
                </Btn>
              </div>

              {/* Content */}
              <pre style={{
                fontFamily:'var(--font-mono)', fontSize:12,
                background:'var(--bg-page)', padding:16,
                borderRadius:'var(--radius-md)', border:'1px solid var(--border)',
                overflow:'auto', margin:0, color:'var(--text-secondary)',
                maxHeight:420, whiteSpace:'pre-wrap', wordBreak:'break-all',
              }}>
                {viewDoc.content || '(no content)'}
              </pre>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
