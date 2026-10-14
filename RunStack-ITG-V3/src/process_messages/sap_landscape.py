"""
SAP landscape-level actions — one call covers every component / server of a
SID (G1D, LH4, LH3, ... — any SID in runstack-sap-instance-details).

    POST /notify-sync  {"domain": "sap", "sid": "G1D", "action": "sap_status"}
    POST /notify-sync  {"domain": "sap", "sid": "G1D", "action": "ec2_status"}
    POST /notify-sync  {"domain": "sap", "sid": "G1D", "action": "sap_stop" | "sap_start" | "plan"
                                                     | "run_status" | "run_list" | "run_cancel"}
      -> handled by sap_runs.py (ordered, verified full-stack SAP stop/start)
    ec2_stop / ec2_start / list_sids -> 400 "not enabled" (not in this release)

Routed here from ec2_sync.handle_notify_sync. Every other SAP request
(action "status" / "start" / "stop", and the named
/notify-sync/{component}-status-check endpoints) still goes to sap_sync.py,
which this module does NOT modify.

Why this exists alongside sap_sync.handle_sap_action:
  handle_sap_action's "status" branch checks components ONE AFTER ANOTHER,
  each waiting up to 18s (_run_sync_check). Four components can take ~72s,
  but API Gateway cuts the call at 29s. Here every job is dispatched first
  and then all of them are awaited together inside ONE 18s window. Status
  checks are read-only, so running them at the same time is safe; results
  are still returned in stop order (AAS -> PAS -> ASCS -> DB).

Data sources (unchanged, shared with sap_sync.py):
  - runstack-sap-instance-details (sid + component): instance_id, label/role,
    status_script_path, status_args, optional stop_order.
  - runstack-instance-catalog (instance_id): account_id, region, server name.

Jobs go through the normal pipeline (jobs table -> process_jobs -> existing
Step Functions workflow), so cross-account and us-west-2 behave exactly as
every other RunStack job. All jobs from one call share an
execution_group_id so Execution Details can show them together.

Authorization: authorize_action(event, "sap_status_check") — the same check
the existing SAP status endpoints and handle_ec2_statuscheck use.
"""

import json
import uuid
import time as _time

from shared import *
from sap_sync import _order_components

STATUS_ACTIONS = ("sap_status", "ec2_status")
RUN_ACTIONS = ("plan", "sap_stop", "sap_start", "run_status", "run_list", "run_cancel")
# In the spec but deliberately not enabled: EC2 power for a whole SID, SID listing.
NOT_ENABLED_ACTIONS = ("ec2_stop", "ec2_start", "list_sids")
# Everything ec2_sync routes to this module (the rest still goes to sap_sync.py).
ACTIONS = STATUS_ACTIONS + RUN_ACTIONS + NOT_ENABLED_ACTIONS

WAIT_TIMEOUT_SEC = 18   # same budget as _run_sync_check; keeps us under API Gateway's 29s
POLL_INTERVAL_SEC = 2
TERMINAL_STATUSES = ("COMPLETED", "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED")


# ── Entry point ──────────────────────────────────────────────────────────

def handle_sap_landscape_action(event, http_method, path, path_parameters, query_params):
    try:
        body = json.loads(event.get("body") or "{}")
    except (TypeError, ValueError):
        return _response(400, {"error": "Request body must be valid JSON"})

    action = body.get("action")
    sid = (body.get("sid") or "").strip()

    if action not in ACTIONS:
        return _response(400, {"error": f"action must be one of {list(STATUS_ACTIONS + RUN_ACTIONS)}"})
    if action in NOT_ENABLED_ACTIONS:
        return _response(400, {"error": f"action '{action}' is not enabled",
                               "message": "EC2 stop/start for a whole SID is not part of this release."})
    if not sid:
        return _response(400, {"error": "sid is required"})
    sid = sid.upper()

    if action in RUN_ACTIONS:
        import sap_runs   # local import: sap_runs imports this module
        return sap_runs.handle_run_action(event, body, action, sid)

    denied = authorize_action(event, "sap_status_check")
    if denied:
        return denied

    components = get_sap_components(sid)
    if not components:
        return _response(404, {"error": f"No components found for SID '{sid}'"})

    components = _in_stop_order(components)

    # Optional, sap_status only: check a single component (e.g. "PAS").
    component_filter = (body.get("component") or "").strip().upper()
    if component_filter and action == "sap_status":
        components = [c for c in components
                      if str(c.get("component", "")).upper() == component_filter]
        if not components:
            return _response(404, {"error": f"No component '{component_filter}' found for SID '{sid}'"})

    group_id = str(uuid.uuid4())

    if action == "sap_status":
        results = _sap_status(event, sid, components, group_id)
    else:
        results = _ec2_status(event, sid, components, group_id)

    return _response(200, {
        "sid": sid,
        "action": action,
        "execution_group_id": group_id,
        "complete": all(r["status"] != "RUNNING" for r in results),
        "results": results,
    })


