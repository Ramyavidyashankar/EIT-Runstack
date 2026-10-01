"""
SQL Health Check for the RunStack UI (Database Operations → SQL Health Check).

Two entry points, both behind authorize_action("sql_healthcheck"):

  GET  /batch-healthcheck/options
       What the page may offer this caller:
         • targets — the GDBA MSSQL SharePoint server list (the only SQL-
           specific inventory RunStack reads today), each name resolved to
           runstack-instance-catalog exactly as POST /batch-healthcheck
           already does, then narrowed to the caller's capability scope.
           runstack-app-access is NOT consulted: SQL access follows the
           GDBA group → runstack-team-capabilities path.
         • checks — one entry per configured check mode, built from the
           live SSM document definition (DescribeDocument + GetDocument),
           never from hardcoded parameter lists. A mode whose document is
           missing, is not a Command document, or needs a parameter this
           page can't safely collect is returned with available=false and
           a reason, so the UI can say why instead of hiding it.

  POST /batch-healthcheck   with "check_type" in the body  (typed path)
       One target (instance_id/server_name), or several (instance_ids) as one
       run sharing a server-created execution_group_id. For EVERY target the
       following is enforced, in this order, regardless of what the UI showed:
         1. Azure AD group / team / capability      (authorize_action)
         2. target exists in runstack-instance-catalog
         3. target scope                            (authorize_action with resource_id)
         4. environment rule                        (SQL_HEALTHCHECK_ALLOWED_ENVIRONMENTS)
         5. region supported + document present in the target's region
         6. parameters validated against the document definition
         7. one active check per target + check type (runstack-action-locks)
       Then the job goes through the normal pipeline: jobs table → stream →
       Step Functions → SSM RunCommand (cross-account; us-west-2 via the
       TargetLocations wrapper). The browser never talks to SQL Server.

  POST /batch-healthcheck WITHOUT "check_type" is unchanged — handled by
  healthcheck.handle_batch_healthcheck exactly as before (AQS SQL agent).

No new DynamoDB tables, IAM actions or SSM documents: this reads
runstack-team-capabilities, runstack-instance-catalog and SSM document
metadata (ssm:DescribeDocument / ssm:GetDocument are already granted for
the SSM Documents page), and writes runstack-jobs-table and
runstack-action-locks, which process_messages already writes.
"""

import re
import time as _time

from boto3.dynamodb.conditions import Key

from shared import *
from shared import _fetch_sharepoint_server_list


# ── Configuration ───────────────────────────────────────────────────────────

# Optional second check. Off by default: SQL-HealthCheck-Bulk (the only
# candidate today) is an Automation wrapper around the same PowerShell for a
# list of instances, which this single-target RunCommand path cannot run
# cross-account. Set only to a Command document that checks one server.
HEALTHCHECK_BULK_DOCUMENT_NAME = os.getenv("HEALTHCHECK_BULK_DOCUMENT_NAME", "")
PRIMARY_REGION = os.getenv("RUNSTACK_PRIMARY_REGION", "us-east-1")
SUPPORTED_REGIONS = [r.strip() for r in os.getenv("SSM_DOC_REGIONS", "us-east-1,us-west-2").split(",") if r.strip()]

# Empty (the default) = no environment restriction, which is today's
# behaviour for SQL health checks. When set (comma-separated, matched
# case-insensitively against the catalog's "environment"), targets in other
# environments are shown as unavailable and refused by the run endpoint.
SQL_HEALTHCHECK_ALLOWED_ENVIRONMENTS = {
    e.strip().upper() for e in os.getenv("SQL_HEALTHCHECK_ALLOWED_ENVIRONMENTS", "").split(",") if e.strip()
}

# How long a started check blocks a second identical check on the same
# target (released early once the job is finished).
SQL_HEALTHCHECK_LOCK_SECONDS = int(os.getenv("SQL_HEALTHCHECK_LOCK_SECONDS", "900"))

