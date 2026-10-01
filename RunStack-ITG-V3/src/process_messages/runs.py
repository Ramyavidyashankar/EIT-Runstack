"""
Multi-target runs — one automation on many servers as ONE RunStack run.

Entry point: POST /notify with a "targets" list (no new API Gateway route).
A body without "targets" is handled by notify.handle_notify exactly as
before, so single-server callers (UI Advanced page, agents, Dynatrace) are
unchanged.

Request
  {
    "kind": "automation" | "ec2_power",
    "document": "<approved SSM document>",          # kind=automation
    "parameters": { "<name>": "<value>" | [...] },  # kind=automation
    "action": "start" | "stop",                     # kind=ec2_power
    "targets": ["i-…", "i-…"],
    "client_request_id": "<uuid from the browser>"  # duplicate-submit guard
  }

What happens (all decisions server-side; nothing about a target comes from
the browser except its instance ID):
  1. Caller must pass the EC2/app-access layer-1 gate (authorize_action
     "ec2_stop_start" without a resource) — same groups as /notify.
  2. kind=automation: the document must be in APPROVED_AUTOMATION_DOCUMENTS
     and readable/Active in the primary region; parameters are validated
     against the document's own definition (InstanceId / AutomationAssumeRole
     are filled in by RunStack, never by the caller). Team-owned documents
     (SQL health check / DR) are refused here — they keep their own pages
     and team-capability authorization.
  3. For EVERY target, the same checks a single /notify call gets:
       catalog lookup (account/region from runstack-instance-catalog)
       → authorize_action("ec2_stop_start", resource_id)  (app-access +
         instance catalog + environment guardrail, admin bypass)
       → document compatibility (Command documents must exist in the
         target's region; platform when the catalog records one)
       → EC2 action lock for start/stop (ec2:<instance>), as /notify.
     A target that fails is reported with its reason; the others still run.
  4. Each accepted target becomes the normal single-server job body and is
     queued on the existing SQS queue — one job and one Step Functions
     execution per server, exactly as today. All share one server-created
     execution_group_id (the run ID) and the caller as initiated_by.
  5. Concurrency: targets are released in waves (RUN_WAVE_SIZE every
     RUN_WAVE_SECONDS) using SQS DelaySeconds (max 900 s), so a large run
     doesn't start every server at once.
  6. A run header (targets, waves) is kept in runstack-action-locks for a
     day so Execution Details can show servers that are queued but not
     yet dispatched.

Nothing here changes IAM, tables, indexes, Step Functions or SSM documents:
it writes SQS (as /notify) and runstack-action-locks (as the EC2 lock and
SQL health check lock already do).
"""

import re
import time as _time
from datetime import timedelta

import sql_healthcheck as _docs
from shared import *

APPROVED_AUTOMATION_DOCUMENTS = [
    d.strip() for d in os.getenv("APPROVED_AUTOMATION_DOCUMENTS", "").split(",") if d.strip()
]
RUN_MAX_TARGETS = int(os.getenv("RUN_MAX_TARGETS", "200"))
RUN_WAVE_SIZE = max(1, int(os.getenv("RUN_WAVE_SIZE", "25")))
RUN_WAVE_SECONDS = max(0, int(os.getenv("RUN_WAVE_SECONDS", "60")))
RUN_SUBMIT_DEDUPE_SECONDS = int(os.getenv("RUN_SUBMIT_DEDUPE_SECONDS", "600"))
RUN_HEADER_TTL_SECONDS = 86400
SQS_MAX_DELAY = 900

EC2_POWER_DOCUMENTS = {"start": "AWS-StartEC2Instance", "stop": "AWS-StopEC2Instance"}
# Filled in by RunStack per target (Automation) or by the pipeline
# (AutomationAssumeRole, see normalize_automation_data) — never by callers.
AUTO_PARAMETERS = {"InstanceId", "AutomationAssumeRole"}
PER_TARGET_PARAMETERS = ("InstanceId",)
OS_FIELDS = ("os_type", "operating_system", "os", "OS", "platform")

_INSTANCE_RE = re.compile(r"^(i|mi)-[0-9a-f]{8,17}$")
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
RUN_GROUP_PREFIX = "grp-run-"
RUN_HEADER_PREFIX = "run#"


