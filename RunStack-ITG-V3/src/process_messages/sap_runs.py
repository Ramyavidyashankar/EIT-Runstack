"""
SAP full-stack runs: stop or start every SAP component of a SID, in order,
verifying each component before the next one begins.

    POST /notify-sync {"domain":"sap","sid":"G1D","action":"sap_stop"}    -> run job_id
    POST /notify-sync {"domain":"sap","sid":"G1D","action":"sap_start"}   -> run job_id
    POST /notify-sync {"domain":"sap","sid":"G1D","action":"run_status","job_id":"sap-run-..."}
    POST /notify-sync {"domain":"sap","sid":"G1D","action":"run_list"}
    POST /notify-sync {"domain":"sap","sid":"G1D","action":"run_cancel","job_id":"sap-run-..."}
    POST /notify-sync {"domain":"sap","sid":"G1D","action":"plan"}
    GET  /jobs/sap-run-...       (same view as run_status; no approval prompt in AQS)

EC2 stop/start ("full stack") is part of a run only for SIDs whose rows in
runstack-sap-instance-details ALL have full_stack = true (and while
SAP_RUN_FULL_STACK_ENABLED is not "false"). For every other SID the run is
SAP-only, exactly as before:
  full-stack stop : SAP components in stop order (each verified), then every
                    server of the SID stopped together (each verified stopped)
  full-stack start: every server started together (each verified running,
                    EC2 status checks passed, SSM Online), then SAP components
                    in start order (each verified)
  Each server step first runs a read-only EC2 status check: a server already
  in the target state is not sent a redundant stop/start.

Approval in Teams (SIDs whose "_CONFIG" row has approval_required = true)
-------------------------------------------------------------------------
  sap_stop / sap_start run every check above (authorization, inventory,
  environment, locks) and then, instead of starting, save the run as
  PENDING_APPROVAL and call the "RunStack SAP Approval" Teams Workflows flow
  (SAP_APPROVAL_FLOW_URL) with an adaptive card for the SID's Teams channel.
  The locks are held while it waits, so nothing else can act on the SID.
  The flow posts the card, waits for Approve / Reject and calls back, either
    (a) the same way the SQL DR-failover Teams approval does (no Cognito):
        POST /dr-failover/SAP/approve {"secret":"<teams approve shared secret>",
             "kind":"sap_run", "sid":"G1D", "job_id":"sap-run-...", ...}
        (dr_failover.handle_dr_approve checks the shared secret, then hands
         the body to handle_teams_decision), or
    (b) POST /notify-sync {"domain":"sap","sid":"G1D","action":"run_decision", ...}
        with a client-credentials token of a client in SAP_APPROVAL_CLIENT_IDS.
  Both carry: "decision":"approve"|"reject", "approval_token", "approver_email",
  "approver_upn", optional "comment".
  RunStack, not Teams, decides. The callback is accepted only when:
    - (a) the Teams approve shared secret matches, or (b) the caller is an
      approval client (never a user token)
    - the run is still PENDING_APPROVAL and not past its expiry (default 15 min)
    - approval_token matches the one sent with this run's card (one per run)
    - the responder is in the SID's approvers list and is not the requester
    - on approve: the requester's SAP and EC2 authorization still pass
  Then the run starts (RUNNING) exactly as an unapproved one would. No
  decision before expiry -> EXPIRED; rejection -> REJECTED; both release the
  locks and nothing runs.

Approval by e-mail ("_CONFIG" approval_channel = "email") — no Power Automate
  RunStack sends the approval e-mail itself (Microsoft Graph, from the shared
  mailbox GRAPH_MAIL_SENDER) to the approvers, with Approve / Reject buttons
  that open a ready-made reply (mailto:). While the request is pending, each
  tick reads that mailbox's Inbox (Graph Mail.Read) for replies whose subject
  or text carries the request ID, and applies APPROVE / REJECT with the same
  checks (approver list, not the requester, not expired, requester still
  authorized). The sender of the reply is the approver: only a message whose
  "from" and "sender" are the same approver address counts. No inbound route
  to AWS is involved. Each reply is answered by e-mail (accepted / refused).

Teams decision collected by RunStack (no inbound call)
  When the approval flow ends with a Response action set to "Asynchronous
  response", Power Automate answers RunStack's POST with 202 and a Location
  link. RunStack keeps that link (never shown in API output or logs) and, on
  each pending tick, GETs it: 202 = no click yet; 200 = the flow's Response
  body {run_id, approval_token, decision, responder, comment}. The decision
  then goes through the same checks as every other channel. Flows without an
  async Response keep working with the old HTTP callback.

Dry run ("_CONFIG" dry_run = true) — for demos / tests without downtime
  Everything up to and including the approval is real (authorization,
  locks, Teams card, approver checks). After approval NO job is created: each
  step is marked SUCCEEDED with "DRY RUN — would ...", one step group per
  tick, so progress, the Backup e-mail and the Teams result can be shown.
  Every message, card and e-mail is labelled DRY RUN.

Notifications (best effort)
  Backup e-mail: sent directly with Microsoft Graph (app-only Mail.Send) when
  GRAPH_MAIL_SECRET_ARN is set (secret JSON: tenant_id, client_id,
  client_secret, optional sender) or GRAPH_MAIL_TENANT_ID / GRAPH_MAIL_CLIENT_ID /
  GRAPH_MAIL_CLIENT_SECRET are all set, from GRAPH_MAIL_SENDER (default
  runstack-notifications@dxc.com); otherwise through the "RunStack Notify"
  flow (SAP_NOTIFY_FLOW_URL). The Teams result message needs the Notify flow.
  - Backup team e-mail (backup_emails in "_CONFIG", full-stack runs only):
      stop : "disable backup" once the run SUCCEEDED (all servers stopped)
      start: "enable backup" as soon as every server is started and verified
    Sent at most once per run; a failure is recorded on the run, never fails it.
  - A Teams message in the SID's channel when an approved run ends or a
    request expires.

How a run moves forward without a new state machine
---------------------------------------------------
API Gateway gives a request 29 s, but a SAP stop/start takes minutes, so the
run continues in the background:

  1. sap_stop / sap_start authorizes the caller, builds the step list from
     runstack-sap-instance-details (+ runstack-instance-catalog), takes a
     per-SID lock, saves the run record and puts a "tick" message on the
     existing RunStack SQS queue. It returns the run job_id immediately.
  2. The same process_messages Lambda receives the tick (it already consumes
     that queue). handle_run_tick looks at the current step's child job:
       - not finished          -> nothing to do
       - action job finished   -> dispatch the component's status script
       - status shows expected -> step SUCCEEDED, dispatch the next step
       - status not yet right  -> re-check (up to SAP_RUN_VERIFY_ATTEMPTS)
     then saves the run and sends the next tick with DelaySeconds.
  3. Child jobs are ordinary RunStack jobs (jobs table -> process_jobs ->
     existing Step Functions SSM-RunCommand branch -> SSM in the SAP account
     via runstack-cross-account-role), grouped under the run ID in
     Execution Details, exactly like sap_status.

  Order: stop_order / start_order on the SAP rows when every row has one,
  otherwise depends_on (sap_sync._order_components). Rows with the same
  order run together. A failed step stops the run (later steps SKIPPED,
  nothing rolled back). sap_start first checks that every server's EC2
  instance is running (EC2-Action jobs) and fails if one is not.

Safety of the tick chain
  - Each tick carries a sequence number (tick_seq). The run record is saved
    with a condition on that number, so a duplicate or redelivered tick is
    dropped and a child job is never dispatched twice. Job IDs are written
    to the run record BEFORE the job is created.
  - If the chain ever breaks (e.g. SendMessage failed), the next run_status
    / GET /jobs/{run} call notices no tick for SAP_RUN_STALL_SECONDS and
    re-sends one.

Authorization
  sap_stop / sap_start / run_cancel -> authorize_action("sap_start_stop")
  plan / run_status / run_list      -> authorize_action("sap_status_check")
  sap_stop / sap_start also apply the environment guardrail to every server
  (SAP_RUN_ALLOWED_ENVIRONMENTS, default = EC2_ALLOWED_ENVIRONMENTS).
  Full-stack runs additionally require EC2 authorization for EVERY server,
  the same check as the EC2 agent / POST /notify:
  authorize_action("ec2_stop_start", resource_id=<server>) — EC2 group,
  app access (runstack-app-access) and the Phase 1 environment guardrail.
  SAP capability alone never allows an EC2 stop/start.

Storage: runstack-action-locks (already used by runs.py / EC2 locks), TTL'd:
  sap-run#<run_id>         run record (steps, status, tick_seq)
  sap-run-active#<SID>     one active run per SID (acquire_action_lock)
  ec2:<instance_id>        full-stack runs hold every server's EC2 lock for the
                           whole run (job_id = run ID), so POST /notify (EC2
                           agent / UI) gets 423 for those servers until it ends
  sap-run-cancel#<run_id>  cancel request
  sap-runs#<SID>           IDs of the last runs for run_list
Settings per SID: runstack-sap-instance-details row component = "_CONFIG"
  (ignored as a component by get_sap_components): app_name, display_name
  (optional full name shown in titles/e-mails instead of "GTS (G1D)"),
  purpose (optional, shown with the Action, e.g. "Cost optimization"),
  backup_incident ("off" (default) | "test" | "on": also raise a ServiceNow
  incident for the backup team, at the same moment as the backup e-mail;
  "test" and dry runs mark it clearly as a test), backup_incident_group
  (assignment group name or sys_id, e.g. "W INCLV3 DXCIT-COHESITY"),
  approval_required, approvers, approval_minutes, teams_team_id,
  teams_channel_id, teams_channel_name, backup_emails, backup_cc, dry_run,
  mention_approvers (true: @mention the approvers on the Teams card),
  approval_channel ("teams" (default) or "email"), channel_email (a Teams
  channel's e-mail address, copied on approval e-mails for visibility),
  notify_emails (run summary e-mail recipients, returned to the agent as
  summary_recipients; the agent sends that e-mail).
No new IAM, tables, indexes, routes, Step Functions or SSM documents.
"""

import json
import hmac
import re
import secrets
import uuid
import time as _time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

from shared import *
import sap_landscape as _sl
import servicenow_ticket

RUN_ID_PREFIX = "sap-run-"
TICK_SECONDS = int(os.getenv("SAP_RUN_TICK_SECONDS", "15"))
STEP_TIMEOUT_SEC = int(os.getenv("SAP_RUN_STEP_TIMEOUT_SEC", "1800"))      # one stop/start script
VERIFY_TIMEOUT_SEC = int(os.getenv("SAP_RUN_VERIFY_TIMEOUT_SEC", "300"))   # one status script
VERIFY_ATTEMPTS = int(os.getenv("SAP_RUN_VERIFY_ATTEMPTS", "4"))
VERIFY_RETRY_SEC = int(os.getenv("SAP_RUN_VERIFY_RETRY_SEC", "20"))
STALL_SECONDS = int(os.getenv("SAP_RUN_STALL_SECONDS", "90"))
# true: a stop/start script whose own output clearly confirms the expected state
# counts as verified (no separate status-script run). Unclear output -> status script.
TRUST_SCRIPT_RESULT = os.getenv("SAP_RUN_TRUST_SCRIPT_RESULT", "true").strip().lower() in ("1", "true", "yes")
LONGPOLL_SECONDS = int(os.getenv("JOB_LONGPOLL_SECONDS", "22"))
JOB_CREATE_GRACE_SEC = 120
RUN_LOCK_TTL_SEC = 6 * 3600
RUN_RECORD_TTL_SEC = 7 * 86400
RUN_LIST_MAX = 10
FULL_STACK_ENABLED = os.getenv("SAP_RUN_FULL_STACK_ENABLED", "true").strip().lower() not in ("0", "false", "no")
EC2_STEP_TIMEOUT_SEC = int(os.getenv("SAP_RUN_EC2_STEP_TIMEOUT_SEC", "1200"))   # start incl. health checks
# Start jobs outside us-east-1 report health_outcome "unavailable" (no health
# loop there). true: accept "running" for those and let the SAP start scripts
# prove SSM works; false: fail the step.
EC2_ACCEPT_UNVERIFIED = os.getenv("SAP_RUN_EC2_ACCEPT_UNVERIFIED", "true").strip().lower() in ("1", "true", "yes")
EC2_POWER_ACTIONS = ("ec2_stop", "ec2_start")
EC2_STEP_ACTIONS = ("ec2_check",) + EC2_POWER_ACTIONS
EC2_DOCUMENTS = {"ec2_stop": "AWS-StopEC2Instance", "ec2_start": "AWS-StartEC2Instance"}
EC2_TARGET_STATE = {"ec2_stop": "stopped", "ec2_start": "running"}
# ── Approval / notifications ──
APPROVAL_ENABLED = os.getenv("SAP_RUN_APPROVAL_ENABLED", "true").strip().lower() not in ("0", "false", "no")
APPROVAL_FLOW_URL = os.getenv("SAP_APPROVAL_FLOW_URL", "").strip()
NOTIFY_FLOW_URL = os.getenv("SAP_NOTIFY_FLOW_URL", "").strip()
# Flow that posts a card into the Teams channel (payload kind "teams":
# "Post card in a chat or channel" with card_json). Used for the decision and
# the final result when the approval channel is Teams. Default: the approval
# flow itself, which branches on kind ("teams" -> post card; else approval card).
TEAMS_POST_FLOW_URL = os.getenv("SAP_TEAMS_POST_FLOW_URL", "").strip() or APPROVAL_FLOW_URL
APPROVAL_CLIENT_IDS = {c.strip() for c in os.getenv("SAP_APPROVAL_CLIENT_IDS", "").split(",") if c.strip()}
APPROVAL_MINUTES_DEFAULT = 15
PENDING_TICK_SECONDS = 30
FLOW_TIMEOUT_SEC = 10
CONFIG_COMPONENT = "_CONFIG"
# Microsoft Graph mail settings. Generic GRAPH_MAIL_* names so other RunStack
# features can reuse them; the earlier SAP_MAIL_* names still work.
def _mail_env(name, default=""):
    return (os.getenv(f"GRAPH_MAIL_{name}") or os.getenv(f"SAP_MAIL_{name}") or default).strip()


MAIL_SECRET_ARN = _mail_env("SECRET_ARN")
# Alternative to the secret (e.g. for testing): plain environment variables.
MAIL_ENV = {k: _mail_env(k.upper()) for k in ("tenant_id", "client_id", "client_secret")}
MAIL_CONFIGURED = bool(MAIL_SECRET_ARN or all(MAIL_ENV.values()))
MAIL_SENDER = _mail_env("SENDER", "runstack-notifications@dxc.com")
_MAIL_CREDS = {}
DISPLAY_TZ = timezone(timedelta(minutes=int(os.getenv("SAP_RUN_DISPLAY_TZ_OFFSET_MINUTES", "330"))))
DISPLAY_TZ_LABEL = os.getenv("SAP_RUN_DISPLAY_TZ_LABEL", "IST")
PENDING = "PENDING_APPROVAL"
OPEN_STATUSES = ("RUNNING", PENDING)
ALLOWED_ENVIRONMENTS = {
    e.strip().upper() for e in os.getenv("SAP_RUN_ALLOWED_ENVIRONMENTS", "").split(",") if e.strip()
} or set(EC2_ALLOWED_ENVIRONMENTS)