# ids are stored on job records (check_type) — keep them stable; labels are
# what the page shows. SQL-Database-Healthcheck checks the SQL services, every
# user database, connectivity, and patch/BigFix status on one server.
CHECK_MODES = [{"id": "single_database", "label": "SQL Server health check", "document": HEALTHCHECK_DOCUMENT_NAME}]
if HEALTHCHECK_BULK_DOCUMENT_NAME:
    CHECK_MODES.append({"id": "all_databases", "label": "All databases", "document": HEALTHCHECK_BULK_DOCUMENT_NAME})
CHECK_MODES_BY_ID = {m["id"]: m for m in CHECK_MODES}

SUPPORTED_PARAM_TYPES = {"String", "StringList", "Integer", "Boolean"}
_SECRET_NAME = re.compile(r"pass(word|wd)?|secret|token|credential|api[_-]?key|private[_-]?key|access[_-]?key", re.I)
MAX_PARAM_CHARS = 1024
_TERMINAL_JOB_STATUSES = {"COMPLETED", "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED"}

_DOC_CACHE = {}          # (name, region) -> (fetched_at, definition)
_DOC_CACHE_SECONDS = 60


def _resp(code, body):
    return {"statusCode": code, "headers": CORS_HEADERS, "body": json.dumps(body, default=decimal_default)}


def _caller_email(event):
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
    username = claims.get("username", "")
    return (username.replace("AzureAD_", "") if username.startswith("AzureAD_") else claims.get("email", username)) or "unknown"


# ── Authorization helpers (all decisions delegated to authorize_action) ───

def _authorize_and_scope(event):
    """
    Returns (denied_response, scope). scope is "ALL" or a set of lower-cased
    identifiers from the capability's scope list.

    authorize_action without a resource_id succeeds only for callers whose
    capability scope is "ALL" (or who hold admin/operator). A scoped GDBA
    member gets reason=scope_excluded there — that is not a denial of the
    feature, it means "narrow the target list to your scope", so we read
    the same capability row authorize_action just checked.
    """
    denied = authorize_action(event, "sql_healthcheck")
    if not denied:
        return None, "ALL"
    try:
        reason = json.loads(denied.get("body") or "{}").get("reason")
    except ValueError:
        reason = None
    if reason != "scope_excluded":
        return denied, None
    team, capability = ACTION_AUTH_CONFIG["sql_healthcheck"]["team_capability"]
    item = get_team_capability(team, capability) or {}
    scope = item.get("scope")
    return None, {str(s).strip().lower() for s in scope} if isinstance(scope, list) else set()


def _target_identifiers(inst):
    ids = []
    for key in ("instance_id", "server_name", "name"):
        v = str(inst.get(key) or "").strip()
        if v and v not in ids:
            ids.append(v)
    return ids


def _in_scope(inst, scope):
    if scope == "ALL":
        return True
    return any(i.lower() in scope for i in _target_identifiers(inst))


def _authorize_target(event, inst):
    """
    Authoritative per-target check. require_team_capability compares
    resource_id with the scope list verbatim, and scope rows may name the
    instance by ID or by server name, so each identifier is tried; the
    first allow wins, otherwise the last denial is returned unchanged.
    """
    denied = None
    for ident in _target_identifiers(inst):
        denied = authorize_action(event, "sql_healthcheck", resource_id=ident)
        if not denied:
            return None
    return denied or authorize_action(event, "sql_healthcheck", resource_id=inst.get("instance_id"))


def _environment_block(inst):
    if not SQL_HEALTHCHECK_ALLOWED_ENVIRONMENTS:
        return None
    env_raw = str(inst.get("environment") or "").strip()
    if env_raw.upper() in SQL_HEALTHCHECK_ALLOWED_ENVIRONMENTS:
        return None
    return (f"SQL health checks are enabled for {', '.join(sorted(SQL_HEALTHCHECK_ALLOWED_ENVIRONMENTS))} "
            f"environments only. This server is in '{env_raw or 'an unrecognized environment'}'.")


# ── SSM document definitions ─────────────────────────────────────────────────

def _ssm_client(region):
    return boto3.client("ssm", region_name=region)


