// src/utils/dlqStatus.js — the last Dead Letter Queue count this tab saw.
//
// Why not poll? GET /jobs/dlq (jobs.handle_jobs_dlq_list) calls SQS
// receive_message with a 30-second visibility timeout, so every read hides
// the returned messages from other readers for 30 s and bumps their receive
// count. Polling it from the header would make the DLQ page look empty to
// whoever opens it next. So the count is only updated when someone opens the
// Dead Letter Queue page, and the header / Dashboard show it from there.
// (A side-effect-free count would need a backend change, e.g. a
// get_queue_attributes-only mode on GET /jobs/dlq.)

let status = null; // { visible: number, inFlight: number, checkedAt: Date }
const listeners = new Set();

export function getDlqStatus() { return status; }

export function setDlqStatus(next) {
  status = next ? { ...next, checkedAt: next.checkedAt || new Date() } : null;
  listeners.forEach((fn) => fn(status));
}

export function subscribeDlqStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