FAILED_JOB_STATUSES = ("FAILED", "TIMED_OUT", "CANCELLED")
TICK_MARKER = "sap_run_tick"
EXPECTED = {"stop": "STOPPED", "start": "RUNNING"}


# ── API entry ────────────────────────────────────────────────────────────

def handle_run_action(event, body, action, sid):
    if action in ("sap_stop", "sap_start"):
        return _start_run(event, body, action, sid)

    if action == "run_decision":
        return _decide(event, body, sid)

    if action == "run_cancel":
        denied = authorize_action(event, "sap_start_stop")
        if denied:
            return denied
        run, err = _run_for_request(body, sid)
        if err:
            return err
        if run["status"] == PENDING:
            # Nothing has run yet: end the request now.
            run.update(status="CANCELLED", finished_at=_now_iso(), error=f"Cancelled by {job_initiator(event)} before approval")
            due = _due_notices(run)          # tell the channel the open card is void
            if not _save_if(run, run["tick_seq"], PENDING, bump=True):
                return _resp(409, {"error": "Run changed meanwhile; check its status", "job_id": run["run_id"]})
            _finish(run)
            _send_notices(run, due)
            if (run.get("approval") or {}).get("channel") == "email":
                _status_email(run, f"⚠️ {_run_label(run)} — CANCELLED by {job_initiator(event)} before approval. "
                                   "Please ignore the approval e-mail; nothing was run.")
            return _resp(200, {"sid": sid, "action": action, "job_id": run["run_id"], "status": "CANCELLED",
                               "message": "The request was cancelled before approval. Nothing was run."})
        if run["status"] != "RUNNING":
            return _resp(409, {"error": f"Run is already {run['status']}", "job_id": run["run_id"]})
        _locks().put_item(Item={"resource_id": f"sap-run-cancel#{run['run_id']}",
                                "locked_by": job_initiator(event), "locked_at": _now_iso(),
                                "expires_at": int(_time.time()) + RUN_RECORD_TTL_SEC})
        return _resp(200, {"sid": sid, "action": action, "job_id": run["run_id"],
                           "status": "CANCEL_REQUESTED",
                           "message": "The step in progress will finish; no further steps will start. Nothing is rolled back."})

    denied = authorize_action(event, "sap_status_check")
    if denied:
        return denied

    if action == "plan":
        components = get_sap_components(sid)
        if not components:
            return _resp(404, {"error": f"No components found for SID '{sid}'"})
        full_stack = is_full_stack(components)
        stop_steps, stop_err = _build_steps(sid, components, "stop", full_stack)
        start_steps, start_err = _build_steps(sid, components, "start", full_stack)
        return _resp(200, {"sid": sid, "action": action, "full_stack": full_stack,
                           "message": "; ".join(stop_err + start_err) or None,
                           "plan": {"stop_sequence": [_step_view(s) for s in stop_steps],
                                    "start_sequence": [_step_view(s) for s in start_steps]}})

    if action == "run_list":
        return _resp(200, {"sid": sid, "action": action, "runs": _list_runs(sid)})

    # run_status
    run, err = _run_for_request(body, sid)
    if err:
        return err
    _kick_if_stalled(run)
    return _resp(200, {**_run_view(run), "sid": sid, "action": action})


def handle_run_detail(event, run_id):
    """GET /jobs/{jobId} for a run ID (called from jobs.handle_job_detail).
    GET needs no approval in AQS, so the agent monitors with this."""
    denied = authorize_action(event, "sap_status_check")
    if denied:
        return denied
    run = _load_run(run_id)
    if not run:
        return _resp(404, {"error": f"Job {run_id} not found"})
    _kick_if_stalled(run)
    run = _long_poll(event, run)
    view = _run_view(run)
    first = next((s for s in run.get("steps", []) if s.get("region")), {})
    # Fields GET /jobs/{jobId} callers always expect.
    view.update({"region": first.get("region", ""), "account_id": first.get("account_id", ""),
                 "resource_id": run["sid"], "automation_type": "SSM-RunCommand",
                 "created_at": run.get("requested_at") or run.get("started_at"), "updated_at": run.get("updated_at")})
    return _resp(200, view)


def is_run_id(job_id):
    return isinstance(job_id, str) and job_id.startswith(RUN_ID_PREFIX)


# ── Starting a run ───────────────────────────────────────────────────────

def _start_run(event, body, action, sid):
    denied = authorize_action(event, "sap_start_stop")
    if denied:
        return denied

    op = "stop" if action == "sap_stop" else "start"
    components = get_sap_components(sid)
    if not components:
        return _resp(404, {"error": f"No components found for SID '{sid}'"})

    full_stack = is_full_stack(components)
    steps, errors = _build_steps(sid, components, op, full_stack)
    if errors:
        # Never run part of a landscape because inventory is incomplete.
        return _resp(400, {"error": "SAP inventory incomplete for this SID", "message": "; ".join(errors)})
    if not any(s["status"] == "PENDING" and s["step_action"] not in EC2_STEP_ACTIONS for s in steps):
        return _resp(400, {"error": f"No {op} scripts configured for SID '{sid}'"})

    restricted = sorted({f"{s.get('host') or s['instance_id']} ({s.get('environment') or 'no environment'})"
                         for s in steps
                         if str(s.get("environment") or "").strip().upper() not in ALLOWED_ENVIRONMENTS})
    if restricted:
        return _resp(403, {"error": "forbidden", "reason": "environment_restricted",
                           "message": (f"SAP {op} is currently restricted to "
                                       f"{', '.join(sorted(ALLOWED_ENVIRONMENTS))} environments. "
                                       f"Not allowed: {', '.join(restricted)}")})

    cfg = get_sid_config(sid)
    needs_approval = approval_required(cfg)
    if needs_approval:
        problem = _approval_setup_problem(cfg)
        if problem:
            # Never run without the approval this SID requires.
            return _resp(503, {"error": "approval_unavailable", "message": problem})

    servers = _servers(steps) if full_stack else {}
    for iid, host in servers.items():
        # Same EC2 check as the EC2 agent: group -> app access -> environment.
        denied = authorize_action(event, "ec2_stop_start", resource_id=iid)
        if denied:
            return _with_server(denied, host, iid, op)

    run_id = f"{RUN_ID_PREFIX}{uuid.uuid4()}"
    initiator = job_initiator(event)

    conflict = acquire_action_lock(f"sap-run-active#{sid}", initiator, run_id, ttl_seconds=RUN_LOCK_TTL_SEC)
    if conflict:
        active = _locks().get_item(Key={"resource_id": f"sap-run-active#{sid}"}).get("Item") or {}
        return _resp(423, {"error": "locked", "reason": "run_in_progress",
                           "job_id": active.get("job_id"),
                           "message": (f"Another SAP run for {sid} is in progress "
                                       f"(started by {conflict.get('locked_by')} at {conflict.get('locked_at')}). "
                                       "Wait for it to finish.")})

    held = []
    for iid, host in servers.items():
        busy = acquire_action_lock(f"ec2:{iid}", initiator, run_id, ttl_seconds=RUN_LOCK_TTL_SEC)
        if busy:
            _release_locks(sid, run_id, held)
            return _resp(423, {"error": "locked", "reason": "server_locked", "server": host,
                               "message": (f"Server {host} is busy: {busy.get('locked_by')} started an action "
                                           f"on it at {busy.get('locked_at')}. Wait for it to finish.")})
        held.append(iid)

    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {}) or {}
    now = _now_iso()
    run = {
        "resource_id": f"sap-run#{run_id}", "record": "sap_run",
        "run_id": run_id, "sid": sid, "run_action": action, "op": op,
        "status": PENDING if needs_approval else "RUNNING", "initiated_by": initiator,
        # Only what job_initiator() needs, so child jobs show the real user.
        "claims": {k: claims[k] for k in ("username", "email", "client_id") if claims.get(k)},
        # What authorize_action() reads, to re-check the requester at approval.
        "auth_claims": {k: claims[k] for k in ("username", "email", "client_id", "runstack:role",
                                               "runstack:groups", "runstack:authorized") if claims.get(k)},
        "request_id": str(body.get("id") or "")[:100],
        "requested_at": now, "started_at": None if needs_approval else now,
        "updated_at": now, "finished_at": None,
        "app_name": cfg.get("app_name") or None,
        "display_name": str(cfg.get("display_name") or "").strip() or None,
        "purpose": str(cfg.get("purpose") or "").strip()[:100] or None,
        "dry_run": _on(cfg.get("dry_run")),
        "notify": _notify_settings(cfg), "notices": {},
        "current_step": None, "failed_step": None, "error": None,
        "full_stack": full_stack, "ec2_locks": held,
        "approval": _new_approval(cfg) if needs_approval else None,
        "steps": steps, "tick_seq": 0, "last_tick_at": _now_iso(),
        "expires_at": int(_time.time()) + RUN_RECORD_TTL_SEC,
    }
    try:
        _locks().put_item(Item=run)
    except Exception as e:
        _release_locks(sid, run_id, held)
        logger.error(f"sap_runs: could not save run {run_id}: {e}")
        return _resp(500, {"error": "Could not create run"})

    _remember_run(sid, run_id)

    if needs_approval:
        if run["approval"]["channel"] == "email":
            ok, detail = _send_mail(_approval_email(run))
            where = "by e-mail"
        else:
            ok, detail = _post_card(run, cfg)
            where = "to Teams"
        if not ok:
            run.update(status="FAILED", finished_at=_now_iso(),
                       error=f"Could not send the approval request {where}: {detail}")
            _save_if(run, 0, PENDING, bump=True)
            _finish(run)
            return _resp(502, {"error": "approval_request_failed", "job_id": run_id, "message": run["error"]})
        if not _send_tick(run_id, 0, PENDING_TICK_SECONDS):
            logger.warning(f"sap_runs: first tick for {run_id} not sent")
        appr = run["approval"]
        return _resp(200, {"sid": sid, "action": action, "run_action": action, "job_id": run_id,
                           "status": PENDING, "initiated_by": initiator, "requested_at": now,
                           "full_stack": full_stack, "approval": _approval_view(run),
                           "dry_run": run["dry_run"],
                           "message": (("DRY RUN — nothing will be stopped or started even if approved. " if run["dry_run"] else "")
                                       + (f"Approval request e-mailed to {', '.join(appr['approvers'])}. "
                                          if appr.get("channel") == "email" else
                                          f"Sent for approval to the {appr.get('channel_name') or 'app team'} Teams channel. ")
                                       + f"Nothing runs until an approver approves it; the request expires at "
                                       f"{_display(appr['expires_at'])} ({appr['minutes']} min). "
                                       "Follow it with GET /jobs/{jobId}."),
                           "steps": [_step_view(s) for s in steps]})

    if not _send_tick(run_id, 0, 0):
        # Run saved; the stall check on the first run_status/GET will re-send.
        logger.warning(f"sap_runs: first tick for {run_id} not sent")

    if run["dry_run"]:
        what = f"DRY RUN of the {_run_label(run)}: nothing will be stopped or started; each step is only simulated."
    elif not full_stack:
        what = (f"SAP {op} started for {sid}. Components are {op_past(op)} one step at a time "
                "and each is verified before the next.")
    elif op == "stop":
        what = (f"Full-stack stop started for {sid}: SAP components are stopped and verified one step at a time, "
                f"then the {len(servers)} EC2 servers are stopped and verified.")
    else:
        what = (f"Full-stack start started for {sid}: the {len(servers)} EC2 servers are started and verified "
                "(running, status checks, SSM), then SAP components are started and verified one step at a time.")
    return _resp(200, {"sid": sid, "action": action, "run_action": action, "job_id": run_id,
                       "status": "STARTED", "initiated_by": initiator, "started_at": run["started_at"],
                       "full_stack": full_stack, "dry_run": run["dry_run"],
                       "message": what + " Follow progress with GET /jobs/{jobId}.",
                       "steps": [_step_view(s) for s in steps]})


def op_past(op):
    return "stopped" if op == "stop" else "started"


def is_full_stack(components):
    """True when EC2 stop/start is part of this SID's runs: every SAP row has
    full_stack = true (bool or "true"). One flag per row keeps the setting in
    the existing table; requiring all rows avoids a half-configured SID."""
    def on(v):
        return v is True or str(v).strip().lower() in ("true", "1", "yes")
    return bool(FULL_STACK_ENABLED and components and all(on(c.get("full_stack")) for c in components))


def _servers(steps):
    """{instance_id: host} of the SAP steps, in step order."""
    out = {}
    for s in steps:
        if s["step_action"] not in EC2_STEP_ACTIONS and s.get("instance_id"):
            out.setdefault(s["instance_id"], s.get("host") or s["instance_id"])
    return out


def _with_server(denied, host, iid, op):
    """Name the server in an EC2 authorization denial."""
    try:
        body = json.loads(denied.get("body") or "{}")
    except (TypeError, ValueError):
        body = {}
    body.update(server=host, instance_id=iid,
                message=f"Full-stack {op} needs EC2 {op} access to every server of this SID. "
                        f"Server {host}: {body.get('message', 'not authorized')}")
    return {**denied, "body": json.dumps(body)}


def _build_steps(sid, components, op, full_stack=False):
    """Ordered step list for op ('stop'|'start'). Returns (steps, errors).
    full_stack adds EC2 stop steps after the SAP steps (stop) or EC2 start
    steps before them (start); otherwise start gets read-only EC2 checks."""
    order_key = f"{op}_order"
    explicit = all(c.get(order_key) is not None for c in components)
    if explicit:
        ordered = sorted(components, key=lambda c: int(c[order_key]))
    else:
        ordered = _sl._order_components(list(components), op)

    steps, errors, servers = [], [], {}
    for idx, c in enumerate(ordered, start=1):
        iid = c.get("instance_id")
        catalog = get_catalog_instance(iid) if iid else None
        if not catalog:
            errors.append(f"{c.get('component')}: instance {iid} not in instance catalog")
            continue
        step = {
            "order": int(c[order_key]) if explicit else idx,
            "component": c.get("component"), "label": _sl._label(c),
            "host": _sl._host(catalog, c), "instance_id": iid,
            "account_id": catalog.get("account_id"), "region": catalog.get("region"),
            "app_id": catalog.get("app_id"), "environment": catalog.get("environment"),
            "server_name": catalog.get("server_name"), "private_ip": catalog.get("private_ip"),
            "step_action": f"{op}_script",
            "script": c.get(f"{op}_script_path"), "args": list(c.get(f"{op}_args", []) or []),
            "status_script": c.get("status_script_path"),
            "status_args": list(c.get("status_args", []) or []),
            "status": "PENDING", "phase": None, "job_id": None, "verify_job_id": None,
            "verify_attempts": 0, "verified_state": None, "output": None,
            "action_summary": None, "message": None, "started_at": None, "finished_at": None,
        }
        if not step["script"]:
            step.update(status="SKIPPED", message=f"No {op} script configured for {c.get('component')}")
        steps.append(step)
        servers.setdefault(iid, {"step": step, "components": []})["components"].append(step["label"])

    if full_stack:
        # A component left running would be cut off by the EC2 stop.
        errors += [f"{s['label']}: no {op} script configured (required for a full-stack {op})"
                   for s in steps if s["status"] == "SKIPPED"]

    def server_step(info, step_action, order, label):
        s = info["step"]
        return {**{k: s.get(k) for k in ("host", "instance_id", "account_id", "region",
                                         "app_id", "environment", "server_name", "private_ip")},
                "order": order, "component": "EC2", "label": f"{label} — {s.get('host') or s['instance_id']}",
                "components": info["components"], "step_action": step_action,
                "script": None, "args": [], "status_script": None, "status_args": [],
                "status": "PENDING", "phase": None, "job_id": None, "verify_job_id": None,
                "precheck_job_id": None, "verify_attempts": 0, "verified_state": None, "output": None,
                "action_summary": None, "message": None, "started_at": None, "finished_at": None}

    orders = [s["order"] for s in steps] or [1]
    if op == "stop" and full_stack:
        # After every SAP step; all servers in one group (stopped together).
        steps = steps + [server_step(i, "ec2_stop", max(orders) + 1, "EC2 stop") for i in servers.values()]
    elif op == "start":
        # Before every SAP step. Full stack: start the servers; otherwise only
        # confirm they are already running (EC2 start is not part of the run).
        first = min(min(orders) - 1, 0)
        action, label = ("ec2_start", "EC2 start") if full_stack else ("ec2_check", "EC2 check")
        steps = [server_step(i, action, first, label) for i in servers.values()] + steps
    return steps, errors