def _resp(code, body):
    return {"statusCode": code, "headers": CORS_HEADERS, "body": json.dumps(body, default=decimal_default)}


def _body_of(resp):
    try:
        return json.loads(resp.get("body") or "{}")
    except (TypeError, ValueError):
        return {}


def _locks_table():
    return boto3.resource("dynamodb").Table(ACTION_LOCKS_TABLE)


def _team_owned_documents():
    names = {HEALTHCHECK_DOCUMENT_NAME, os.getenv("HEALTHCHECK_BULK_DOCUMENT_NAME", ""),
             DR_STATUS_CHECK_DOCUMENT_NAME, DR_FAILOVER_DOCUMENT_NAME}
    return {_docs._lookup_name(n, None).lower() for n in names if n}


def parse_approved_entries(entries):
    """
    APPROVED_AUTOMATION_DOCUMENTS entries, comma-separated in the setting:
        Document-Name
        Document-Name=Friendly name
        Document-Name=Friendly name|team_action
        Document-Name|team_action
    team_action names an ACTION_AUTH_CONFIG entry with a team capability
    (e.g. tidal_action, sap_status_check). Without it, servers are
    authorized by application access, as for any /notify job. An unknown or
    non-team action is ignored (application access applies) and logged.
    Returns {document: {"display_name", "auth"}} in configured order.
    """
    out = {}
    for raw in entries or []:
        entry = str(raw or "").strip()
        head, _, auth = entry.partition("|")
        name, _, display = head.partition("=")
        name, display, auth = name.strip(), display.strip(), auth.strip()
        if not name:
            continue
        cfg = ACTION_AUTH_CONFIG.get(auth) if auth else None
        if auth and not (cfg and cfg.get("team_capability")):
            logger.warning(f"runs: ignoring unknown team action '{auth}' for approved document {name}")
            auth = ""
        out[name] = {"display_name": display or None, "auth": auth or "app"}
    return out


def approved_config():
    """Approved documents minus team-owned SQL/DR documents (those keep their
    own pages, flows and authorization)."""
    team = _team_owned_documents()
    return {n: c for n, c in parse_approved_entries(APPROVED_AUTOMATION_DOCUMENTS).items()
            if _docs._lookup_name(n, None).lower() not in team}


def approved_documents():
    return list(approved_config())


def _integration_documents():
    return {d.strip() for d in os.getenv("INTEGRATION_ALLOWED_DOCUMENTS", "").split(",") if d.strip()}


def allowlist_mode():
    mode = os.getenv("DOCUMENT_ALLOWLIST_MODE", "enforce").strip().lower()
    return mode if mode in ("enforce", "audit", "off") else "enforce"


def single_target_allowed_documents():
    """Lower-cased document names a single-server request may run: EC2
    start/stop, every APPROVED_AUTOMATION_DOCUMENTS entry, RunStack's own
    SQL/DR documents (their existing callers keep working), and
    INTEGRATION_ALLOWED_DOCUMENTS (e.g. Update-Tidal-Outage-Automation,
    Dynatrace remediation documents)."""
    names = set(EC2_POWER_DOCUMENTS.values()) | set(parse_approved_entries(APPROVED_AUTOMATION_DOCUMENTS))
    names |= {_docs._lookup_name(n, None) for n in _integration_documents()}
    return {n.lower() for n in names if n} | _team_owned_documents()


def check_single_target_document(event, body, route):
    """
    Allowlist for single-server requests (/notify, /notify-sync, incl. the
    Advanced page and agents). Allowed: EC2 status checks (no document), the
    EC2 start/stop documents, approved Run Automations documents, and
    INTEGRATION_ALLOWED_DOCUMENTS (agent/Dynatrace documents not offered in
    the UI). DOCUMENT_ALLOWLIST_MODE=audit logs instead of refusing (to find
    what integrations send before enforcing); off disables the check.
    Returns None (allowed) or a 403 response.
    """
    if body.get("automation_type") == "EC2-Action":
        return None
    mode = allowlist_mode()
    if mode == "off":
        return None
    raw = str((body.get("automation_data") or {}).get("DocumentName") or "").strip()
    name = _docs._lookup_name(raw, None)
    if name.lower() in single_target_allowed_documents():
        return None
    who = job_initiator(event)
    if mode == "audit":
        logger.warning(f"allowlist(audit): {route} would refuse document '{name}' from {who}")
        return None
    logger.warning(f"allowlist: {route} refused document '{name}' from {who}")
    return _resp(403, {"error": "forbidden", "reason": "document_not_approved",
                       "message": f"'{name or 'unknown'}' is not an approved automation document. "
                                  f"Ask a RunStack administrator to approve it."})


