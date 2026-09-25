// src/pages/TriggersSchedules.jsx — Triggers & Schedules
//
// Two kinds of EventBridge **Rules** (events API), shown and edited
// differently:
//   Scheduled        ScheduleExpression — cron in UTC (or rate()). The editor
//                    works in a named local zone and converts to/from UTC,
//                    shifting days as well as hours (utils/schedule.js).
//   Event-triggered  EventPattern — shown as source + matching conditions.
//                    Editing never adds a schedule; pattern, targets, target
//                    input, role and state are preserved unless changed.
// EventBridge **Scheduler** schedules are a different AWS resource with a
// native time zone; they're listed read-only under their own source.
//
// Every save goes through a "Review changes" step that lists what changes —
// including when the rule runs and what it invokes. An edit with no changes
// sends nothing.

import React from 'react';
import ReactDOM from 'react-dom';
import { Topbar } from '../components/Layout';
import { Btn, Card, Empty, ErrorBanner, Input, Select, Spinner, Textarea } from '../components/ui';
import { Callout, Chip } from '../components/sections';
import { useAuth } from '../auth/AuthContext';
import { createSchedule, deleteSchedule, fetchSchedules, updateSchedule } from '../api/client';
import { usePageRefresh } from '../hooks/usePageRefresh';
import {
  allTimeZones, DAY_LABELS, DEFAULT_TZ, describeExpression, describeRate, describeSpec, describeUtc, fmtInZone,
  fromCronUtc, nextRuns, normalizeCron, observesDst, parseExpression, prettyJson, summarizeEventPattern, toCronUtc, tzAbbrev,
} from '../utils/schedule';

const TEAL = '#0F766E';
const TZ_KEY = 'runstack.triggers.tz';
const SOURCES = [
  { value: 'runstack', label: 'RunStack rules' },
  { value: 'other', label: 'Other EventBridge rules' },
  { value: 'scheduler', label: 'EventBridge Scheduler' },
];
const KIND_LABEL = { scheduled: 'Scheduled', event: 'Event-triggered' };
const SERVICE_LABEL = { lambda: 'Lambda', states: 'Step Functions', sqs: 'SQS', sns: 'SNS', ssm: 'Systems Manager', events: 'Event bus', logs: 'CloudWatch Logs', ecs: 'ECS', batch: 'Batch' };

function loadTz() { try { return localStorage.getItem(TZ_KEY) || DEFAULT_TZ; } catch { return DEFAULT_TZ; } }
function saveTz(tz) { try { localStorage.setItem(TZ_KEY, tz); } catch { /* optional */ } }

const mono = { fontFamily: 'var(--font-mono)', fontSize: 11.5 };
const label = { display: 'grid', gap: 5, fontSize: 12, fontWeight: 600, color: '#334155' };

function Seg({ options, value, onChange, disabled }) {
  return (
    <div role="radiogroup" style={{ display: 'inline-flex', border: '1px solid #CBD5E1', borderRadius: 8, overflow: 'hidden', flexWrap: 'wrap' }}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} disabled={disabled || o.disabled} onClick={() => onChange(o.value)}
            title={o.title}
            style={{
              padding: '6px 12px', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit', cursor: disabled || o.disabled ? 'not-allowed' : 'pointer',
              border: 'none', borderLeft: i ? '1px solid #CBD5E1' : 'none', background: on ? TEAL : '#FFFFFF', color: on ? '#FFFFFF' : '#334155',
              opacity: o.disabled ? 0.5 : 1,
            }}>{o.label}</button>
        );
      })}
    </div>
  );
}

function StatePill({ state }) {
  return <Chip tone={state === 'ENABLED' ? 'green' : 'gray'}>{state === 'ENABLED' ? 'Enabled' : state === 'DISABLED' ? 'Disabled' : state}</Chip>;
}

function targetLine(t) {
  if (!t) return '—';
  return `${t.name}${t.service ? ` · ${SERVICE_LABEL[t.service] || t.service}` : ''}`;
}

// ─── Row trigger summary ─────────────────────────────────────────────────────
function triggerInfo(rule, tz, now) {
  if (rule.resource_type === 'scheduler') {
    const zone = rule.timezone || 'UTC';
    const rate = describeRate(rule.schedule_expression);
    if (rate) return { text: rate, sub: null };
    // Scheduler cron is evaluated in its own zone: describe it as wall-clock time there.
    const spec = fromCronUtc(rule.schedule_expression, 'UTC', now);
    const text = spec ? describeSpec(spec, 'UTC', now).replace(/UTC\)?$/, `${tzAbbrev(zone, now)}${spec.frequency === 'hourly' ? ')' : ''}`) : 'Custom schedule';
    return { text, sub: `Time zone: ${zone} (follows daylight saving)` };
  }
  if (rule.kind === 'event') {
    return { text: summarizeEventPattern(rule.event_pattern).summary, sub: rule.event_bus_name && rule.event_bus_name !== 'default' ? `Bus: ${rule.event_bus_name}` : null };
  }
  const d = describeExpression(rule.schedule_expression, tz, now);
  const next = nextRuns(rule.schedule_expression, 1, now);
  let sub = null;
  if (next && next[0]) sub = `Next: ${fmtInZone(next[0], tz)} · ${fmtInZone(next[0], 'UTC')}`;
  else if (parseExpression(rule.schedule_expression)?.type === 'rate') sub = 'Interval counted from when the rule was created';
  return { text: d.text, sub };
}