# ── Tick: move a run forward (SQS) ───────────────────────────────────────

def is_tick_message(payload):
    return isinstance(payload, dict) and payload.get("runstack_internal") == TICK_MARKER


def handle_run_tick(payload):
    """Called from app.process_single_message. Always returns True so a tick
    problem never makes SQS redeliver the other job messages in the batch;
    the stall check recovers a broken chain."""
    try:
        run_id, seq = payload.get("run_id"), int(payload.get("seq", 0))
        if not is_run_id(run_id):
            return True
        run = _load_run(run_id)
        if not run or run.get("status") not in OPEN_STATUSES:
            return True
        if int(run.get("tick_seq", 0)) != seq:
            logger.info(f"sap_runs: stale tick {seq} for {run_id} (now {run.get('tick_seq')})")
            return True

        if run["status"] == PENDING:
            return _pending_tick(run, seq)

        dispatches = _advance(run)
        due = _due_notices(run)
        run["tick_seq"] = seq + 1
        run["last_tick_at"] = _now_iso()
        run["updated_at"] = _now_iso()
        try:
            _locks().put_item(Item=run, ConditionExpression="tick_seq = :s",
                              ExpressionAttributeValues={":s": seq})
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                logger.info(f"sap_runs: tick {seq} for {run_id} lost the race; dropped")
                return True
            raise

        # Job IDs are now recorded, so these are created at most once.
        for step, kind in dispatches:
            _dispatch_step(run, step, kind)
        # Marked as sent in the saved record, so each notice goes out at most once.
        _send_notices(run, due)

        if run["status"] == "RUNNING":
            _send_tick(run_id, seq + 1, TICK_SECONDS)
        else:
            _finish(run)
    except Exception as e:
        logger.exception(f"sap_runs: tick failed: {e}")
    return True


def _advance(run):
    """Update run/steps in place for one tick. Returns [(step, 'action'|'verify')]
    to dispatch AFTER the run record is saved."""
    dispatches = []
    cancelled = _cancel_requested(run["run_id"])
    steps = run["steps"]

    for _ in range(len(steps) + 1):          # bounded: at most one pass per group
        open_orders = sorted({s["order"] for s in steps if s["status"] in ("PENDING", "RUNNING")})
        if not open_orders:
            _close_run(run, "SUCCEEDED")
            return dispatches
        order = open_orders[0]
        group = [s for s in steps if s["order"] == order]

        if cancelled and not any(s["status"] == "RUNNING" for s in group):
            _skip_remaining(steps, f"Not run — cancelled by {cancelled}")
            _close_run(run, "CANCELLED", error=f"Cancelled by {cancelled}")
            return dispatches

        run["current_step"] = order
        for s in group:
            _advance_step(run, s, dispatches)

        if any(s["status"] in ("PENDING", "RUNNING") for s in group):
            return dispatches                    # group still busy
        failed = [s for s in group if s["status"] == "FAILED"]
        if failed:
            run["failed_step"] = order
            _skip_remaining(steps, f"Not run — step {order} ({failed[0]['label']}) failed")
            _close_run(run, "FAILED", error=f"{failed[0]['label']}: {failed[0]['message']}")
            return dispatches
        if run.get("dry_run"):
            return dispatches                    # dry run: one group per tick, so progress is visible
        # Group done — loop to start the next group in this same tick.
    return dispatches


def _advance_step(run, s, dispatches):
    if run.get("dry_run"):
        return _simulate_step(run, s)
    if s["step_action"] in EC2_POWER_ACTIONS:
        return _advance_ec2_power(s, dispatches)
    op = run["op"]
    if s["status"] == "PENDING":
        s.update(status="RUNNING", phase="action", job_id=str(uuid.uuid4()),
                 started_at=_now_iso(), phase_started_at=_now_iso())
        dispatches.append((s, "action"))
        return
    if s["status"] != "RUNNING":
        return

    age = _age_seconds(s.get("phase_started_at"))

    if s["phase"] == "verify_wait":
        if age >= VERIFY_RETRY_SEC:
            s.update(phase="verify", verify_job_id=str(uuid.uuid4()), phase_started_at=_now_iso())
            dispatches.append((s, "verify"))
        return

    job_id = s["verify_job_id"] if s["phase"] == "verify" else s["job_id"]
    job = get_job_by_id(job_id)
    if job is None:
        if age > JOB_CREATE_GRACE_SEC:
            _fail(s, f"Job {job_id} was not created")
        return
    status = job.get("status")
    if status not in _sl.TERMINAL_STATUSES:
        limit = STEP_TIMEOUT_SEC if s["phase"] == "action" else VERIFY_TIMEOUT_SEC
        if age > limit:
            _fail(s, f"No result after {limit // 60} min (job {job_id} still {status})")
        return
    if status in FAILED_JOB_STATUSES:
        _fail(s, f"{'Status check' if s['phase'] == 'verify' else s['step_action']} job {status}: {_job_error(job)}")
        return

    raw = job.get("qualys_output", "") or ""

    if s["step_action"] == "ec2_check":
        state = job.get("ec2_state")
        s["verified_state"] = state
        if state == "running":
            _succeed(s, "EC2 instance is running")
        else:
            _fail(s, f"Server {s.get('host') or s['instance_id']} is {state or 'in an unknown state'} — "
                     "start the EC2 instance first (EC2 start is not part of this action)")
        return

    parsed = _sl._parse_script_json(raw)
    if s["phase"] == "action":
        s["action_summary"] = (_sl._summarize_status(parsed) if parsed
                               else ("no output" if not raw.strip() else raw.strip()[-300:]))
        # Fast path: the stop/start script validates its own result. If its
        # output clearly confirms the expected state, skip the status script.
        confirmed = _confirmed_by_action_output(parsed, op) if (parsed and TRUST_SCRIPT_RESULT) else None
        if confirmed:
            s["verified_state"] = EXPECTED[op]
            s["output"] = json.dumps(parsed, separators=(",", ":"))
            _succeed(s, f"{EXPECTED[op]} — {confirmed} (confirmed by the {op} script)")
            return
        if s.get("status_script"):
            s.update(phase="verify", verify_job_id=str(uuid.uuid4()),
                     phase_started_at=_now_iso(), verify_attempts=0)
            dispatches.append((s, "verify"))
        else:
            # No status script: judge from the stop/start script's own validation.
            verdict = s["action_summary"].split(" ", 1)[0] if parsed else "UNKNOWN"
            s["verified_state"] = verdict
            s["output"] = json.dumps(parsed, separators=(",", ":")) if parsed else raw[-2000:]
            if verdict == EXPECTED[op]:
                _succeed(s, f"{s['action_summary']} (from the {op} script; no status script configured)")
            else:
                _fail(s, f"Expected {EXPECTED[op]} — {s['action_summary']}")
        return

    # phase == verify
    s["verify_attempts"] = int(s.get("verify_attempts", 0)) + 1
    summary = (_sl._summarize_status(parsed) if parsed
               else ("UNKNOWN — status script produced no output" if not raw.strip()
                     else "UNKNOWN — status script output is not JSON"))
    verdict = summary.split(" ", 1)[0]
    s["verified_state"] = verdict
    s["output"] = json.dumps(parsed, separators=(",", ":")) if parsed else raw[-2000:]
    s["message"] = summary
    if verdict == EXPECTED[op]:
        _succeed(s, summary)
    elif s["verify_attempts"] < VERIFY_ATTEMPTS:
        s.update(phase="verify_wait", phase_started_at=_now_iso())
    else:
        _fail(s, f"Expected {EXPECTED[op]} after {s['verify_attempts']} checks — {summary}")


def _simulate_step(run, s):
    """Dry run: never creates a job. The step is marked as it would end."""
    if s["status"] != "PENDING":
        return
    host = s.get("host") or s["instance_id"]
    now = _now_iso()
    if s["step_action"] in EC2_POWER_ACTIONS:
        verb, state = ("stop", "stopped") if s["step_action"] == "ec2_stop" else ("start", "running")
        text = f"DRY RUN — would {verb} EC2 server {host} (no request sent; server not touched)"
    elif s["step_action"] == "ec2_check":
        state, text = "running", f"DRY RUN — would check that {host} is running"
    else:
        state = EXPECTED[run["op"]]
        text = f"DRY RUN — would run the {run['op']} script for {s['label']} on {host} (nothing run)"
    s.update(status="SUCCEEDED", phase=None, started_at=now, finished_at=now,
             verified_state=f"SIMULATED {state.upper()}", message=text)


def _on(v):
    return v is True or str(v).strip().lower() in ("true", "1", "yes")


def _pending_tick(run, seq):
    """While waiting for approval: expire the request when its time is up,
    otherwise keep the tick chain alive (one tick per PENDING_TICK_SECONDS)."""
    logger.info(f"sap_runs: waiting for approval of {run['run_id']} (tick {seq}, "
                f"{int(run['approval']['expires_epoch'] - _time.time())}s left)")
    if run["approval"].get("channel") == "email" and _check_mailbox(run):
        return True                          # a reply decided the request (the run moved on)
    if run["approval"].get("poll_url") and _check_flow(run):
        return True                          # the Teams card was answered (the run moved on)
    left = run["approval"]["expires_epoch"] - _time.time()
    if left <= 0:
        run.update(status="EXPIRED", finished_at=_now_iso(),
                   error=f"No approval within {run['approval']['minutes']} minutes; nothing was run")
        run["approval"]["decision"] = "expired"
        due = _due_notices(run)
        if _save_if(run, seq, PENDING, bump=True):
            _finish(run)
            _send_notices(run, due)
            if run["approval"].get("channel") == "email":
                _status_email(run, f"⌛ {_run_label(run)} — EXPIRED: no approval within "
                                   f"{run['approval']['minutes']} minutes. Nothing was run.")
        return True
    run["last_tick_at"] = _now_iso()          # so the stall check does not re-send ticks while waiting
    if _save_if(run, seq, PENDING, bump=True):
        _send_tick(run["run_id"], seq + 1, min(PENDING_TICK_SECONDS, int(left) + 1))
    return True


def _decide(event, body, sid):
    """run_decision via /notify-sync: only an approval client (client credentials)."""
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {}) or {}
    client_id = claims.get("client_id")
    if claims.get("username") or not client_id or client_id not in APPROVAL_CLIENT_IDS:
        return _resp(403, {"error": "forbidden", "reason": "approval_client_only",
                           "message": "Approvals are accepted only from the RunStack approval flow."})
    return _apply_decision(body, sid)


def handle_teams_decision(body):
    """Teams callback through POST /dr-failover/<any>/approve. The caller
    (dr_failover.handle_dr_approve) has ALREADY verified the Teams approve
    shared secret. The reply also carries a Teams message so a flow cloned
    from the SQL DR approval flow can post the body as it is."""
    sid = str(body.get("sid") or "").strip().upper()
    if not sid:
        return _teams_resp(_resp(400, {"error": "sid is required", "message": "No action taken: sid is missing."}))
    r = _apply_decision(body, sid)
    try:
        out = json.loads(r.get("body") or "{}")
    except (TypeError, ValueError):
        out = {}
    run = _load_run(str(body.get("job_id") or "")) if is_run_id(body.get("job_id")) else None
    reposted = False
    if (run and out.get("result") in ("self_approval", "not_an_approver") and run["status"] == PENDING
            and _time.time() < run["approval"]["expires_epoch"]):
        # A Teams card takes one response; after a refused click post a fresh
        # card so a real approver can still decide before the request expires.
        reposted, _ = _post_card(run, run.get("notify") or {},
                                 note=f"Previous response not accepted: {out.get('message')}")
        out["card_reposted"] = reposted
        r = {**r, "body": json.dumps(out, default=decimal_default)}
    return _teams_resp(r, run, reposted)


def _teams_resp(r, run=None, reposted=False):
    """Adds a Teams message to the reply: the result plus the request details
    (requested by, decision, who, sequence, status), so the details stay in
    the channel after the approval card is replaced."""
    try:
        body = json.loads(r.get("body") or "{}")
    except (TypeError, ValueError):
        body = {}
    text = body.get("message") or body.get("error") or "No action taken."
    colour = {"approved": "Good", "rejected": "Attention"}.get(body.get("result"), "Warning" if r.get("statusCode", 200) >= 400 else "Default")
    blocks = [{"type": "TextBlock", "text": text, "wrap": True, "weight": "Bolder", "color": colour}]
    if run:
        appr = run.get("approval") or {}
        facts = _request_facts(run) + [{"title": "Status", "value": run["status"]}]
        if appr.get("decided_by"):
            facts.append({"title": "Decision", "value": f"{appr.get('decision')} by {appr['decided_by']} at {_display(appr.get('decided_at'))}"})
        if appr.get("comment"):
            facts.append({"title": "Comment", "value": appr["comment"]})
        blocks.append({"type": "FactSet", "facts": facts})
        blocks.append({"type": "TextBlock", "text": "Sequence", "weight": "Bolder", "spacing": "Medium"})
        blocks += [{"type": "TextBlock", "text": line, "wrap": True, "spacing": "None"} for line in _sequence_lines(run) or ["—"]]
        if reposted:
            blocks.append({"type": "TextBlock", "wrap": True, "spacing": "Medium", "color": "Accent",
                           "text": "A new approval card has been posted for an approver."})
    body.update({"type": "message", "attachments": [{
        "contentType": "application/vnd.microsoft.card.adaptive",
        "content": {"$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard",
                    "version": "1.4", "body": blocks}}]})
    # Same card as a JSON string, for "Post card in a chat or channel".
    body["card_json"] = json.dumps(body["attachments"][0]["content"])
    # Always 200 to Teams (like the DR approve route): a refused click is a
    # normal answer, not a failure, so the flow completes and posts the card.
    # The real outcome stays in "result" / "http_status".
    body["http_status"] = r.get("statusCode", 200)
    return {**r, "statusCode": 200, "body": json.dumps(body, default=decimal_default)}