# ── sap_status ───────────────────────────────────────────────────────────

def _sap_status(event, sid, components, group_id):
    """Dispatch one status-script job per component, then wait for all."""
    results = []
    for c in components:
        result = {
            "component": c.get("component"),
            "label": _label(c),
            "instance_id": c.get("instance_id"),
        }
        catalog = get_catalog_instance(c.get("instance_id"))
        if not catalog:
            results.append({**result, "status": "ERROR",
                            "message": f"Instance {c.get('instance_id')} not in instance catalog"})
            continue
        result["host"] = _host(catalog, c)

        script = c.get("status_script_path")
        if not script:
            # e.g. TREX rows registered without automation scripts — not an error.
            results.append({**result, "status": "NOT_CONFIGURED",
                            "message": f"No status script configured for component {c.get('component')}"})
            continue

        # Same command shape as sap_sync.handle_sap_action's status branch.
        cmd = f"{script} {' '.join(c.get('status_args', []))}".strip() + "; true"
        job_id = _dispatch(event, sid, catalog, c["instance_id"], group_id,
                           "SSM-RunCommand",
                           {"DocumentName": "AWS-RunShellScript",
                            "InstanceIds": [c["instance_id"]],
                            "Parameters": {"commands": [cmd]}},
                           f"sap-status-{str(c.get('component')).lower()}")
        if not job_id:
            results.append({**result, "status": "ERROR", "message": "Failed to create status job"})
            continue
        results.append({**result, "job_id": job_id, "status": "PENDING"})

    jobs = _wait_for_jobs([r["job_id"] for r in results if r.get("job_id")])

    for r in results:
        if not r.get("job_id"):
            continue
        job = jobs.get(r["job_id"])
        if not job or job.get("status") not in TERMINAL_STATUSES:
            r["status"] = "RUNNING"
            r["message"] = "Still running — poll GET /jobs/{jobId} for this component."
            continue
        r["status"] = job.get("status")
        raw = job.get("qualys_output", "") or ""
        parsed = _parse_script_json(raw)
        if parsed is not None:
            # Compact JSON (drops the blank lines SSM adds) + a one-line verdict
            # in the existing "message" field — no spec change needed.
            r["output"] = json.dumps(parsed, separators=(",", ":"))
            r["message"] = _summarize_status(parsed)
        else:
            r["output"] = raw
            r["message"] = ("UNKNOWN — script produced no output (check the script path on the server)"
                            if not raw.strip() else
                            "UNKNOWN — script output is not JSON")
        r["exit_code"] = job.get("exit_code")
        r["updated_at"] = job.get("updated_at")
    return results


# ── Status-script output → one-line verdict ──────────────────────────────

def _parse_script_json(text):
    """Return the JSON object the status script printed, or None.
    Tolerates log lines before/after the object."""
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        obj = json.loads(text[start:end + 1])
    except ValueError:
        return None
    return obj if isinstance(obj, dict) else None