# ── Team-capability documents (SQL/SAP/Tidal) ───────────────────────────────

def _team_scope(event, action_key):
    """(denied, scope): scope is "ALL" or a set of lower-cased identifiers
    from the team capability — same rule as the SQL health check page."""
    denied = authorize_action(event, action_key)
    if not denied:
        return None, "ALL"
    if (_body_of(denied).get("reason")) != "scope_excluded":
        return denied, None
    team, capability = ACTION_AUTH_CONFIG[action_key]["team_capability"]
    item = get_team_capability(team, capability) or {}
    scope = item.get("scope")
    return None, ({str(x).strip().lower() for x in scope} if isinstance(scope, list) else set())


def _authorize_team_target(event, action_key, inst):
    """Per-server team check: scope rows may name the server by instance ID
    or by name, so each identifier is tried (first allow wins)."""
    denied = None
    for ident in _docs._target_identifiers(inst):
        denied = authorize_action(event, action_key, resource_id=ident)
        if not denied:
            return None
    return denied


def instances_for_document(event, document):
    """
    Servers to offer for a document whose approval names a team action:
    every catalog server inside the caller's team scope. Returns
    (instances, denied) — or (None, None) when the document uses
    application access, so the caller lists app-access servers as usual.
    """
    cfg = approved_config().get(document)
    if not cfg or cfg["auth"] == "app":
        return None, None
    denied, scope = _team_scope(event, cfg["auth"])
    if denied:
        return None, denied
    return [i for i in get_instances_for_apps(["ALL"]) if _docs._in_scope(i, scope)], None


def describe_approved_document(name):
    """UI view of one approved document: type, parameters the caller sets,
    regions it exists in. Never raises."""
    primary = _docs.PRIMARY_REGION
    cfg = approved_config().get(name) or {"display_name": None, "auth": "app"}
    out = {"name": name, "display_name": cfg["display_name"] or name, "auth": cfg["auth"],
           "available": False, "reason": None, "automation_type": None,
           "description": None, "parameters": [], "per_target_parameters": [],
           "regions_available": [], "platform_types": []}
    d = _docs._read_document(name, primary)
    if not d.get("found"):
        out["reason"] = (f"Not found in {primary}." if d.get("error") == "not_found"
                         else f"RunStack could not read this document ({d.get('error')}).")
        return out
    if d.get("status") not in (None, "Active"):
        out["reason"] = f"Document status is {d.get('status')}."
        return out
    kind = {"Command": "SSM-RunCommand", "Automation": "SSM-Automation"}.get(d.get("document_type"))
    if not kind:
        out["reason"] = f"{d.get('document_type')} documents can't be run from RunStack."
        return out
    if kind == "SSM-RunCommand":
        regions = [primary] + [r for r in _docs.SUPPORTED_REGIONS
                               if r != primary and _docs._read_document(name, r).get("found")]
    else:
        # Automation documents live in the primary region only and reach
        # other regions through TargetLocations (see inject_target_locations).
        regions = list(_docs.SUPPORTED_REGIONS)
    defs = d.get("parameters") or {}
    params = [_docs._param_spec(n, s) for n, s in defs.items() if n not in AUTO_PARAMETERS]
    # Set by RunStack for each server (shown to the user as such, never asked for).
    per_target = [n for n in PER_TARGET_PARAMETERS if n in defs] if kind == "SSM-Automation" else []
    out.update(available=True, automation_type=kind, description=d.get("description"),
               parameters=params, per_target_parameters=per_target,
               regions_available=regions, platform_types=d.get("platform_types") or [])
    return out


def _platform_mismatch(inst, platform_types):
    """Only when the catalog actually records an OS; unknown never blocks."""
    os_raw = next((str(inst[k]).strip().lower() for k in OS_FIELDS if inst.get(k)), "")
    if not os_raw or not platform_types:
        return None
    wanted = {p.lower() for p in platform_types}
    is_windows = "win" in os_raw
    if is_windows and "windows" not in wanted:
        return "This document doesn't support Windows servers."
    if not is_windows and wanted == {"windows"}:
        return "This document only supports Windows servers."
    return None