// ─── Technical details (expandable) ──────────────────────────────────────────
function RunStackTagControl({ rule, onChanged }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(null);
  const mark = async (value) => {
    setBusy(true); setErr(null);
    try { await updateSchedule(rule.name, { runstack_managed: value }); onChanged(); }
    catch (e) { setErr(e.body?.error || e.message || String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'grid', gap: 6, padding: 10, background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 8 }}>
      <div>
        {rule.runstack_managed
          ? <>Listed under <strong>RunStack rules</strong> because {rule.runstack_reason.toLowerCase()}.</>
          : <>Listed under <strong>Other EventBridge rules</strong>{rule.runstack_tag ? <> because it is tagged <span style={mono}>runstack:managed={rule.runstack_tag}</span></> : ''}.</>}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {rule.runstack_managed
          ? <Btn variant="default" size="sm" disabled={busy} onClick={() => mark(false)} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{busy ? <Spinner size={12} /> : null} Not a RunStack rule</Btn>
          : <Btn variant="primary" size="sm" disabled={busy} onClick={() => mark(true)} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{busy ? <Spinner size={12} /> : null} Mark as RunStack</Btn>}
        <span style={{ fontSize: 11.5, color: '#64748B' }}>Sets the tag <span style={mono}>runstack:managed</span>. The rule, its schedule and targets aren't changed.</span>
      </div>
      {err && <div style={{ color: '#B91C1C' }}>{err}</div>}
    </div>
  );
}