def _lookup_name(name, region):
    """HEALTHCHECK_DOCUMENT_NAME may be a bare name or a full document ARN
    (arn:aws:ssm:us-east-1:246314649749:document/SQL-Database-Healthcheck).
    RunStack's documents are owned by the account this Lambda runs in, so
    metadata is always read by the bare name — an ARN would only resolve in
    the region it names, hiding the us-west-2 copy. The job itself still
    sends DocumentName exactly as configured (normalize_runcommand_data
    handles cross-account/cross-region qualification)."""
    return name.split(":document/", 1)[1] if ":document/" in name else name


def _read_document(name, region):
    """Live definition of one document in one region, cached briefly.
    Returns {"found": False, "error": ...} when it can't be read."""
    name = _lookup_name(name, region)
    key = (name, region)
    hit = _DOC_CACHE.get(key)
    if hit and _time.time() - hit[0] < _DOC_CACHE_SECONDS:
        return hit[1]
    try:
        ssm = _ssm_client(region)
        described = ssm.describe_document(Name=name)["Document"]
        content = json.loads(ssm.get_document(Name=name, DocumentFormat="JSON").get("Content") or "{}")
        definition = {
            "found": True,
            "document_type": described.get("DocumentType"),
            "status": described.get("Status"),
            "default_version": described.get("DefaultVersion"),
            "description": described.get("Description") or (content.get("description") if isinstance(content, dict) else None),
            "platform_types": described.get("PlatformTypes") or [],
            "parameters": (content.get("parameters") or {}) if isinstance(content, dict) else {},
        }
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        definition = {"found": False, "error": "not_found" if code in ("InvalidDocument", "InvalidDocumentVersion") else code or "error"}
    except (ValueError, Exception) as e:  # unreadable content, network
        logger.warning(f"sql_healthcheck: could not read {name} in {region}: {e}")
        definition = {"found": False, "error": "unreadable"}
    _DOC_CACHE[key] = (_time.time(), definition)
    return definition


def _param_spec(name, spec):
    spec = spec if isinstance(spec, dict) else {}
    return {
        "name": name,
        "type": spec.get("type") or "String",
        "description": spec.get("description") or None,
        "default": spec.get("default"),
        "required": "default" not in spec,
        "allowed_values": spec.get("allowedValues") or None,
        "allowed_pattern": spec.get("allowedPattern") or None,
        "min_chars": spec.get("minChars"),
        "max_chars": spec.get("maxChars"),
        "min_items": spec.get("minItems"),
        "max_items": spec.get("maxItems"),
        "display_type": spec.get("displayType") or None,
    }


def describe_check(mode_id):
    """Check mode as offered to the UI, from the primary-region document."""
    mode = CHECK_MODES_BY_ID[mode_id]
    out = {"id": mode["id"], "label": mode["label"], "document": mode["document"],
           "available": False, "reason": None, "description": None, "document_version": None,
           "parameters": [], "optional_parameter_count": 0, "regions_available": []}
    if not mode["document"]:
        out["reason"] = "No SSM document is configured for this check."
        return out
    d = _read_document(mode["document"], PRIMARY_REGION)
    if not d.get("found"):
        out["reason"] = (f"SSM document {mode['document']} was not found in {PRIMARY_REGION}."
                         if d.get("error") == "not_found" else
                         f"RunStack could not read SSM document {mode['document']} ({d.get('error')}).")
        return out
    out.update(description=d.get("description"), document_version=d.get("default_version"))
    out["regions_available"] = [PRIMARY_REGION] + [
        r for r in SUPPORTED_REGIONS if r != PRIMARY_REGION and _read_document(mode["document"], r).get("found")
    ]
    if d.get("document_type") != "Command":
        out["reason"] = f"{mode['document']} is a {d.get('document_type')} document; health checks run as SSM RunCommand."
        return out
    if d.get("status") not in (None, "Active"):
        out["reason"] = f"{mode['document']} is {d.get('status')} in SSM."
        return out

    specs = [_param_spec(n, s) for n, s in d.get("parameters", {}).items()]
    for p in specs:
        if p["required"] and p["type"] not in SUPPORTED_PARAM_TYPES:
            out["reason"] = f"{mode['document']} requires parameter {p['name']} of type {p['type']}, which this page cannot collect."
            return out
        if p["required"] and _SECRET_NAME.search(p["name"]):
            out["reason"] = (f"{mode['document']} requires {p['name']}, which looks like a secret. "
                             "RunStack does not collect secrets from the browser.")
            return out
    out["parameters"] = [p for p in specs if p["required"]]
    out["optional_parameter_count"] = sum(1 for p in specs if not p["required"])
    out["available"] = True
    return out