def _shared_secret_configured():
    try:
        return bool(get_teams_approve_shared_secret())
    except Exception:
        return False


def _apply_decision(body, sid):
    run, err = _run_for_request(body, sid)
    if err:
        return err
    label = _run_label(run)
    decision = str(body.get("decision") or "").strip().lower()
    if decision not in ("approve", "reject"):
        return _resp(400, {"error": "decision must be 'approve' or 'reject'"})
    responders = {str(body.get(k) or "").strip().lower() for k in ("approver_email", "approver_upn")} - {""}
    appr = run.get("approval") or {}
    if run["status"] == PENDING and not hmac.compare_digest(str(body.get("approval_token") or ""),
                                                            str(appr.get("token") or "")):
        return _resp(403, {"result": "invalid_token", "message": "No action taken: this card does not match the request."})
    return _decide_core(run, decision, responders, body.get("comment"))


def _decide_core(run, decision, responders, comment=None, decided_at=None):
    """Every approval channel ends here: Teams callback, approval client, e-mail reply."""
    label = _run_label(run)
    who = sorted(responders)[0] if responders else "unknown"
    appr = run.get("approval") or {}
    if run["status"] != PENDING:
        return _resp(409, {"result": "not_pending", "status": run["status"],
                           "message": f"No action taken: the {label} request is already {run['status']}."})
    if (decided_at or _time.time()) > appr["expires_epoch"]:
        return _resp(409, {"result": "expired",
                           "message": f"No action taken: the {label} request expired at {_display(appr['expires_at'])}."})
    allowed = {a.lower() for a in appr.get("approvers", [])}
    approver = next((r for r in responders if r in allowed), None)
    if not approver:
        return _resp(403, {"result": "not_an_approver",
                           "message": f"No action taken: {who} is not an approver for {label}."})
    if approver == str(run.get("initiated_by") or "").lower() or responders & {str(run.get("initiated_by") or "").lower()}:
        return _resp(403, {"result": "self_approval",
                           "message": f"No action taken: {approver} raised this request and cannot approve it."})

    seq = int(run.get("tick_seq", 0))
    comment = str(comment or "").strip()[:500] or None
    appr.update(decided_by=approver, decided_at=_now_iso(), comment=comment)

    if decision == "reject":
        appr["decision"] = "rejected"
        run.update(status="REJECTED", finished_at=_now_iso(), error=f"Rejected by {approver}")
        if not _save_if(run, seq, PENDING, bump=True):
            return _resp(409, {"result": "conflict", "message": "No action taken: the request changed meanwhile."})
        _finish(run)
        return _resp(200, {"result": "rejected", "status": "REJECTED",
                           "message": f"❌ {label} rejected by {approver} at {_display(appr['decided_at'])}. Nothing was run."})

    denied = _recheck_requester(run)
    if denied:
        appr["decision"] = "refused"
        run.update(status="FAILED", finished_at=_now_iso(),
                   error=f"Approved by {approver}, but the requester is no longer authorized: {denied}")
        if _save_if(run, seq, PENDING, bump=True):
            _finish(run)
        return _resp(409, {"result": "requester_not_authorized", "message": f"Not started: {run['error']}"})

    appr["decision"] = "approved"
    run.update(status="RUNNING", started_at=_now_iso(), last_tick_at=_now_iso())
    if not _save_if(run, seq, PENDING, bump=True):
        return _resp(409, {"result": "conflict", "message": "No action taken: the request changed meanwhile."})
    _send_tick(run["run_id"], seq + 1, 0)
    return _resp(200, {"result": "approved", "status": "RUNNING",
                       "message": f"✅ {label} approved by {approver} at {_display(appr['decided_at'])}. The run has started."})


# ── Approval by e-mail ───────────────────────────────────────────────────

_DECISION_WORDS = {"approve": "approve", "approved": "approve", "reject": "reject", "rejected": "reject"}


def _mailbox():
    return (_mail_creds().get("sender") or MAIL_SENDER).strip()


def _approval_email(run):
    """The approval request: details + Approve / Reject buttons (mailto: replies)."""
    appr, label = run["approval"], _run_label(run)
    box = _mailbox()
    ref = run["run_id"]
    app = _app_label(run)

    def mailto(word):
        subject = f"{word} · {ref} · {app}"
        body = f"{word}\n\nComment (optional):\n\n\n— Reference: {ref} (please keep this line)"
        return f"mailto:{box}?subject={urllib.parse.quote(subject)}&body={urllib.parse.quote(body)}"

    btn = ('<a href="{href}" style="{f};display:inline-block;background:{c};color:#ffffff;text-decoration:none;'
           'font-weight:700;font-size:14px;padding:10px 22px;border-radius:4px;margin-right:10px">{t}</a>')
    facts = "".join(f'<tr><td style="{_FONT};padding:4px 10px;color:#616E7C;width:160px;font-size:13px">{_h(x["title"])}</td>'
                    f'<td style="{_FONT};padding:4px 10px;font-size:13px">{_h(x["value"])}</td></tr>' for x in _request_facts(run))
    seq = "".join(f'<div style="{_FONT};font-size:13px;padding:2px 0">{_h(line)}</div>' for line in _sequence_lines(run))
    html = (f'<table width="680" cellpadding="0" cellspacing="0" style="{_FONT};border:1px solid #DDE1E6">'
            f'<tr><td style="{_FONT};background:#0F3557;color:#fff;padding:16px 24px;font-size:17px;font-weight:600">'
            f'EIT RunStack | Approval Request</td></tr>'
            f'<tr><td style="{_FONT};padding:16px 24px 4px;font-size:14px;color:#1F2933">Hi '
            + ", ".join(f'<a href="mailto:{_h(a)}" style="{_FONT};color:#0F6CBD;font-weight:600;text-decoration:none;'
                        f'background:#EBF3FC;padding:1px 4px;border-radius:3px">@{_h(a)}</a>' for a in appr["approvers"])
            + ', your approval is needed.</td></tr>'
            f'<tr><td style="{_FONT};padding:8px 24px 16px;font-size:15px;font-weight:700;color:#1F2933">{_h(label)}</td></tr>'
            f'<tr><td style="{_FONT};padding:0 24px 12px;font-size:14px;color:#1F2933">'
            f'{_h(run["initiated_by"])} has asked to run this. Nothing runs until an approver approves it. '
            f'<b>This request expires at {_h(_display(appr["expires_at"]))}.</b></td></tr>'
            f'<tr><td style="{_FONT};padding:0 24px 12px"><table width="100%" cellpadding="0" cellspacing="0" '
            f'style="{_FONT};border:1px solid #DDE1E6">{facts}</table></td></tr>'
            f'<tr><td style="{_FONT};padding:0 24px 4px;font-size:14px;font-weight:600;color:#0F3557">Sequence</td></tr>'
            f'<tr><td style="{_FONT};padding:0 24px 16px">{seq}</td></tr>'
            f'<tr><td style="{_FONT};padding:4px 24px 8px">'
            + btn.format(href=mailto("APPROVE"), f=_FONT, c="#1C7C54", t="✅ Approve")
            + btn.format(href=mailto("REJECT"), f=_FONT, c="#B42318", t="❌ Reject")
            + f'</td></tr><tr><td style="{_FONT};padding:4px 24px 16px;font-size:12px;color:#616E7C">'
            f'Clicking a button opens a ready-made reply to {_h(box)} — just press <b>Send</b> '
            f'(you can add a comment). You can also simply reply with APPROVE or REJECT. Only the approvers listed '
            f'for this application can approve, and the requester cannot approve their own request. '
            f'RunStack never asks for your password.</td></tr>'
            f'<tr><td style="{_FONT};padding:12px 24px;font-size:12px;color:#616E7C;border-top:1px solid #EEF1F4">'
            f'Automated message from EIT RunStack. Reference: {_h(ref)}</td></tr></table>')
    cc = [e for e in dict.fromkeys([str(run.get("initiated_by") or "").lower()] + appr.get("channel_email", []))
          if "@" in e and e not in appr["approvers"]]
    subject = f"[RunStack] Approval needed: {label} — expires {_display(appr['expires_at'])} — Ref {ref}"
    return {"kind": "email", "to": "; ".join(appr["approvers"]), "cc": "; ".join(cc), "subject": subject, "html": html}


def _status_email(run, text, to=None):
    """Short e-mail about the request (decision accepted / refused / expired / cancelled)."""
    appr = run.get("approval") or {}
    people = to or ([str(run.get("initiated_by") or "").lower()] + appr.get("approvers", []))
    # A note to one person (e.g. "you are not an approver") stays private;
    # request-wide news (decision, expiry, cancel) also goes to the channel.
    rcpt = [e for e in dict.fromkeys(people + ([] if to else appr.get("channel_email", []))) if "@" in e]
    if not (MAIL_CONFIGURED and rcpt):
        return
    html = (f'<div style="{_FONT};font-size:14px;color:#1F2933">{_h(text)}</div>'
            f'<div style="{_FONT};font-size:12px;color:#616E7C;margin-top:12px">EIT RunStack · Reference: {_h(run["run_id"])}</div>')
    _send_mail({"kind": "email", "to": "; ".join(rcpt), "cc": "",
                "subject": f"[RunStack] {text.split('. ')[0][:150]} — Ref {run['run_id']}", "html": html})


def _graph_get(url):
    c = _mail_creds()
    _, tok = _http_json(f"https://login.microsoftonline.com/{c['tenant_id']}/oauth2/v2.0/token",
                        {"grant_type": "client_credentials", "client_id": c["client_id"],
                         "client_secret": c["client_secret"], "scope": "https://graph.microsoft.com/.default"}, {}, form=True)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok.get('access_token')}"}, method="GET")
    with urllib.request.urlopen(req, timeout=FLOW_TIMEOUT_SEC) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _mailbox_replies(run):
    """Inbox messages received since the request that carry its ID. [] on any error."""
    since = run.get("requested_at") or _now_iso()
    url = (f"https://graph.microsoft.com/v1.0/users/{urllib.parse.quote(_mailbox())}/mailFolders/inbox/messages"
           f"?$filter={urllib.parse.quote(f'receivedDateTime ge {since}')}"
           f"&$select=id,subject,from,sender,bodyPreview,receivedDateTime&$top=50")
    try:
        msgs = _graph_get(url).get("value", [])
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:400]
        except Exception:
            detail = ""
        logger.warning(f"sap_runs: mailbox read failed for {run['run_id']}: HTTP {e.code} {detail}")
        return []
    except Exception as e:
        logger.warning(f"sap_runs: mailbox read failed for {run['run_id']}: {e}")
        return []
    rid = run["run_id"].lower()
    hits = [m for m in msgs if rid in (str(m.get("subject") or "") + " " + str(m.get("bodyPreview") or "")).lower()]
    logger.info(f"sap_runs: mailbox {_mailbox()} checked for {run['run_id']}: "
                f"{len(msgs)} new message(s) since {since}, {len(hits)} about this request")
    return hits


def _parse_reply(msg):
    """(decision, comment) from a reply, or (None, None). The first decision word
    in the subject (after RE:/FW:) or else in the first line of the text counts."""
    subject = re.sub(r"^\s*((re|fw|fwd|aw)\s*:\s*)+", "", str(msg.get("subject") or ""), flags=re.I)
    text = str(msg.get("bodyPreview") or "")
    text = re.split(r"\n\s*(from:|-----|________________|— reference:)", text, flags=re.I)[0]
    for source in (subject, text.strip().splitlines()[0] if text.strip() else ""):
        m = re.match(r"\s*(approved|approve|rejected|reject)\b", source, flags=re.I)
        if m:
            comment = re.sub(r"^\s*(approved|approve|rejected|reject)\b", "", text.strip(), flags=re.I)
            comment = re.sub(r"comment \(optional\):", "", comment, flags=re.I).strip()
            return _DECISION_WORDS[m.group(1).lower()], (comment[:500] or None)
    return None, None


def _received_epoch(msg):
    try:
        return datetime.strptime(str(msg.get("receivedDateTime"))[:19], "%Y-%m-%dT%H:%M:%S").replace(
            tzinfo=timezone.utc).timestamp()
    except (TypeError, ValueError):
        return None


def _check_mailbox(run):
    """Apply the first valid e-mail decision. Returns True when the request was decided."""
    appr = run["approval"]
    done = set(appr.get("processed") or [])
    for msg in sorted(_mailbox_replies(run), key=lambda m: str(m.get("receivedDateTime"))):
        if msg.get("id") in done:
            continue
        appr.setdefault("processed", []).append(msg.get("id"))
        sender = str(((msg.get("from") or {}).get("emailAddress") or {}).get("address") or "").lower()
        actual = str(((msg.get("sender") or {}).get("emailAddress") or {}).get("address") or sender).lower()
        decision, comment = _parse_reply(msg)
        if not sender:
            continue
        if not decision:
            _status_email(run, f"No action taken: your reply about {_run_label(run)} did not start with "
                               "APPROVE or REJECT. Please use the buttons in the approval e-mail.", to=[sender])
            continue
        if actual != sender:
            _status_email(run, f"No action taken: the reply was sent by {actual} on behalf of {sender}. "
                               "The approver must reply from their own mailbox.", to=[sender])
            continue
        r = _decide_core(run, decision, {sender}, comment, decided_at=_received_epoch(msg))
        out = json.loads(r["body"])
        logger.info(f"sap_runs: e-mail {decision} from {sender} for {run['run_id']}: {out.get('result')}")
        if out.get("result") in ("approved", "rejected", "requester_not_authorized"):
            _status_email(run, out["message"],
                          to=[sender, str(run.get("initiated_by") or "").lower()] + appr.get("approvers", []))
            return True
        _status_email(run, out.get("message") or "No action taken.", to=[sender])
        if out.get("result") in ("expired", "not_pending", "conflict"):
            return out.get("result") != "expired"
    return False


def _recheck_requester(run):
    """Requester's SAP + EC2 authorization at approval time (access may have
    changed while the request waited). Returns a reason, or None if allowed."""
    ev = {"requestContext": {"authorizer": {"claims": run.get("auth_claims") or run.get("claims") or {}}}}
    checks = [("sap_start_stop", None)] + [("ec2_stop_start", iid) for iid in run.get("ec2_locks") or []]
    for key, iid in checks:
        denied = authorize_action(ev, key, resource_id=iid) if iid else authorize_action(ev, key)
        if denied:
            try:
                return json.loads(denied.get("body") or "{}").get("message") or "not authorized"
            except (TypeError, ValueError):
                return "not authorized"
    return None


def get_sid_config(sid):
    """The SID's settings row ("_CONFIG") in runstack-sap-instance-details, or {}."""
    item = get_sap_instance(sid, CONFIG_COMPONENT) or {}
    return json.loads(json.dumps(item, default=decimal_default))


def approval_required(cfg):
    on = cfg.get("approval_required")
    return bool(APPROVAL_ENABLED and (on is True or str(on).strip().lower() in ("true", "1", "yes")))


