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

EC2 stop/start is NOT part of these runs.

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

Storage: runstack-action-locks (already used by runs.py / EC2 locks), TTL'd:
  sap-run#<run_id>         run record (steps, status, tick_seq)
  sap-run-active#<SID>     one active run per SID (acquire_action_lock)
  sap-run-cancel#<run_id>  cancel request
  sap-runs#<SID>           IDs of the last runs for run_list
No new IAM, tables, indexes, routes, Step Functions or SSM documents.
"""

import json
import uuid
import time as _time
from datetime import datetime, timezone

from shared import *
import sap_landscape as _sl

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

    if action == "run_cancel":
        denied = authorize_action(event, "sap_start_stop")
        if denied:
            return denied
        run, err = _run_for_request(body, sid)
        if err:
            return err
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
        stop_steps, stop_err = _build_steps(sid, components, "stop")
        start_steps, start_err = _build_steps(sid, components, "start")
        return _resp(200, {"sid": sid, "action": action,
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
                 "created_at": run.get("started_at"), "updated_at": run.get("updated_at")})
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

    steps, errors = _build_steps(sid, components, op)
    if errors:
        # Never run part of a landscape because inventory is incomplete.
        return _resp(400, {"error": "SAP inventory incomplete for this SID", "message": "; ".join(errors)})
    if not any(s["status"] == "PENDING" and s["step_action"] != "ec2_check" for s in steps):
        return _resp(400, {"error": f"No {op} scripts configured for SID '{sid}'"})

    restricted = sorted({f"{s.get('host') or s['instance_id']} ({s.get('environment') or 'no environment'})"
                         for s in steps
                         if str(s.get("environment") or "").strip().upper() not in ALLOWED_ENVIRONMENTS})
    if restricted:
        return _resp(403, {"error": "forbidden", "reason": "environment_restricted",
                           "message": (f"SAP {op} is currently restricted to "
                                       f"{', '.join(sorted(ALLOWED_ENVIRONMENTS))} environments. "
                                       f"Not allowed: {', '.join(restricted)}")})

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

    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {}) or {}
    run = {
        "resource_id": f"sap-run#{run_id}", "record": "sap_run",
        "run_id": run_id, "sid": sid, "run_action": action, "op": op,
        "status": "RUNNING", "initiated_by": initiator,
        # Only what job_initiator() needs, so child jobs show the real user.
        "claims": {k: claims[k] for k in ("username", "email", "client_id") if claims.get(k)},
        "request_id": str(body.get("id") or "")[:100],
        "started_at": _now_iso(), "updated_at": _now_iso(), "finished_at": None,
        "current_step": None, "failed_step": None, "error": None,
        "steps": steps, "tick_seq": 0, "last_tick_at": _now_iso(),
        "expires_at": int(_time.time()) + RUN_RECORD_TTL_SEC,
    }
    try:
        _locks().put_item(Item=run)
    except Exception as e:
        release_action_lock(f"sap-run-active#{sid}")
        logger.error(f"sap_runs: could not save run {run_id}: {e}")
        return _resp(500, {"error": "Could not create run"})

    _remember_run(sid, run_id)
    if not _send_tick(run_id, 0, 0):
        # Run saved; the stall check on the first run_status/GET will re-send.
        logger.warning(f"sap_runs: first tick for {run_id} not sent")

    return _resp(200, {"sid": sid, "action": action, "run_action": action, "job_id": run_id,
                       "status": "STARTED", "initiated_by": initiator, "started_at": run["started_at"],
                       "message": (f"SAP {op} started for {sid}. Components are {op_past(op)} one step at a time "
                                   "and each is verified before the next. Follow progress with GET /jobs/{jobId}."),
                       "steps": [_step_view(s) for s in steps]})


def op_past(op):
    return "stopped" if op == "stop" else "started"


def _build_steps(sid, components, op):
    """Ordered step list for op ('stop'|'start'). Returns (steps, errors)."""
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
            "server_name": catalog.get("server_name"),
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

    if op == "start":
        # EC2 start is not part of this action: confirm every server is up first.
        checks = []
        for iid, info in servers.items():
            s = info["step"]
            checks.append({**{k: s[k] for k in ("host", "instance_id", "account_id", "region",
                                                "app_id", "environment", "server_name")},
                           "order": 0, "component": "EC2", "label": f"EC2 check — {s.get('host') or iid}",
                           "components": info["components"], "step_action": "ec2_check",
                           "script": None, "args": [], "status_script": None, "status_args": [],
                           "status": "PENDING", "phase": None, "job_id": None, "verify_job_id": None,
                           "verify_attempts": 0, "verified_state": None, "output": None,
                           "action_summary": None, "message": None, "started_at": None, "finished_at": None})
        steps = checks + steps
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
        if not run or run.get("status") != "RUNNING":
            return True
        if int(run.get("tick_seq", 0)) != seq:
            logger.info(f"sap_runs: stale tick {seq} for {run_id} (now {run.get('tick_seq')})")
            return True

        dispatches = _advance(run)
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
        # Group done — loop to start the next group in this same tick.
    return dispatches


def _advance_step(run, s, dispatches):
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
    """Release the per-SID lock (only if it is still ours)."""
    try:
        _locks().delete_item(Key={"resource_id": f"sap-run-active#{run['sid']}"},
                             ConditionExpression="job_id = :j",
                             ExpressionAttributeValues={":j": run["run_id"]})
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            logger.warning(f"sap_runs: could not release lock for {run['sid']}: {e}")


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
                    "job_id", "verify_job_id", "status", "phase", "verified_state", "action_summary",
                    "output", "message", "started_at", "finished_at")


def _step_view(s):
    return {k: s.get(k) for k in STEP_VIEW_FIELDS if k in s}


def _run_view(run):
    steps = run.get("steps", [])
    sap_steps = [s for s in steps if s["step_action"] != "ec2_check"]
    done = sum(1 for s in sap_steps if s["status"] == "SUCCEEDED")
    running = [s for s in steps if s["status"] == "RUNNING"]
    if run["status"] == "RUNNING" and running:
        r = running[0]
        what = {"action": f"{run['op']} script running", "verify": "verifying",
                "verify_wait": "re-checking status shortly"}.get(r.get("phase"), "running")
        msg = (f"{r['label']} — {what}" if r["step_action"] != "ec2_check" else "Checking EC2 servers are running")
        msg += f" ({done} of {len(sap_steps)} components {op_past(run['op'])})"
    elif run["status"] == "RUNNING":
        msg = f"Starting next step ({done} of {len(sap_steps)} components {op_past(run['op'])})"
    elif run["status"] == "SUCCEEDED":
        msg = f"All {done} SAP components of {run['sid']} {op_past(run['op'])} and verified"
    else:
        msg = f"Run {run['status']}: {run.get('error') or ''}".strip()
    return {
        "job_id": run["run_id"], "sid": run["sid"], "run_action": run["run_action"],
        "status": run["status"], "complete": run["status"] != "RUNNING", "message": msg,
        "initiated_by": run.get("initiated_by"), "started_at": run.get("started_at"),
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
    if headers.get("origin") or run.get("status") != "RUNNING" or LONGPOLL_SECONDS <= 0:
        return run
    start, before = _time.time(), _fingerprint(run)
    while _time.time() - start < LONGPOLL_SECONDS:
        _time.sleep(2)
        latest = _load_run(run["run_id"])
        if not latest:
            break
        run = latest
        if _fingerprint(run) != before or run.get("status") != "RUNNING":
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
    if run.get("status") == "RUNNING" and _age_seconds(run.get("last_tick_at")) > STALL_SECONDS:
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