def validate_parameters(document_parameters, supplied):
    """
    Validate caller-supplied values against the document's own parameter
    definitions. Returns (ssm_parameters, errors). ssm_parameters is in the
    SSM/validate_message_payload shape {name: [str, ...]}; parameters the
    caller did not send are omitted so SSM applies the document default.
    """
    supplied = supplied if isinstance(supplied, dict) else None
    if supplied is None:
        return {}, {"_": "parameters must be an object"}
    specs = {n: _param_spec(n, s) for n, s in (document_parameters or {}).items()}
    errors, out = {}, {}

    for name in supplied:
        if name not in specs:
            errors[name] = "This parameter is not defined by the document."

    for name, p in specs.items():
        raw = supplied.get(name)
        empty = raw is None or (isinstance(raw, str) and raw.strip() == "") or (isinstance(raw, list) and not raw)
        if empty:
            if p["required"]:
                errors[name] = "Required."
            continue
        if p["type"] not in SUPPORTED_PARAM_TYPES:
            errors[name] = f"Parameters of type {p['type']} can't be set from this page."
            continue
        if _SECRET_NAME.search(name):
            errors[name] = "Secret values can't be submitted from this page."
            continue

        values = raw if p["type"] == "StringList" else [raw]
        if p["type"] == "StringList":
            if not isinstance(raw, list):
                errors[name] = "Must be a list of values."
                continue
            if p["min_items"] is not None and len(values) < int(p["min_items"]):
                errors[name] = f"At least {p['min_items']} value(s) required."
                continue
            if p["max_items"] is not None and len(values) > int(p["max_items"]):
                errors[name] = f"At most {p['max_items']} value(s) allowed."
                continue

        cleaned, err = [], None
        for v in values:
            if isinstance(v, bool):
                v = "true" if v else "false"
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                v = str(v)
            if not isinstance(v, str):
                err = "Must be text."
                break
            if "\x00" in v or len(v) > MAX_PARAM_CHARS:
                err = f"Must be at most {MAX_PARAM_CHARS} characters."
                break
            if ("\n" in v or "\r" in v) and p["display_type"] != "textarea":
                err = "Must be a single line."
                break
            if p["type"] == "Integer":
                if not re.fullmatch(r"-?\d+", v.strip()):
                    err = "Must be a whole number."
                    break
                v = str(int(v.strip()))
            elif p["type"] == "Boolean":
                if v.strip().lower() not in ("true", "false"):
                    err = "Must be true or false."
                    break
                v = v.strip().lower()
            if p["min_chars"] is not None and len(v) < int(p["min_chars"]):
                err = f"Must be at least {p['min_chars']} characters."
                break
            if p["max_chars"] is not None and len(v) > int(p["max_chars"]):
                err = f"Must be at most {p['max_chars']} characters."
                break
            if p["allowed_values"] and v not in [str(a) for a in p["allowed_values"]]:
                err = f"Must be one of: {', '.join(str(a) for a in p['allowed_values'])}."
                break
            if p["allowed_pattern"]:
                try:
                    if not re.fullmatch(p["allowed_pattern"], v):
                        err = "Does not match the format the document requires."
                        break
                except re.error:
                    err = "The document's validation pattern could not be applied; contact a RunStack administrator."
                    break
            cleaned.append(v)
        if err:
            errors[name] = err
            continue
        out[name] = cleaned
    return out, errors


# ── Targets ─────────────────────────────────────────────────────────────────

def _catalog_by_name():
    by_name = {}
    for inst in get_instances_for_apps(["ALL"]):
        for key in ("server_name", "name"):
            k = str(inst.get(key) or "").strip().lower()
            if k:
                by_name[k] = inst
    return by_name


