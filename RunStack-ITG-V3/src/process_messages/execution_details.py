"""
Execution Details — per-server status and running script output for one
RunStack execution (a single job, or every job in an explicit execution
group such as one scheduled run or one batch health-check sweep).

Routes (both read-only, both under the existing /jobs/{jobId} resource):

  GET /jobs/{jobId}/execution
      Header, per-status counts and a page of targets (servers). With
      ?target=<key> it also returns that target's Steps and Details.
  GET /jobs/{jobId}/logs?target=<key>
      Incremental stdout/stderr for one target from CloudWatch Logs, using
      opaque continuation cursors (forward for new output, backward for
      older output).

Where the SSM identifiers come from
  * ssm_dispatch       written on the job item by the Step Functions
                       workflow right after SendCommand /
                       StartAutomationExecution (RecordDispatch* states).
  * Step Functions     fallback for jobs dispatched before that change:
    history            the dispatch task's output in the execution history.
  * execution_tracking written here once resolved: child Automation
                       execution, command IDs and plugins per target.
  * exec_outcome       written here once a job is finished, so finished
                       jobs in a large group never need SSM calls again.

Trust rules
  * Nothing that decides WHERE we read (account, region, execution/command
    ID, log group, log stream) comes from the browser. The browser only
    sends a job ID and a target key (<job_id>~<instance_id>); both are
    checked against the jobs table, and every AWS location is derived from
    the job record and SSM's own responses.
  * Access is checked before any SSM or CloudWatch call (see
    authorize_job_view): admin; the person who started the job; team
    capability for team-owned documents (SQL/DR); otherwise app-access on
    the target instance, exactly like EC2. Viewing does not stamp
    runstack-app-access.last_used_at (that marks real actions only).
  * A failure to READ status or logs is reported separately from the
    execution's own outcome, so the UI never shows "failed" because a
    permission or throttling error hid the real status.
"""

from shared import *
import re
import threading
from datetime import timezone
from concurrent.futures import ThreadPoolExecutor

from boto3.dynamodb.conditions import Key

from jobs import automation_label, document_short_name, _is_sensitive, REDACTED

# ── Configuration ───────────────────────────────────────────────────────────
WORKFLOW_ARN = os.getenv("WORKFLOW_ARN", "")
EXECUTION_GROUP_INDEX = os.getenv("EXECUTION_GROUP_INDEX", "execution-group-index")
PRIMARY_REGION = os.getenv("RUNSTACK_PRIMARY_REGION", "us-east-1")
EXECUTION_REGIONS = {r.strip() for r in os.getenv("RUNSTACK_EXECUTION_REGIONS", "us-east-1,us-west-2").split(",") if r.strip()}
CENTRAL_ACCOUNT_ID = os.getenv("RUNSTACK_CENTRAL_ACCOUNT_ID", "")   # blank → this Lambda's own account
CROSS_ROLE = os.getenv("CROSS_ACCOUNT_ROLE_NAME", "runstack-cross-account-role")

STATUS_POLL_MS = int(os.getenv("EXEC_STATUS_POLL_MS", "5000"))
LOG_POLL_MS = int(os.getenv("EXEC_LOG_POLL_MS", "10000"))
TARGET_PAGE_MAX = 200
GROUP_MAX_MEMBERS = int(os.getenv("EXEC_GROUP_MAX_MEMBERS", "5000"))
LOG_EVENTS_PER_STREAM = 250
LOG_RESPONSE_BYTES = 900_000       # stay well under Lambda/API Gateway limits
LOG_MESSAGE_MAX = 64_000
SSM_WORKERS = 8
MAX_LIVE_PER_REQUEST = int(os.getenv("EXEC_MAX_LIVE_PER_REQUEST", "25"))

_INSTANCE_RE = re.compile(r"^(i|mi)-[0-9a-f]{8,17}$")
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9._:\-]{1,128}$")
_ACCOUNT_RE = re.compile(r"^\d{12}$")

ACTIVE = ("pending", "running")
FINISHED = ("success", "failed", "cancelled", "timed_out")

# Team-owned documents: the same team capability that authorizes running
# them authorizes viewing their output (admin/operator bypass inside
# require_team_capability, exactly as for running them).
_TEAM_DOC_ACTIONS = {
    (HEALTHCHECK_DOCUMENT_NAME or "").lower(): "sql_healthcheck",
    (DR_STATUS_CHECK_DOCUMENT_NAME or "").lower(): "sql_dr_failover",
    (DR_FAILOVER_DOCUMENT_NAME or "").lower(): "sql_dr_failover",
}
_TEAM_DOC_ACTIONS.pop("", None)


def _resp(code, body, extra_headers=None):
    headers = dict(CORS_HEADERS)
    if extra_headers:
        headers.update(extra_headers)
    return {"statusCode": code, "headers": headers, "body": json.dumps(body, default=decimal_default)}


def _now_iso():
    return datetime.utcnow().isoformat() + "Z"


# ── Small TTL cache (per warm Lambda) ───────────────────────────────────────
_cache = {}
_cache_lock = threading.Lock()


def _cached(key, ttl, fn):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[1] > now:
            return hit[0]
    value = fn()
    with _cache_lock:
        if len(_cache) > 5000:
            _cache.clear()
        _cache[key] = (value, now + ttl)
    return value


# ── AWS clients (own account or runstack-cross-account-role) ────────────────
_own_account = {"id": None}
_creds = {}
_clients = {}
_client_lock = threading.Lock()


def own_account_id():
    if _own_account["id"] is None:
        _own_account["id"] = boto3.client("sts").get_caller_identity()["Account"]
    return _own_account["id"]


def central_account_id():
    return CENTRAL_ACCOUNT_ID or own_account_id()


def aws_client(service, account_id, region):
    """Client for `service` in account/region. Only validated, server-derived
    locations reach here; still re-checked as defence in depth."""
    if not _ACCOUNT_RE.match(str(account_id or "")) or region not in EXECUTION_REGIONS:
        raise ValueError(f"refusing AWS location {account_id}/{region}")
    with _client_lock:
        # Reads go through runstack-cross-account-role in every account —
        # including RunStack's own (central) account, where the workflow
        # uses the same role — because that role already has
        # ssm:Get*/List*/Describe*. Only if it can't be assumed in our own
        # account do we fall back to this Lambda's own credentials.
        if _creds.get(account_id) == "own":
            key = (service, account_id, region, "own")
            if key not in _clients:
                _clients[key] = boto3.client(service, region_name=region)
            return _clients[key]
        c = _creds.get(account_id)
        if not c or c["Expiration"].timestamp() - time.time() < 300:
            try:
                c = boto3.client("sts").assume_role(
                    RoleArn=f"arn:aws:iam::{account_id}:role/{CROSS_ROLE}",
                    RoleSessionName="runstack-execution-details",
                )["Credentials"]
            except ClientError as e:
                if account_id == own_account_id() and _err_info(e)["kind"] == "permission":
                    _creds[account_id] = "own"
                    key = (service, account_id, region, "own")
                    _clients[key] = boto3.client(service, region_name=region)
                    return _clients[key]
                raise
            _creds[account_id] = c
            for k in [k for k in _clients if k[1] == account_id]:
                _clients.pop(k, None)
        key = (service, account_id, region, c["AccessKeyId"])
        if key not in _clients:
            _clients[key] = boto3.client(
                service, region_name=region,
                aws_access_key_id=c["AccessKeyId"], aws_secret_access_key=c["SecretAccessKey"],
                aws_session_token=c["SessionToken"],
            )
        return _clients[key]


def _err_info(e):
    """Classify a retrieval error. These are problems READING the execution,
    never the execution's own result."""
    if isinstance(e, ClientError):
        code = e.response.get("Error", {}).get("Code", "ClientError")
        msg = e.response.get("Error", {}).get("Message", "")
    else:
        code, msg = type(e).__name__, str(e)
    if code in ("ThrottlingException", "Throttling", "TooManyRequestsException", "RequestLimitExceeded"):
        kind = "throttled"
    elif code in ("AccessDenied", "AccessDeniedException", "UnauthorizedOperation") or "not authorized" in msg.lower():
        kind = "permission"
    elif code in ("AutomationExecutionNotFoundException", "InvalidCommandId", "ResourceNotFoundException",
                  "InvocationDoesNotExist", "ExecutionDoesNotExist"):
        kind = "not_found"
    else:
        kind = "error"
    return {"kind": kind, "code": code, "message": msg[:600]}


