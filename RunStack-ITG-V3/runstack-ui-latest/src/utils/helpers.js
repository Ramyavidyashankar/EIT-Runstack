// src/utils/helpers.js

export function fmtDuration(createdAt, updatedAt) {
  if (!createdAt || !updatedAt) return '—';
  // Ensure both timestamps are parsed as UTC. DynamoDB stores them as
  // ISO strings without a Z suffix (e.g. "2026-06-30T10:00:00.123456"),
  // which JavaScript treats as local time. Appending Z forces UTC parsing,
  // matching the Step Function's $$.State.EnteredTime which is always UTC.
  const toUtc = s => s.endsWith('Z') || s.includes('+') ? s : s + 'Z';
  const ms = new Date(toUtc(updatedAt)) - new Date(toUtc(createdAt));
  if (isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function fmtRelative(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function fmtDateTime(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleString('en-GB', {
    day:'2-digit', month:'short', year:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
  });
}

export function shortId(id) {
  if (!id) return '—';
  return id.length > 16 ? id.slice(0, 16) + '…' : id;
}

// ── Status meta — enterprise semantic colors ─────────────────────────────────
// Green = finished OK, amber = waiting or in progress (pulsing while
// running), red = did not succeed. Same meaning on every page.
export const STATUS_META = {
  COMPLETED: { color:'#0F9D6D', bg:'#E4F8F0', label:'Completed' },
  SUCCEEDED: { color:'#0F9D6D', bg:'#E4F8F0', label:'Succeeded' },
  RUNNING:   { color:'#B45309', bg:'#FEF3E2', label:'Running', pulse:true },
  PENDING:   { color:'#B45309', bg:'#FEF3E2', label:'Pending' },
  FAILED:    { color:'#DC2626', bg:'#FDECEC', label:'Failed' },
  TIMED_OUT: { color:'#DC2626', bg:'#FDECEC', label:'Timed Out' },
  CANCELLED: { color:'#DC2626', bg:'#FDECEC', label:'Cancelled' },
};

// ── Type meta ─────────────────────────────────────────────────────────────────
// Type tags are labels, not statuses, so they use the teal accent and
// slate — never the green/amber/red that mean Completed/Running/Failed.
export const TYPE_META = {
  'SSM-Automation': { color:'#0F766E', bg:'#E6F5F3' },
  'SSM-RunCommand': { color:'#475569', bg:'#F1F5F9' },
  'EC2-Action':     { color:'#0B5C56', bg:'#E6F5F3' },
};

export const SSM_DOCS = [
  'AWS-RestartEC2Instance',
  'AWS-StopEC2Instance',
  'AWS-StartEC2Instance',
  'AWS-RunShellScript',
  'AWS-RunRemoteScript',
  'AWS-RunPowerShellScript',
];

export const AWS_REGIONS = [
  'us-east-1','us-east-2','us-west-1','us-west-2',
  'eu-west-1','eu-west-2','eu-central-1',
  'ap-southeast-1','ap-southeast-2','ap-northeast-1','ap-south-1',
  'sa-east-1','ca-central-1',
];