def _one_instance_state(inst):
    """(STATE, detail) for one SAP instance / DB block of the script output."""
    checks = inst.get("checks") or {}
    name = inst.get("instance") or inst.get("sap_role") or inst.get("role") or ""
    prefix = f"{name}: " if name else ""

    pl = checks.get("process_list")
    if isinstance(pl, dict):
        total, green = pl.get("process_count", 0) or 0, pl.get("green", 0) or 0
        red, s = pl.get("red", 0) or 0, str(pl.get("status", "")).upper()
        if red:
            state = "FAILED"
        elif s == "HEALTHY" or (total and green == total):
            state = "RUNNING"
        elif s == "STOPPED" or (total and green == 0):
            state = "STOPPED"
        elif total:
            state = "DEGRADED"
        else:
            state = "UNKNOWN"
        return state, f"{prefix}{green}/{total} processes GREEN"

    db, lsn = checks.get("database"), checks.get("listener")
    if isinstance(db, dict) or isinstance(checks.get("overall"), dict):
        return _db_state(checks, prefix)

    return "UNKNOWN", f"{prefix}no process_list/database checks in output"


# Oracle status script (check_oracle_status.sh) — a stopped database is
# reported as overall FAILED, pmon NOT_RUNNING, database UNKNOWN with
# ORA-01034, listener NOT_RUNNING. Those are the expected results after a
# stop, so they must count as STOPPED, not FAILED.
_DB_DOWN_ERRORS = ("ORA-01034", "ORA-27101", "ORACLE NOT AVAILABLE")
_DOWN_WORDS = ("NOT_RUNNING", "STOPPED", "DOWN", "SHUTDOWN", "NOT RUNNING")
_UP_WORDS = ("RUNNING", "READY", "UP", "OPEN", "HEALTHY")


def _db_state(checks, prefix):
    overall = str((checks.get("overall") or {}).get("status", "")).upper()
    db = checks.get("database") or {}
    lsn = checks.get("listener") or {}
    pmon = checks.get("pmon") or {}
    db_s = str(db.get("status", "")).upper()
    lsn_s = str(lsn.get("status", "")).upper()
    pmon_s = str(pmon.get("status", "")).upper()
    db_err = str(db.get("error", "")).upper()

    db_down = (db_s in _DOWN_WORDS or pmon_s in _DOWN_WORDS
               or any(e in db_err for e in _DB_DOWN_ERRORS))
    db_up = db_s == "OPEN" and pmon_s not in _DOWN_WORDS
    lsn_down = lsn_s in _DOWN_WORDS or lsn_s == ""
    lsn_up = lsn_s in _UP_WORDS

    if overall == "HEALTHY" or (db_up and lsn_up):
        state = "RUNNING"
    elif db_down and lsn_down:
        state = "STOPPED"
    elif db_down or (db_up and not lsn_up):
        state = "DEGRADED"          # one of database / listener up, the other down
    elif overall == "FAILED":
        state = "FAILED"
    else:
        state = "UNKNOWN"

    parts = []
    if pmon_s:
        parts.append(f"PMON {pmon_s}")
    if db_down and any(e in db_err for e in _DB_DOWN_ERRORS):
        parts.append("DB not available (ORA-01034)")
    else:
        parts.append(f"DB {db_s or '?'}")
    parts.append(f"Listener {lsn_s or '?'}")
    return state, prefix + ", ".join(parts)


def _summarize_status(obj):
    """'RUNNING — D00: 4/4 processes GREEN'. Handles both the top-level
    'checks' shape and the 'instances: [...]' shape (several instances on
    one server are combined)."""
    blocks = obj.get("instances") if isinstance(obj.get("instances"), list) else [obj]
    states, details, errors = [], [], []
    for inst in blocks:
        if not isinstance(inst, dict):
            continue
        st, detail = _one_instance_state(inst)
        states.append(st)
        details.append(detail)
        if inst.get("error"):
            errors.append(str(inst["error"])[:200])
    if not states:
        return "UNKNOWN — no instances in script output"

    if len(set(states)) == 1:
        overall = states[0]
    elif "FAILED" in states:
        overall = "FAILED"
    elif "UNKNOWN" in states:
        overall = "UNKNOWN"
    else:
        overall = "DEGRADED"

    msg = f"{overall} — {'; '.join(details)}"
    if errors:
        msg += f" — error: {' | '.join(errors)}"
    return msg


# ── ec2_status ───────────────────────────────────────────────────────────