def _target_row(listed_name, inst):
    region = inst.get("region") or ""
    env_block = _environment_block(inst)
    region_block = None if region in SUPPORTED_REGIONS else f"Region '{region or 'unknown'}' is not supported by RunStack SSM execution."
    return {
        "server_name": listed_name,
        "instance_id": inst.get("instance_id"),
        "catalog_name": inst.get("name") or None,
        "app_id": inst.get("app_id") or None,
        "app_name": inst.get("app_name") or None,
        "environment": inst.get("environment") or None,
        "account_id": inst.get("account_id") or None,
        "region": region or None,
        "selectable": not (env_block or region_block),
        "unavailable_reason": env_block or region_block,
    }


def handle_healthcheck_options(event, http_method, path, path_parameters, query_params):
    denied, scope = _authorize_and_scope(event)
    if denied:
        return denied
    try:
        checks = [describe_check(m["id"]) for m in CHECK_MODES]

        targets, unresolved, source_error = [], [], None
        try:
            listed = _fetch_sharepoint_server_list()
        except Exception as e:
            logger.error(f"sql_healthcheck options: SharePoint server list unavailable: {e}")
            listed, source_error = [], "The GDBA SQL server list could not be read from SharePoint."

        if listed:
            by_name = _catalog_by_name()
            seen = set()
            for name in listed:
                inst = by_name.get(name.strip().lower())
                if not inst:
                    unresolved.append(name)
                    continue
                if inst.get("instance_id") in seen or not _in_scope(inst, scope):
                    continue
                seen.add(inst.get("instance_id"))
                targets.append(_target_row(name, inst))
        targets.sort(key=lambda t: ((t["app_name"] or t["app_id"] or "").lower(), (t["environment"] or "").lower(), t["server_name"].lower()))

        return _resp(200, {
            "targets": targets,
            # Names on the SQL list with no instance-catalog row. Only
            # returned to full-scope callers — a scoped caller gets no
            # information about servers outside their scope.
            "unresolved": unresolved if scope == "ALL" else [],
            "unresolved_count": len(unresolved) if scope == "ALL" else None,
            "scope": "ALL" if scope == "ALL" else "SCOPED",
            "source": {"type": "sharepoint", "file": SHAREPOINT_TARGET_FILE_NAME, "folder": SHAREPOINT_FOLDER_PATH},
            "source_error": source_error,
            "environment_rule": sorted(SQL_HEALTHCHECK_ALLOWED_ENVIRONMENTS) or None,
            "checks": checks,
        })
    except Exception as e:
        logger.error(f"sql_healthcheck options failed: {e}")
        return _resp(500, {"error": "Could not load SQL health check options", "detail": str(e)})


# ── One active check per target + check type ─────────────────────────────

def _acquire_check_lock(lock_key, job_id, user_email):
    """
    Returns None when the lock was taken for job_id, else the existing lock
    item (with its job_id). A lock whose job has already finished is taken
    over, so a finished check never blocks the next one.
    """
    table = boto3.resource("dynamodb").Table(ACTION_LOCKS_TABLE)
    now = int(_time.time())
    item = {"resource_id": lock_key, "locked_by": user_email, "job_id": job_id,
            "locked_at": datetime.utcnow().isoformat(), "expires_at": now + SQL_HEALTHCHECK_LOCK_SECONDS}
    try:
        table.put_item(Item=item, ConditionExpression="attribute_not_exists(resource_id) OR expires_at < :now",
                       ExpressionAttributeValues={":now": now})
        return None
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
    existing = table.get_item(Key={"resource_id": lock_key}).get("Item") or {}
    existing_job = get_job_by_id(existing["job_id"]) if existing.get("job_id") else None
    if existing_job is None or str(existing_job.get("status", "")).upper() in _TERMINAL_JOB_STATUSES:
        try:
            table.put_item(Item=item, ConditionExpression="job_id = :old",
                           ExpressionAttributeValues={":old": existing.get("job_id")})
            return None
        except ClientError as e:
            if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise
            existing = table.get_item(Key={"resource_id": lock_key}).get("Item") or {}
    return existing