function TechDetails({ rule, tz, isAdmin, onChanged }) {
  const runs = rule.kind === 'scheduled' && rule.resource_type !== 'scheduler' ? nextRuns(rule.schedule_expression, 5) : null;
  const ev = rule.kind === 'event' ? summarizeEventPattern(rule.event_pattern) : null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, padding: '12px 16px 16px', background: '#F8FAFC', borderTop: '1px solid #E2E8F0' }}>
      <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6 }}>
          {rule.kind === 'event' ? 'Event pattern' : rule.resource_type === 'scheduler' ? `Schedule expression (${rule.timezone || 'UTC'})` : 'Schedule expression (UTC)'}
        </div>
        <pre style={{ ...mono, margin: 0, padding: 10, background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {rule.kind === 'event' ? prettyJson(rule.event_pattern) : rule.schedule_expression}
        </pre>
        {ev && ev.conditions.length > 0 && (
          <div style={{ fontSize: 12, color: '#334155' }}>
            <strong>Matching conditions</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{ev.conditions.map((c) => <li key={c.path}><span style={mono}>{c.path}</span> is {c.text}</li>)}</ul>
          </div>
        )}
        {runs && runs.length > 0 && (
          <div style={{ fontSize: 12, color: '#334155' }}>
            <strong>Next runs</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{runs.map((r) => <li key={r.toISOString()}>{fmtInZone(r, tz)} <span style={{ color: '#94A3B8' }}>· {fmtInZone(r, 'UTC')}</span></li>)}</ul>
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gap: 8, alignContent: 'start', fontSize: 12, color: '#334155' }}>
        <div><strong>ARN</strong> <div style={{ ...mono, wordBreak: 'break-all' }}>{rule.arn || '—'}</div></div>
        {rule.event_bus_name && <div><strong>Event bus</strong> <span style={mono}>{rule.event_bus_name}</span></div>}
        {rule.role_arn && <div><strong>Role</strong> <div style={{ ...mono, wordBreak: 'break-all' }}>{rule.role_arn}</div></div>}
        {rule.managed_by && <div><strong>Managed by</strong> <span style={mono}>{rule.managed_by}</span></div>}
        {isAdmin && rule.resource_type === 'rule' && !rule.managed_by
          ? <RunStackTagControl rule={rule} onChanged={onChanged} />
          : rule.runstack_reason && <div><strong>Shown under RunStack because</strong> {rule.runstack_reason.toLowerCase()}</div>}
        <div>
          <strong>Targets ({(rule.targets || []).length})</strong>
          {(rule.targets || []).map((t) => (
            <div key={t.id || t.target_arn} style={{ marginTop: 6, padding: 8, background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 8 }}>
              <div style={{ fontWeight: 600 }}>{targetLine(t)} {t.id && <span style={{ ...mono, color: '#94A3B8' }}>id {t.id}</span>}</div>
              <div style={{ ...mono, color: '#64748B', wordBreak: 'break-all' }}>{t.target_arn}</div>
              {t.has_input_transformer ? <div style={{ marginTop: 4, color: '#64748B' }}>Uses an input transformer</div>
                : t.input_path ? <div style={{ marginTop: 4, color: '#64748B' }}>Input path: <span style={mono}>{t.input_path}</span></div>
                  : t.input ? <pre style={{ ...mono, margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{prettyJson(t.input)}</pre>
                    : <div style={{ marginTop: 4, color: '#64748B' }}>Receives the matched event</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Scheduled editor section ───────────────────────────────────────────────
const FREQS = [
  { value: 'hourly', label: 'Hourly' }, { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' }, { value: 'rate', label: 'Interval' }, { value: 'advanced', label: 'Advanced (cron)' },
];

function initialScheduleState(expr, tz) {
  const p = parseExpression(expr);
  if (!expr) return { mode: 'daily', spec: { frequency: 'daily', time: '06:30', days: [1], monthDay: 1 }, rate: { value: 15, unit: 'minute' }, cron: '', note: null };
  if (p?.type === 'rate') return { mode: 'rate', spec: { frequency: 'daily', time: '06:30', days: [1], monthDay: 1 }, rate: { value: p.value, unit: p.unit }, cron: '', note: null };
  const spec = fromCronUtc(expr, tz);
  if (spec) return { mode: spec.frequency, spec: { days: [1], monthDay: 1, ...spec }, rate: { value: 15, unit: 'minute' }, cron: expr, note: null };
  return { mode: 'advanced', spec: { frequency: 'daily', time: '06:30', days: [1], monthDay: 1 }, rate: { value: 15, unit: 'minute' }, cron: expr,
    note: "This schedule can't be shown with the simple controls, so it's kept exactly as saved. Change it here only if you mean to." };
}

/** → { expression, error, preview, dstWarning } for the current controls. */
function computeSchedule(st, tz) {
  if (st.mode === 'rate') {
    const n = Math.max(1, parseInt(st.rate.value, 10) || 0);
    const expr = `rate(${n} ${n === 1 ? st.rate.unit : `${st.rate.unit}s`})`;
    return { expression: expr, preview: describeRate(expr), zoneIndependent: true };
  }
  if (st.mode === 'advanced') {
    const p = parseExpression(st.cron);
    if (!p) return { error: 'Enter cron(minutes hours day-of-month month day-of-week year) or rate(...).' };
    if (p.type === 'cron' && !((p.dom === '?') !== (p.dow === '?'))) return { error: "Exactly one of day-of-month and day-of-week must be '?'." };
    const d = describeExpression(st.cron, tz);
    return { expression: st.cron.trim(), preview: d.simple ? `${d.text}${describeUtc(st.cron) ? ` (${describeUtc(st.cron)})` : ''}` : 'Custom schedule (UTC)', zoneIndependent: p.type === 'rate' };
  }
  const spec = { ...st.spec, frequency: st.mode };
  const r = toCronUtc(spec, tz);
  if (!r.expression) return { error: r.error };
  const utc = describeUtc(r.expression);
  return { expression: r.expression, preview: `Runs ${describeSpec(spec, tz).replace(/^./, (c) => c.toLowerCase())}${tz !== 'UTC' && utc ? ` (${utc})` : ''}`, dstWarning: observesDst(tz) };
}

function ScheduleEditor({ st, setSt, tz, setTz, original }) {
  const set = (patch) => setSt((s) => ({ ...s, ...patch, touched: true }));
  const setSpec = (patch) => setSt((s) => ({ ...s, spec: { ...s.spec, ...patch }, touched: true }));
  const result = computeSchedule(st, tz);
  const runs = result.expression ? nextRuns(result.expression, 5) : null;
  const zones = React.useMemo(allTimeZones, []);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={label}>How often
        <Seg options={FREQS} value={st.mode} onChange={(v) => set({ mode: v, cron: v === 'advanced' && !st.cron ? (result.expression || '') : st.cron })} />
      </div>
      {st.note && <Callout tone="info">{st.note}</Callout>}

      {['hourly', 'daily', 'weekly', 'monthly'].includes(st.mode) && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {st.mode === 'hourly' ? (
            <label style={label}>Minutes past the hour
              <Select value={Number(st.spec.time.split(':')[1])} onChange={(e) => setSpec({ time: `00:${String(e.target.value).padStart(2, '0')}` })} style={{ width: 120 }}>
                {Array.from({ length: 60 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, '0')}</option>)}
              </Select>
            </label>
          ) : (
            <label style={label}>Time
              <Input type="time" value={st.spec.time} onChange={(e) => setSpec({ time: e.target.value || '00:00' })} style={{ width: 140 }} />
            </label>
          )}
          <label style={label}>Time zone
            <Select value={tz} onChange={(e) => setTz(e.target.value)} style={{ width: 230 }}>
              {zones.map((z) => <option key={z} value={z}>{z}{z === DEFAULT_TZ ? ' (default)' : ''}</option>)}
            </Select>
          </label>
          {st.mode === 'monthly' && (
            <label style={label}>Day of month
              <Select value={st.spec.monthDay} onChange={(e) => setSpec({ monthDay: e.target.value === 'L' ? 'L' : Number(e.target.value) })} style={{ width: 140 }}>
                {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
                <option value="L">Last day</option>
              </Select>
            </label>
          )}
        </div>
      )}
      {st.mode === 'weekly' && (
        <div style={label}>Days
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {DAY_LABELS.map((d, i) => {
              const on = (st.spec.days || []).includes(i);
              return (
                <button key={d} type="button" aria-pressed={on} onClick={() => setSpec({ days: on ? st.spec.days.filter((x) => x !== i) : [...(st.spec.days || []), i].sort() })}
                  style={{ padding: '6px 11px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                    border: `1px solid ${on ? TEAL : '#CBD5E1'}`, background: on ? '#E6F5F3' : '#FFFFFF', color: on ? '#0B5C56' : '#334155' }}>{d}</button>
              );
            })}
          </div>
        </div>
      )}
      {st.mode === 'rate' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <label style={label}>Every
            <Input type="number" min={1} value={st.rate.value} onChange={(e) => set({ rate: { ...st.rate, value: e.target.value } })} style={{ width: 100 }} />
          </label>
          <Select value={st.rate.unit} onChange={(e) => set({ rate: { ...st.rate, unit: e.target.value } })} style={{ width: 130 }}>
            <option value="minute">minutes</option><option value="hour">hours</option><option value="day">days</option>
          </Select>
        </div>
      )}
      {st.mode === 'advanced' && (
        <label style={label}>Cron expression (UTC)
          <Input value={st.cron} onChange={(e) => set({ cron: e.target.value })} style={{ ...mono, fontSize: 13 }} placeholder="cron(0 1 * * ? *)" spellCheck={false} />
          <span style={{ fontSize: 11, fontWeight: 400, color: '#64748B' }}>EventBridge rules evaluate cron in UTC. Fields: minutes hours day-of-month month day-of-week (1=SUN) year.</span>
        </label>
      )}

      {/* Preview */}
      <div style={{ border: '1px solid #BFE0DB', background: '#F4FAF9', borderRadius: 10, padding: '10px 12px', display: 'grid', gap: 6 }}>
        {result.error ? <div style={{ color: '#B91C1C', fontSize: 12.5 }}>{result.error}</div> : (
          <>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: '#0F172A' }}>{result.preview}</div>
            <div style={{ fontSize: 12, color: '#475569' }}>Saved as <span style={mono}>{result.expression}</span>{original && normalizeCron(original) !== normalizeCron(result.expression) && <> · was <span style={mono}>{original}</span></>}</div>
            {runs && runs.length > 0 && (
              <div style={{ fontSize: 12, color: '#334155' }}>
                Next runs:
                <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{runs.map((r) => <li key={r.toISOString()}>{fmtInZone(r, tz)} <span style={{ color: '#94A3B8' }}>· {fmtInZone(r, 'UTC')}</span></li>)}</ul>
              </div>
            )}
            {result.zoneIndependent && <div style={{ fontSize: 12, color: '#64748B' }}>Intervals don't depend on a time zone; the first run is counted from when the rule is saved.</div>}
          </>
        )}
      </div>

      {result.dstWarning && !result.error && (
        <Callout tone="warning" title={`${tz} changes its clocks for daylight saving`}>
          EventBridge rules store this schedule in UTC ({describeUtc(result.expression)}), so it will run an hour earlier or later in local time after the clocks change.
          To stay at the same local time all year, use an <strong>EventBridge Scheduler</strong> schedule with its own time zone setting. RunStack doesn't create those yet.
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, fontWeight: 600 }}>
            <input type="checkbox" checked={!!st.dstAck} onChange={(e) => setSt((s) => ({ ...s, dstAck: e.target.checked }))} />
            I understand this rule stays at a fixed UTC time
          </label>
        </Callout>
      )}
    </div>
  );
}

// ─── Event editor section ───────────────────────────────────────────────────
function EventEditor({ ev, setEv, isCreate }) {
  const summary = summarizeEventPattern(ev.pattern);
  const [showJson, setShowJson] = React.useState(isCreate ? false : false);
  const setField = (patch) => setEv((s) => ({ ...s, ...patch, touched: true }));

  const quickUpdate = (key, value) => {
    let p; try { p = JSON.parse(ev.pattern || '{}'); } catch { p = {}; }
    const list = value.split(',').map((x) => x.trim()).filter(Boolean);
    if (list.length) p[key] = list; else delete p[key];
    setField({ pattern: JSON.stringify(p, null, 2) });
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Callout tone="info">This rule runs when a matching event arrives on the <strong>{ev.bus || 'default'}</strong> event bus. It has no schedule.</Callout>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={label}>Event source
          <Input value={(summary.sources || []).join(', ')} onChange={(e) => quickUpdate('source', e.target.value)} placeholder="aws.securityhub" style={mono} />
        </label>
        <label style={label}>Event type (detail-type)
          <Input value={(summary.detailTypes || []).join(', ')} onChange={(e) => quickUpdate('detail-type', e.target.value)} placeholder="Security Hub Findings - Imported" />
        </label>
      </div>
      <div style={{ border: '1px solid #BFE0DB', background: '#F4FAF9', borderRadius: 10, padding: '10px 12px', fontSize: 12.5, color: '#334155' }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: summary.valid ? '#0F172A' : '#B91C1C' }}>{summary.summary}</div>
        {summary.conditions?.length > 0 && (
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{summary.conditions.map((c) => <li key={c.path}><span style={mono}>{c.path}</span> is {c.text}</li>)}</ul>
        )}
      </div>
      <div>
        <button type="button" onClick={() => setShowJson((x) => !x)} style={{ background: 'none', border: 'none', color: TEAL, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', padding: 0 }}>
          {showJson ? '▾' : '▸'} Advanced: edit event pattern JSON
        </button>
        {showJson && (
          <Textarea value={ev.pattern} onChange={(e) => setField({ pattern: e.target.value })} style={{ minHeight: 180, marginTop: 8 }} spellCheck={false} />
        )}
      </div>
    </div>
  );
}

// ─── Targets section ────────────────────────────────────────────────────────
function TargetsEditor({ targets, setTargets, isCreate, knownTargets, newTarget, setNewTarget }) {
  if (isCreate) {
    return (
      <div style={{ display: 'grid', gap: 10 }}>
        <label style={label}>Target
          <Select value={knownTargets.some((k) => k.target_arn === newTarget.arn) ? newTarget.arn : newTarget.arn ? '__custom__' : ''}
            onChange={(e) => setNewTarget((t) => ({ ...t, arn: e.target.value === '__custom__' ? ' ' : e.target.value }))}>
            <option value="">No target yet</option>
            {knownTargets.map((k) => <option key={k.target_arn} value={k.target_arn}>{targetLine(k)}</option>)}
            <option value="__custom__">Enter an ARN…</option>
          </Select>
        </label>
        {newTarget.arn && !knownTargets.some((k) => k.target_arn === newTarget.arn) && (
          <label style={label}>Target ARN
            <Input value={newTarget.arn.trim()} onChange={(e) => setNewTarget((t) => ({ ...t, arn: e.target.value }))} placeholder="arn:aws:lambda:…:function:…" style={mono} />
          </label>
        )}
        {newTarget.arn.trim() && (
          <label style={label}>Input sent to the target (JSON)
            <Textarea value={newTarget.input} onChange={(e) => setNewTarget((t) => ({ ...t, input: e.target.value }))} style={{ minHeight: 120 }} spellCheck={false} />
          </label>
        )}
      </div>
    );
  }
  if (!targets.length) return <div style={{ fontSize: 12.5, color: '#64748B' }}>This rule has no targets, so it doesn't invoke anything.</div>;
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {targets.map((t, i) => (
        <div key={t.id} style={{ border: '1px solid #E2E8F0', borderRadius: 8, padding: 10, display: 'grid', gap: 6 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{targetLine(t)} <span style={{ ...mono, color: '#94A3B8' }}>id {t.id}</span></div>
          <div style={{ ...mono, color: '#64748B', wordBreak: 'break-all' }}>{t.target_arn}</div>
          {t.has_input_transformer || t.input_path ? (
            <div style={{ fontSize: 12, color: '#64748B' }}>Uses an {t.has_input_transformer ? 'input transformer' : 'input path'} — kept as is (edit in the AWS console).</div>
          ) : (
            <label style={{ ...label, fontWeight: 500 }}>Input sent to the target (JSON){!t.input && <span style={{ fontWeight: 400, color: '#64748B' }}> — empty means the matched event is passed</span>}
              <Textarea value={t.draft} onChange={(e) => setTargets((all) => all.map((x, j) => (j === i ? { ...x, draft: e.target.value } : x)))} style={{ minHeight: 100 }} spellCheck={false} />
            </label>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Rule editor (modal) ────────────────────────────────────────────────────
function jsonEqual(a, b) {
  const n = (x) => { if (!x) return ''; try { return JSON.stringify(JSON.parse(x), Object.keys(JSON.parse(x)).sort()); } catch { return x; } };
  try { return JSON.stringify(JSON.parse(a || 'null')) === JSON.stringify(JSON.parse(b || 'null')) || n(a) === n(b); } catch { return (a || '') === (b || ''); }
}
function deepSortJson(text) {
  try {
    const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => ({ ...o, [k]: sort(v[k]) }), {}) : v);
    return JSON.stringify(sort(JSON.parse(text)));
  } catch { return (text || '').trim(); }
}

function RuleEditor({ rule, tz: pageTz, knownTargets, onClose, onSaved }) {
  const isCreate = !rule;
  const [kind, setKind] = React.useState(rule?.kind || 'scheduled');
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState(rule?.description || '');
  const [enabled, setEnabled] = React.useState(rule ? rule.state === 'ENABLED' : true);
  const [tz, setTz] = React.useState(pageTz);
  const [st, setSt] = React.useState(() => initialScheduleState(rule?.schedule_expression, pageTz));
  const [ev, setEv] = React.useState({ pattern: rule?.kind === 'event' ? prettyJson(rule.event_pattern) : '{\n  "source": [""],\n  "detail-type": [""]\n}', bus: rule?.event_bus_name });
  const [targets, setTargets] = React.useState((rule?.targets || []).map((t) => ({ ...t, draft: t.input ? prettyJson(t.input) : '' })));
  const [newTarget, setNewTarget] = React.useState({ arn: '', input: '{\n  \n}' });
  const [step, setStep] = React.useState('edit');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState(null);

  // Changing the display zone re-reads an untouched saved schedule in that zone.
  const changeTz = (z) => {
    setTz(z);
    if (!st.touched && rule?.schedule_expression) setSt(initialScheduleState(rule.schedule_expression, z));
  };

  const sched = kind === 'scheduled' ? computeSchedule(st, tz) : null;
  // Untouched schedule → keep the saved expression byte-for-byte.
  const newExpr = kind === 'scheduled' ? (!st.touched && rule ? rule.schedule_expression : sched?.expression) : null;

  const changes = [];
  const errors = [];
  if (isCreate && !/^[A-Za-z0-9._-]{1,64}$/.test(name)) errors.push('Name: 1–64 letters, numbers, dot, dash or underscore.');
  if (kind === 'scheduled' && sched?.error && (st.touched || isCreate)) errors.push(sched.error);
  if (kind === 'scheduled' && sched?.dstWarning && (st.touched || isCreate) && !st.dstAck) errors.push('Confirm the daylight-saving note under the schedule.');
  let patternOut = null;
  if (kind === 'event') {
    const s = summarizeEventPattern(ev.pattern);
    if (!s.valid) errors.push('Event pattern must be valid JSON.');
    patternOut = ev.pattern;
  }
  const targetUpdates = [];
  targets.forEach((t) => {
    if (t.has_input_transformer || t.input_path) return;
    if (t.draft.trim() && summarizeEventPattern(t.draft).valid === false && !(() => { try { JSON.parse(t.draft); return true; } catch { return false; } })()) errors.push(`Target ${t.id}: input must be valid JSON.`);
    else if (!jsonEqual(t.draft.trim(), t.input || '')) targetUpdates.push({ id: t.id, input: t.draft.trim(), before: t.input });
  });
  if (isCreate && newTarget.arn.trim()) { try { JSON.parse(newTarget.input || '{}'); } catch { errors.push('Target input must be valid JSON.'); } }

  if (isCreate) {
    changes.push({ label: 'Name', after: name || '—' });
    changes.push({ label: 'Type', after: KIND_LABEL[kind] });
    changes.push({ label: 'When it runs', after: kind === 'scheduled' ? `${sched?.preview || '—'}  ·  ${newExpr || ''}` : summarizeEventPattern(ev.pattern).summary });
    changes.push({ label: 'What it invokes', after: newTarget.arn.trim() ? newTarget.arn.trim() : 'Nothing yet (no target)' });
    changes.push({ label: 'State', after: enabled ? 'Enabled' : 'Disabled' });
  } else {
    if ((description || '') !== (rule.description || '')) changes.push({ label: 'Description', before: rule.description || '—', after: description || '—' });
    if ((enabled ? 'ENABLED' : 'DISABLED') !== rule.state) changes.push({ label: 'State', before: rule.state === 'ENABLED' ? 'Enabled' : 'Disabled', after: enabled ? 'Enabled' : 'Disabled' });
    if (kind === 'scheduled' && newExpr && normalizeCron(newExpr) !== normalizeCron(rule.schedule_expression)) {
      changes.push({ label: 'When it runs', before: `${describeExpression(rule.schedule_expression, tz).text} · ${rule.schedule_expression}`, after: `${sched.preview} · ${newExpr}` });
    }
    if (kind === 'event' && deepSortJson(patternOut) !== deepSortJson(rule.event_pattern)) {
      changes.push({ label: 'When it runs', before: summarizeEventPattern(rule.event_pattern).summary, after: summarizeEventPattern(patternOut).summary, json: true });
    }
    targetUpdates.forEach((u) => changes.push({ label: `What it invokes — input for ${targets.find((t) => t.id === u.id).name}`, before: u.before ? prettyJson(u.before) : '(matched event)', after: u.input ? prettyJson(u.input) : '{}', pre: true }));
  }

  const save = async () => {
    setSaving(true); setError(null);
    try {
      if (isCreate) {
        await createSchedule({
          name, description, state: enabled ? 'ENABLED' : 'DISABLED',
          ...(kind === 'scheduled' ? { schedule_expression: newExpr } : { event_pattern: patternOut }),
          ...(newTarget.arn.trim() ? { target_arn: newTarget.arn.trim(), target_input: newTarget.input || '{}' } : {}),
        });
      } else {
        const body = {};
        if ((description || '') !== (rule.description || '')) body.description = description;
        if ((enabled ? 'ENABLED' : 'DISABLED') !== rule.state) body.state = enabled ? 'ENABLED' : 'DISABLED';
        if (kind === 'scheduled' && normalizeCron(newExpr) !== normalizeCron(rule.schedule_expression)) body.schedule_expression = newExpr;
        if (kind === 'event' && deepSortJson(patternOut) !== deepSortJson(rule.event_pattern)) body.event_pattern = patternOut;
        if (targetUpdates.length) body.target_updates = targetUpdates.map(({ id, input }) => ({ id, input }));
        await updateSchedule(rule.name, body);
      }
      onSaved();
    } catch (e) {
      setError(e.body?.error || e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const section = (title, children, sub) => (
    <section style={{ display: 'grid', gap: 10 }}>
      <div><div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A' }}>{title}</div>{sub && <div style={{ fontSize: 12, color: '#64748B' }}>{sub}</div>}</div>
      {children}
    </section>
  );

  return ReactDOM.createPortal(
    <>
      <div onClick={onClose} aria-hidden style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.28)', zIndex: 40 }} />
      <div role="dialog" aria-modal="true" aria-label={isCreate ? 'New rule' : `Edit ${rule.name}`} style={{
        position: 'fixed', top: '4vh', bottom: '4vh', left: '50%', transform: 'translateX(-50%)', width: 'min(780px, 96vw)', zIndex: 41,
        background: '#FFFFFF', borderRadius: 12, boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A' }}>{isCreate ? 'New rule' : rule.name}</div>
            <div style={{ fontSize: 12, color: '#64748B' }}>{step === 'review' ? 'Review changes' : isCreate ? 'EventBridge rule' : `${KIND_LABEL[kind]} EventBridge rule`}</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 22, color: '#64748B', cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 18, display: 'grid', gap: 20, alignContent: 'start' }}>
          {step === 'edit' ? (
            <>
              {section('Rule', (
                <div style={{ display: 'grid', gap: 10 }}>
                  {isCreate && (
                    <>
                      <div style={label}>Type <Seg options={[{ value: 'scheduled', label: 'Scheduled' }, { value: 'event', label: 'Event-triggered' }]} value={kind} onChange={setKind} /></div>
                      <label style={label}>Name <Input value={name} onChange={(e) => setName(e.target.value.trim())} placeholder="runstack-nightly-restart" style={mono} /></label>
                    </>
                  )}
                  <label style={label}>Description <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this rule is for" /></label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, fontWeight: 600, color: '#334155' }}>
                    <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
                  </label>
                </div>
              ))}
              {kind === 'scheduled'
                ? section('Schedule', <ScheduleEditor st={st} setSt={setSt} tz={tz} setTz={changeTz} original={rule?.schedule_expression} />, 'Pick the time in your time zone — RunStack converts it to UTC for EventBridge.')
                : section('Trigger', <EventEditor ev={ev} setEv={setEv} isCreate={isCreate} />)}
              {section('What it invokes', <TargetsEditor targets={targets} setTargets={setTargets} isCreate={isCreate} knownTargets={knownTargets} newTarget={newTarget} setNewTarget={setNewTarget} />,
                isCreate ? null : 'Targets are kept as they are; only the input can be changed here.')}
            </>
          ) : (
            <>
              {changes.length === 0 ? (
                <Callout tone="info" title="No changes">Nothing has been changed, so there's nothing to save.</Callout>
              ) : (
                <div style={{ border: '1px solid #E2E8F0', borderRadius: 10, overflow: 'hidden' }}>
                  {changes.map((c) => (
                    <div key={c.label} style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 12, padding: '10px 12px', borderTop: '1px solid #F1F5F9' }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#334155' }}>{c.label}</div>
                      <div style={{ display: 'grid', gap: 4, fontSize: 12.5 }}>
                        {c.before !== undefined && <div style={{ color: '#94A3B8', textDecoration: 'line-through', whiteSpace: c.pre ? 'pre-wrap' : 'normal', ...(c.pre ? mono : {}) }}>{c.before}</div>}
                        <div style={{ color: '#0F172A', fontWeight: 600, whiteSpace: c.pre ? 'pre-wrap' : 'normal', ...(c.pre ? mono : {}) }}>{c.after}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!isCreate && <div style={{ fontSize: 12, color: '#64748B' }}>Everything not listed — targets, role, event bus{kind === 'event' ? ', event pattern' : ''} — stays exactly as it is.</div>}
            </>
          )}
          {error && <ErrorBanner message={error} />}
        </div>

        <div style={{ padding: '12px 18px', borderTop: '1px solid #E2E8F0', display: 'flex', gap: 10, alignItems: 'center' }}>
          {step === 'edit' && errors.length > 0 && <span style={{ fontSize: 12, color: '#B45309', flex: 1 }}>{errors[0]}</span>}
          <span style={{ flex: errors.length && step === 'edit' ? 0 : 1 }} />
          {step === 'edit' ? (
            <>
              <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
              <Btn variant="primary" onClick={() => setStep('review')} disabled={errors.length > 0}>Review changes</Btn>
            </>
          ) : (
            <>
              <Btn variant="default" onClick={() => setStep('edit')} disabled={saving}>Back</Btn>
              <Btn variant="primary" onClick={save} disabled={saving || changes.length === 0}>{saving ? <Spinner size={13} /> : isCreate ? 'Create rule' : 'Save changes'}</Btn>
            </>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function TriggersSchedules() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const [source, setSource] = React.useState('runstack');
  const [kindFilter, setKindFilter] = React.useState('all');
  const [search, setSearch] = React.useState('');
  const [tz, setTzState] = React.useState(loadTz);
  const [data, setData] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [open, setOpen] = React.useState(null);
  const [editing, setEditing] = React.useState(null); // rule | 'new'
  const [deleting, setDeleting] = React.useState(null);
  const [delBusy, setDelBusy] = React.useState(false);
  const [lastUpdated, setLastUpdated] = React.useState(null);
  const zones = React.useMemo(allTimeZones, []);
  const setTz = (z) => { setTzState(z); saveTz(z); };

  const load = React.useCallback(async (which = source) => {
    setLoading(true); setError(null);
    try {
      const res = which === 'scheduler' ? await fetchSchedules({ source: 'scheduler' }) : await fetchSchedules({ scope: which });
      setData((d) => ({ ...d, [which]: res }));
      setLastUpdated(new Date());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [source]);
  React.useEffect(() => { load(source); }, [source]); // eslint-disable-line
  usePageRefresh(() => load(source));

  const current = data[source];
  const rows = React.useMemo(() => {
    const list = source === 'scheduler' ? (current?.schedules || []) : (current?.schedules || []);
    const q = search.trim().toLowerCase();
    return list.filter((r) => (kindFilter === 'all' || r.kind === kindFilter)
      && (!q || `${r.name} ${r.description || ''} ${(r.targets || []).map((t) => t.name).join(' ')}`.toLowerCase().includes(q)));
  }, [current, kindFilter, search, source]);
  const counts = React.useMemo(() => {
    const list = current?.schedules || [];
    return { all: list.length, scheduled: list.filter((r) => r.kind === 'scheduled').length, event: list.filter((r) => r.kind === 'event').length };
  }, [current]);
  const knownTargets = React.useMemo(() => {
    const m = new Map();
    Object.values(data).forEach((d) => (d?.schedules || []).forEach((r) => (r.targets || []).forEach((t) => {
      if (t.target_arn && r.runstack_managed) m.set(t.target_arn, t);
    })));
    return [...m.values()];
  }, [data]);
  const now = new Date();

  const th = { textAlign: 'left', padding: '9px 12px', fontSize: 10, fontWeight: 700, color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.6, background: '#F8FAFC', borderBottom: '1px solid #E2E8F0', whiteSpace: 'nowrap' };
  const td = { padding: '10px 12px', borderBottom: '1px solid #F1F5F9', verticalAlign: 'top', fontSize: 12.5 };

  const doDelete = async () => {
    setDelBusy(true);
    try { await deleteSchedule(deleting.name); setDeleting(null); await load(source); } catch (e) { setError(e.message || String(e)); } finally { setDelBusy(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Topbar
        title="Triggers & Schedules"
        subtitle="EventBridge rules that start RunStack automations — on a schedule or when an event happens."
        actions={<>
          <span style={{ fontSize: 11, color: '#64748B' }}>{lastUpdated ? `Last updated ${lastUpdated.toLocaleTimeString('en-GB')}` : ''}</span>
          <Btn variant="default" size="sm" onClick={() => load(source)} disabled={loading}>{loading ? <Spinner size={12} /> : '↺'} Refresh</Btn>
          {isAdmin && <Btn variant="primary" size="sm" onClick={() => setEditing('new')}>+ New rule</Btn>}
        </>}
      />
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px 24px' }}>
        <div style={{ maxWidth: 1500, margin: '0 auto', display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <Seg options={SOURCES} value={source} onChange={(v) => { setSource(v); setOpen(null); if (v === 'scheduler') setKindFilter('all'); }} />
            {source !== 'scheduler' && (
              <Seg value={kindFilter} onChange={setKindFilter} options={[
                { value: 'all', label: `All ${current ? counts.all : ''}` },
                { value: 'scheduled', label: `Scheduled ${current ? counts.scheduled : ''}` },
                { value: 'event', label: `Event-triggered ${current ? counts.event : ''}` },
              ]} />
            )}
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, description or target…" style={{ maxWidth: 280, fontSize: 12.5 }} />
            <span style={{ flex: 1 }} />
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#475569', fontWeight: 600 }}>Show times in
              <Select value={tz} onChange={(e) => setTz(e.target.value)} style={{ width: 210, fontSize: 12.5 }}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
            </label>
          </div>

          {source === 'other' && <Callout tone="info">Rules in this account that don't belong to RunStack. They're shown for reference; rules managed by an AWS service can't be edited here.</Callout>}
          {source === 'scheduler' && (
            <Callout tone="info" title="EventBridge Scheduler is a separate AWS service">
              Scheduler schedules have their own time zone, so they keep the same local time through daylight saving. RunStack lists them here read-only.
              {current && current.available === false && <div style={{ marginTop: 4 }}>Not available: <span style={mono}>{current.reason}</span> — the RunStack Lambda needs <span style={mono}>scheduler:ListSchedules</span> and <span style={mono}>scheduler:GetSchedule</span>.</div>}
            </Callout>
          )}
          {error && <ErrorBanner message={error} />}

          <Card>
            {loading && !current ? <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
              : rows.length === 0 ? <Empty message={current?.schedules?.length ? 'No rules match these filters.' : source === 'runstack' ? 'No RunStack rules yet.' : 'Nothing to show.'} />
                : (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1000 }}>
                      <thead><tr>
                        <th style={th}>Rule</th><th style={th}>Type</th><th style={th}>Trigger</th><th style={th}>Target</th><th style={th}>State</th><th style={{ ...th, textAlign: 'right' }}> </th>
                      </tr></thead>
                      {rows.map((r) => {
                        const info = triggerInfo(r, tz, now);
                        const key = `${r.resource_type}:${r.group || ''}:${r.name}`;
                        const isOpen = open === key;
                        const editable = isAdmin && r.resource_type === 'rule' && !r.managed_by;
                        return (
                          <tbody key={key}>
                            <tr className="rs-exec-row">
                              <td style={{ ...td, maxWidth: 280 }}>
                                <div style={{ fontWeight: 700, color: '#0F172A', wordBreak: 'break-all' }}>{r.name}</div>
                                {r.description && <div style={{ fontSize: 11.5, color: '#64748B' }}>{r.description}</div>}
                              </td>
                              <td style={td}><Chip tone={r.kind === 'event' ? 'default' : 'gray'}>{r.resource_type === 'scheduler' ? 'Scheduler' : KIND_LABEL[r.kind]}</Chip></td>
                              <td style={{ ...td, maxWidth: 420 }}>
                                <div style={{ fontWeight: 600, color: '#0F172A' }}>{info.text}</div>
                                {info.sub && <div style={{ fontSize: 11.5, color: '#64748B' }}>{info.sub}</div>}
                              </td>
                              <td style={{ ...td, maxWidth: 240 }}>
                                {(r.targets || []).length === 0 ? <span style={{ color: '#94A3B8' }}>No target</span> : (
                                  <>
                                    <div style={{ color: '#0F172A' }}>{targetLine(r.targets[0])}</div>
                                    {r.targets.length > 1 && <div style={{ fontSize: 11.5, color: '#64748B' }}>+{r.targets.length - 1} more</div>}
                                  </>
                                )}
                              </td>
                              <td style={td}><StatePill state={r.state} /></td>
                              <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                                <Btn variant="ghost" size="sm" onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}>{isOpen ? '▾' : '▸'} Details</Btn>
                                {editable && <Btn variant="default" size="sm" onClick={() => setEditing(r)} style={{ marginLeft: 6 }}>Edit</Btn>}
                                {editable && <Btn variant="danger" size="sm" onClick={() => setDeleting(r)} style={{ marginLeft: 6 }}>Delete</Btn>}
                              </td>
                            </tr>
                            {isOpen && <tr><td colSpan={6} style={{ padding: 0 }}><TechDetails rule={r} tz={tz} isAdmin={isAdmin} onChanged={() => { setOpen(null); setData({}); load(source); }} /></td></tr>}
                          </tbody>
                        );
                      })}
                    </table>
                  </div>
                )}
          </Card>
          {source !== 'scheduler' && <div style={{ fontSize: 11.5, color: '#64748B' }}>Scheduled EventBridge rules run in UTC. Times are shown in {tz} ({tzAbbrev(tz)}) and UTC.</div>}
        </div>
      </div>

      {editing && (
        <RuleEditor rule={editing === 'new' ? null : editing} tz={tz} knownTargets={knownTargets}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(source); }} />
      )}
      {deleting && ReactDOM.createPortal(
        <>
          <div onClick={() => setDeleting(null)} aria-hidden style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.28)', zIndex: 40 }} />
          <div role="dialog" aria-modal="true" style={{ position: 'fixed', top: '20vh', left: '50%', transform: 'translateX(-50%)', width: 'min(460px, 94vw)', zIndex: 41, background: '#FFFFFF', borderRadius: 12, padding: 18, boxShadow: 'var(--shadow-lg)', display: 'grid', gap: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Delete {deleting.name}?</div>
            <div style={{ fontSize: 12.5, color: '#334155' }}>
              {triggerInfo(deleting, tz, now).text}. It invokes {deleting.targets?.length ? deleting.targets.map(targetLine).join(', ') : 'nothing'}. Its targets are removed too. This can't be undone.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn variant="ghost" onClick={() => setDeleting(null)} disabled={delBusy}>Cancel</Btn>
              <Btn variant="danger" onClick={doDelete} disabled={delBusy}>{delBusy ? <Spinner size={12} /> : 'Delete rule'}</Btn>
            </div>
          </div>
        </>, document.body,
      )}
    </div>
  );
}