def _emails(value):
    if isinstance(value, (list, set, tuple)):
        items = value
    else:
        items = str(value or "").replace(";", ",").split(",")
    return [str(e).strip().lower() for e in items if str(e).strip()]


def _approval_channel(cfg):
    return "email" if str(cfg.get("approval_channel") or "").strip().lower() == "email" else "teams"


def _approval_setup_problem(cfg):
    if _approval_channel(cfg) == "email":
        if not _emails(cfg.get("approvers")):
            return "Approval is required for this SID but its settings are incomplete (approvers)."
        if not MAIL_CONFIGURED:
            return "Approval by e-mail is set for this SID but Graph mail is not configured (GRAPH_MAIL_*)."
        return None
    missing = [k for k in ("teams_team_id", "teams_channel_id") if not cfg.get(k)]
    if not _emails(cfg.get("approvers")):
        missing.append("approvers")
    if missing:
        return f"Approval is required for this SID but its settings are incomplete ({', '.join(missing)})."
    if not APPROVAL_FLOW_URL:
        return "Approval is required for this SID but the Teams approval flow is not configured (SAP_APPROVAL_FLOW_URL)."
    if not APPROVAL_CLIENT_IDS and not _shared_secret_configured():
        return ("Approval is required for this SID but the approval callback is not configured "
                "(Teams approve shared secret or SAP_APPROVAL_CLIENT_IDS).")
    return None