def _ec2_status(event, sid, components, group_id):
    """One EC2-Action job per UNIQUE instance (a server hosting several
    components is checked once), then wait for all."""
    servers = {}   # instance_id -> {"components": [...]} in stop order
    for c in components:
        iid = c.get("instance_id")
        if not iid:
            continue
        servers.setdefault(iid, {"components": []})["components"].append(_label(c))

    results = []
    for iid, info in servers.items():
        result = {"instance_id": iid, "components": info["components"]}
        catalog = get_catalog_instance(iid)
        if not catalog:
            results.append({**result, "status": "ERROR",
                            "message": f"Instance {iid} not in instance catalog"})
            continue
        result["host"] = _host(catalog, None)
        job_id = _dispatch(event, sid, catalog, iid, group_id,
                           "EC2-Action", {}, "sap-ec2-status")
        if not job_id:
            results.append({**result, "status": "ERROR", "message": "Failed to create EC2 status job"})
            continue
        results.append({**result, "job_id": job_id, "status": "PENDING"})

    jobs = _wait_for_jobs([r["job_id"] for r in results if r.get("job_id")])

    for r in results:
        if not r.get("job_id"):
            continue
        job = jobs.get(r["job_id"])
        if not job or job.get("status") not in TERMINAL_STATUSES:
            r["status"] = "RUNNING"
            r["message"] = "Still running — poll GET /jobs/{jobId} for this server."
            continue
        r["status"] = job.get("status")
        r["ec2_state"] = job.get("ec2_state")
        r["updated_at"] = job.get("updated_at")
    return results


# ── Helpers ──────────────────────────────────────────────────────────────

def _dispatch(event, sid, catalog, instance_id, group_id, automation_type, automation_data, id_prefix,
              job_id=None, group_label=None):
    """Create one job through the normal RunStack pipeline. Returns job_id or None.
    job_id may be pre-assigned (sap_runs claims it in the run record first)."""
    job_id = job_id or str(uuid.uuid4())
    payload = {
        "id": f"{id_prefix}-{job_id[:8]}",
        "job_id": job_id,
        "account_id": catalog["account_id"],
        "region": catalog["region"],
        "resource_id": instance_id,
        "automation_type": automation_type,
        "automation_data": automation_data,
    }
    if not validate_message_payload(payload):
        logger.error(f"sap_landscape: invalid payload for {instance_id}")
        return None

    # Initiator comes from the caller's token; the group is set here,
    # server-side, AFTER stamp_job_origin strips any caller-supplied value.
    stamp_job_origin(payload, event)
    payload["execution_group_id"] = group_id
    payload["execution_group_label"] = group_label or f"SAP {sid} {id_prefix}"
    for field in ("app_id", "environment", "server_name"):
        if catalog.get(field):
            payload.setdefault(field, catalog[field])

    try:
        transformed = transform_message_data(payload, job_id)
    except Exception as e:
        logger.error(f"sap_landscape: transform failed for {instance_id}: {e}")
        return None
    if not store_message_in_dynamodb(transformed):
        logger.error(f"sap_landscape: failed to store job for {instance_id}")
        return None
    return job_id


def _wait_for_jobs(job_ids):
    """Poll all jobs together until each is terminal or the shared window ends.
    Returns {job_id: latest job record or None}."""
    latest = {jid: None for jid in job_ids}
    pending = set(job_ids)
    elapsed = 0
    while pending and elapsed < WAIT_TIMEOUT_SEC:
        _time.sleep(POLL_INTERVAL_SEC)
        elapsed += POLL_INTERVAL_SEC
        for jid in list(pending):
            job = get_job_by_id(jid)
            latest[jid] = job
            if job and job.get("status") in TERMINAL_STATUSES:
                pending.discard(jid)
    return latest


def _in_stop_order(components):
    """Use explicit stop_order when every row has one; otherwise fall back to
    the existing depends_on ordering from sap_sync (reversed for stop)."""
    if components and all(c.get("stop_order") is not None for c in components):
        return sorted(components, key=lambda c: int(c["stop_order"]))
    return _order_components(components, "stop")


def _label(component):
    return component.get("label") or component.get("role") or component.get("component")


def _host(catalog, component):
    return (catalog.get("server_name") or catalog.get("name")
            or (component or {}).get("sap_virtual_hostname"))


def _response(status_code, body):
    return {"statusCode": status_code, "headers": CORS_HEADERS,
            "body": json.dumps(body, default=decimal_default)}