# ── Duplicate-submission guard ──────────────────────────────────────────────

def _claim_request(initiator, request_id, group_id):
    """Returns None when this request ID is new for this caller, else the
    stored item of the earlier submission (same caller, within the window)."""
    if not request_id:
        return None
    key = f"run-submit#{initiator}#{request_id}"
    now = int(_time.time())
    table = _locks_table()
    try:
        table.put_item(
            Item={"resource_id": key, "locked_by": initiator, "job_id": group_id, "execution_group_id": group_id,
                  "locked_at": datetime.utcnow().isoformat(), "expires_at": now + RUN_SUBMIT_DEDUPE_SECONDS},
            ConditionExpression="attribute_not_exists(resource_id) OR expires_at < :now",
            ExpressionAttributeValues={":now": now})
        return None
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
    return table.get_item(Key={"resource_id": key}).get("Item") or {"execution_group_id": None}


def _store_result(initiator, request_id, result):
    if not request_id:
        return
    try:
        _locks_table().update_item(
            Key={"resource_id": f"run-submit#{initiator}#{request_id}"},
            UpdateExpression="SET #r = :r",
            ExpressionAttributeNames={"#r": "result"},
            ExpressionAttributeValues={":r": json.dumps(result, default=decimal_default)})
    except Exception as e:  # the run itself is already queued
        logger.warning(f"runs: could not store result for request {request_id}: {e}")


# ── Run header (queued targets for Execution Details) ───────────────────────

def _put_header(group_id, initiator, label, kind, document, targets):
    now = int(_time.time())
    last = max((t["delay_seconds"] for t in targets), default=0)
    try:
        _locks_table().put_item(Item={
            "resource_id": f"{RUN_HEADER_PREFIX}{group_id}", "locked_by": initiator, "job_id": group_id,
            "record": "run_header", "label": label, "kind": kind, "document": document,
            "created_at": datetime.utcnow().isoformat(), "target_count": len(targets),
            "wave_size": RUN_WAVE_SIZE, "wave_seconds": RUN_WAVE_SECONDS,
            "targets": [{k: t[k] for k in ("job_id", "instance_id", "server_name", "account_id", "region",
                                             "environment", "wave", "dispatch_at")} for t in targets],
            "expires_at": now + RUN_HEADER_TTL_SECONDS + last,
        })
    except Exception as e:  # informational only — the jobs carry the group
        logger.warning(f"runs: could not write run header for {group_id}: {e}")


def get_run_header(group_id):
    try:
        item = _locks_table().get_item(Key={"resource_id": f"{RUN_HEADER_PREFIX}{group_id}"}).get("Item")
    except Exception as e:
        logger.warning(f"runs: could not read run header for {group_id}: {e}")
        return None
    return item if item and item.get("record") == "run_header" else None


# ── Submission ──────────────────────────────────────────────────────────────

def _reject(rows, inst, iid, reason, message, error="forbidden"):
    rows.append({"instance_id": iid, "server_name": (inst or {}).get("server_name") or (inst or {}).get("name"),
                 "account_id": (inst or {}).get("account_id"), "region": (inst or {}).get("region"),
                 "status": "NOT_STARTED", "error": error, "reason": reason, "message": message})
    logger.info(f"runs: target {iid} not started — {reason}: {message}")


def _authorize_caller(event, auth):
    """Layer 1, before anything about the document is revealed: application-
    access documents and EC2 use the /notify group gate; team documents use
    their team capability (scoped members pass here and are checked per
    server below)."""
    if auth == "app":
        return authorize_action(event, "ec2_stop_start")
    denied, _scope = _team_scope(event, auth)
    return denied