def _new_approval(cfg):
    try:
        minutes = max(1, int(cfg.get("approval_minutes") or APPROVAL_MINUTES_DEFAULT))
    except (TypeError, ValueError):
        minutes = APPROVAL_MINUTES_DEFAULT
    expires = int(_time.time()) + minutes * 60
    return {"token": secrets.token_urlsafe(24), "minutes": minutes, "expires_epoch": expires,
            "expires_at": datetime.fromtimestamp(expires, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "approvers": _emails(cfg.get("approvers")), "channel_name": cfg.get("teams_channel_name"),
            "mention": _on(cfg.get("mention_approvers")),
            "channel": _approval_channel(cfg), "channel_email": _emails(cfg.get("channel_email")),
            "processed": [],
            "decision": None, "decided_by": None, "decided_at": None, "comment": None}


def _notify_settings(cfg):
    mode = str(cfg.get("backup_incident") or "off").strip().lower()
    return {"backup_incident": mode if mode in ("test", "on") else "off",
            "backup_incident_group": str(cfg.get("backup_incident_group") or "").strip() or None,
            "backup_emails": _emails(cfg.get("backup_emails")), "backup_cc": _emails(cfg.get("backup_cc")),
            "summary_emails": _emails(cfg.get("notify_emails")),
            "teams_team_id": cfg.get("teams_team_id"), "teams_channel_id": cfg.get("teams_channel_id"),
            "teams_channel_name": cfg.get("teams_channel_name")}


def _app_label(run):
    """How the system is named in titles and subjects. "_CONFIG".display_name
    (e.g. "Global Trade Services – Development") wins; else "GTS (G1D)"."""
    if run.get("display_name"):
        return run["display_name"]
    return f"{run['app_name']} ({run['sid']})" if run.get("app_name") else run["sid"]


def _app_fact(run):
    """The 'Application' detail: full name with the short name, e.g.
    "Global Trade Services (GTS)"."""
    full, short = run.get("display_name"), run.get("app_name")
    if full and short and short.lower() not in full.lower():
        return f"{full} ({short})"
    return full or short or "—"


def _action_text(run):
    """e.g. "Full-stack stop (SAP components + EC2 servers) — Cost optimization".
    The purpose comes from "_CONFIG".purpose."""
    if run.get("full_stack"):
        text = f"Full-stack {run['op']} (SAP components + EC2 servers)"
    else:
        text = f"SAP {run['op']} (SAP components only)"
    return f"{text} — {run['purpose']}" if run.get("purpose") else text


def _run_label(run):
    kind = "full-stack " if run.get("full_stack") else ""
    app = _app_label(run)
    return ("[DRY RUN] " if run.get("dry_run") else "") + f"SAP {kind}{run['op']} of {app}"


def _approval_view(run):
    a = run.get("approval")
    if not a:
        return None
    return {"required": True, "decision": a.get("decision"), "decided_by": a.get("decided_by"),
            "decided_at": a.get("decided_at"), "comment": a.get("comment"), "expires_at": a.get("expires_at"),
            "minutes": a.get("minutes"), "approvers": a.get("approvers"), "method": a.get("channel") or "teams",
            "teams_decision": (None if a.get("channel") == "email"
                               else "collected by RunStack" if a.get("collect")
                               else "flow callback"),
            "channel": (f"e-mail to {', '.join(a.get('approvers') or [])}" if a.get("channel") == "email"
                        else f"the {a.get('channel_name') or 'app team'} Teams channel")}


# ── Teams card and notifications ─────────────────────────────────────────

def _sequence_lines(run):
    sap = [s for s in run["steps"] if s["step_action"] not in EC2_STEP_ACTIONS]
    ec2 = [s for s in run["steps"] if s["step_action"] in EC2_POWER_ACTIONS]
    lines = [f"{i}. {s['label']} — {s.get('host') or s['instance_id']}" for i, s in enumerate(sap, 1)]
    if not ec2:
        return lines
    names = [s.get("host") or s["instance_id"] for s in ec2]
    # Same servers as the components listed: say so instead of repeating them.
    same = set(names) == {s.get("host") or s["instance_id"] for s in sap}
    n = len(ec2)
    what = (f"all {n} EC2 server{'s' if n != 1 else ''} {'above' if run['op'] == 'stop' else 'below'}"
            if same else f"{n} EC2 server{'s' if n != 1 else ''}: {', '.join(names)}")
    if run["op"] == "stop":
        lines.append(f"Then stop {what}")
    else:
        lines.insert(0, f"First start {what}")
    return lines


def _request_facts(run):
    appr = run.get("approval") or {}
    envs = sorted({str(s.get("environment") or "") for s in run["steps"] if s.get("environment")})
    facts = [
        {"title": "Requested by", "value": run["initiated_by"]},
        {"title": "Action", "value": _action_text(run)},
        {"title": "SID", "value": run["sid"]},
        {"title": "Application", "value": _app_fact(run)},
        {"title": "Environment", "value": ", ".join(envs) or "—"},
        {"title": "Requested at", "value": _display(run.get("requested_at"))},
    ]
    if appr.get("expires_at"):
        facts.append({"title": "Expires at", "value": f"{_display(appr['expires_at'])} ({appr.get('minutes')} min)"})
    facts.append({"title": "Request ID", "value": run["run_id"]})
    if run.get("dry_run"):
        facts.append({"title": "Mode", "value": "DRY RUN — nothing is stopped or started, even if approved"})
    return facts


def _approval_payload(run, cfg, note=None):
    """Body for the approval flow. 'card_json' goes straight into "Post adaptive
    card and wait for a response"; the flow echoes run_id, sid and
    approval_token back in its decision call. note: shown at the top of a
    re-posted card (after a refused response)."""
    appr = run["approval"]
    label = _run_label(run)
    seq_lines = _sequence_lines(run)
    title = f"Approval needed: {label}"
    card = {
        "type": "AdaptiveCard", "$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "version": "1.4",
        "body": ([{"type": "TextBlock", "text": note, "wrap": True, "color": "Attention"}] if note else []) + [
            {"type": "TextBlock", "text": title, "weight": "Bolder", "size": "Medium", "wrap": True},
            {"type": "FactSet", "facts": _request_facts(run)},
            {"type": "TextBlock", "text": "Sequence", "weight": "Bolder", "spacing": "Medium"},
        ] + [{"type": "TextBlock", "text": line, "wrap": True, "spacing": "None"} for line in seq_lines or ["—"]] + [
            {"type": "Input.Text", "id": "comment", "placeholder": "Comment (optional)", "isMultiline": True},
        ],
        "actions": [
            {"type": "Action.Submit", "title": "Approve", "style": "positive", "data": {"decision": "approve"}},
            {"type": "Action.Submit", "title": "Reject", "style": "destructive", "data": {"decision": "reject"}},
        ],
    }
    if appr.get("mention") and appr.get("approvers"):
        # @mention each approver (Teams notifies them). Opt-in per SID with
        # "_CONFIG".mention_approvers = true; Teams resolves the user by UPN.
        tags = [f"<at>{a}</at>" for a in appr["approvers"]]
        card["body"].insert(1 if note else 0, {"type": "TextBlock", "wrap": True,
                                               "text": "Approvers: " + ", ".join(tags)})
        card["msteams"] = {"entities": [{"type": "mention", "text": f"<at>{a}</at>",
                                         "mentioned": {"id": a, "name": a}} for a in appr["approvers"]]}
    summary = (f"{label} · requested by {run['initiated_by']} at {_display(run['requested_at'])} · "
               f"expires {_display(appr['expires_at'])} · {run['run_id']}")
    return {"kind": "sap_run", "run_id": run["run_id"], "sid": run["sid"], "app_name": run.get("app_name"), "op": run["op"],
            "full_stack": bool(run.get("full_stack")), "requested_by": run["initiated_by"],
            "approval_token": appr["token"], "approvers": appr["approvers"], "expires_at": appr["expires_at"],
            "teams_team_id": cfg.get("teams_team_id"), "teams_channel_id": cfg.get("teams_channel_id"),
            "title": title, "summary": summary, "card": card, "card_json": json.dumps(card)}


def _due_notices(run):
    """Notices that became due in this tick. They are marked 'sending' on the run
    BEFORE it is saved, so a duplicate tick can never send them again."""
    due, notices, n = [], run.setdefault("notices", {}), run.get("notify") or {}
    can_mail = bool(MAIL_CONFIGURED or NOTIFY_FLOW_URL)
    ec2 = [s for s in run["steps"] if s["step_action"] in EC2_POWER_ACTIONS]
    backup_time = run.get("full_stack") and (
        (run["op"] == "stop" and run["status"] == "SUCCEEDED")
        or (run["op"] == "start" and ec2 and all(s["status"] == "SUCCEEDED" for s in ec2)))
    if (backup_time and n.get("backup_incident", "off") != "off" and n.get("backup_incident_group")
            and servicenow_ticket.configured() and "backup_incident" not in notices):
        due.append("backup_incident")      # first, so the e-mail can quote the incident number
    if backup_time and can_mail and n.get("backup_emails") and "backup" not in notices:
        due.append("backup")
    if (TEAMS_POST_FLOW_URL and run.get("approval") and n.get("teams_team_id") and n.get("teams_channel_id")
            and run["status"] not in OPEN_STATUSES and "teams_result" not in notices):
        due.append("teams_result")
    for key in due:
        notices[key] = {"status": "sending", "at": _now_iso()}
    return due


def _send_notices(run, due):
    for key in due:
        if key == "backup_incident":
            t = _backup_incident(run)
            r = servicenow_ticket.create_incident(t["short_description"], t["description"],
                                                  t["group"], t["correlation_id"])
            ok = r["status"] in ("created", "dry_run", "exists")
            result = {"status": {"created": "sent", "exists": "sent"}.get(r["status"], r["status"] if ok else "failed"),
                      "at": _now_iso(), "to": t["group"], "number": r.get("number"), "url": r.get("url"),
                      "test": t["test"], "detail": None if ok else r.get("error")}
            detail = r.get("error")
            _record_notice(run, key, result, ok, detail)
            continue
        payload = _backup_email(run) if key == "backup" else _teams_result(run)
        if payload.get("kind") == "email" and MAIL_CONFIGURED:
            ok, detail = _send_mail(payload)
        elif payload.get("kind") == "teams":
            ok, detail = _post_flow(TEAMS_POST_FLOW_URL, payload)
        else:
            ok, detail = _post_flow(NOTIFY_FLOW_URL, payload)
        result = {"status": "sent" if ok else "failed", "at": _now_iso(),
                  "to": payload.get("to"), "detail": None if ok else detail}
        _record_notice(run, key, result, ok, detail)


def _record_notice(run, key, result, ok, detail):
    run["notices"][key] = result
    try:
        _locks().update_item(Key={"resource_id": f"sap-run#{run['run_id']}"},
                             UpdateExpression="SET notices.#k = :v",
                             ExpressionAttributeNames={"#k": key}, ExpressionAttributeValues={":v": result})
    except Exception as e:   # informational only
        logger.warning(f"sap_runs: could not record notice {key} for {run['run_id']}: {e}")
    if not ok:
        logger.error(f"sap_runs: notice {key} for {run['run_id']} failed: {detail}")


def _backup_incident(run):
    """ServiceNow incident for the backup team (same moment and facts as the backup e-mail)."""
    n = run["notify"]
    stop = run["op"] == "stop"
    verb = "Disable" if stop else "Enable"
    app = _app_label(run)
    ec2 = [s for s in run["steps"] if s["step_action"] in EC2_POWER_ACTIONS]
    test = bool(run.get("dry_run")) or n.get("backup_incident") == "test"
    tag = "[RunStack][TEST — PLEASE IGNORE, NO ACTION NEEDED]" if test else "[RunStack]"
    short = (f"{tag} {verb} backup — {app} — {len(ec2)} EC2 server{'s' if len(ec2) != 1 else ''} "
             f"{'stopped' if stop else 'started'}")
    appr = run.get("approval") or {}
    lines = []
    if test:
        lines += ["*** TEST TICKET — PLEASE IGNORE. NO ACTION IS NEEDED. ***",
                  ("This was raised by a RunStack DRY RUN: no server was stopped or started."
                   if run.get("dry_run") else "This ticket was raised while testing the RunStack integration."),
                  "Please close it as a test.", ""]
    lines += [(f"All EC2 servers of {app} were stopped by RunStack (SAP full-stack stop). Please DISABLE backup "
               "for the servers below until RunStack reports that they have been started again.")
              if stop else
              (f"All EC2 servers of {app} were started by RunStack and verified (running, EC2 status checks, SSM). "
               "Please ENABLE backup for the servers below."),
              "", "Servers:"]
    lines += [f"  - {s.get('host') or '—'} | {s.get('instance_id')} | IP {s.get('private_ip') or '—'} | "
              f"SAP: {', '.join(s.get('components') or []) or '—'} | {(s.get('verified_state') or '').upper() or '—'}"
              for s in ec2]
    lines += ["", f"Application: {_app_fact(run)}", f"SAP system (SID): {run['sid']}",
              f"Action: {_action_text(run)}", f"Requested by: {run.get('initiated_by')}",
              "Approved by: " + (f"{appr['decided_by']} at {_display(appr['decided_at'])}"
                                 if appr.get("decided_by") else "Not required"),
              f"RunStack request ID: {run['run_id']}", "", "Raised automatically by EIT RunStack."]
    return {"short_description": short, "description": "\n".join(lines), "group": n["backup_incident_group"],
            "correlation_id": f"{run['run_id']}:backup-{run['op']}", "test": test}


_FONT = "font-family:Segoe UI,Arial,sans-serif"


def _backup_email(run):
    stop = run["op"] == "stop"
    n = run["notify"]
    ec2 = [s for s in run["steps"] if s["step_action"] in EC2_POWER_ACTIONS]
    app = _app_label(run)
    verb = "Disable" if stop else "Enable"
    subject = f"[RunStack] ACTION REQUIRED: {verb} backup — {app} servers {'stopped' if stop else 'started'}"
    if run.get("dry_run"):
        subject = f"[RunStack] [DRY RUN — TEST, NO ACTION] {verb} backup — {app}"
    intro = (f"All EC2 servers of {app} were stopped by RunStack. Please <b>disable backup</b> for the servers "
             "below until RunStack reports that they have been started again."
             if stop else
             f"All EC2 servers of {app} were started by RunStack and verified (running, EC2 status checks, SSM). "
             "Please <b>enable backup</b> for the servers below.")
    if run.get("dry_run"):
        intro = ("<b>DRY RUN — this is a test. No server was stopped or started and no action is needed.</b> "
                 "This is the e-mail the Backup team would receive: " + intro)
    inc = (run.get("notices") or {}).get("backup_incident") or {}
    if inc.get("number"):
        intro += f"<br><br>ServiceNow incident: <b>{_h(inc['number'])}</b> (assigned to {_h(inc.get('to'))})."
    colour = "#B26B00" if stop else "#1C7C54"
    td = f'style="{_FONT};padding:6px 10px;border-bottom:1px solid #EEF1F4;font-size:13px"'
    th = f'style="{_FONT};padding:6px 10px;border-bottom:1px solid #DDE1E6;font-size:13px;font-weight:600;background:#F5F7FA"'
    rows = "".join(
        f"<tr><td {td}>{_h(s.get('host'))}</td><td {td}>{_h(s.get('instance_id'))}</td>"
        f"<td {td}>{_h(s.get('private_ip') or '—')}</td><td {td}>{_h(', '.join(s.get('components') or []))}</td>"
        f"<td {td}>{_h((s.get('verified_state') or '').upper() or '—')}</td>"
        f"<td {td}>{_h(_display(s.get('finished_at')))}</td></tr>" for s in ec2)
    appr = run.get("approval") or {}
    details = [("SAP system (SID)", run["sid"]), ("Application", _app_fact(run)),
               ("Action", _action_text(run)), ("Requested by", run.get("initiated_by")),
               ("Approved by", f"{appr['decided_by']} at {_display(appr['decided_at'])}" if appr.get("decided_by") else "Not required"),
               ("RunStack run ID", run["run_id"])]
    drows = "".join(f'<tr><td style="{_FONT};padding:4px 10px;color:#616E7C;width:180px;font-size:13px">{_h(k)}</td>'
                    f'<td style="{_FONT};padding:4px 10px;font-size:13px">{_h(v)}</td></tr>' for k, v in details)
    html = (f'<!--[if mso]><style>table,td,div,span,a{{font-family:Segoe UI,Arial,sans-serif!important}}</style><![endif]-->'
            f'<table width="720" cellpadding="0" cellspacing="0" style="{_FONT};border:1px solid #DDE1E6">'
            f'<tr><td style="{_FONT};background:#0F3557;color:#fff;padding:16px 24px;font-size:17px;font-weight:600">'
            f'EIT RunStack | Backup Notification</td></tr>'
            f'<tr><td style="{_FONT};background:{colour};color:#fff;padding:12px 24px;font-size:15px;font-weight:700">'
            f'{verb.upper()} BACKUP — {_h(app)}</td></tr>'
            f'<tr><td style="{_FONT};padding:16px 24px;font-size:14px;color:#1F2933">{intro}</td></tr>'
            f'<tr><td style="{_FONT};padding:0 24px 16px"><table width="100%" cellpadding="0" cellspacing="0" '
            f'style="{_FONT};border:1px solid #DDE1E6"><tr><td {th}>Server</td><td {th}>Instance ID</td>'
            f'<td {th}>Private IP</td><td {th}>SAP components</td><td {th}>State</td><td {th}>Time</td></tr>'
            f'{rows}</table></td></tr>'
            f'<tr><td style="{_FONT};padding:0 24px 16px"><table width="100%" cellpadding="0" cellspacing="0" '
            f'style="{_FONT};border:1px solid #DDE1E6">{drows}</table></td></tr>'
            f'<tr><td style="{_FONT};padding:12px 24px;font-size:12px;color:#616E7C">Automated notification from '
            f'EIT RunStack. Questions: eit-ai-ops-runstack@dxc.com</td></tr></table>')
    cc = [e for e in dict.fromkeys(n.get("backup_cc", []) + [str(run.get("initiated_by") or "").lower()])
          if "@" in e and e not in n["backup_emails"]]
    return {"kind": "email", "to": "; ".join(n["backup_emails"]), "cc": "; ".join(cc),
            "subject": subject, "html": html}


def _duration(a, b):
    """'31 seconds', '5 min 21 sec', '1 hr 2 min' between two ISO times, or None."""
    try:
        f = "%Y-%m-%dT%H:%M:%SZ"
        sec = int((datetime.strptime(b, f) - datetime.strptime(a, f)).total_seconds())
    except (TypeError, ValueError):
        return None
    if sec < 0:
        return None
    h, m, x = sec // 3600, sec % 3600 // 60, sec % 60
    if h:
        return f"{h} hr {m} min"
    if m:
        return f"{m} min {x} sec"
    return f"{x} second{'s' if x != 1 else ''}"


def _summary_email(run):
    """The run summary e-mail (subject + HTML) the agent sends as-is through its
    Outlook connector once the run has finished. None while it is still open or
    when nothing ran (REJECTED / EXPIRED)."""
    if run["status"] not in ("SUCCEEDED", "FAILED", "CANCELLED"):
        return None
    op, stop, full = run["op"], run["op"] == "stop", bool(run.get("full_stack"))
    Op, OP, past = op.capitalize(), op.upper(), op_past(op)
    name = _app_label(run)
    if run["sid"].lower() not in name.lower():
        name = f"{name} ({run['sid']})"
    steps = run.get("steps", [])
    sap = [x for x in steps if x["step_action"] not in EC2_STEP_ACTIONS]
    ec2 = [x for x in steps if x["step_action"] in EC2_POWER_ACTIONS]
    n, m = len(sap), len(ec2)
    sap_ok = sum(1 for x in sap if x["status"] == "SUCCEEDED")
    ec2_ok = sum(1 for x in ec2 if x["status"] == "SUCCEEDED")
    failed = next((x for x in steps if x["status"] == "FAILED"), None)
    status = run["status"]
    dry = bool(run.get("dry_run"))
    kind = "Full-Stack " if full else "SAP "
    if status == "SUCCEEDED":
        colour = "#1C7C54"
        counts = (f"{n} SAP components and {m} EC2 servers {past}" if full and stop else
                  f"{m} EC2 servers and {n} SAP components {past}" if full else f"{n} components {past}")
        subject = f"[RunStack] {kind}{Op} Completed — {name} ({counts})"
        title = f"{'FULL-STACK' if full else 'SAP'} {OP} COMPLETED"
        sub = f"{name} · All {n} SAP components {past} and confirmed" + (f" · {m} EC2 servers {past}" if full else "")
        if stop:
            sentence = (f"All {n} SAP components of {name} were stopped one at a time, and each was confirmed "
                        "stopped before the next one began. "
                        + (f"All {m} EC2 servers were then stopped and confirmed stopped." if full
                           else "The EC2 servers are still running."))
        else:
            sentence = ((f"All {m} EC2 servers were started and confirmed ready (running, status checks passed, "
                         "SSM online). " if full else "All EC2 servers were confirmed running. ")
                        + f"Then all {n} SAP components of {name} were started one at a time, and each was "
                          "confirmed running before the next one began.")
    elif status == "FAILED":
        colour = "#B42318"
        where = failed["label"] if failed else "an unknown step"
        subject = f"[RunStack] ACTION REQUIRED: SAP {Op} Failed — {name} — {where}"
        title = f"SAP {OP} FAILED"
        sub = f"{name} · Failed at {where}: {(failed or {}).get('message') or run.get('error') or ''}"
        sentence = (f"The run stopped at {where}. Later steps were not run, and nothing was rolled back. "
                    "Please check with the SAP Basis team.")
    else:
        colour = "#B26B00"
        subject = f"[RunStack] SAP {Op} Cancelled — {name}"
        title = f"SAP {OP} CANCELLED"
        sub = f"{name} · {sap_ok} of {n} components completed before cancel"
        sentence = (f"The run was cancelled. The step in progress finished; later steps were not run. "
                    "Nothing was rolled back.")
    if dry:
        subject = "[DRY RUN — TEST, NO ACTION] " + subject
    result = {"SUCCEEDED": "Completed successfully", "FAILED": "Failed", "CANCELLED": "Cancelled"}[status]
    if dry:
        result = {"SUCCEEDED": "Dry run completed — no changes made", "FAILED": "Dry run failed",
                  "CANCELLED": "Dry run cancelled"}[status]
    appr = run.get("approval") or {}
    notices = run.get("notices") or {}
    ended = "completed" if status == "SUCCEEDED" else "ended"
    rows = [("Application", _app_fact(run)), ("SAP system (SID)", run["sid"]), ("Action", _action_text(run)),
            ("Result", result), ("Requested by", run.get("initiated_by")),
            ("Requested at", _display(run.get("requested_at"))),
            ("Approved by", f"{appr['decided_by']} at {_display(appr.get('decided_at'))}"
             if appr.get("decided_by") else "Not required"),
            (f"{Op} initiated", _display(run.get("started_at"))),
            (f"{Op} {ended}", _display(run.get("finished_at"))),
            ("Total duration", _duration(run.get("started_at"), run.get("finished_at")) or "Not available"),
            ("SAP components", f"{sap_ok} of {n} {past}"),
            ("EC2 servers", f"{ec2_ok} of {m} {past}" if full else "Not part of this run (left running)"),
            ("Failed step", f"{failed['label']}: {failed.get('message') or ''}" if failed else "None")]
    inc = notices.get("backup_incident") or {}
    if inc.get("number"):
        rows.append(("Backup incident", f"{inc['number']} ({inc.get('to')})"))
    if notices.get("backup"):
        rows.append(("Backup team e-mail", str(notices["backup"].get("status"))))
    rows.append(("RunStack request ID", run["run_id"]))
    td = f'style="{_FONT};border-bottom:1px solid #EEF1F4"'
    drows = "".join(f'<tr><td style="{_FONT};color:#616E7C;width:200px;border-bottom:1px solid #EEF1F4">{_h(k)}</td>'
                    f'<td {td}>{_h(v)}</td></tr>' for k, v in rows)
    shown = [x for x in steps if x["step_action"] != "ec2_check" or x["status"] == "FAILED"]
    res = {"SUCCEEDED": ("✅ Succeeded", "#1C7C54"), "FAILED": ("❌ Failed", "#B42318"),
           "SKIPPED": ("➖ Skipped", "#616E7C")}
    srows = ""
    for x in shown:
        text, col = res.get(x["status"], (x["status"].capitalize(), "#616E7C"))
        comp = "EC2" if x["step_action"] in EC2_STEP_ACTIONS else x["label"]
        srows += (f'<tr><td {td}>{_h(x.get("order"))}</td><td {td}>{_h(comp)}</td>'
                  f'<td {td}>{_h(x.get("host") or x.get("instance_id"))}</td>'
                  f'<td style="{_FONT};border-bottom:1px solid #EEF1F4;color:{col};font-weight:600">{text}</td>'
                  f'<td {td}>{_h(x.get("message") or "—")}</td>'
                  f'<td {td}>{_h(_display(x.get("finished_at")) if x["status"] != "SKIPPED" else "—")}</td></tr>')
    th = f'style="{_FONT};font-weight:600;border-bottom:1px solid #DDE1E6"'
    dry_line = (f'<tr><td style="{_FONT};padding:16px 24px 0;font-size:14px;color:#1F2933"><b>DRY RUN (test): no SAP '
                'component or EC2 server was actually stopped or started.</b></td></tr>' if dry else "")
    html = (f'<!--[if mso]><style>table,td,div,span,a{{font-family:Segoe UI,Arial,sans-serif!important}}</style><![endif]-->'
            f'<table width="720" cellpadding="0" cellspacing="0" style="{_FONT};border:1px solid #DDE1E6">'
            f'<tr><td style="{_FONT};background:#0F3557;color:#ffffff;padding:16px 24px;font-size:17px;font-weight:600">'
            f'EIT RunStack | SAP Operation Notification</td></tr>'
            f'<tr><td style="{_FONT};background:{colour};color:#ffffff;padding:12px 24px;font-size:15px;font-weight:700">'
            f'{_h(title)}<br><span style="{_FONT};font-size:13px;font-weight:400">{_h(sub)}</span></td></tr>'
            f'{dry_line}'
            f'<tr><td style="{_FONT};padding:16px 24px;font-size:14px;color:#1F2933">{_h(sentence)}</td></tr>'
            f'<tr><td style="{_FONT};padding:0 24px 4px;font-size:14px;font-weight:600;color:#0F3557">Run details</td></tr>'
            f'<tr><td style="{_FONT};padding:0 24px 16px"><table width="100%" cellpadding="6" cellspacing="0" '
            f'style="{_FONT};font-size:13px;border:1px solid #DDE1E6">{drows}</table></td></tr>'
            f'<tr><td style="{_FONT};padding:0 24px 4px;font-size:14px;font-weight:600;color:#0F3557">Steps</td></tr>'
            f'<tr><td style="{_FONT};padding:0 24px 16px"><table width="100%" cellpadding="6" cellspacing="0" '
            f'style="{_FONT};font-size:13px;border:1px solid #DDE1E6"><tr style="background:#F5F7FA">'
            f'<td {th}>Order</td><td {th}>Component</td><td {th}>Server</td><td {th}>Result</td>'
            f'<td {th}>Confirmed state</td><td {th}>Completed at</td></tr>{srows}</table></td></tr>'
            f'<tr><td style="{_FONT};padding:12px 24px;font-size:12px;color:#616E7C">Automated notification from '
            f'EIT RunStack. Questions: eit-ai-ops-runstack@dxc.com</td></tr></table>')
    return {"subject": subject, "html": html,
            "to": (run.get("notify") or {}).get("summary_emails") or []}


def _teams_result(run):
    icon = {"SUCCEEDED": "✅", "FAILED": "❌", "CANCELLED": "⚠️", "EXPIRED": "⌛", "REJECTED": "❌"}.get(run["status"], "ℹ️")
    appr = run.get("approval") or {}
    view = _run_view(run)
    lines = [f"<b>{icon} {_h(_run_label(run))} — {run['status']}</b>",
             f"Requested by {_h(run.get('initiated_by'))} at {_h(_display(run.get('requested_at')))}"]
    if appr.get("decided_by"):
        lines.append(f"Approved by {_h(appr['decided_by'])} at {_h(_display(appr['decided_at']))}")
    lines.append(_h(view["message"]))
    if run["status"] in ("CANCELLED", "EXPIRED") and not appr.get("decided_by"):
        lines.append("The approval card above is no longer valid; nothing was run.")
    if run.get("finished_at"):
        lines.append(f"Finished {_h(_display(run['finished_at']))} · Request {_h(run['run_id'])}")
    notices = run.get("notices") or {}
    backup, inc = notices.get("backup"), notices.get("backup_incident")
    if backup:
        lines.append(f"Backup team e-mail: {_h(backup.get('status'))}")
    if inc:
        lines.append(f"Backup ServiceNow incident: {_h(inc.get('number') or inc.get('status'))}")
    # Adaptive card for "Post card in a chat or channel" (card_json).
    colour = {"SUCCEEDED": "Good", "FAILED": "Attention", "REJECTED": "Attention"}.get(run["status"], "Warning")
    facts = _request_facts(run) + [{"title": "Status", "value": run["status"]}]
    if appr.get("decided_by"):
        facts.append({"title": "Decision", "value": f"{appr.get('decision')} by {appr['decided_by']} at {_display(appr.get('decided_at'))}"})
    if run.get("finished_at"):
        facts.append({"title": "Finished", "value": _display(run["finished_at"])})
    if backup:
        facts.append({"title": "Backup team e-mail", "value": str(backup.get("status"))})
    if inc:
        facts.append({"title": "Backup incident", "value": str(inc.get("number") or inc.get("status"))})
    blocks = [{"type": "TextBlock", "wrap": True, "weight": "Bolder", "color": colour,
               "text": f"{icon} {_run_label(run)} — {run['status']}"},
              {"type": "TextBlock", "wrap": True, "text": view["message"]}]
    if run["status"] in ("CANCELLED", "EXPIRED") and not appr.get("decided_by"):
        blocks.append({"type": "TextBlock", "wrap": True, "color": "Warning",
                       "text": "The approval card above is no longer valid; nothing was run."})
    blocks.append({"type": "FactSet", "facts": facts})
    card = {"$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard",
            "version": "1.4", "body": blocks}
    n = run["notify"]
    return {"kind": "teams", "team_id": n["teams_team_id"], "channel_id": n["teams_channel_id"],
            "subject": f"{_run_label(run)} — {run['status']}", "message_html": "<br>".join(lines),
            "card_json": json.dumps(card)}


def _mail_creds():
    """Graph app credentials from GRAPH_MAIL_SECRET_ARN or GRAPH_MAIL_* (read once per container)."""
    if not _MAIL_CREDS and not MAIL_SECRET_ARN:
        _MAIL_CREDS.update(MAIL_ENV, sender=MAIL_SENDER)
    if not _MAIL_CREDS:
        raw = boto3.client("secretsmanager").get_secret_value(SecretId=MAIL_SECRET_ARN)["SecretString"]
        sec = json.loads(raw)
        pick = lambda *names: next((str(sec[n]).strip() for n in names if sec.get(n)), "")
        _MAIL_CREDS.update(tenant_id=pick("tenant_id", "tenantId", "tenant"),
                           client_id=pick("client_id", "clientId", "app_id"),
                           client_secret=pick("client_secret", "clientSecret", "secret"),
                           sender=pick("sender", "mailbox", "from") or MAIL_SENDER)
    return _MAIL_CREDS


def _http_json(url, data, headers, form=False):
    body = (urllib.parse.urlencode(data) if form else json.dumps(data)).encode("utf-8")
    hdrs = {"Content-Type": "application/x-www-form-urlencoded" if form else "application/json", **headers}
    req = urllib.request.Request(url, data=body, headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=FLOW_TIMEOUT_SEC) as r:
        text = r.read().decode("utf-8", "replace")
        return r.status, (json.loads(text) if text.strip().startswith("{") else {})


def send_graph_mail(to, subject, html, cc=""):
    """Reusable by any RunStack module: send_graph_mail("a@dxc.com; b@dxc.com", "Subject", "<b>html</b>").
    Returns (ok, detail); never raises."""
    if not MAIL_CONFIGURED:
        return False, "Graph mail is not configured (GRAPH_MAIL_*)"
    return _send_mail({"to": to, "cc": cc, "subject": subject, "html": html})


def _send_mail(payload):
    """Send {to, cc, subject, html} with Microsoft Graph as the shared mailbox.
    Never raises; returns (ok, detail)."""
    try:
        c = _mail_creds()
        if not (c["tenant_id"] and c["client_id"] and c["client_secret"]):
            return False, "mail secret is missing tenant_id / client_id / client_secret"
        _, tok = _http_json(f"https://login.microsoftonline.com/{c['tenant_id']}/oauth2/v2.0/token",
                            {"grant_type": "client_credentials", "client_id": c["client_id"],
                             "client_secret": c["client_secret"],
                             "scope": "https://graph.microsoft.com/.default"}, {}, form=True)
        token = tok.get("access_token")
        if not token:
            return False, f"no Graph token: {str(tok)[:200]}"
        rcpt = lambda v: [{"emailAddress": {"address": a}} for a in _emails(v)]
        msg = {"message": {"subject": payload["subject"],
                           "body": {"contentType": "HTML", "content": payload["html"]},
                           "toRecipients": rcpt(payload.get("to")), "ccRecipients": rcpt(payload.get("cc"))},
               "saveToSentItems": True}
        status, _ = _http_json(f"https://graph.microsoft.com/v1.0/users/{urllib.parse.quote(c['sender'])}/sendMail",
                               msg, {"Authorization": f"Bearer {token}"})
        return 200 <= status < 300, f"Graph HTTP {status}"
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:400]
        except Exception:
            detail = ""
        logger.error(f"sap_runs: Graph mail failed HTTP {e.code}: {detail}")
        return False, f"Graph HTTP {e.code}: {detail or e.reason}"
    except Exception as e:
        logger.error(f"sap_runs: Graph mail failed: {e}")
        return False, str(e)[:300]


