// src/utils/schedule.js
//
// Time-zone aware helpers for EventBridge **Rules** schedules.
//
// EventBridge Rules evaluate cron in UTC and have no time-zone setting. So
// the editor lets people think in a named local zone (default Asia/Kolkata),
// converts to a UTC cron on save, and converts the saved UTC cron back on
// edit. The conversion uses the zone's UTC offset at the next occurrence;
// zones with daylight saving will drift by an hour when DST changes, and the
// UI says so (EventBridge Scheduler is the right tool for that case).
//
// Conversion shifts the *day* as well as the hour: 1:00 AM IST on Monday is
// 7:30 PM UTC on Sunday, so weekly day lists and monthly days move too.
//
// All cron here is EventBridge's 6-field form:
//   minutes hours day-of-month month day-of-week year
//   day-of-week: 1-7 = SUN-SAT (or SUN..SAT); exactly one of dom/dow is '?'.

export const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DEFAULT_TZ = 'Asia/Kolkata';

export const COMMON_TIME_ZONES = [
  'Asia/Kolkata', 'UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago',
  'America/Denver', 'America/Los_Angeles', 'Asia/Singapore', 'Asia/Dubai', 'Asia/Tokyo', 'Australia/Sydney',
];

const ABBREV = { 'Asia/Kolkata': 'IST', 'Asia/Calcutta': 'IST', UTC: 'UTC', 'Etc/UTC': 'UTC' };

export function allTimeZones() {
  try {
    const list = Intl.supportedValuesOf('timeZone');
    return [...new Set([...COMMON_TIME_ZONES, ...list])];
  } catch {
    return COMMON_TIME_ZONES;
  }
}

// ─── Offsets ────────────────────────────────────────────────────────────────

const dtfCache = {};
function partsIn(tz, date) {
  if (!dtfCache[tz]) {
    dtfCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
  }
  const o = {};
  dtfCache[tz].formatToParts(date).forEach((p) => { o[p.type] = p.value; });
  return {
    year: +o.year, month: +o.month, day: +o.day, hour: +o.hour % 24, minute: +o.minute, second: +o.second,
    weekday: DAY_LABELS.indexOf(o.weekday),
  };
}