def _parse_ts(v):
    """Datetime (aware or naive-UTC) or ISO string → aware UTC datetime."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v.replace(tzinfo=timezone.utc) if v.tzinfo is None else v.astimezone(timezone.utc)
    try:
        d = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d.replace(tzinfo=timezone.utc) if d.tzinfo is None else d.astimezone(timezone.utc)


def _ts(v):
    """One timestamp format for every source: UTC ISO-8601 with 'Z'.
    (Job records store naive UTC; SSM returns aware datetimes.)"""
    d = _parse_ts(v)
    return d.isoformat().replace("+00:00", "Z") if d else None


# ── Status mapping ──────────────────────────────────────────────────────────
# Keeps SSM's detailed outcome (status_detail) alongside a small set of
# display buckets. Run Command StatusDetails such as DeliveryTimedOut,
# ExecutionTimedOut and Undeliverable are preserved verbatim.

def map_command_status(status, detail=None):
    s = (status or "").replace(" ", "")
    d = (detail or "").replace(" ", "")
    if d in ("DeliveryTimedOut", "ExecutionTimedOut") or s == "TimedOut":
        return "timed_out"
    if s in ("Cancelled", "Cancelling") or d in ("Cancelled", "Terminated"):
        return "cancelled"
    if d == "Undeliverable" or s == "Failed":
        return "failed"
    if s == "Success":
        return "success"
    if s == "InProgress":
        return "running"
    return "pending"   # Pending, Delayed, unknown


_AUTOMATION_MAP = {
    "Pending": "pending", "Scheduled": "pending", "PendingApproval": "pending", "Approved": "running",
    "PendingChangeCalendarOverride": "pending", "ChangeCalendarOverrideApproved": "running",
    "InProgress": "running", "Waiting": "running", "RunbookInProgress": "running", "Cancelling": "running",
    "Success": "success", "CompletedWithSuccess": "success",
    "TimedOut": "timed_out", "Cancelled": "cancelled", "Exited": "cancelled",
    "Failed": "failed", "Rejected": "failed", "CompletedWithFailure": "failed",
    "ChangeCalendarOverrideRejected": "failed",
}


def map_automation_status(status):
    return _AUTOMATION_MAP.get(status or "", "pending")


def map_job_status(status):
    """RunStack job status → bucket. Used only when SSM detail is not
    available; the job record cannot tell timeout from failure."""
    s = (status or "").upper()
    if s in ("COMPLETED", "SUCCEEDED", "SUCCESS"):
        return "success"
    if s == "TIMED_OUT":
        return "timed_out"
    if s in ("CANCELLED", "CANCELED"):
        return "cancelled"
    if s in ("FAILED", "ERROR"):
        return "failed"
    if s in ("RUNNING", "IN_PROGRESS"):
        return "running"
    return "pending"


STATUS_LABELS = {"pending": "Pending", "running": "Running", "success": "Succeeded", "failed": "Failed",
                 "cancelled": "Cancelled", "timed_out": "Timed out"}


def job_is_active(job):
    return map_job_status(job.get("status")) in ACTIVE


# ── Job helpers ─────────────────────────────────────────────────────────────

def job_instances(job):
    """Instance IDs a job targets, from the job record only."""
    out = []

    def add(v):
        if isinstance(v, str) and _INSTANCE_RE.match(v) and v not in out:
            out.append(v)

    add(job.get("resource_id"))
    ad = job.get("automation_data") or {}
    for v in ad.get("InstanceIds") or []:
        add(v)
    params = ad.get("Parameters") or {}
    if isinstance(params, dict):
        for k in ("InstanceId", "InstanceIds", "instanceId"):
            v = params.get(k)
            for x in (v if isinstance(v, list) else [v]):
                add(x)
    return out


def job_automation_name(job):
    """The name given when the job was submitted. Older scheduled jobs carry
    it inside automation_data (the schedule's payload template) rather than
    at the top level, so look in both."""
    name = job.get("automation_name") or (job.get("automation_data") or {}).get("automation_name")
    return str(name).strip() if name and str(name).strip() else None


def make_target_key(job_id, instance_id):
    return f"{job_id}~{instance_id or '-'}"


def parse_target_key(key):
    if not key or "~" not in key:
        return None, None
    job_id, inst = key.rsplit("~", 1)
    if not _JOB_ID_RE.match(job_id):
        return None, None
    if inst == "-":
        return job_id, None
    if not _INSTANCE_RE.match(inst):
        return None, None
    return job_id, inst


def _job_location(job):
    account, region = str(job.get("account_id") or ""), str(job.get("region") or "")
    if not _ACCOUNT_RE.match(account) or region not in EXECUTION_REGIONS:
        return None, None
    return account, region


def _update_job(job_id, expr, values, names=None, condition="attribute_exists(job_id)"):
    try:
        kw = {"Key": {"job_id": job_id}, "UpdateExpression": expr, "ExpressionAttributeValues": values,
              "ConditionExpression": condition}
        if names:
            kw["ExpressionAttributeNames"] = names
        get_dynamodb_table().update_item(**kw)
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            logger.warning(f"execution_details: could not update job {job_id}: {e}")
    except Exception as e:  # never fail a read because a cache write failed
        logger.warning(f"execution_details: could not update job {job_id}: {e}")
    return False


# ── Authorization ───────────────────────────────────────────────────────────

def _caller(event):
    claims, role = get_claims_and_role(event)
    username = claims.get("username", "") or ""
    email = username.replace("AzureAD_", "") if username.startswith("AzureAD_") else (claims.get("email") or username)
    return claims, role, (email or "").strip().lower()


def _user_instances(email):
    """Every instance the user's app-access grants cover, read once per
    minute (one app_id-index query per granted app) so checking hundreds of
    servers in a bulk run costs no more than checking one. None = 'ALL'."""
    def load():
        apps = get_user_apps(email)
        if "ALL" in apps:
            return None
        table = boto3.resource("dynamodb").Table(INSTANCE_CATALOG_TABLE)
        found = set()
        for app_id in apps:
            kw = {"IndexName": "app_id-index", "KeyConditionExpression": Key("app_id").eq(app_id),
                  "ProjectionExpression": "instance_id"}
            try:
                while True:
                    page = table.query(**kw)
                    found.update(i["instance_id"] for i in page.get("Items", []) if i.get("instance_id"))
                    if not page.get("LastEvaluatedKey"):
                        break
                    kw["ExclusiveStartKey"] = page["LastEvaluatedKey"]
            except Exception as e:
                logger.warning(f"app-access lookup failed for {app_id}: {e}")
        return frozenset(found)
    return _cached(("user-instances", email), 60, load)


def can_view_instance(email, instance_id):
    """Same rule as validate_instance_access (runstack-app-access →
    runstack-instance-catalog), but without the last_used_at write — that
    stamp is for real actions, and this page polls."""
    if not email or not instance_id:
        return False
    allowed = _user_instances(email)
    return allowed is None or instance_id in allowed


def _team_allows(event, job, who):
    """Team-owned documents: the capability that allows running them allows
    viewing them. Decisions are cached per caller for 60 s; the unscoped
    check (operator bypass or scope ALL) runs first, so a large group of
    one team's jobs costs one lookup."""
    action = _TEAM_DOC_ACTIONS.get(document_short_name(job).lower())
    if not action:
        return False
    team, capability = ACTION_AUTH_CONFIG[action]["team_capability"]

    def allowed(rid):
        return _cached(("team", who, team, capability, rid), 60,
                       lambda: require_team_capability(event, team, capability, rid) is None)

    if allowed(None):
        return True
    return any(rid and allowed(rid) for rid in (job.get("resource_id"), job.get("server_name")))


def authorize_job_view(event, job):
    """Returns (visible, visible_instances or None for 'all', reason)."""
    claims, role, email = _caller(event)
    if role == "admin":
        return True, None, "admin"
    if claims.get("runstack:authorized") == "false" and role == "none" and not is_in_any_team(claims):
        return False, [], "not_in_group"
    if email and str(job.get("initiated_by") or "").lower() == email:
        return True, None, "initiator"
    try:
        if _team_allows(event, job, f"{role}|{email}|{claims.get('runstack:groups', '')}"):
            return True, None, "team_capability"
    except Exception as e:
        logger.warning(f"team capability check failed for job {job.get('job_id')}: {e}")
    visible = [i for i in job_instances(job) if can_view_instance(email, i)]
    if visible:
        return True, visible, "app_access"
    return False, [], "no_access"


def _forbidden(job_id):
    # Same body whether the job is missing or not visible, so IDs of other
    # people's jobs can't be probed.
    return _resp(404, {"error": "not_found", "message": f"Execution {job_id} was not found or you do not have access to it."})


# ── Dispatch identifiers ────────────────────────────────────────────────────

def _normalize_dispatch(d):
    if not isinstance(d, dict):
        return None
    kind = d.get("kind")
    if kind not in ("run_command", "run_command_wrapper", "automation", "automation_target_locations"):
        return None
    out = {k: str(d[k]) for k in ("kind", "command_id", "automation_execution_id", "dispatch_account",
                                   "dispatch_region", "dispatched_at") if d.get(k) not in (None, "")}
    if not (out.get("command_id") or out.get("automation_execution_id")):
        return None
    return out


def _expected_dispatch_location(job, kind):
    account, region = _job_location(job)
    if kind in ("run_command_wrapper", "automation_target_locations"):
        return central_account_id(), PRIMARY_REGION
    return account, region


def _dispatch_from_history(job):
    """Fallback for jobs dispatched before the workflow recorded ssm_dispatch:
    read the dispatch task's output from the Step Functions history."""
    if not WORKFLOW_ARN or ":stateMachine:" not in WORKFLOW_ARN:
        return None
    exec_arn = WORKFLOW_ARN.replace(":stateMachine:", ":execution:") + ":" + job["job_id"]
    sfn = boto3.client("stepfunctions")
    kwargs = {"executionArn": exec_arn, "reverseOrder": True, "maxResults": 1000, "includeExecutionData": True}
    for _ in range(5):
        page = sfn.get_execution_history(**kwargs)
        for ev in page.get("events", []):
            det = ev.get("taskSucceededEventDetails")
            if not det or det.get("resourceType") != "aws-sdk:ssm":
                continue
            try:
                out = json.loads(det.get("output") or "{}")
            except ValueError:
                continue
            region_is_primary = job.get("region") == PRIMARY_REGION
            if det.get("resource") == "sendCommand" and out.get("Command", {}).get("CommandId"):
                kind = "run_command"
                d = {"kind": kind, "command_id": out["Command"]["CommandId"]}
            elif det.get("resource") == "startAutomationExecution" and out.get("AutomationExecutionId"):
                if job.get("automation_type") == "SSM-RunCommand":
                    kind = "run_command_wrapper"
                else:
                    kind = "automation" if region_is_primary else "automation_target_locations"
                d = {"kind": kind, "automation_execution_id": out["AutomationExecutionId"]}
            else:
                continue
            acc, reg = _expected_dispatch_location(job, kind)
            d.update(dispatch_account=acc, dispatch_region=reg, dispatched_at=_ts(ev.get("timestamp")) or "")
            return _normalize_dispatch(d)
        if not page.get("nextToken"):
            break
        kwargs["nextToken"] = page["nextToken"]
    return None


def _failure_from_history(job):
    """For a job that failed before anything reached SSM (e.g. SSM rejected
    StartAutomationExecution): the error Step Functions recorded, so the page
    can say WHY instead of only 'no command'. Newest failure wins."""
    if not WORKFLOW_ARN or ":stateMachine:" not in WORKFLOW_ARN:
        return None
    exec_arn = WORKFLOW_ARN.replace(":stateMachine:", ":execution:") + ":" + job["job_id"]
    page = boto3.client("stepfunctions").get_execution_history(
        executionArn=exec_arn, reverseOrder=True, maxResults=200, includeExecutionData=True)
    for ev in page.get("events", []):
        det = ev.get("taskFailedEventDetails")
        if det and det.get("resourceType", "").startswith("aws-sdk"):
            cause = det.get("cause") or ""
            try:
                c = json.loads(cause)
                cause = c.get("errorMessage") or c.get("Message") or c.get("message") or cause
            except (ValueError, AttributeError):
                pass
            return {"error": det.get("error"), "cause": str(cause)[:600],
                    "step": f"{det.get('resourceType')}:{det.get('resource')}", "at": _ts(ev.get("timestamp"))}
    return None


def get_dispatch(job):
    """(dispatch, error). Dispatch locations are re-derived from the job and
    must match what the workflow recorded."""
    d = _normalize_dispatch(job.get("ssm_dispatch"))
    if d:
        exp = _expected_dispatch_location(job, d["kind"])
        if (d.get("dispatch_account"), d.get("dispatch_region")) != exp:
            return None, {"kind": "error", "code": "DispatchLocationMismatch",
                          "message": "Recorded dispatch location does not match the job"}
        return d, None
    if map_job_status(job.get("status")) == "pending":
        return None, None
    if not WORKFLOW_ARN or ":stateMachine:" not in WORKFLOW_ARN:
        # Optional: the Step Functions history lookup (for jobs started
        # before the workflow recorded ssm_dispatch) needs WORKFLOW_ARN and
        # states:GetExecutionHistory. Without it such jobs simply have no
        # SSM detail — that is not a read error.
        return None, None
    key = ("hist", job["job_id"])
    with _cache_lock:
        hit = _cache.get(key)
    if hit and hit[1] > time.time():
        d = hit[0]
    else:
        try:
            d = _dispatch_from_history(job)
        except Exception as e:
            return None, _err_info(e)
        # A miss on a still-running job may just be early: re-check soon.
        ttl = 300 if d or not job_is_active(job) else 10
        with _cache_lock:
            _cache[key] = (d, time.time() + ttl)
    if d:
        _update_job(job["job_id"], "SET ssm_dispatch = :d", {":d": d},
                    condition="attribute_exists(job_id) AND attribute_not_exists(ssm_dispatch)")
    return d, None


# ── SSM reads ───────────────────────────────────────────────────────────────

def _ssm(account, region):
    return aws_client("ssm", account, region)


def get_automation(account, region, execution_id, active=True):
    def load():
        return _ssm(account, region).get_automation_execution(AutomationExecutionId=execution_id)["AutomationExecution"]
    return _cached(("auto", account, region, execution_id), 3 if active else 600, load)


def find_child_automation(parent, job):
    """Child execution created by TargetLocations in the job's own
    account/region: the parent's step output pointer when present, else a
    ParentExecutionId search in the target account."""
    account, region = _job_location(job)
    for step in parent.get("StepExecutions") or []:
        tl = step.get("TargetLocation") or {}
        accs, regs = tl.get("Accounts") or [], tl.get("Regions") or []
        if accs and account not in accs:
            continue
        if regs and region not in regs:
            continue
        ids = (step.get("Outputs") or {}).get("ExecutionId") or []
        if ids:
            return ids[0], account, region
    try:
        res = _ssm(account, region).describe_automation_executions(
            Filters=[{"Key": "ParentExecutionId", "Values": [parent["AutomationExecutionId"]]}], MaxResults=5)
        metas = res.get("AutomationExecutionMetadataList") or []
        if metas:
            return metas[0]["AutomationExecutionId"], account, region
    except ClientError as e:
        if _err_info(e)["kind"] != "not_found":
            raise
    return None, account, region


def list_invocations(account, region, command_id, instance_id=None, active=True):
    def load():
        kw = {"CommandId": command_id, "Details": True, "MaxResults": 50}
        if instance_id:
            kw["InstanceId"] = instance_id
        out = []
        ssm = _ssm(account, region)
        while True:
            page = ssm.list_command_invocations(**kw)
            out.extend(page.get("CommandInvocations") or [])
            if not page.get("NextToken") or len(out) >= 1000:
                return out
            kw["NextToken"] = page["NextToken"]
    return _cached(("inv", account, region, command_id, instance_id), 3 if active else 600, load)


def _redact_map(m):
    if not isinstance(m, dict):
        return m
    return {k: (REDACTED if _is_sensitive(k) else v) for k, v in m.items()}


def _first(v):
    return v[0] if isinstance(v, list) and v else v


def _automation_steps(auto):
    steps = []
    for s in auto.get("StepExecutions") or []:
        outputs = s.get("Outputs") or {}
        command_id = _first(outputs.get("CommandId")) if s.get("Action") == "aws:runCommand" else None
        steps.append({
            "name": s.get("StepName"),
            "action": s.get("Action"),
            "status": map_automation_status(s.get("StepStatus")),
            "status_detail": s.get("StepStatus"),
            "started_at": _ts(s.get("ExecutionStartTime")),
            "ended_at": _ts(s.get("ExecutionEndTime")),
            "failure_message": s.get("FailureMessage"),
            "outputs": _redact_map({k: v for k, v in outputs.items() if k != "Output"}),
            "command_id": command_id,
            "child_execution_id": _first(outputs.get("ExecutionId")),
            "has_running_output": bool(command_id),
        })
    return steps


def _current_step(steps):
    for s in steps:
        if s["status"] == "running":
            return s["name"]
    pend = [s for s in steps if s["status"] == "pending"]
    return pend[0]["name"] if pend else None


def _plugins(inv):
    out = []
    for p in inv.get("CommandPlugins") or []:
        out.append({
            "name": p.get("Name"),
            "status": map_command_status(p.get("Status"), p.get("StatusDetails")),
            "status_detail": p.get("StatusDetails") or p.get("Status"),
            "response_code": p.get("ResponseCode"),
            "started_at": _ts(p.get("ResponseStartDateTime")),
            "ended_at": _ts(p.get("ResponseFinishDateTime")),
            "final_output_preview": p.get("Output") or "",
        })
    return out


# ── Per-job resolution ──────────────────────────────────────────────────────

def _base_target(job, instance_id):
    return {
        "key": make_target_key(job["job_id"], instance_id),
        "job_id": job["job_id"],
        "instance_id": instance_id,
        "server_name": job.get("server_name") if instance_id in (job.get("resource_id"), None) else None,
        "account_id": job.get("account_id"),
        "region": job.get("region"),
        "status": map_job_status(job.get("status")),
        "status_detail": job.get("status"),
        "status_source": "runstack",
        "current_step": None,
        "started_at": _ts(job.get("created_at")),
        "ended_at": None if job_is_active(job) else _ts(job.get("updated_at")),
        "output_mode": "none",
        "retrieval_error": None,
    }


def resolve_job(job, detail=False, only_instance=None):
    """Live view of one job from SSM.

    Returns {targets, steps, ids, command_refs, errors}; command_refs maps
    instance_id → [(command_id, account, region)] for the logs endpoint.
    SSM read errors leave the RunStack status in place and are reported in
    retrieval_error — they are never turned into a failed target.
    """
    instances = job_instances(job)
    if only_instance:
        instances = [only_instance]
    targets = {i: _base_target(job, i) for i in (instances or [None])}
    result = {"targets": targets, "steps": [], "ids": {}, "command_refs": {}, "errors": [], "document": document_short_name(job),
              "workflow_error": None}
    atype = job.get("automation_type")
    active = job_is_active(job)

    if atype == "EC2-Action":
        for t in targets.values():
            t["output_mode"] = "none"
            t["status_detail"] = f"{job.get('status')}" + (f" · instance {job.get('ec2_state')}" if job.get("ec2_state") else "")
        return result

    account, region = _job_location(job)
    if not account:
        result["errors"].append({"kind": "error", "code": "InvalidJobLocation", "message": "Job has no valid account/region"})
        return result

    dispatch, derr = get_dispatch(job)
    if derr:
        result["errors"].append(derr)
    if not dispatch:
        wf_err = None
        de = job.get("dispatch_error")
        if isinstance(de, dict) and de.get("detail") and not de.get("error"):
            # The workflow stores the whole Catch output as one JSON string
            # (States.JsonToString($.error)) so a missing Cause can never
            # break the execution. Unpack it into error/cause here.
            try:
                d = json.loads(de["detail"])
                de = {**de, "error": d.get("Error") or "Error", "cause": d.get("Cause") or ""}
            except (ValueError, TypeError, AttributeError):
                de = {**de, "error": "Error", "cause": str(de["detail"])}
        if isinstance(de, dict) and de.get("error"):
            cause = str(de.get("cause") or "")
            try:
                c = json.loads(cause)
                cause = c.get("errorMessage") or c.get("Message") or c.get("message") or cause
            except (ValueError, AttributeError):
                pass
            wf_err = {"error": de.get("error"), "cause": cause[:600], "step": de.get("step"), "at": _ts(de.get("at"))}
        elif not derr and WORKFLOW_ARN and map_job_status(job.get("status")) in ("failed", "timed_out", "cancelled"):
            try:
                wf_err = _cached(("wferr", job["job_id"]), 600, lambda: _failure_from_history(job))
            except Exception as e:
                logger.warning(f"could not read workflow failure for {job.get('job_id')}: {e}")
        result["workflow_error"] = wf_err
        for t in targets.values():
            t["output_mode"] = "live"
            if derr:
                t["retrieval_error"] = derr
            if wf_err:
                t["status_detail"] = f"Not started in Systems Manager: {wf_err['error']}"
        return result
    result["ids"]["dispatch"] = dispatch

    try:
        kind = dispatch["kind"]
        command_id = dispatch.get("command_id")
        automation = None
        # 1. Automation (direct, central TargetLocations parent, or the
        #    cross-region Run Command wrapper) → the execution that ran in
        #    the job's own account/region.
        if kind in ("automation", "automation_target_locations", "run_command_wrapper"):
            parent = get_automation(dispatch["dispatch_account"], dispatch["dispatch_region"],
                                    dispatch["automation_execution_id"], active)
            result["ids"]["automation_execution_id"] = parent.get("AutomationExecutionId")
            if kind == "automation":
                automation = parent
            else:
                result["ids"]["parent_status"] = parent.get("AutomationExecutionStatus")
                child_id, c_acc, c_reg = find_child_automation(parent, job)
                if child_id:
                    result["ids"].update(child_execution_id=child_id, child_account=c_acc, child_region=c_reg)
                    automation = get_automation(c_acc, c_reg, child_id, active)
                else:
                    # Parent exists but the child has not been created (or
                    # was never created) yet: show the parent's status.
                    ps = map_automation_status(parent.get("AutomationExecutionStatus"))
                    for t in targets.values():
                        t.update(status=ps, status_detail=parent.get("AutomationExecutionStatus"), status_source="ssm",
                                 current_step="Starting in target account", output_mode="live")
                        if ps in FINISHED:
                            t["status_detail"] = f"{parent.get('AutomationExecutionStatus')} before the target-account execution started"
                    return result

        if automation is not None:
            steps = _automation_steps(automation)
            result["steps"] = steps
            a_status = map_automation_status(automation.get("AutomationExecutionStatus"))
            cmd_steps = [s for s in steps if s["command_id"]]
            for inst, t in targets.items():
                t.update(status=a_status, status_detail=automation.get("AutomationExecutionStatus"),
                         status_source="ssm", current_step=_current_step(steps),
                         started_at=_ts(automation.get("ExecutionStartTime")) or t["started_at"],
                         ended_at=_ts(automation.get("ExecutionEndTime")),
                         output_mode="live" if cmd_steps else "none")
                if automation.get("FailureMessage") and a_status not in ("success",) + ACTIVE:
                    t["status_detail"] = f"{automation.get('AutomationExecutionStatus')}: {automation['FailureMessage'][:200]}"
                result["command_refs"][inst] = [(s["command_id"], account, region, s["name"]) for s in cmd_steps]
            if kind == "run_command_wrapper" and cmd_steps:
                # The wrapper's aws:runCommand step is the real command:
                # use per-instance command status below.
                command_id = cmd_steps[-1]["command_id"]
                result["ids"]["command_id"] = command_id
            else:
                result["ids"]["command_ids"] = [s["command_id"] for s in cmd_steps]
                return result
            if not command_id:
                return result

        # 2. Run Command: one invocation per instance.
        if command_id:
            result["ids"]["command_id"] = command_id
            invs = list_invocations(account, region, command_id, only_instance, active)
            by_inst = {inv.get("InstanceId"): inv for inv in invs}
            for inst in list(targets):
                if inst is None:
                    continue
                inv = by_inst.get(inst)
                t = targets[inst]
                t["output_mode"] = "live"
                result["command_refs"][inst] = [(command_id, account, region, None)]
                if not inv:
                    # Listed on the job but SSM has no invocation for it yet.
                    t.update(status="pending" if active else t["status"], status_source="ssm" if active else "runstack",
                             status_detail="Waiting for Systems Manager to deliver the command" if active else t["status_detail"])
                    continue
                plugins = _plugins(inv)
                cw = inv.get("CloudWatchOutputConfig") or {}
                t.update(
                    status=map_command_status(inv.get("Status"), inv.get("StatusDetails")),
                    status_detail=inv.get("StatusDetails") or inv.get("Status"),
                    status_source="ssm",
                    current_step=next((p["name"] for p in plugins if p["status"] == "running"), None),
                    started_at=_ts(inv.get("RequestedDateTime")) or t["started_at"],
                    ended_at=max([p["ended_at"] for p in plugins if p["ended_at"]], default=None)
                    if map_command_status(inv.get("Status"), inv.get("StatusDetails")) in FINISHED else None,
                    output_mode="live" if cw.get("CloudWatchOutputEnabled") else "final_only",
                    server_name=t["server_name"] or inv.get("InstanceName") or None,
                )
                if detail:
                    t["plugins"] = plugins
                    t["cloudwatch"] = {"enabled": bool(cw.get("CloudWatchOutputEnabled")),
                                       "log_group": cw.get("CloudWatchLogGroupName") or None}
                    t["document_name"] = inv.get("DocumentName")
                    t["command_comment"] = inv.get("Comment")
            # Instances SSM reports that the job record did not list (only
            # for the job's own command; still the same account/region).
            if not only_instance:
                for inst, inv in by_inst.items():
                    if inst and inst not in targets and _INSTANCE_RE.match(inst):
                        t = _base_target(job, inst)
                        t.update(status=map_command_status(inv.get("Status"), inv.get("StatusDetails")),
                                 status_detail=inv.get("StatusDetails") or inv.get("Status"), status_source="ssm",
                                 output_mode="live", server_name=inv.get("InstanceName") or None)
                        targets[inst] = t
                        result["command_refs"][inst] = [(command_id, account, region, None)]
    except Exception as e:
        info = _err_info(e)
        logger.warning(f"execution_details: SSM read failed for job {job.get('job_id')}: {info}")
        result["errors"].append(info)
        for t in targets.values():
            t["retrieval_error"] = info
    return result


def _persist(job, res):
    """Store resolved IDs (and, once finished, the outcome) on the job so
    later reads — especially of large groups — need no SSM calls."""
    ids = {k: v for k, v in res["ids"].items() if k in ("automation_execution_id", "child_execution_id",
                                                           "child_account", "child_region", "command_id", "command_ids")}
    stored = _strip_meta(job.get("execution_tracking")) or {}
    tracking = dict(ids)
    tracking["targets"] = {}
    for inst, t in list(res["targets"].items())[:100]:
        if not inst:
            continue
        plugins = [p["name"] for p in t.get("plugins") or []]
        if not plugins:   # list views don't fetch plugins; keep what detail views stored
            plugins = ((stored.get("targets") or {}).get(inst) or {}).get("plugins") or []
        tracking["targets"][inst] = {"plugins": plugins}
    if ids and tracking != stored:
        tracking_to_store = dict(tracking, resolved_at=_now_iso())
        _update_job(job["job_id"], "SET execution_tracking = :t", {":t": tracking_to_store})
    finished = [t for t in res["targets"].values() if t["status"] in FINISHED and t["status_source"] == "ssm"]
    if (not job_is_active(job) and not job.get("exec_outcome") and finished
            and len(finished) == len(res["targets"]) and not res["errors"]):
        outcome = {"targets": {(t["instance_id"] or "-"): {"status": t["status"], "detail": str(t["status_detail"] or ""),
                                                             "started_at": t["started_at"] or "", "ended_at": t["ended_at"] or ""}
                               for t in list(res["targets"].values())[:100]},
                   "resolved_at": _now_iso()}
        _update_job(job["job_id"], "SET exec_outcome = :o", {":o": outcome},
                    condition="attribute_exists(job_id) AND attribute_not_exists(exec_outcome)")


def _strip_meta(t):
    if not isinstance(t, dict):
        return None
    return json.loads(json.dumps({k: v for k, v in t.items() if k != "resolved_at"}, default=decimal_default))


def targets_from_outcome(job):
    """Finished job with a stored outcome → targets without any SSM call."""
    oc = job.get("exec_outcome") or {}
    out = []
    for inst, o in (oc.get("targets") or {}).items():
        t = _base_target(job, None if inst == "-" else inst)
        t.update(status=o.get("status") or t["status"], status_detail=o.get("detail") or t["status_detail"],
                 status_source="ssm", started_at=o.get("started_at") or t["started_at"],
                 ended_at=o.get("ended_at") or t["ended_at"], output_mode="live")
        out.append(t)
    return out


# ── Groups ──────────────────────────────────────────────────────────────────

_MEMBER_ATTRS = ["job_id", "status", "resource_id", "server_name", "account_id", "region", "created_at",
                 "updated_at", "automation_type", "exec_outcome", "initiated_by", "notification_id",
                 "execution_group_id", "app_id", "environment"]


def group_members(group_id):
    """All jobs in an execution group (explicit execution_group_id only)."""
    table = get_dynamodb_table()
    names = {f"#a{i}": a for i, a in enumerate(_MEMBER_ATTRS)}
    kw = {"IndexName": EXECUTION_GROUP_INDEX, "KeyConditionExpression": Key("execution_group_id").eq(group_id),
          "ProjectionExpression": ", ".join(names), "ExpressionAttributeNames": names}
    items, truncated = [], False
    while True:
        page = table.query(**kw)
        items.extend(page.get("Items", []))
        if not page.get("LastEvaluatedKey"):
            break
        if len(items) >= GROUP_MAX_MEMBERS:
            truncated = True
            break
        kw["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    items.sort(key=lambda j: (str(j.get("created_at", "")), str(j.get("job_id", ""))))
    return items, truncated


def _batch_get(job_ids):
    if not job_ids:
        return {}
    ddb = boto3.resource("dynamodb")
    name = get_dynamodb_table().name
    out = {}
    keys = [{"job_id": j} for j in job_ids]
    for i in range(0, len(keys), 100):
        req = {name: {"Keys": keys[i:i + 100]}}
        for _ in range(5):
            resp = ddb.batch_get_item(RequestItems=req)
            for it in resp.get("Responses", {}).get(name, []):
                out[it["job_id"]] = it
            req = resp.get("UnprocessedKeys") or {}
            if not req:
                break
            time.sleep(0.2)
    return out


def _encode_cursor(obj):
    return base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).decode().rstrip("=")


def _decode_cursor(s):
    if not s:
        return None
    try:
        pad = "=" * (-len(s) % 4)
        v = json.loads(base64.urlsafe_b64decode(s + pad).decode())
        return v if isinstance(v, dict) else None
    except Exception:
        return None


def _counts(targets):
    c = {k: 0 for k in ("pending", "running", "success", "failed", "cancelled", "timed_out")}
    for t in targets:
        c[t["status"]] = c.get(t["status"], 0) + 1
    c["total"] = len(targets)
    c["finished"] = sum(c[k] for k in FINISHED)
    c["unsuccessful"] = c["failed"] + c["cancelled"] + c["timed_out"]
    return c


def _overall(counts):
    if counts["total"] == 0:
        return "unknown", "No targets"
    if counts["running"] or counts["pending"]:
        if counts["running"] == 0 and counts["finished"] == 0:
            return "pending", "Pending"
        return "running", "Running"
    if counts["success"] == counts["total"]:
        return "success", "Succeeded"
    if counts["success"] == 0:
        if counts["timed_out"] == counts["total"]:
            return "timed_out", "Timed out"
        if counts["cancelled"] == counts["total"]:
            return "cancelled", "Cancelled"
        return "failed", "Failed"
    return "partial", "Finished with failures"


def _elapsed(t, now):
    a = _parse_ts(t.get("started_at"))
    if not a:
        return None
    b = _parse_ts(t.get("ended_at")) if t["status"] in FINISHED else None
    return max(0, round(((b or now) - a).total_seconds()))


# ── GET /jobs/{jobId}/execution ─────────────────────────────────────────────

def handle_execution_details(event, http_method, path, path_parameters, query_params):
    qp = query_params or {}
    job_id = path_parameters.get("jobId", "")
    if not _JOB_ID_RE.match(job_id):
        return _resp(400, {"error": "invalid job id"})
    try:
        limit = int(qp.get("limit", 50))
    except ValueError:
        return _resp(400, {"error": "limit must be an integer"})
    if not 1 <= limit <= TARGET_PAGE_MAX:
        return _resp(400, {"error": f"limit must be 1–{TARGET_PAGE_MAX}"})
    status_filter = (qp.get("status") or "").lower() or None
    if status_filter and status_filter not in ("pending", "running", "success", "failed", "cancelled", "timed_out", "active", "finished", "unsuccessful"):
        return _resp(400, {"error": "invalid status filter"})
    search = (qp.get("q") or "").strip().lower()[:100]
    cursor = _decode_cursor(qp.get("cursor"))
    offset = int((cursor or {}).get("o", 0)) if cursor else 0
    selected_key = qp.get("target") or None

    try:
        job = get_job_by_id(job_id)
    except Exception as e:
        return _resp(503, {"error": "status_unavailable", "message": "Could not read the jobs table", "retrieval_error": _err_info(e)})
    if not job or job.get("record_type"):
        return _forbidden(job_id)
    visible, vis_instances, why = authorize_job_view(event, job)
    if not visible:
        logger.info(f"execution view denied for job {job_id}: {why}")
        return _forbidden(job_id)

    now = datetime.now(timezone.utc)
    group_id = job.get("execution_group_id")
    scope = "group" if group_id and qp.get("scope") != "job" else "job"
    errors = []
    hidden = 0
    truncated = False

    # ── Build the (authorized) member list ──
    if scope == "group":
        try:
            members, truncated = _cached(("grp", group_id), 4, lambda: group_members(group_id))
        except ClientError as e:
            info = _err_info(e)
            if info["code"] in ("ValidationException", "ResourceNotFoundException"):
                # Index not deployed yet: fall back to the job on its own.
                members, scope = [job], "job"
                errors.append({"kind": "not_configured", "code": "ExecutionGroupIndexMissing",
                               "message": f"The {EXECUTION_GROUP_INDEX} index is not deployed; showing this job only."})
            else:
                return _resp(503, {"error": "status_unavailable", "retrieval_error": info})
    else:
        members = [job]

    member_access = {}
    allowed = []
    for m in members:
        if m["job_id"] == job_id:
            ok, inst, _ = visible, vis_instances, why
        else:
            ok, inst, _ = authorize_job_view(event, m)
        if ok:
            member_access[m["job_id"]] = inst
            allowed.append(m)
        else:
            hidden += 1

    # ── Targets for every allowed member (stored data first) ──
    all_targets = []
    for m in allowed:
        inst_filter = member_access[m["job_id"]]
        if m.get("exec_outcome"):
            ts = targets_from_outcome(m)
        else:
            full = m if "automation_data" in m else None
            insts = job_instances(full) if full else ([m.get("resource_id")] if _INSTANCE_RE.match(str(m.get("resource_id") or "")) else [])
            ts = [_base_target(m, i) for i in (insts or [None])]
        if inst_filter is not None:
            ts = [t for t in ts if t["instance_id"] in inst_filter]
        all_targets.extend(ts)

    def matches(t):
        if search and not any(search in str(t.get(f) or "").lower() for f in ("server_name", "instance_id", "account_id", "region", "job_id")):
            return False
        if status_filter == "active":
            return t["status"] in ACTIVE
        if status_filter == "finished":
            return t["status"] in FINISHED
        if status_filter == "unsuccessful":
            return t["status"] in ("failed", "cancelled", "timed_out")
        return not status_filter or t["status"] == status_filter

    # ── Live SSM status for active jobs on this page (+ the selected one) ──
    page_targets = [t for t in all_targets if matches(t)][offset:offset + limit]
    page_job_ids = {t["job_id"] for t in page_targets}
    sel_job_id, sel_inst = parse_target_key(selected_key) if selected_key else (None, None)
    if selected_key and not sel_job_id:
        return _resp(400, {"error": "invalid target key"})
    if sel_job_id and sel_job_id not in member_access:
        return _forbidden(job_id)
    # Live SSM reads per request are capped; finished jobs are resolved once
    # and then served from exec_outcome, so later polls get cheaper.
    ordered = [t["job_id"] for t in page_targets]
    stored_by_id = {m["job_id"]: m for m in allowed}
    active_first = sorted(dict.fromkeys(ordered), key=lambda j: (0 if job_is_active(stored_by_id.get(j, {})) else 1))
    need_live = [j for j in active_first if not stored_by_id.get(j, {}).get("exec_outcome")][:MAX_LIVE_PER_REQUEST]
    live_skipped = len([j for j in active_first if not stored_by_id.get(j, {}).get("exec_outcome")]) - len(need_live)
    if sel_job_id and sel_job_id not in need_live:
        need_live.append(sel_job_id)
    full_jobs = {job_id: job}
    try:
        full_jobs.update(_batch_get([j for j in need_live if j != job_id]))
    except Exception as e:
        errors.append(_err_info(e))
    live = {}

    def work(jid):
        j = full_jobs.get(jid)
        if not j:
            return jid, None
        want_detail = jid == sel_job_id
        if j.get("exec_outcome") and not want_detail:
            return jid, None
        res = resolve_job(j, detail=want_detail)
        try:
            _persist(j, res)
        except Exception as e:
            logger.warning(f"persist failed for {jid}: {e}")
        return jid, res

    with ThreadPoolExecutor(max_workers=SSM_WORKERS) as pool:
        for jid, res in pool.map(work, need_live):
            if res:
                live[jid] = res

    # Replace stored targets with live ones where resolved.
    for jid, res in live.items():
        inst_filter = member_access.get(jid)
        new_ts = [t for t in res["targets"].values() if inst_filter is None or t["instance_id"] in inst_filter]
        all_targets = [t for t in all_targets if t["job_id"] != jid] + new_ts
        for e in res["errors"]:
            errors.append(dict(e, job_id=jid))
    order = {m["job_id"]: i for i, m in enumerate(allowed)}
    all_targets.sort(key=lambda t: (order.get(t["job_id"], 0), t.get("instance_id") or ""))

    counts = _counts(all_targets)
    matching = [t for t in all_targets if matches(t)]
    page = matching[offset:offset + limit]
    for t in page:
        t["elapsed_seconds"] = _elapsed(t, now)
        t["status_label"] = STATUS_LABELS.get(t["status"], t["status"])
        t.pop("plugins", None)
        t.pop("cloudwatch", None)

    # Server names for multi-instance jobs, from the catalog (cached).
    for t in page:
        if not t.get("server_name") and t.get("instance_id"):
            cat = _cached(("cat", t["instance_id"]), 300, lambda i=t["instance_id"]: get_catalog_instance(i))
            if cat:
                t["server_name"] = cat.get("server_name") or cat.get("name")

    overall, overall_label = _overall(counts)
    first = allowed[0] if allowed else job
    started = min((str(m.get("created_at")) for m in allowed if m.get("created_at")), default=job.get("created_at"))
    ended = None
    if overall not in ("running", "pending"):
        ended = max((t.get("ended_at") or "" for t in all_targets), default="") or max(
            (str(m.get("updated_at") or "") for m in allowed), default=None)

    body = {
        "execution": {
            "scope": scope,
            "group_id": group_id if scope == "group" else None,
            "group_label": job.get("execution_group_label") if scope == "group" else None,
            "job_id": job_id,
            "automation_name": job_automation_name(job) or (job.get("execution_group_label") if scope == "group" else None) or automation_label(job),
            "automation_label": automation_label(job),
            "automation_type": job.get("automation_type"),
            "document_name": document_short_name(job),
            "environment": job.get("environment") or (first.get("environment") if first else None),
            "initiated_by": job.get("initiated_by") or None,
            "started_at": _ts(started),
            "ended_at": _ts(ended),
            "status": overall,
            "status_label": overall_label,
            "is_active": overall in ("running", "pending"),
            "jobs_in_scope": len(allowed),
        },
        "counts": counts,
        "targets": page,
        "total_matching": len(matching),
        "offset": offset,
        "limit": limit,
        "next_cursor": _encode_cursor({"o": offset + limit}) if offset + limit < len(matching) else None,
        "prev_cursor": _encode_cursor({"o": max(0, offset - limit)}) if offset > 0 else None,
        "hidden_jobs": hidden,
        "live_status_deferred": max(0, live_skipped),
        "members_truncated": truncated,
        "retrieval_errors": errors[:20],
        "poll": {"status_interval_ms": STATUS_POLL_MS, "log_interval_ms": LOG_POLL_MS},
        "generated_at": _now_iso(),
    }

    if sel_job_id:
        body["selected"] = _selected_detail(full_jobs.get(sel_job_id), live.get(sel_job_id), sel_inst,
                                            member_access.get(sel_job_id), now)
        if body["selected"] is None:
            return _forbidden(job_id)
    return _resp(200, body)


def _selected_detail(job, res, instance_id, inst_filter, now):
    if not job:
        return None
    if inst_filter is not None and instance_id not in inst_filter:
        return None
    if instance_id and instance_id not in job_instances(job) and not (res and instance_id in res["targets"]):
        return None
    if res is None:
        res = resolve_job(job, detail=True)
    t = res["targets"].get(instance_id) or next(iter(res["targets"].values()), None)
    if not t:
        return None
    t = dict(t)
    if t.get("output_mode") == "none" and _record_output(job, t.get("instance_id")):
        t["output_mode"] = "final_only"     # stored job output can still be shown
    t["elapsed_seconds"] = _elapsed(t, now)
    t["status_label"] = STATUS_LABELS.get(t["status"], t["status"])
    ids = res["ids"]
    steps = res["steps"]
    plugins = t.pop("plugins", None) or []
    cw = t.pop("cloudwatch", None)
    output_notes = []
    if job.get("automation_type") == "EC2-Action":
        output_notes.append("EC2 status checks call the EC2 API directly; there is no script output.")
    elif t["output_mode"] == "final_only":
        output_notes.append("CloudWatch output was not enabled for this command, so there is no running output. "
                            "Systems Manager's final output preview (first 2,500 characters per step) is shown once it finishes.")
    elif steps and not any(s["has_running_output"] for s in steps):
        output_notes.append("This Automation's steps do not run commands on the server, so there is no console output. "
                            "Step status and outputs are on the Steps tab.")
    return {
        "target": t,
        "steps": steps,
        "plugins": plugins,
        "details": {
            "job_id": job["job_id"],
            "notification_id": job.get("notification_id"),
            "step_functions_execution": job.get("execution_id") or None,
            "automation_type": job.get("automation_type"),
            "document_name": document_short_name(job),
            "dispatch": ids.get("dispatch"),
            "automation_execution_id": ids.get("automation_execution_id"),
            "child_execution_id": ids.get("child_execution_id"),
            "child_location": {"account_id": ids.get("child_account"), "region": ids.get("child_region")} if ids.get("child_execution_id") else None,
            "command_id": ids.get("command_id"),
            "command_ids": ids.get("command_ids"),
            "cloudwatch": cw,
            "workflow_error": res.get("workflow_error"),
            "exit_code": job.get("exit_code"),
            "execution_group_id": job.get("execution_group_id"),
            "initiated_by": job.get("initiated_by"),
            "created_at": _ts(job.get("created_at")),
            "updated_at": _ts(job.get("updated_at")),
        },
        "output_notes": output_notes,
        "retrieval_errors": res["errors"],
    }


# ── GET /jobs/{jobId}/logs ──────────────────────────────────────────────────

def _log_streams(logs, group, prefix):
    streams, kw = [], {"logGroupName": group, "logStreamNamePrefix": prefix}
    while True:
        page = logs.describe_log_streams(**kw)
        streams.extend(s["logStreamName"] for s in page.get("logStreams", []))
        if not page.get("nextToken") or len(streams) >= 50:
            return streams
        kw["nextToken"] = page["nextToken"]


def _stream_meta(name, prefix):
    # <CommandId>/<InstanceId>/<PluginName>/stdout|stderr
    rest = name[len(prefix):]
    parts = rest.rsplit("/", 1)
    if len(parts) != 2 or parts[1] not in ("stdout", "stderr"):
        return None
    return {"plugin": parts[0], "kind": parts[1]}


def _final_output(refs, instance_id):
    """Complete-output fallback when running output can't be read from
    CloudWatch (not enabled, nothing uploaded, or no permission to read it):
    GetCommandInvocation per step, up to 24,000 characters each from
    Systems Manager. Only used once the command has finished."""
    events = []
    for command_id, account, region, step_name in refs:
        invs = list_invocations(account, region, command_id, instance_id, False)
        if not invs:
            continue
        ssm = _ssm(account, region)
        for p in invs[0].get("CommandPlugins") or []:
            name = p.get("Name")

            def load(name=name):
                return ssm.get_command_invocation(CommandId=command_id, InstanceId=instance_id, PluginName=name)
            try:
                gi = _cached(("gci", account, region, command_id, instance_id, name), 600, load)
            except ClientError as e:
                logger.warning(f"GetCommandInvocation failed for {command_id}/{instance_id}/{name}: {_err_info(e)}")
                continue
            ts = _parse_ts(p.get("ResponseFinishDateTime"))
            ms = int(ts.timestamp() * 1000) if ts else None
            for kind, key in (("stdout", "StandardOutputContent"), ("stderr", "StandardErrorContent")):
                text = gi.get(key) or ""
                if text:
                    events.append({"ts": ms, "ingested": ms, "stream": kind, "plugin": name, "step": step_name,
                                   "message": text, "truncated": len(text) >= 24000})
    return events


def _record_output(job, instance_id):
    """The output RunStack already stores on the job when it finishes
    (qualys_output / stderr_output, written by the workflow — the same
    output GET /jobs/{jobId} and the AQS agents return). Needs no AWS call.
    It belongs to the job's resource_id, so it's only used for that server."""
    if job_is_active(job) or instance_id != job.get("resource_id"):
        return None
    ms = None
    d = _parse_ts(job.get("updated_at"))
    if d:
        ms = int(d.timestamp() * 1000)
    events = []
    for kind, key in (("stdout", "qualys_output"), ("stderr", "stderr_output")):
        text = job.get(key) or ""
        if isinstance(text, str) and text.strip():
            events.append({"ts": ms, "ingested": ms, "stream": kind, "plugin": "", "step": None,
                           "message": text, "truncated": False})
    return events or None


def _record_resp(base, events, note):
    return _resp(200, dict(base, status="final_only", replace=True, events=events, more=False, source="runstack_record",
                           message=(note + " " if note else "") + "Showing the final output RunStack saved for this job "
                                                                   "(the same output the RunStack agents return)."))


def _final_or(base, refs, instance_id, target_status, note, fallback, record=None):
    """Finished command → full final output from Systems Manager (with a note
    on why running output wasn't available); still running → `fallback`."""
    if target_status in ACTIVE:
        return fallback
    try:
        events = _final_output(refs, instance_id)
    except Exception as e:
        logger.warning(f"final output fallback failed: {_err_info(e)}")
        events = None
    if not events:
        return _record_resp(base, record, note) if record else fallback
    return _resp(200, dict(base, status="final_only", replace=True, events=events, more=False,
                           message=note + " Showing the final output from Systems Manager "
                                          "(up to 24,000 characters per step)."))


def handle_execution_logs(event, http_method, path, path_parameters, query_params):
    qp = query_params or {}
    job_id = path_parameters.get("jobId", "")
    if not _JOB_ID_RE.match(job_id):
        return _resp(400, {"error": "invalid job id"})
    t_job_id, instance_id = parse_target_key(qp.get("target") or "")
    if not t_job_id or not instance_id:
        return _resp(400, {"error": "target must be a target key from /execution"})
    direction = qp.get("direction") or "forward"
    if direction not in ("forward", "backward"):
        return _resp(400, {"error": "direction must be forward or backward"})
    cursor = _decode_cursor(qp.get("cursor")) if qp.get("cursor") else None
    if qp.get("cursor") and cursor is None:
        return _resp(400, {"error": "invalid cursor"})
    if direction == "backward" and not cursor:
        return _resp(400, {"error": "backward reads need an older_cursor"})

    try:
        job = get_job_by_id(job_id)
        target_job = job if t_job_id == job_id else (get_job_by_id(t_job_id) if job else None)
    except Exception as e:
        return _resp(503, {"status": "unavailable", "retrieval_error": _err_info(e)})
    if not job or not target_job or target_job.get("record_type"):
        return _forbidden(job_id)
    # The target job must be this job or a member of the same explicit group.
    if t_job_id != job_id and (not job.get("execution_group_id")
                               or target_job.get("execution_group_id") != job.get("execution_group_id")):
        return _forbidden(job_id)
    visible, vis_instances, _ = authorize_job_view(event, target_job)
    if not visible or (vis_instances is not None and instance_id not in vis_instances):
        return _forbidden(job_id)
    if instance_id not in job_instances(target_job):
        # Only instances in the job record, or ones SSM itself reports for
        # this job's own command, are readable.
        res_check = resolve_job(target_job)
        t_check = res_check["targets"].get(instance_id)
        if not t_check or t_check["status_source"] != "ssm":
            return _forbidden(job_id)

    res = resolve_job(target_job, detail=True, only_instance=instance_id)
    t = res["targets"].get(instance_id) or {}
    target_status = t.get("status")
    base = {"target_status": target_status, "target_status_detail": t.get("status_detail"),
            "is_active": target_status in ACTIVE, "poll_interval_ms": LOG_POLL_MS,
            "batching_note": "Systems Manager uploads output to CloudWatch in batches, usually about every 30 seconds; "
                             "scripts that buffer their output can add more delay.",
            "events": [], "streams": []}

    record = _record_output(target_job, instance_id)

    if res["errors"] and not res["command_refs"].get(instance_id):
        info = res["errors"][0]
        if record and info["kind"] != "throttled":
            return _record_resp(dict(base, retrieval_error=info), record, "")
        if info["kind"] == "not_configured":
            return _resp(200, dict(base, status="not_configured", retrieval_error=info,
                                   message="Output can't be looked up for this job: " + info["message"]))
        code = 429 if info["kind"] == "throttled" else 200
        hdr = {"Retry-After": "15"} if code == 429 else None
        return _resp(code, dict(base, status="unavailable", retrieval_error=info,
                                message="Couldn't read this server's output right now. This is not an execution failure."), hdr)

    if target_job.get("automation_type") == "EC2-Action":
        return _resp(200, dict(base, status="no_output", message="EC2 status checks have no script output."))

    refs = res["command_refs"].get(instance_id) or []
    if not refs and record:
        return _record_resp(base, record, "")
    if not refs:
        wf = res.get("workflow_error")
        if wf and not res["ids"].get("dispatch"):
            return _resp(200, dict(base, status="no_output", workflow_error=wf,
                                   message=f"This job failed before Systems Manager started anything, so there is no output. "
                                           f"{wf['error']}: {wf['cause']}"))
        if not res["ids"].get("dispatch") and target_status not in ACTIVE:
            return _resp(200, dict(base, status="no_output",
                                   message="RunStack couldn't find the Systems Manager command for this job, so its output "
                                           "can't be shown here. This happens for jobs that ran before Execution Details was "
                                           "deployed once their Step Functions history is gone, or if the job failed before "
                                           "anything was sent to Systems Manager."))
        if target_status in ACTIVE:
            return _resp(200, dict(base, status="waiting", message="Waiting for script output"))
        return _resp(200, dict(base, status="no_output",
                               message="This execution did not run a command on the server, so there is no console output."))

    # Log group per command, from SSM's own invocation record.
    plugins_by_cmd = {}
    groups = {}
    final_preview = []
    for command_id, account, region, step_name in refs:
        try:
            invs = list_invocations(account, region, command_id, instance_id, target_status in ACTIVE)
        except Exception as e:
            info = _err_info(e)
            if record and info["kind"] != "throttled":
                return _record_resp(dict(base, retrieval_error=info), record, "")
            code = 429 if info["kind"] == "throttled" else 200
            return _resp(code, dict(base, status="unavailable", retrieval_error=info,
                                    message="Couldn't read this server's output right now. This is not an execution failure."),
                         {"Retry-After": "15"} if code == 429 else None)
        inv = invs[0] if invs else None
        if not inv:
            continue
        cw = inv.get("CloudWatchOutputConfig") or {}
        plugins_by_cmd[command_id] = [p["name"] for p in _plugins(inv)]
        if cw.get("CloudWatchOutputEnabled"):
            group = cw.get("CloudWatchLogGroupName") or f"/aws/ssm/{inv.get('DocumentName', '').split('/')[-1]}"
            groups[command_id] = (group, account, region, step_name)
        else:
            for p in _plugins(inv):
                if p["final_output_preview"] and p["status"] in FINISHED:
                    final_preview.append({"step": step_name, "plugin": p["name"], "text": p["final_output_preview"]})

    if not groups:
        if not plugins_by_cmd and target_status in ACTIVE:
            return _resp(200, dict(base, status="waiting", message="Waiting for script output"))
        return _final_or(base, refs, instance_id, target_status,
                         "CloudWatch output was not enabled for this command, so running output isn't available.",
                         _resp(200, dict(base, status="not_configured", final_output=final_preview,
                                         message="CloudWatch output is not enabled for this command, so running output isn't available. "
                                                 "The final output from Systems Manager is shown when it finishes.")),
                         record)

    # Server-derived stream list; cursor tokens for any other stream are ignored.
    streams = []
    try:
        for command_id, (group, account, region, step_name) in groups.items():
            prefix = f"{command_id}/{instance_id}/"
            logs = aws_client("logs", account, region)

            def load(logs=logs, group=group, prefix=prefix):
                try:
                    return _log_streams(logs, group, prefix)
                except ClientError as e:
                    if _err_info(e)["kind"] == "not_found":
                        return []
                    raise
            names = _cached(("streams", account, region, group, prefix), 15 if target_status not in ACTIVE else 5, load)
            order = {p: i for i, p in enumerate(plugins_by_cmd.get(command_id) or [])}
            metas = []
            for n in names:
                m = _stream_meta(n, prefix)
                if m:
                    metas.append(dict(m, name=n, group=group, account=account, region=region, step=step_name, command_id=command_id))
            metas.sort(key=lambda m: (order.get(m["plugin"], order.get(m["plugin"].replace("-", ":"), 99)), m["kind"]))
            streams.extend(metas)
    except Exception as e:
        info = _err_info(e)
        code = 429 if info["kind"] == "throttled" else 200
        unavailable = _resp(code, dict(base, status="unavailable", retrieval_error=info,
                                       message="Couldn't read this server's running output from CloudWatch Logs. "
                                               "This is not an execution failure."),
                            {"Retry-After": "15"} if code == 429 else None)
        if info["kind"] == "throttled":
            return unavailable
        return _final_or(dict(base, retrieval_error=info), refs, instance_id, target_status,
                         "Running output couldn't be read from CloudWatch Logs.", unavailable, record)

    stream_list = [{"plugin": s["plugin"], "kind": s["kind"], "step": s["step"]} for s in streams]
    first_group = next(iter(groups.values()))
    base.update(streams=stream_list, log_group=first_group[0])
    if not streams:
        status = "waiting" if target_status in ACTIVE else "no_logs"
        msg = "Waiting for script output" if status == "waiting" else \
            "No output was written to CloudWatch for this server (the script printed nothing, or the server could not upload logs)."
        # Keep the client's cursor so nothing is re-read once streams appear.
        plain = _resp(200, dict(base, status=status, message=msg, next_cursor=qp.get("cursor") if direction == "forward" else None,
                                final_output=final_preview or None))
        return _final_or(base, refs, instance_id, target_status,
                         "No running output reached CloudWatch Logs for this server.", plain, record)

    known = {s["name"]: s for s in streams}
    fwd = (cursor or {}).get("f") or {}
    back = (cursor or {}).get("b") or {}
    events, new_f, new_b, more, used = [], dict(), dict(), False, 0
    per_stream = max(20, LOG_EVENTS_PER_STREAM // max(1, len(streams)) * 2)

    try:
        for name, s in known.items():
            logs = aws_client("logs", s["account"], s["region"])
            kw = {"logGroupName": s["group"], "logStreamName": name, "limit": per_stream}
            if direction == "forward":
                tok = fwd.get(name) if isinstance(fwd, dict) else None
                if tok:
                    kw.update(nextToken=tok, startFromHead=True)
                elif cursor:
                    kw.update(startFromHead=True)       # stream appeared after the first read
                else:
                    kw.update(startFromHead=False)      # first read: latest events
            else:
                tok = back.get(name) if isinstance(back, dict) else None
                if not tok:
                    continue
                kw.update(nextToken=tok, startFromHead=False)
            page = logs.get_log_events(**kw)
            evs = page.get("events", [])
            for ev in evs:
                msg = ev.get("message", "")
                trunc = len(msg) > LOG_MESSAGE_MAX
                used += min(len(msg), LOG_MESSAGE_MAX)
                events.append({"ts": ev.get("timestamp"), "ingested": ev.get("ingestionTime"), "stream": s["kind"],
                               "plugin": s["plugin"], "step": s["step"], "message": msg[:LOG_MESSAGE_MAX], "truncated": trunc})
            if direction == "forward":
                new_f[name] = page.get("nextForwardToken") or tok
                if not cursor:
                    new_b[name] = page.get("nextBackwardToken")
                if len(evs) >= per_stream:
                    more = True
            else:
                if evs:
                    new_b[name] = page.get("nextBackwardToken")
            if used > LOG_RESPONSE_BYTES:
                more = True
                break
    except Exception as e:
        info = _err_info(e)
        code = 429 if info["kind"] == "throttled" else 200
        return _resp(code, dict(base, status="unavailable", retrieval_error=info,
                                message="Couldn't read this server's output right now. This is not an execution failure."),
                     {"Retry-After": "15"} if code == 429 else None)

    # CloudWatch timestamps are per upload batch, so stdout/stderr lines in the
    # same batch share one; keep a stable order (stdout first) for ties.
    events.sort(key=lambda e: (e["ts"] or 0, e["ingested"] or 0, e["stream"] != "stdout"))
    body = dict(base, status="ok", events=events, more=more)
    if direction == "forward":
        f_all = dict(fwd) if isinstance(fwd, dict) else {}
        f_all = {k: v for k, v in f_all.items() if k in known}
        f_all.update({k: v for k, v in new_f.items() if v})
        body["next_cursor"] = _encode_cursor({"f": f_all})
        if not cursor:
            b = {k: v for k, v in new_b.items() if v}
            body["older_cursor"] = _encode_cursor({"b": b}) if b and events else None
    else:
        b = {k: v for k, v in new_b.items() if v}
        body["older_cursor"] = _encode_cursor({"b": b}) if b else None
    return _resp(200, body)