def _post_flow(url, payload):
    """POST JSON to a Teams Workflows HTTP trigger. Never raises."""
    ok, detail, _ = _post_flow_raw(url, payload)
    return ok, detail


def _post_flow_raw(url, payload):
    """Like _post_flow, plus the response headers (for the async Location link)."""
    if not url:
        return False, "flow URL not configured", {}
    try:
        req = urllib.request.Request(url, data=json.dumps(payload, default=decimal_default).encode("utf-8"),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=FLOW_TIMEOUT_SEC) as r:
            return 200 <= r.status < 300, f"HTTP {r.status}", dict(r.headers.items())
    except urllib.error.HTTPError as e:
        # Keep the flow's own reason (e.g. schema validation failed) so it is
        # visible in the API response and the agent, not only "HTTP 400".
        try:
            detail = e.read().decode("utf-8", "replace")
        except Exception:
            detail = ""
        logger.error(f"sap_runs: flow call failed HTTP {e.code}: {detail[:1000]}")
        return False, f"HTTP {e.code}: {detail[:400] or e.reason}", {}
    except Exception as e:
        return False, str(e)[:300], {}


def _location(headers):
    return next((v for k, v in (headers or {}).items() if k.lower() == "location"), None)


def _post_card(run, cfg, note=None):
    """Post the approval card. When the flow answers asynchronously (202 +
    Location), keep the link so RunStack can collect the decision itself."""
    ok, detail, headers = _post_flow_raw(APPROVAL_FLOW_URL, _approval_payload(run, cfg, note=note))
    loc = _location(headers) if ok else None
    appr = run["approval"]
    appr["poll_url"] = loc
    appr["poll_note"] = None
    appr["collect"] = bool(loc or appr.get("collect"))
    logger.info(f"sap_runs: approval card for {run['run_id']} posted ({detail}); "
                + ("decision will be collected from the flow" if loc else "waiting for the flow's callback"))
    if ok:
        try:   # also on the stored record (the caller may not save the run again)
            _locks().update_item(Key={"resource_id": f"sap-run#{run['run_id']}"},
                                 UpdateExpression="SET approval.poll_url = :u, approval.poll_note = :n, approval.#c = :c",
                                 ExpressionAttributeNames={"#c": "collect"},
                                 ExpressionAttributeValues={":u": loc, ":n": None, ":c": appr["collect"]})
        except Exception as e:
            logger.warning(f"sap_runs: could not store the decision link for {run['run_id']}: {e}")
    return ok, detail


def _poll_flow(url):
    """(http_status, body, headers) from the async flow's Location link. Never raises."""
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=FLOW_TIMEOUT_SEC) as r:
            text = r.read().decode("utf-8", "replace")
            try:
                body = json.loads(text) if text.strip() else {}
            except ValueError:
                body = {}
            return r.status, body if isinstance(body, dict) else {}, dict(r.headers.items())
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            detail = ""
        return e.code, {"error": detail}, {}
    except Exception as e:
        return 0, {"error": str(e)[:300]}, {}


def _check_flow(run):
    """Collect the Teams decision from the approval flow (async Response).
    Returns True when the request was decided."""
    appr = run["approval"]
    status, body, headers = _poll_flow(appr["poll_url"])
    if status == 202:
        appr["poll_url"] = _location(headers) or appr["poll_url"]
        return False                                   # nobody has clicked yet
    if status != 200:
        note = f"HTTP {status}: {str(body.get('error') or '')[:200]}"
        if appr.get("poll_note") != note:              # log each new problem once
            logger.warning(f"sap_runs: approval flow for {run['run_id']} answered {note}")
        appr["poll_note"] = note
        return False                                   # keep trying until the request expires
    appr["poll_url"] = None                            # this card's answer is used once
    token_ok = hmac.compare_digest(str(body.get("approval_token") or ""), str(appr.get("token") or ""))
    decision = _DECISION_WORDS.get(str(body.get("decision") or "").strip().lower())
    responder = str(body.get("responder") or "").strip().lower()
    if str(body.get("run_id") or body.get("job_id") or "") != run["run_id"] or not token_ok:
        logger.warning(f"sap_runs: approval flow answer for {run['run_id']} does not match the request; ignored")
        return False
    if not decision or "@" not in responder:
        logger.warning(f"sap_runs: approval flow answer for {run['run_id']} has no decision/responder; ignored")
        return False
    r = _decide_core(run, decision, {responder}, body.get("comment"))
    out = json.loads(r["body"])
    logger.info(f"sap_runs: Teams {decision} by {responder} for {run['run_id']} (collected): {out.get('result')}")
    if out.get("result") in ("approved", "rejected", "requester_not_authorized"):
        _post_teams(run, r)                           # decision + request details, in the channel
        return True
    reposted = False
    if (out.get("result") in ("self_approval", "not_an_approver") and run["status"] == PENDING
            and _time.time() < appr["expires_epoch"]):
        # The answered card is spent; post a fresh one for a real approver.
        reposted, _ = _post_card(run, run.get("notify") or {},
                                 note=f"Previous response not accepted: {out.get('message')}")
    _post_teams(run, r, reposted)
    return out.get("result") in ("not_pending", "conflict")


def _post_teams(run, r, reposted=False):
    """Post RunStack's answer to a Teams click into the channel (what the old
    callback flow posted). Never raises."""
    n = run.get("notify") or {}
    if not (TEAMS_POST_FLOW_URL and n.get("teams_team_id") and n.get("teams_channel_id")):
        logger.warning(f"sap_runs: no Teams post flow (SAP_TEAMS_POST_FLOW_URL); decision for "
                       f"{run['run_id']} not posted to the channel")
        return
    body = json.loads(_teams_resp(r, run, reposted)["body"])
    ok, detail = _post_flow(TEAMS_POST_FLOW_URL, {
        "kind": "teams", "team_id": n["teams_team_id"], "channel_id": n["teams_channel_id"],
        "subject": _run_label(run), "card_json": body["card_json"],
        "message_html": _h(body.get("message") or "")})
    if not ok:
        logger.error(f"sap_runs: Teams post for {run['run_id']} failed: {detail}")


def _h(v):
    return (str(v if v is not None else "")).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _display(iso):
    """'2026-11-02T12:50:00Z' -> '02-Nov-2026 18:20 IST' (SAP_RUN_DISPLAY_TZ_*)."""
    if not iso:
        return "—"
    try:
        t = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return str(iso)
    return t.astimezone(DISPLAY_TZ).strftime("%d-%b-%Y %H:%M:%S ") + DISPLAY_TZ_LABEL


def _advance_ec2_power(s, dispatches):
    """One server of a full-stack run.
    precheck (EC2-Action status) -> already in target state: done, nothing sent
                                 -> otherwise: AWS-Stop/StartEC2Instance job
    action -> stop : COMPLETED + ec2_state stopped
              start: COMPLETED + ec2_state running + health_outcome passed
                     (the start job itself waits for status checks and SSM)."""
    target = EC2_TARGET_STATE[s["step_action"]]
    verb = "stop" if s["step_action"] == "ec2_stop" else "start"
    host = s.get("host") or s["instance_id"]

    if s["status"] == "PENDING":
        s.update(status="RUNNING", phase="precheck", precheck_job_id=str(uuid.uuid4()),
                 started_at=_now_iso(), phase_started_at=_now_iso())
        dispatches.append((s, "precheck"))
        return
    if s["status"] != "RUNNING":
        return

    precheck = s["phase"] == "precheck"
    job_id = s["precheck_job_id"] if precheck else s["job_id"]
    age = _age_seconds(s.get("phase_started_at"))
    job = get_job_by_id(job_id)
    if job is None:
        if age > JOB_CREATE_GRACE_SEC:
            _fail(s, f"Job {job_id} was not created")
        return
    status = job.get("status")
    if status not in _sl.TERMINAL_STATUSES:
        limit = VERIFY_TIMEOUT_SEC if precheck else EC2_STEP_TIMEOUT_SEC
        if age > limit:
            _fail(s, f"No result after {limit // 60} min (job {job_id} still {status})")
        return
    if status in FAILED_JOB_STATUSES:
        what = "EC2 status check" if precheck else f"EC2 {verb}"
        _fail(s, f"{what} job {status}: {_job_error(job)}")
        return

    state = job.get("ec2_state")
    s["verified_state"] = state
    if precheck:
        if state == target:
            _succeed(s, f"{target.upper()} — server {host} was already {target}; no {verb} sent")
        elif state in ("running", "stopped"):
            s.update(phase="action", job_id=str(uuid.uuid4()), phase_started_at=_now_iso())
            dispatches.append((s, "action"))
        else:
            _fail(s, f"Server {host} is {state or 'in an unknown state'}; not sent a {verb}. "
                     "Try again once it has settled.")
        return

    if state != target:
        _fail(s, f"EC2 {verb} finished but server {host} is {state or 'in an unknown state'}, not {target}")
        return
    if verb == "stop":
        _succeed(s, f"STOPPED — EC2 instance {host} stopped")
        return
    outcome = job.get("health_outcome")
    if outcome == "passed":
        _succeed(s, f"RUNNING — {host} running, status checks passed, SSM Online")
    elif outcome == "impaired":
        _fail(s, f"Server {host} is running but EC2 status checks did not pass")
    elif outcome == "timeout":
        _fail(s, f"Server {host} is running but status checks / SSM were not ready in time")
    elif EC2_ACCEPT_UNVERIFIED:
        _succeed(s, f"RUNNING — {host} running; status checks / SSM not verified by RunStack "
                    f"({s.get('region')}); the SAP start scripts will confirm SSM")
    else:
        _fail(s, f"Server {host} is running but startup health could not be verified ({outcome or 'not reported'})")


