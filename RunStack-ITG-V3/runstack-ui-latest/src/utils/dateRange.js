// src/utils/dateRange.js — the time ranges shared by the Dashboard and the
// Executions page (components/DateRangeSelect.jsx), and their windows.
//
// The windows match the backend's job counters (process_messages
// jobs_list.window), so a Dashboard number and its Executions drill-down
// cover exactly the same executions:
//   24h, 7d   the current UTC hour and the hours before it (hour-aligned)
//   30d, 90d  today and the days before it, from UTC midnight
//   custom    whole UTC calendar days, both included
//   all       no limit

export const RANGE_PRESETS = [
  { value: '24h', label: 'Last 24 hours', short: 'the last 24 hours', hours: 24 },
  { value: '7d', label: 'Last 7 days', short: 'the last 7 days', hours: 24 * 7 },
  { value: '30d', label: 'Last 30 days', short: 'the last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', short: 'the last 90 days', days: 90 },
  { value: 'all', label: 'All time', short: 'all time' },
  { value: 'custom', label: 'Custom range…', short: 'the selected dates' },
];

// Fixed month names: some browsers' en-GB short month for September is "Sept".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad2 = (n) => String(n).padStart(2, '0');

/** UTC date as "07 Sep" / "07 Sep 2026" / "Mon 07 Sep 2026". */
export function fmtUtcDay(d, { year, weekday } = {}) {
  const out = `${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ''}`;
  return weekday ? `${WEEKDAYS[d.getUTCDay()]} ${out}` : out;
}
export const fmtUtcMonth = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
/** Local "07 Sep 14:00" (or just "14:00"). */
export const fmtLocal = (d, { day = true } = {}) => `${day ? `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ` : ''}${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** Value for an <input type="datetime-local"> (local wall clock). */
export function localInput(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function utcDay(d = new Date()) {
  return new Date(d).toISOString().slice(0, 10);
}
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return utcDay(d);
}
export const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/** "01 Sep – 30 Sep 2026"; "15 Dec 2025 – 10 Jan 2026"; "01 Sep 2026". */
export function customLabel(fromDay, toDay) {
  if (!isDay(fromDay) || !isDay(toDay)) return '';
  const f = (day, year) => fmtUtcDay(new Date(`${day}T00:00:00Z`), { year });
  if (fromDay === toDay) return f(fromDay, true);
  const sameYear = fromDay.slice(0, 4) === toDay.slice(0, 4);
  return `${f(fromDay, !sameYear)} – ${f(toDay, true)}`;
}

/** Error text for a draft custom range, or null when it can be applied. */
export function customRangeError(fromDay, toDay, today = utcDay()) {
  if (!isDay(fromDay) || !isDay(toDay)) return 'Choose both dates.';
  if (toDay < fromDay) return '“To” must be on or after “From”.';
  if (fromDay > today) return 'The range can’t start in the future.';
  return null;
}

/** Start of an hour preset: the current UTC hour plus the (hours - 1) before it. */
export function presetStart(hours, now = Date.now()) {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return new Date(d.getTime() - (hours - 1) * 3600_000);
}

/**
 * { from, to } (UTC ISO, `to` exclusive) for a range value
 *   { range, from_day, to_day }      presets and custom UTC days
 *   { range: 'custom', from, to }    older links: local date-times
 * Either end may be missing (no limit).
 */
export function rangeWindow(value, now = Date.now()) {
  const { range, from_day: fromDay, to_day: toDay, from, to } = value || {};
  const preset = RANGE_PRESETS.find((p) => p.value === range);
  if (preset?.hours) return { from: presetStart(preset.hours, now).toISOString() };
  if (preset?.days) return { from: `${addDays(utcDay(new Date(now)), -(preset.days - 1))}T00:00:00.000Z` };
  if (range === 'custom') {
    if (isDay(fromDay) || isDay(toDay)) {
      return {
        ...(isDay(fromDay) ? { from: `${fromDay}T00:00:00.000Z` } : {}),
        ...(isDay(toDay) ? { to: `${addDays(toDay, 1)}T00:00:00.000Z` } : {}),
      };
    }
    const out = {};
    const f = from ? new Date(from) : null;
    const t = to ? new Date(to) : null;
    if (f && !Number.isNaN(f.getTime())) out.from = f.toISOString();
    if (t && !Number.isNaN(t.getTime())) out.to = t.toISOString();
    return out;
  }
  return {};
}

/** Short text for the selected range: "Last 7 days", "01 Sep – 30 Sep 2026 (UTC)". */
export function rangeText(value) {
  const { range, from_day: fromDay, to_day: toDay, from, to } = value || {};
  if (range === 'custom') {
    if (isDay(fromDay) && isDay(toDay)) return `${customLabel(fromDay, toDay)} (UTC)`;
    const f = from ? new Date(from) : null;
    const t = to ? new Date(to) : null;
    const ok = (d) => d && !Number.isNaN(d.getTime());
    if (ok(f) || ok(t)) return `${ok(f) ? fmtLocal(f) : 'Any time'} – ${ok(t) ? fmtLocal(t) : 'now'}`;
    return 'Custom range';
  }
  return RANGE_PRESETS.find((p) => p.value === range)?.label || 'Last 7 days';
}