def handle_run_submission(event, body):
    kind = body.get("kind") or "automation"
    if kind not in ("automation", "ec2_power"):
        return _resp(400, {"error": "invalid_kind", "message": "kind must be automation or ec2_power."})

    raw = body.get("targets")
    if not isinstance(raw, list) or not raw:
        return _resp(400, {"error": "target_required", "message": "targets must be a non-empty list of instance IDs."})
    ids, seen = [], set()
    for v in raw:
        iid = str(v or "").strip()
        if not _INSTANCE_RE.match(iid):
            return _resp(400, {"error": "invalid_instance_id", "message": f"'{iid[:40]}' is not a valid instance ID."})
        if iid not in seen:
            seen.add(iid)
            ids.append(iid)
    if len(ids) > RUN_MAX_TARGETS:
        return _resp(400, {"error": "too_many_targets", "max_targets": RUN_MAX_TARGETS,
                           "message": f"A run can include at most {RUN_MAX_TARGETS} servers."})

    request_id = str(body.get("client_request_id") or "").strip()
    if request_id and not _REQUEST_ID_RE.match(request_id):
        return _resp(400, {"error": "invalid_request_id", "message": "client_request_id is not valid."})

    # What runs on each server.
    if kind == "ec2_power":
        action = str(body.get("action") or "").lower()
        if action not in EC2_POWER_DOCUMENTS:
            return _resp(400, {"error": "invalid_action", "message": "action must be start or stop."})
        document, automation_type, ssm_params = EC2_POWER_DOCUMENTS[action], "SSM-Automation", {}
        label = f"EC2 {action.title()}"
        doc_view = {"regions_available": list(_docs.SUPPORTED_REGIONS), "platform_types": [], "auth": "app"}
        denied = _authorize_caller(event, "app")
        if denied:
            return denied
    else:
        action = None
        document = str(body.get("document") or "").strip()
        if document not in approved_documents():
            return _resp(403, {"error": "forbidden", "reason": "document_not_approved",
                               "message": "That automation is not approved for running from RunStack."})
        denied = _authorize_caller(event, approved_config()[document]["auth"])
        if denied:
            return denied
        doc_view = describe_approved_document(document)
        if not doc_view["available"]:
            return _resp(409, {"error": "document_unavailable", "message": doc_view["reason"]})
        automation_type = doc_view["automation_type"]
        definition = _docs._read_document(document, _docs.PRIMARY_REGION).get("parameters") or {}
        settable = {n: s for n, s in definition.items() if n not in AUTO_PARAMETERS}
        ssm_params, errors = _docs.validate_parameters(settable, body.get("parameters") or {})
        if errors:
            return _resp(400, {"error": "invalid_parameters", "message": "Some parameters are not valid.", "errors": errors})
        label = doc_view.get("display_name") or document
    auth = doc_view.get("auth", "app")

    initiator = job_initiator(event)
    group_id = f"{RUN_GROUP_PREFIX}{uuid.uuid4()}"
    earlier = _claim_request(initiator, request_id, group_id)
    if earlier is not None:
        stored = {}
        try:
            stored = json.loads(earlier.get("result") or "{}")
        except (TypeError, ValueError):
            pass
        return _resp(200, dict(stored, duplicate=True, execution_group_id=earlier.get("execution_group_id"),
                               message="This submission was already received; no second run was started."))

    import notify  # local import: notify routes to this module
    sqs = boto3.client("sqs")
    queue_url = os.getenv("QUEUE_URL")
    origin = {"initiated_by": initiator, "execution_group_id": group_id,
              "execution_group_label": f"{label} ({len(ids)} server{'' if len(ids) == 1 else 's'})"}

    rejected, accepted = [], []
    now = datetime.utcnow()
    for iid in ids:
        inst = get_catalog_instance(iid)
        if not inst:
            _reject(rejected, None, iid, "target_not_found", "That server is not in the RunStack instance catalog.", "not_found")
            continue
        if auth == "app":
            denied = authorize_action(event, "ec2_stop_start", resource_id=iid)
        else:
            denied = _authorize_team_target(event, auth, inst)
        if denied:
            b = _body_of(denied)
            _reject(rejected, inst, iid, b.get("reason") or "forbidden", b.get("message") or "Not authorized for this server.")
            continue
        region = inst.get("region") or ""
        if region not in _docs.SUPPORTED_REGIONS:
            _reject(rejected, inst, iid, "unsupported_region", f"Region '{region or 'unknown'}' is not supported.", "invalid_target")
            continue
        if region not in doc_view["regions_available"]:
            _reject(rejected, inst, iid, "document_not_in_region",
                    f"{document} is not available in {region}, where this server runs.", "incompatible")
            continue
        mismatch = _platform_mismatch(inst, doc_view["platform_types"])
        if mismatch:
            _reject(rejected, inst, iid, "incompatible_platform", mismatch, "incompatible")
            continue

        job_id = str(uuid.uuid4())
        if kind == "ec2_power":
            conflict = check_and_acquire_lock(event, f"ec2:{iid}", job_id=job_id)
            if conflict:
                _reject(rejected, inst, iid, "locked",
                        f"Someone is already performing an action on this instance ({conflict.get('locked_by')}).", "locked")
                continue

        params = dict(ssm_params)
        automation_data = {"DocumentName": document, "Parameters": params}
        if automation_type == "SSM-RunCommand":
            automation_data["InstanceIds"] = [iid]
            automation_data["Comment"] = f"RunStack run {group_id}"[:100]
        else:
            params["InstanceId"] = [iid]
        job = {
            "id": job_id, "job_id": job_id, "region": region, "account_id": str(inst.get("account_id") or ""),
            "resource_id": iid, "automation_type": automation_type, "automation_data": automation_data,
            "automation_name": label,
        }
        for key in ("server_name", "app_id", "app_name", "environment"):
            if inst.get(key):
                job[key] = inst[key]
        job = notify.inject_target_locations(job)
        job.update(origin)
        if not validate_message_payload(job):
            if kind == "ec2_power":
                release_action_lock(f"ec2:{iid}")
            _reject(rejected, inst, iid, "invalid_job", "Could not build a valid job (check account/region in the catalog).", "dispatch_failed")
            continue

        wave = len(accepted) // RUN_WAVE_SIZE
        delay = min(SQS_MAX_DELAY, wave * RUN_WAVE_SECONDS)
        try:
            sqs.send_message(QueueUrl=queue_url, MessageBody=json.dumps(job, default=decimal_default), DelaySeconds=delay)
        except Exception as e:
            logger.error(f"runs: queueing {iid} for {group_id} failed: {e}")
            if kind == "ec2_power":
                release_action_lock(f"ec2:{iid}")
            _reject(rejected, inst, iid, "dispatch_failed", "RunStack could not queue this server. Try again.", "dispatch_failed")
            continue
        accepted.append({
            "job_id": job_id, "instance_id": iid, "server_name": inst.get("server_name") or inst.get("name"),
            "account_id": job["account_id"], "region": region, "environment": inst.get("environment"),
            "wave": wave + 1, "delay_seconds": delay,
            "dispatch_at": (now + timedelta(seconds=delay)).isoformat(),
        })

    if accepted:
        _put_header(group_id, initiator, label, kind, document, accepted)
    logger.info(f"runs: {group_id} {label} by {initiator} — {len(accepted)} queued, {len(rejected)} not started "
                f"(of {len(ids)})")
    result = {
        "execution_group_id": group_id if accepted else None,
        "run_job_id": accepted[0]["job_id"] if accepted else None,
        "label": label, "document": document, "kind": kind, "action": action,
        "total_requested": len(ids), "accepted": len(accepted), "rejected_count": len(rejected),
        "targets": accepted, "rejected": rejected,
        # Dispatch batches: how many servers are released at a time and how
        # far apart — a release rate, not a limit on how many run at once.
        "concurrency": {"wave_size": RUN_WAVE_SIZE, "wave_seconds": RUN_WAVE_SECONDS,
                        "waves": (accepted[-1]["wave"] if accepted else 0)},
    }
    _store_result(initiator, request_id, result)
    return _resp(200, result)


# ── Catalog for the Run Automations page ────────────────────────────────────

def list_approved_documents_response():
    docs = [describe_approved_document(d) for d in approved_documents()]
    return _resp(200, {
        "documents": docs, "count": len(docs), "configured": bool(APPROVED_AUTOMATION_DOCUMENTS),
        # Staggered dispatch: up to wave_size jobs are released every
        # wave_seconds. It paces when jobs start; it is not a cap on how many
        # run at once (a long job can overlap the next batch).
        "limits": {"max_targets": RUN_MAX_TARGETS, "wave_size": RUN_WAVE_SIZE, "wave_seconds": RUN_WAVE_SECONDS,
                   "dispatch_batch_size": RUN_WAVE_SIZE, "dispatch_interval_seconds": RUN_WAVE_SECONDS},
    })