# ── Verification from the stop/start script's own output ─────────────────
# Same rules the SAP Basis team agreed for the earlier SAP agent:
#   ASCS/PAS/AAS stop : sap_command SUCCESS + process_list STOPPED
#   ASCS/PAS/AAS start: sap_command SUCCESS + process_list HEALTHY
#   DB stop           : database STOPPED + listener STOPPED   (blackout STARTED = info)
#   DB start          : database OPEN    + listener RUNNING   (blackout STOPPED = info)
# Every SAP instance in the output must pass. Anything else -> None (status script decides).

def _confirmed_by_action_output(obj, op):
    if str(obj.get("execution_status", "SUCCESS")).upper() not in ("SUCCESS", ""):
        return None
    blocks = obj.get("instances") if isinstance(obj.get("instances"), list) else [obj]
    details = []
    for inst in blocks:
        if not isinstance(inst, dict):
            return None
        if str(inst.get("execution_status", "SUCCESS")).upper() not in ("SUCCESS", ""):
            return None
        checks = inst.get("checks") or {}
        name = inst.get("instance") or inst.get("role") or inst.get("sap_role") or ""
        prefix = f"{name}: " if name else ""
        pl, db = checks.get("process_list"), checks.get("database")
        if isinstance(pl, dict):
            cmd = str((checks.get("sap_command") or {}).get("status", "")).upper()
            want = "STOPPED" if op == "stop" else "HEALTHY"
            if cmd != "SUCCESS" or str(pl.get("status", "")).upper() != want:
                return None
            details.append(f"{prefix}{pl.get('green', 0)}/{pl.get('process_count', 0)} processes GREEN")
        elif isinstance(db, dict):
            db_s = str(db.get("status", "")).upper()
            lsn_s = str((checks.get("listener") or {}).get("status", "")).upper()
            want_db, want_lsn = ("STOPPED", "STOPPED") if op == "stop" else ("OPEN", "RUNNING")
            if db_s != want_db or lsn_s != want_lsn:
                return None
            text = f"{prefix}DB {db_s}, Listener {lsn_s}"
            blackout = str((checks.get("blackout") or {}).get("status", "")).upper()
            if blackout:
                text += f", OEM blackout {blackout}"
            details.append(text)
        else:
            return None
    return "; ".join(details) if details else None


def _dispatch_step(run, s, kind):
    if kind == "action" and s["step_action"] == "ec2_check":
        automation_type, data, prefix = "EC2-Action", {}, "sap-run-ec2-check"
        job_id = s["job_id"]
    elif kind == "precheck":
        automation_type, data, prefix = "EC2-Action", {}, "sap-run-ec2-precheck"
        job_id = s["precheck_job_id"]
    elif s["step_action"] in EC2_POWER_ACTIONS:
        # The same job the EC2 agent submits through POST /notify, so the
        # workflow records live state, start health and ServiceNow incidents.
        from notify import inject_target_locations
        automation_type, job_id = "SSM-Automation", s["job_id"]
        prefix = f"sap-run-{s['step_action'].replace('_', '-')}"
        data = inject_target_locations({
            "automation_type": automation_type, "region": s.get("region"), "account_id": s.get("account_id"),
            "automation_data": {"DocumentName": EC2_DOCUMENTS[s["step_action"]],
                                "Parameters": {"InstanceId": [s["instance_id"]]}},
        })["automation_data"]
    else:
        if kind == "action":
            script, args, job_id = s["script"], s.get("args", []), s["job_id"]
            prefix = f"sap-{run['op']}-{str(s['component']).lower()}"
        else:
            script, args, job_id = s["status_script"], s.get("status_args", []), s["verify_job_id"]
            prefix = f"sap-verify-{str(s['component']).lower()}"
        # "; true" as in sap_sync: the workflow re-dispatches a command once
        # when it fails, and a stop/start script must not run twice. Success
        # is decided by the verification step, not the exit code.
        cmd = f"{script} {' '.join(args)}".strip() + "; true"
        automation_type = "SSM-RunCommand"
        data = {"DocumentName": "AWS-RunShellScript", "InstanceIds": [s["instance_id"]],
                "Parameters": {"commands": [cmd]}}
    catalog = {k: s.get(k) for k in ("account_id", "region", "app_id", "environment", "server_name")}
    event = {"requestContext": {"authorizer": {"claims": run.get("claims") or {}}}}
    created = _sl._dispatch(event, run["sid"], catalog, s["instance_id"], run["run_id"],
                            automation_type, data, prefix, job_id=job_id,
                            group_label=f"SAP {run['sid']} {run['op']} run")
    if not created:
        logger.error(f"sap_runs: failed to create job {job_id} for {run['run_id']} step {s['label']}")
        # The next tick fails the step after JOB_CREATE_GRACE_SEC.


# ── Step / run helpers ───────────────────────────────────────────────────

def _succeed(s, message):
    s.update(status="SUCCEEDED", phase=None, message=message, finished_at=_now_iso())


def _fail(s, message):
    s.update(status="FAILED", phase=None, message=message, finished_at=_now_iso())


def _skip_remaining(steps, message):
    for s in steps:
        if s["status"] == "PENDING":
            s.update(status="SKIPPED", message=message)


def _close_run(run, status, error=None):
    run.update(status=status, finished_at=_now_iso(), error=error or run.get("error"))


def _finish(run):
    """Release the per-SID lock and the run's EC2 locks (only those still ours)."""
    _release_locks(run["sid"], run["run_id"], run.get("ec2_locks") or [])


def _release_locks(sid, run_id, instance_ids):
    for key in [f"sap-run-active#{sid}"] + [f"ec2:{i}" for i in instance_ids]:
        try:
            _locks().delete_item(Key={"resource_id": key}, ConditionExpression="job_id = :j",
                                 ExpressionAttributeValues={":j": run_id})
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                logger.warning(f"sap_runs: could not release lock {key}: {e}")


def _job_error(job):
    err = job.get("error")
    if isinstance(err, dict):
        return err.get("message") or err.get("details") or json.dumps(err, default=decimal_default)[:300]
    return str(err or job.get("stderr_output") or "no error details")[:300]


def _cancel_requested(run_id):
    item = _locks().get_item(Key={"resource_id": f"sap-run-cancel#{run_id}"}).get("Item")
    return item.get("locked_by", "user") if item else None


# ── Views ────────────────────────────────────────────────────────────────

STEP_VIEW_FIELDS = ("order", "component", "label", "components", "host", "instance_id", "step_action",
                    "precheck_job_id", "job_id", "verify_job_id", "status", "phase", "verified_state", "action_summary",
                    "output", "message", "started_at", "finished_at")


def _step_view(s):
    return {k: s.get(k) for k in STEP_VIEW_FIELDS if k in s}


def _run_view(run):
    steps = run.get("steps", [])
    sap_steps = [s for s in steps if s["step_action"] not in EC2_STEP_ACTIONS]
    ec2_steps = [s for s in steps if s["step_action"] in EC2_POWER_ACTIONS]
    done = sum(1 for s in sap_steps if s["status"] == "SUCCEEDED")
    ec2_done = sum(1 for s in ec2_steps if s["status"] == "SUCCEEDED")
    progress = f"{done} of {len(sap_steps)} components {op_past(run['op'])}"
    if ec2_steps:
        progress += f", {ec2_done} of {len(ec2_steps)} servers {op_past(run['op'])}"
    running = [s for s in steps if s["status"] == "RUNNING"]
    if run["status"] == "RUNNING" and running:
        r = running[0]
        if r["step_action"] == "ec2_check":
            msg = "Checking EC2 servers are running"
        elif r["step_action"] in EC2_POWER_ACTIONS:
            verb = "Stopping" if r["step_action"] == "ec2_stop" else "Starting"
            busy = [x for x in running if x["step_action"] == r["step_action"]]
            msg = (f"{verb} EC2 servers ({len(busy)} in progress)" if r.get("phase") == "action"
                   else "Checking EC2 server states")
        else:
            what = {"action": f"{run['op']} script running", "verify": "verifying",
                    "verify_wait": "re-checking status shortly"}.get(r.get("phase"), "running")
            msg = f"{r['label']} — {what}"
        msg += f" ({progress})"
    elif run["status"] == "RUNNING":
        msg = f"Starting next step ({progress})"
    elif run["status"] == PENDING:
        a = run["approval"]
        msg = ((f"Waiting for an e-mail approval from {', '.join(a.get('approvers') or [])} "
                if a.get("channel") == "email" else
                f"Waiting for approval in the {a.get('channel_name') or 'app team'} Teams channel ")
               + f"(expires {_display(a['expires_at'])})")
    elif run["status"] == "REJECTED":
        a = run["approval"]
        msg = f"Rejected by {a.get('decided_by')} at {_display(a.get('decided_at'))}; nothing was run"
    elif run["status"] == "EXPIRED":
        msg = f"Not approved within {run['approval']['minutes']} minutes; nothing was run"
    elif run["status"] == "SUCCEEDED":
        msg = f"All {done} SAP components of {run['sid']} {op_past(run['op'])} and verified"
        if ec2_steps:
            msg += (f"; all {ec2_done} EC2 servers stopped" if run["op"] == "stop"
                    else f"; all {ec2_done} EC2 servers started first")
    else:
        msg = f"Run {run['status']}: {run.get('error') or ''}".strip()
    if run.get("dry_run"):
        msg = "DRY RUN (simulated, nothing stopped or started) — " + msg
    return {
        "job_id": run["run_id"], "sid": run["sid"], "run_action": run["run_action"],
        "full_stack": bool(run.get("full_stack")), "dry_run": bool(run.get("dry_run")),
        # Display wording for the agent's summary e-mail ("_CONFIG" display_name / purpose).
        "system_name": _app_label(run), "application": _app_fact(run),
        "action_text": _action_text(run), "purpose": run.get("purpose"),
        "status": run["status"], "complete": run["status"] not in OPEN_STATUSES, "message": msg,
        "initiated_by": run.get("initiated_by"), "requested_at": run.get("requested_at") or run.get("started_at"),
        "started_at": run.get("started_at"),
        "approval": _approval_view(run),
        # Who the agent sends the run summary e-mail to ("_CONFIG".notify_emails).
        "summary_recipients": (run.get("notify") or {}).get("summary_emails") or [],
        # Ready-made run summary e-mail: the agent sends subject + html unchanged.
        "summary_email": _summary_email(run),
        "notices": {k: {f: v.get(f) for f in ("status", "at", "to", "number")} for k, v in (run.get("notices") or {}).items()},
        "finished_at": run.get("finished_at"), "current_step": run.get("current_step"),
        "failed_step": run.get("failed_step"), "error": run.get("error"),
        "steps": [_step_view(s) for s in steps],
    }


def _fingerprint(run):
    # Only step status changes (a component started / finished / failed) end a
    # long-poll early. Phase changes (e.g. "verifying") don't, so each of the
    # agent's limited polls per reply covers as much of the run as possible.
    return json.dumps([run.get("status")] + [s.get("status") for s in run.get("steps", [])])


def _long_poll(event, run):
    """For the agent (no Origin header): hold GET up to LONGPOLL_SECONDS until
    something visible changes, so each poll reports progress."""
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    if headers.get("origin") or run.get("status") not in OPEN_STATUSES or LONGPOLL_SECONDS <= 0:
        return run
    start, before = _time.time(), _fingerprint(run)
    while _time.time() - start < LONGPOLL_SECONDS:
        _time.sleep(2)
        latest = _load_run(run["run_id"])
        if not latest:
            break
        run = latest
        if _fingerprint(run) != before or run.get("status") not in OPEN_STATUSES:
            break
    return run


# ── Storage helpers ──────────────────────────────────────────────────────

def _locks():
    return boto3.resource("dynamodb").Table(ACTION_LOCKS_TABLE)


def _load_run(run_id):
    item = _locks().get_item(Key={"resource_id": f"sap-run#{run_id}"}, ConsistentRead=True).get("Item")
    if not item or item.get("record") != "sap_run":
        return None
    return json.loads(json.dumps(item, default=decimal_default))   # Decimal -> int/float


def _save_if(run, seq, status, bump=False):
    """Save the run only if nobody moved it meanwhile (same tick_seq and status).
    bump=True also advances tick_seq, so any tick already queued is dropped."""
    item = dict(run)
    item["tick_seq"] = seq + 1 if bump else seq
    item["updated_at"] = _now_iso()
    try:
        _locks().put_item(Item=json.loads(json.dumps(item), parse_float=Decimal),
                          ConditionExpression="tick_seq = :s AND #st = :p",
                          ExpressionAttributeNames={"#st": "status"},
                          ExpressionAttributeValues={":s": seq, ":p": status})
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise
    run["tick_seq"] = item["tick_seq"]
    return True


def _run_for_request(body, sid):
    run_id = (body.get("job_id") or "").strip()
    if not is_run_id(run_id):
        return None, _resp(400, {"error": "job_id of a SAP run (sap-run-...) is required"})
    run = _load_run(run_id)
    if not run:
        return None, _resp(404, {"error": f"Run {run_id} not found"})
    if run["sid"] != sid:
        return None, _resp(400, {"error": f"Run {run_id} belongs to SID {run['sid']}, not {sid}"})
    return run, None


def _remember_run(sid, run_id):
    key = {"resource_id": f"sap-runs#{sid}"}
    try:
        item = _locks().get_item(Key=key).get("Item") or {}
        ids = [run_id] + [r for r in item.get("run_ids", []) if r != run_id]
        _locks().put_item(Item={**key, "record": "sap_run_index", "run_ids": ids[:RUN_LIST_MAX],
                                "expires_at": int(_time.time()) + RUN_RECORD_TTL_SEC})
    except Exception as e:   # informational only
        logger.warning(f"sap_runs: could not update run index for {sid}: {e}")


def _list_runs(sid):
    item = _locks().get_item(Key={"resource_id": f"sap-runs#{sid}"}).get("Item") or {}
    runs = []
    for rid in item.get("run_ids", []):
        run = _load_run(rid)
        if run:
            v = _run_view(run)
            v.pop("steps", None)
            runs.append(v)
    return runs


def _send_tick(run_id, seq, delay):
    try:
        boto3.client("sqs").send_message(
            QueueUrl=os.getenv("QUEUE_URL"),
            MessageBody=json.dumps({"runstack_internal": TICK_MARKER, "run_id": run_id, "seq": seq}),
            DelaySeconds=max(0, min(int(delay), 900)))
        return True
    except Exception as e:
        logger.error(f"sap_runs: could not send tick {seq} for {run_id}: {e}")
        return False


def _kick_if_stalled(run):
    if run.get("status") in OPEN_STATUSES and _age_seconds(run.get("last_tick_at")) > STALL_SECONDS:
        logger.warning(f"sap_runs: run {run['run_id']} stalled; re-sending tick {run.get('tick_seq')}")
        _send_tick(run["run_id"], int(run.get("tick_seq", 0)), 0)


def _now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _age_seconds(iso):
    if not iso:
        return 10 ** 9
    try:
        t = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return 10 ** 9
    return (datetime.now(timezone.utc) - t).total_seconds()


def _resp(code, body):
    return {"statusCode": code, "headers": CORS_HEADERS, "body": json.dumps(body, default=decimal_default)}