def _release_check_lock(lock_key, job_id):
    try:
        boto3.resource("dynamodb").Table(ACTION_LOCKS_TABLE).delete_item(
            Key={"resource_id": lock_key}, ConditionExpression="job_id = :j",
            ExpressionAttributeValues={":j": job_id})
    except ClientError:
        pass


# ── POST /batch-healthcheck (typed path) ──────────────────────────────────
#
# Single target  {check_type, parameters, instance_id | server_name}
#   One job, no execution group — unchanged response shape and status codes.
#
# Several targets {check_type, parameters, instance_ids: [...], execution_group_id?}
#   One run: every job gets the same execution_group_id, created HERE (never
#   taken from the browser on the first call), so Execution Details shows the
#   servers together. Each server goes through exactly the same checks as a
#   single target (catalog, team scope, environment, region/document, lock).
#   A server that fails a check is reported in its row; the others still
#   start. Larger selections are sent in chunks of MAX_TARGETS_PER_REQUEST:
#   later chunks pass back the execution_group_id from the first response,
#   which is accepted only for a recent health-check group whose jobs were
#   all started by this same caller.

MAX_TARGETS_PER_REQUEST = int(os.getenv("SQL_HEALTHCHECK_MAX_TARGETS_PER_REQUEST", "100"))
GROUP_CONTINUE_SECONDS = int(os.getenv("SQL_HEALTHCHECK_GROUP_CONTINUE_SECONDS", "900"))
EXECUTION_GROUP_INDEX = os.getenv("EXECUTION_GROUP_INDEX", "execution-group-index")
UI_GROUP_PREFIX = "grp-hcui-"
_UI_GROUP_RE = re.compile(r"^grp-hcui-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_INSTANCE_ID_RE = re.compile(r"^(i|mi)-[0-9a-f]{8,17}$")


def _body_of(resp):
    try:
        return json.loads(resp.get("body") or "{}")
    except (TypeError, ValueError):
        return {}


def _resolve_and_vet(event, instance_id, server_name):
    """
    Per-target checks shared by the single and multi-target paths, in the
    original order: catalog → team scope → environment → supported region.
    Returns (inst, None) or (inst_or_None, error_response).
    """
    if instance_id:
        inst = get_catalog_instance(instance_id)
    else:
        inst = _catalog_by_name().get(server_name.lower())
    if not inst:
        return None, _resp(404, {"error": "target_not_found", "reason": "target_not_found",
                                 "message": "That server is not in the RunStack instance catalog."})
    denied = _authorize_target(event, inst)
    if denied:
        return inst, denied
    env_block = _environment_block(inst)
    if env_block:
        return inst, _resp(403, {"error": "forbidden", "reason": "environment_restricted", "message": env_block})
    region = inst.get("region") or ""
    if region not in SUPPORTED_REGIONS:
        return inst, _resp(400, {"error": "unsupported_region", "message": f"Region '{region or 'unknown'}' is not supported."})
    return inst, None


def _document_region_error(check, region):
    if region not in check["regions_available"]:
        return _resp(409, {"error": "document_not_in_region", "reason": "document_not_in_region",
                           "message": f"SSM document {check['document']} is not available in {region}, where this server runs."})
    return None


def _start_job(event, inst, check_type, check, ssm_params, server_name, user_email, origin):
    """
    Take the per-target lock and write the job. Returns (status_code, body)
    in the single-target response shape; `origin` carries initiated_by and,
    for a multi-target run, the execution group.
    """
    region = inst.get("region") or ""
    job_id = str(uuid.uuid4())
    lock_key = f"sql-healthcheck#{inst['instance_id']}#{check_type}"
    existing = _acquire_check_lock(lock_key, job_id, user_email)
    listed_name = server_name or inst.get("server_name") or inst.get("name") or inst["instance_id"]
    if existing:
        # Same check already running on this target — attach to it instead
        # of starting a second one (covers double clicks and a second tab).
        return (200 if existing.get("locked_by") == user_email else 409), {
            "error": None if existing.get("locked_by") == user_email else "already_running",
            "reason": "already_running",
            "message": "A health check of this type is already running on this server.",
            "deduplicated": True,
            "total_servers": 1,
            "jobs": [{"server_name": listed_name, "instance_id": inst["instance_id"],
                      "job_id": existing.get("job_id"), "status": "PENDING", "check_type": check_type,
                      "document": check["document"]}],
        }

    payload = {
        "id": job_id,
        "account_id": str(inst.get("account_id") or ""),
        "region": region,
        "resource_id": inst["instance_id"],
        "automation_type": "SSM-RunCommand",
        "automation_data": {
            "DocumentName": check["document"],
            "InstanceIds": [inst["instance_id"]],
            **({"Parameters": ssm_params} if ssm_params else {}),
        },
        "server_name": listed_name,
        "requested_by": user_email,
        "check_type": check_type,
    }
    for key in ("app_id", "app_name", "environment"):
        if inst.get(key):
            payload[key] = inst[key]
    # Server-side origin only (verified token / group created by this handler).
    payload.update({k: v for k, v in origin.items() if v})

    if not validate_message_payload(payload):
        _release_check_lock(lock_key, job_id)
        return 422, {"error": "dispatch_failed", "message":
                     "Could not build a valid job for this server (check account_id/region in the instance catalog)."}
    try:
        stored = store_message_in_dynamodb(transform_message_data(payload, job_id))
    except Exception as e:
        logger.error(f"sql_healthcheck: job transform/store failed: {e}")
        stored = False
    if not stored:
        _release_check_lock(lock_key, job_id)
        return 500, {"error": "dispatch_failed", "message": "Failed to create the health check job."}

    logger.info(f"sql_healthcheck: job {job_id} ({check_type}, {check['document']}) for {inst['instance_id']} "
                f"{inst.get('account_id')}/{region} by {user_email}"
                + (f" in group {origin['execution_group_id']}" if origin.get("execution_group_id") else ""))
    return 200, {
        "deduplicated": False,
        "total_servers": 1,
        "jobs": [{"server_name": listed_name, "instance_id": inst["instance_id"], "job_id": job_id,
                  "status": "PENDING", "check_type": check_type, "document": check["document"]}],
    }


def _check_and_params(check_type, body):
    """Check availability + parameter validation (target-independent)."""
    check = describe_check(check_type)
    if not check["available"]:
        return None, None, _resp(409, {"error": "check_unavailable", "reason": "check_unavailable", "message": check["reason"]})
    definition = _read_document(check["document"], PRIMARY_REGION)
    ssm_params, errors = validate_parameters(definition.get("parameters"), body.get("parameters", {}))
    if errors:
        return check, None, _resp(400, {"error": "invalid_parameters", "message": "Some parameters are not valid.", "errors": errors})
    return check, ssm_params, None


def handle_typed_healthcheck(event, body):
    denied, _scope = _authorize_and_scope(event)
    if denied:
        return denied

    check_type = body.get("check_type")
    if check_type not in CHECK_MODES_BY_ID:
        return _resp(400, {"error": "invalid_check_type", "message": f"check_type must be one of: {', '.join(CHECK_MODES_BY_ID)}"})

    if "instance_ids" in body:
        return _handle_multi_target(event, body, check_type)

    instance_id = str(body.get("instance_id") or "").strip()
    server_name = str(body.get("server_name") or "").strip()
    if not instance_id and not server_name:
        return _resp(400, {"error": "target_required", "message": "Choose a target (instance_id or server_name)."})

    # Resolve through the catalog only — never trust account/region from the browser.
    inst, err = _resolve_and_vet(event, instance_id, server_name)
    if err:
        return err

    check, ssm_params, err = _check_and_params(check_type, body)
    if err and err["statusCode"] == 409:
        return err
    region_err = _document_region_error(check, inst.get("region") or "")
    if region_err:
        return region_err
    if err:
        return err

    code, out = _start_job(event, inst, check_type, check, ssm_params, server_name, _caller_email(event),
                           {"initiated_by": job_initiator(event)})
    return _resp(code, out)


def _continued_group_ok(group_id, initiator):
    """
    A later chunk may join a group only if that group is a recent UI health
    check group and every job already in it was started by this caller.
    Uses the existing execution-group-index; any read problem refuses.
    """
    if not _UI_GROUP_RE.match(group_id):
        return False
    try:
        table = boto3.resource("dynamodb").Table(DYNAMODB_TABLE_NAME)
        items, kw = [], {"IndexName": EXECUTION_GROUP_INDEX,
                         "KeyConditionExpression": Key("execution_group_id").eq(group_id)}
        while True:
            page = table.query(**kw)
            items.extend(page.get("Items", []))
            if not page.get("LastEvaluatedKey") or len(items) > 5000:
                break
            kw["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    except Exception as e:
        logger.warning(f"sql_healthcheck: could not verify group {group_id}: {e}")
        return False
    if not items or any(str(i.get("initiated_by") or "") != initiator for i in items):
        return False
    first = min(str(i.get("created_at") or "") for i in items)
    try:
        created = datetime.fromisoformat(first.replace("Z", "")).replace(tzinfo=None)
    except ValueError:
        return False
    return (datetime.utcnow() - created).total_seconds() <= GROUP_CONTINUE_SECONDS


def _handle_multi_target(event, body, check_type):
    raw = body.get("instance_ids")
    if not isinstance(raw, list) or not raw:
        return _resp(400, {"error": "target_required", "message": "instance_ids must be a non-empty list."})
    ids, seen = [], set()
    for v in raw:
        iid = str(v or "").strip()
        if not _INSTANCE_ID_RE.match(iid):
            return _resp(400, {"error": "invalid_instance_id", "message": f"'{iid[:40]}' is not a valid instance ID."})
        if iid not in seen:
            seen.add(iid)
            ids.append(iid)
    if len(ids) > MAX_TARGETS_PER_REQUEST:
        return _resp(400, {"error": "too_many_targets",
                           "message": f"Send at most {MAX_TARGETS_PER_REQUEST} servers per request.",
                           "max_targets": MAX_TARGETS_PER_REQUEST})

    check, ssm_params, err = _check_and_params(check_type, body)
    if err:
        return err

    initiator = job_initiator(event)
    user_email = _caller_email(event)
    requested_group = str(body.get("execution_group_id") or "").strip()
    if requested_group:
        if not _continued_group_ok(requested_group, initiator):
            return _resp(400, {"error": "invalid_execution_group",
                               "message": "That run can't be continued. Start the health check again."})
        group_id = requested_group
    else:
        group_id = f"{UI_GROUP_PREFIX}{uuid.uuid4()}"
    origin = {
        "initiated_by": initiator,
        "execution_group_id": group_id,
        "execution_group_label": f"SQL Database Health Check · {check.get('label') or CHECK_MODES_BY_ID[check_type]['label']}",
    }

    rows, started = [], 0
    for iid in ids:
        inst, err = _resolve_and_vet(event, iid, "")
        if not err:
            err = _document_region_error(check, inst.get("region") or "")
        if err:
            b = _body_of(err)
            rows.append({"server_name": (inst or {}).get("server_name") or (inst or {}).get("name") or None,
                         "instance_id": iid, "job_id": None, "status": "NOT_STARTED",
                         "error": b.get("error") or "forbidden", "reason": b.get("reason") or b.get("error"),
                         "message": b.get("message") or b.get("error") or "Not allowed for this server."})
            continue
        code, out = _start_job(event, inst, check_type, check, ssm_params, "", user_email, origin)
        job = (out.get("jobs") or [{}])[0]
        if code == 200 and not out.get("deduplicated"):
            started += 1
            rows.append(dict(job, deduplicated=False, error=None))
        elif out.get("deduplicated"):
            rows.append(dict(job, deduplicated=True, error=out.get("error"), reason="already_running",
                             message=out.get("message")))
        else:
            rows.append({"server_name": inst.get("server_name") or inst.get("name"), "instance_id": iid, "job_id": None,
                         "status": "NOT_STARTED", "error": out.get("error"), "reason": out.get("error"),
                         "message": out.get("message")})

    logger.info(f"sql_healthcheck: group {group_id} — {started} started of {len(ids)} requested by {user_email}")
    return _resp(200, {
        "execution_group_id": group_id if started or requested_group else None,
        "total_servers": len(ids),
        "started": started,
        "jobs": rows,
    })