/** Minutes to add to UTC to get local wall-clock time in tz at `date`. */
export function tzOffsetMinutes(tz, date = new Date()) {
  const p = partsIn(tz, date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

export function observesDst(tz, year = new Date().getUTCFullYear()) {
  return tzOffsetMinutes(tz, new Date(Date.UTC(year, 0, 15))) !== tzOffsetMinutes(tz, new Date(Date.UTC(year, 6, 15)));
}

export function tzAbbrev(tz, date = new Date()) {
  if (ABBREV[tz]) return ABBREV[tz];
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(date);
    return p.find((x) => x.type === 'timeZoneName')?.value || tz;
  } catch {
    return tz;
  }
}

export function fmtTime(h, m) {
  const ampm = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ampm}`;
}

export function fmtInZone(date, tz) {
  const p = partsIn(tz, date);
  const mon = new Date(Date.UTC(p.year, p.month - 1, p.day)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  return `${DAY_LABELS[p.weekday]} ${p.day} ${mon} ${p.year}, ${fmtTime(p.hour, p.minute)} ${tzAbbrev(tz, date)}`;
}

// ─── Expression parsing ─────────────────────────────────────────────────────

export function parseExpression(expr) {
  const s = (expr || '').trim();
  let m = s.match(/^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/);
  if (m) return { type: 'rate', value: +m[1], unit: m[2].replace(/s$/, '') };
  m = s.match(/^cron\((.+)\)$/);
  if (m) {
    const f = m[1].trim().split(/\s+/);
    if (f.length !== 6) return null;
    const [minutes, hours, dom, month, dow, year] = f;
    return { type: 'cron', minutes, hours, dom, month, dow, year };
  }
  return null;
}

export function cronString(c) {
  return `cron(${c.minutes} ${c.hours} ${c.dom} ${c.month} ${c.dow} ${c.year})`;
}

function dowList(tok) {
  // "MON-FRI", "2-6", "SUN,WED", "1,4" → sorted indexes 0..6, or null.
  if (!tok || tok === '?' || tok === '*' || /[#L/]/i.test(tok)) return null;
  const set = expandField(tok, 1, 7, DAY_NAMES);
  return set ? [...set].map((v) => v - 1).sort((a, b) => a - b) : null;
}

/** Same schedule, spelled consistently: equal strings ⇔ same meaning. */
export function normalizeCron(expr) {
  const c = parseExpression(expr);
  if (!c || c.type !== 'cron') return (expr || '').trim();
  const list = dowList(c.dow);
  const dow = list ? list.map((i) => DAY_NAMES[i]).join(',') : c.dow.toUpperCase();
  return cronString({ ...c, dow, dom: c.dom.toUpperCase(), month: c.month.toUpperCase() });
}

function dowIndex(tok) {
  const t = String(tok).toUpperCase();
  const i = DAY_NAMES.indexOf(t);
  if (i >= 0) return i;
  if (/^[1-7]$/.test(t)) return +t - 1;
  return null;
}

// ─── Simple spec <-> UTC cron ───────────────────────────────────────────────
// spec: { frequency: 'hourly'|'daily'|'weekly'|'monthly', time: 'HH:MM'
//         (hourly: minute only), days: [0..6] (weekly), monthDay: 1..31|'L' }

function nextLocalReference(spec, tz, now) {
  // Offset at "today at the chosen local time" is a good-enough reference;
  // used only for the offset, not the day.
  const [h, m] = (spec.time || '00:00').split(':').map(Number);
  const p = partsIn(tz, now);
  return zonedToUtc(p.year, p.month, p.day, h, m, tz);
}

/** Local wall-clock in tz → UTC Date (handles DST by re-checking offset). */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let off = tzOffsetMinutes(tz, new Date(guess));
  let ts = guess - off * 60000;
  const off2 = tzOffsetMinutes(tz, new Date(ts));
  if (off2 !== off) ts = guess - off2 * 60000;
  return new Date(ts);
}

export function toCronUtc(spec, tz, now = new Date()) {
  const [h, m] = (spec.time || '00:00').split(':').map(Number);
  const offset = tzOffsetMinutes(tz, nextLocalReference(spec, tz, now));
  if (spec.frequency === 'hourly') {
    const utcMin = (((m - offset) % 60) + 60) % 60;
    return { expression: cronString({ minutes: utcMin, hours: '*', dom: '*', month: '*', dow: '?', year: '*' }), exact: true, offset };
  }
  const local = h * 60 + m;
  const utcTotal = local - offset;
  const shift = Math.floor(utcTotal / 1440);
  const utcMod = ((utcTotal % 1440) + 1440) % 1440;
  const uh = Math.floor(utcMod / 60);
  const um = utcMod % 60;

  if (spec.frequency === 'daily') {
    return { expression: cronString({ minutes: um, hours: uh, dom: '*', month: '*', dow: '?', year: '*' }), exact: true, offset, shift };
  }
  if (spec.frequency === 'weekly') {
    const days = [...new Set(spec.days || [])].sort((a, b) => a - b);
    if (!days.length) return { expression: null, exact: false, offset, error: 'Choose at least one day.' };
    const utcDays = [...new Set(days.map((d) => (((d + shift) % 7) + 7) % 7))].sort((a, b) => a - b);
    return {
      expression: cronString({ minutes: um, hours: uh, dom: '?', month: '*', dow: utcDays.map((d) => DAY_NAMES[d]).join(','), year: '*' }),
      exact: true, offset, shift,
    };
  }
  if (spec.frequency === 'monthly') {
    const D = spec.monthDay;
    let dom; let exact = true; let note = null;
    if (shift === 0) dom = D === 'L' ? 'L' : String(D);
    else if (shift === -1) {
      if (D === 'L') { exact = false; note = 'The last day of the month in this time zone falls on the second-to-last day in UTC, which EventBridge cron cannot express.'; }
      else if (D === 1) dom = 'L';
      else dom = String(D - 1);
    } else if (shift === 1) {
      if (D === 'L') dom = '1';
      else if (D <= 27) dom = String(D + 1);
      else { exact = false; note = `Day ${D} in this time zone is the next day in UTC, and that day doesn't exist in every month, so a UTC cron can't match it exactly.`; }
    } else { exact = false; note = 'Unsupported offset.'; }
    if (!exact) return { expression: null, exact, offset, shift, error: note };
    return { expression: cronString({ minutes: um, hours: uh, dom, month: '*', dow: '?', year: '*' }), exact, offset, shift };
  }
  return { expression: null, exact: false, error: 'Unknown frequency' };
}

/**
 * UTC cron → simple local spec, or null when the simple controls can't
 * represent it exactly. "Exactly" is proven by converting the spec back and
 * requiring the identical (normalized) expression — so an unchanged edit
 * never rewrites a rule.
 */
export function fromCronUtc(expr, tz, now = new Date()) {
  const c = parseExpression(expr);
  if (!c || c.type !== 'cron') return null;
  if (c.month !== '*' || c.year !== '*' || !/^\d+$/.test(c.minutes)) return null;
  const um = +c.minutes;
  let spec;

  if (c.hours === '*') {
    if (!((c.dom === '*' && c.dow === '?') || (c.dom === '?' && c.dow === '*'))) return null;
    const off = tzOffsetMinutes(tz, now);
    const lm = (((um + off) % 60) + 60) % 60;
    spec = { frequency: 'hourly', time: `00:${String(lm).padStart(2, '0')}` };
  } else {
    if (!/^\d+$/.test(c.hours)) return null;
    const uh = +c.hours;
    // Offset: estimate from now, then refine using the resulting local time.
    let off = tzOffsetMinutes(tz, now);
    const build = (o) => {
      const localTotal = uh * 60 + um + o;
      const shift = Math.floor(localTotal / 1440);
      const lmod = ((localTotal % 1440) + 1440) % 1440;
      return { time: `${String(Math.floor(lmod / 60)).padStart(2, '0')}:${String(lmod % 60).padStart(2, '0')}`, shift };
    };
    let { time, shift } = build(off);
    off = tzOffsetMinutes(tz, nextLocalReference({ time }, tz, now));
    ({ time, shift } = build(off));

    if ((c.dom === '*' || c.dom === '?') && (c.dow === '*' || c.dow === '?')) {
      spec = { frequency: 'daily', time };
    } else if (c.dom === '?') {
      const idx = dowList(c.dow);
      if (!idx) return null;
      spec = { frequency: 'weekly', time, days: [...new Set(idx.map((d) => (((d + shift) % 7) + 7) % 7))].sort((a, b) => a - b) };
    } else if (c.dow === '?') {
      let D;
      const dom = c.dom.toUpperCase();
      if (shift === 0) D = dom === 'L' ? 'L' : +dom;
      else if (shift === 1) D = dom === 'L' ? 1 : +dom + 1;      // UTC day d → local day d+1
      else if (shift === -1) D = dom === '1' ? 'L' : +dom - 1;   // UTC day d → local day d-1
      if (D == null || (D !== 'L' && (!Number.isInteger(D) || D < 1 || D > 31))) return null;
      spec = { frequency: 'monthly', time, monthDay: D };
    } else return null;
  }
  const back = toCronUtc(spec, tz, now);
  if (!back.expression || normalizeCron(back.expression) !== normalizeCron(expr)) return null;
  return spec;
}

// ─── Next runs (UTC evaluation, like EventBridge) ───────────────────────────

function expandField(field, min, max, names) {
  const out = new Set();
  for (const partRaw of String(field).toUpperCase().split(',')) {
    let part = partRaw;
    let step = 1;
    if (part.includes('/')) { const [a, b] = part.split('/'); part = a; step = +b; if (!step) return null; }
    const val = (t) => (names && names.indexOf(t) >= 0 ? names.indexOf(t) + min : /^\d+$/.test(t) ? +t : NaN);
    let lo; let hi;
    if (part === '*' || part === '?') { lo = min; hi = max; }
    else if (part.includes('-')) { const [a, b] = part.split('-'); lo = val(a); hi = val(b); }
    else { lo = val(part); hi = partRaw.includes('/') ? max : lo; }
    if (Number.isNaN(lo) || Number.isNaN(hi)) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Next `count` run times (Date, UTC) for an EventBridge cron, or null if unsupported. */
export function nextRuns(expr, count = 5, from = new Date()) {
  const c = parseExpression(expr);
  if (!c) return null;
  if (c.type === 'rate') return null; // rate() runs relative to creation time — not predictable here
  const mins = expandField(c.minutes, 0, 59);
  const hours = expandField(c.hours, 0, 23);
  const months = expandField(c.month, 1, 12, MONTHS);
  const years = c.year === '*' ? null : expandField(c.year, 1970, 2199);
  if (!mins || !hours || !months || (c.year !== '*' && !years)) return null;

  const domTok = c.dom.toUpperCase();
  const dowTok = c.dow.toUpperCase();
  let domTest; let dowTest;
  if (domTok === '?' || domTok === '*') domTest = () => true;
  else if (domTok === 'L') domTest = (d, last) => d === last;
  else { const s = expandField(domTok, 1, 31); if (!s) return null; domTest = (d) => s.has(d); }
  if (dowTok === '?' || dowTok === '*') dowTest = () => true;
  else if (/^[A-Z1-7]+#[1-5]$/.test(dowTok)) {
    const [dname, nth] = dowTok.split('#'); const di = dowIndex(dname);
    if (di == null) return null;
    dowTest = (wd, d) => wd === di && Math.ceil(d / 7) === +nth;
  } else {
    const s = expandField(dowTok, 1, 7, DAY_NAMES); if (!s) return null;
    dowTest = (wd) => s.has(wd + 1);
  }

  const out = [];
  const start = new Date(from.getTime() + 60000 - (from.getTime() % 60000));
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const hs = [...hours].sort((a, b) => a - b);
  const ms = [...mins].sort((a, b) => a - b);
  for (let i = 0; i < 800 && out.length < count; i++) {
    const y = day.getUTCFullYear(); const mo = day.getUTCMonth() + 1; const d = day.getUTCDate();
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    if ((!years || years.has(y)) && months.has(mo) && domTest(d, last) && dowTest(day.getUTCDay(), d)) {
      for (const h of hs) {
        for (const m of ms) {
          const t = new Date(Date.UTC(y, mo - 1, d, h, m));
          if (t >= start && out.length < count) out.push(t);
        }
      }
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

// ─── Plain language ─────────────────────────────────────────────────────────

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']; const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function describeSpec(spec, tz, now = new Date()) {
  const [h, m] = (spec.time || '00:00').split(':').map(Number);
  const ab = tzAbbrev(tz, now);
  if (spec.frequency === 'hourly') return `Every hour at ${String(m).padStart(2, '0')} minutes past (${ab})`;
  const at = `${fmtTime(h, m)} ${ab}`;
  if (spec.frequency === 'daily') return `Daily at ${at}`;
  if (spec.frequency === 'weekly') {
    const days = spec.days || [];
    if (days.length === 7) return `Daily at ${at}`;
    if (days.join() === '1,2,3,4,5') return `Weekdays at ${at}`;
    return `Every ${days.map((d) => DAY_LABELS[d]).join(', ')} at ${at}`;
  }
  if (spec.frequency === 'monthly') return `Monthly on the ${spec.monthDay === 'L' ? 'last day' : ordinal(spec.monthDay)} at ${at}`;
  return '';
}

/** "1:00 AM UTC" or "Sun 7:30 PM UTC" — the UTC side of a spec. */
export function describeUtc(expr) {
  const c = parseExpression(expr);
  if (!c || c.type !== 'cron' || !/^\d+$/.test(c.minutes)) return null;
  if (c.hours === '*') return `${c.minutes.padStart(2, '0')} minutes past each hour UTC`;
  if (!/^\d+$/.test(c.hours)) return null;
  const t = `${fmtTime(+c.hours, +c.minutes)} UTC`;
  if (c.dom === '?' && c.dow !== '*') return `${c.dow.split(',').map((x) => DAY_LABELS[dowIndex(x)] || x).join(', ')} ${t}`;
  if (c.dow === '?' && c.dom !== '*') return `day ${c.dom === 'L' ? 'last' : c.dom} ${t}`;
  return t;
}

export function describeRate(expr) {
  const c = parseExpression(expr);
  if (!c || c.type !== 'rate') return null;
  return c.value === 1 ? `Every ${c.unit}` : `Every ${c.value} ${c.unit}s`;
}

/** Row summary for any schedule expression, in the chosen display zone. */
export function describeExpression(expr, tz, now = new Date()) {
  const rate = describeRate(expr);
  if (rate) return { text: rate, simple: true };
  const spec = fromCronUtc(expr, tz, now);
  if (spec) return { text: describeSpec(spec, tz, now), simple: true, spec };
  const runs = nextRuns(expr, 1, now);
  return { text: 'Custom schedule', simple: false, hasRuns: !!(runs && runs.length) };
}

// ─── Event patterns ─────────────────────────────────────────────────────────

const SOURCE_NAMES = {
  'aws.securityhub': 'Security Hub', 'aws.guardduty': 'GuardDuty', 'aws.ec2': 'EC2', 'aws.health': 'AWS Health',
  'aws.ssm': 'Systems Manager', 'aws.config': 'AWS Config', 'aws.cloudwatch': 'CloudWatch', 'aws.s3': 'S3',
  'aws.autoscaling': 'Auto Scaling', 'aws.rds': 'RDS', 'aws.backup': 'AWS Backup', 'aws.states': 'Step Functions',
  'aws.inspector2': 'Inspector', 'aws.signin': 'Console sign-in', 'aws.cloudtrail': 'CloudTrail',
};
const DETAIL_PHRASES = {
  'Security Hub Findings - Imported': 'a Security Hub finding is imported',
  'Security Hub Findings - Custom Action': 'a Security Hub custom action is used',
  'GuardDuty Finding': 'GuardDuty reports a finding',
  'EC2 Instance State-change Notification': 'an EC2 instance changes state',
  'AWS Health Event': 'AWS Health reports an event',
  'CloudWatch Alarm State Change': 'a CloudWatch alarm changes state',
  'Config Rules Compliance Change': 'an AWS Config rule compliance changes',
  'EC2 Command Status-change Notification': 'an SSM Run Command changes status',
  'EC2 Automation Execution Status-change Notification': 'an SSM Automation changes status',
  'Object Created': 'an S3 object is created',
  'AWS API Call via CloudTrail': 'a matching AWS API call is made',
  'Step Functions Execution Status Change': 'a Step Functions execution changes status',
};

function flatten(obj, prefix = []) {
  const out = [];
  Object.entries(obj || {}).forEach(([k, v]) => {
    const path = [...prefix, k];
    if (Array.isArray(v)) out.push({ path: path.join('.'), values: v });
    else if (v && typeof v === 'object') out.push(...flatten(v, path));
    else out.push({ path: path.join('.'), values: [v] });
  });
  return out;
}

function valueText(v) {
  if (v && typeof v === 'object') {
    const [op, arg] = Object.entries(v)[0] || [];
    if (op === 'prefix') return `starts with "${arg}"`;
    if (op === 'suffix') return `ends with "${arg}"`;
    if (op === 'anything-but') return `anything but ${JSON.stringify(arg)}`;
    if (op === 'exists') return arg ? 'is present' : 'is absent';
    if (op === 'numeric') return `numeric ${arg.join(' ')}`;
    if (op === 'wildcard') return `matches "${arg}"`;
    return JSON.stringify(v);
  }
  return String(v);
}

export function summarizeEventPattern(patternText) {
  let p;
  try { p = typeof patternText === 'string' ? JSON.parse(patternText) : patternText; } catch { return { summary: 'Invalid event pattern', valid: false, conditions: [] }; }
  if (!p || typeof p !== 'object') return { summary: 'Invalid event pattern', valid: false, conditions: [] };
  const sources = [].concat(p.source || []).filter((x) => typeof x === 'string');
  const types = [].concat(p['detail-type'] || []).filter((x) => typeof x === 'string');
  const conditions = flatten(p).filter((c) => c.path !== 'source' && c.path !== 'detail-type')
    .map((c) => ({ path: c.path.replace(/^detail\./, ''), text: c.values.map(valueText).join(' or ') }));
  const srcName = sources.map((s) => SOURCE_NAMES[s] || s.replace(/^aws\./, '')).join(' or ');
  let summary;
  if (types.length === 1 && DETAIL_PHRASES[types[0]]) summary = `When ${DETAIL_PHRASES[types[0]]}`;
  else if (types.length) summary = `When ${srcName || 'an event source'} sends “${types.join('” or “')}”`;
  else if (sources.length) summary = `When ${srcName} sends any event`;
  else summary = 'When a matching event arrives';
  if (conditions.length) summary += ` (${conditions.length} condition${conditions.length === 1 ? '' : 's'})`;
  return { summary, valid: true, sources, sourceNames: srcName, detailTypes: types, conditions };
}

export function prettyJson(text) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text || ''; }
}
