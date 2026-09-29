"""
SAP component actions (start/stop/status), data-driven from two DynamoDB tables:

- runstack-sap-instance-details (keyed by sid + component): SAP-specific
  fields only — instance_id, role, sap_sid, sap_instance_id,
  sap_virtual_hostname, sapadm_user, depends_on, and the start/stop/status
  script paths + args. Never touched by any instance-catalog sync.
- runstack-instance-catalog (keyed by instance_id): generic server fields
  only — account_id, region, environment, etc. May be overwritten wholesale
  by an external inventory sync at any time; SAP fields are never stored
  here to avoid being wiped out by that sync.

Adding a new SAP system (a new sid) is a pure data operation — new rows in
both tables, no code change and no redeploy required.

Retained from the original file:
- handle_ec2_statuscheck: dynamic resource_id, unrelated to any single SID.

NOTE: handle_notify_sync (generic, non-SAP-specific EC2 stop/start/status,
plus the domain="sap" dispatch into handle_sap_action below) has moved to
ec2_sync.py — it was never SAP-specific and belongs in a neutral module.
app.py now imports it from there.

CHANGES IN THIS VERSION: handle_sap_action and handle_ec2_statuscheck now
call authorize_action(event, "sap_action") instead of
require_team_capability(event, "sap", "sap-status-check") directly — same
underlying capability check (admin/operator bypass, else
runstack-team-sap membership + capability), but Layer 1 (Azure AD group
membership) is now checked first and mandatorily, with a denial message
that names the real Azure AD groups (Automation-Admin,
Automation-Operator, SAP Basis-Operator) rather than a generic message.
"""

from shared import *
from shared import _run_sync_check

DEFAULT_SID = os.getenv("SAP_DEFAULT_SID", "G1D")


def _order_components(components: list, action: str) -> list:
    """Order components so dependencies start before dependents, and the
    reverse for stop. Falls back to input order if depends_on data is
    inconsistent, rather than raising."""
    ordered, done = [], set()
    remaining = {c["component"]: c for c in components}
    while remaining:
        ready = [
            c for c in remaining.values()
            if all(dep.upper() in done for dep in c.get("depends_on", []))
        ]
        if not ready:
            ready = list(remaining.values())
        for c in ready:
            ordered.append(c)
            done.add(c["component"])
            del remaining[c["component"]]
    return ordered if action == "start" else list(reversed(ordered))


def _run_sap_component_action(component: dict, action: str) -> dict:
    """Runs start or stop for a single SAP component via its own script
    path/args from the sap-instance-details table, dispatched async through
    the existing DynamoDB Streams -> Step Function -> SSM pipeline."""
    catalog = get_catalog_instance(component["instance_id"])
    if not catalog:
        return {
            "component": component["component"],
            "status": "ERROR",
            "message": f"Instance {component['instance_id']} not in instance catalog",
        }

    script = component.get(f"{action}_script_path")
    args = component.get(f"{action}_args", [])
    if not script:
        return {
            "component": component["component"],
            "status": "ERROR",
            "message": f"No {action} script configured for component {component['component']}",
        }

    cmd = f"{script} {' '.join(args)}; true"
    job_id = str(uuid.uuid4())
    payload = {
        "id": f"sap-{action}-{job_id[:8]}",
        "job_id": job_id,
        "account_id": catalog["account_id"],
        "region": catalog["region"],
        "resource_id": component["instance_id"],
        "automation_type": "SSM-Automation",
        "automation_data": {
            "DocumentName": "SSM-RunCommand",
            "Parameters": {
                "DocumentName": "AWS-RunShellScript",
                "InstanceIds": [component["instance_id"]],
                "Parameters": {"commands": [cmd]},
            },
        },
    }

    if not validate_message_payload(payload):
        return {"component": component["component"], "status": "ERROR", "message": "Invalid payload"}

    transformed = transform_message_data(payload, job_id)
    if not store_message_in_dynamodb(transformed):
        return {"component": component["component"], "status": "ERROR", "message": "Failed to create job"}

    return {"component": component["component"], "job_id": job_id, "status": "PENDING"}


def handle_sap_action(event, http_method, path, path_parameters, query_params):
    """POST /sap/action
    Body: {"sid": "G1D", "component": "pas", "action": "start"}   — single component
    Body: {"sid": "G1D", "action": "start"}                        — all components for that SID

    action is one of "start", "stop", "status". component is optional; if
    omitted, every component registered for the sid is actioned, ordered by
    depends_on (reverse order for stop).

    CHANGED: authorization now splits by requested action — "status" needs
    only the "sap-status-check" capability, while "start"/"stop" require
    the separate "sap-start-stop" capability. This mirrors the existing
    GDBA-SQL split (sql-db-healthcheck vs sql-dr-failover), so someone
    can be trusted to check SAP status without being trusted to restart
    production SAP components."""
    body = json.loads(event.get("body", "{}"))
    action = body.get("action")

    action_auth_key = "sap_start_stop" if action in ("start", "stop") else "sap_status_check"
    denied = authorize_action(event, action_auth_key)
    if denied:
        return denied

    sid = body.get("sid")
    component_name = body.get("component")

    if not sid or action not in ("start", "stop", "status"):
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "sid and a valid action ('start'|'stop'|'status') are required"}),
        }

    if component_name:
        detail = get_sap_instance(sid, component_name)
        if not detail:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": f"No component '{component_name}' found for SID '{sid}'"}),
            }
        components = [detail]
    else:
        components = get_sap_components(sid)
        if not components:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": f"No components found for SID '{sid}'"}),
            }
        components = _order_components(components, action)

    if action == "status":
        claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
        results = []
        for c in components:
            catalog = get_catalog_instance(c["instance_id"])
            if not catalog:
                results.append({"component": c["component"], "status": "ERROR", "message": "Not in catalog"})
                continue
            cmd = f"{c['status_script_path']} {' '.join(c.get('status_args', []))}; true"
            res = _run_sync_check(
                event, claims, c["instance_id"], catalog["region"], catalog["account_id"],
                "SSM-RunCommand",
                {"DocumentName": "AWS-RunShellScript",
                 "InstanceIds": [c["instance_id"]],
                 "Parameters": {"commands": [cmd]}},
                f"{c['component'].lower()}-check")
            results.append(res)
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"sid": sid, "action": action, "results": results}, default=decimal_default),
        }

    results = [_run_sap_component_action(c, action) for c in components]
    return {
        "statusCode": 200,
        "headers": CORS_HEADERS,
        "body": json.dumps({"sid": sid, "action": action, "results": results}),
    }


# ── POST /notify-sync/ec2-statuscheck ──────────────────────────────────
# Dynamic resource_id check, reused across arbitrary instances — not tied
# to any single SID, so it stays outside the sid/component model above.

def handle_ec2_statuscheck(event, http_method, path, path_parameters, query_params):
    denied = authorize_action(event, "sap_status_check")
    if denied:
        return denied
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
    body_in = json.loads(event.get("body", "{}"))
    resource_id = body_in.get("resource_id")
    if not resource_id:
        return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps({"error": "resource_id is required"})}
    catalog = get_catalog_instance(resource_id)
    account_id = catalog["account_id"] if catalog else SAP_ACCOUNT_ID_FALLBACK
    region = catalog["region"] if catalog else "us-east-1"
    return _run_sync_check(event, claims, resource_id, region, account_id,
                            "EC2-Action", {}, "ec2-check")


# Fallback only used if a resource_id passed to ec2-statuscheck isn't in the
# catalog yet (e.g. a brand-new instance not synced). Kept narrow and only
# used as a last resort — prefer catalog data whenever available.
SAP_ACCOUNT_ID_FALLBACK = os.getenv("SAP_ACCOUNT_ID_FALLBACK", "533267087748")


# ── Named per-component status-check wrappers ──────────────────────────
# Kept as thin wrappers around handle_sap_action for backward compatibility
# with the existing /notify-sync/{component}-status-check routes already
# wired in app.py, so no route changes are required to keep these working
# while the new generic /sap/action path is rolled out alongside them.

def _status_check_wrapper(event, http_method, path, path_parameters, query_params, component):
    event = dict(event)
    event["body"] = json.dumps({"sid": DEFAULT_SID, "component": component, "action": "status"})
    result = handle_sap_action(event, http_method, path, path_parameters, query_params)
    logger.info(f"_status_check_wrapper[{component}] handle_sap_action returned statusCode={result.get('statusCode')}, body={result.get('body')}")
    if result.get("statusCode") != 200:
        return result
    body = json.loads(result["body"])
    results = body.get("results", [])
    if not results:
        return {"statusCode": 404, "headers": CORS_HEADERS, "body": json.dumps({"error": "No result"})}
    return {"statusCode": 200, "headers": CORS_HEADERS, "body": json.dumps(results[0], default=decimal_default)}


def handle_db_status_check(event, http_method, path, path_parameters, query_params):
    return _status_check_wrapper(event, http_method, path, path_parameters, query_params, "db")


def handle_ascs_status_check(event, http_method, path, path_parameters, query_params):
    return _status_check_wrapper(event, http_method, path, path_parameters, query_params, "ascs")


def handle_pas_status_check(event, http_method, path, path_parameters, query_params):
    return _status_check_wrapper(event, http_method, path, path_parameters, query_params, "pas")


def handle_aas_status_check(event, http_method, path, path_parameters, query_params):
    return _status_check_wrapper(event, http_method, path, path_parameters, query_params, "aas")


# ── Named per-component start/stop wrappers ────────────────────────────
# Same backward-compatibility rationale as the status wrappers above.

def _power_action_wrapper(event, http_method, path, path_parameters, query_params, component, action):
    event = dict(event)
    event["body"] = json.dumps({"sid": DEFAULT_SID, "component": component, "action": action})
    result = handle_sap_action(event, http_method, path, path_parameters, query_params)
    if result.get("statusCode") != 200:
        return result
    body = json.loads(result["body"])
    results = body.get("results", [])
    if not results:
        return {"statusCode": 404, "headers": CORS_HEADERS, "body": json.dumps({"error": "No result"})}
    return {"statusCode": 200, "headers": CORS_HEADERS, "body": json.dumps(results[0])}


def handle_sap_db_start(event, http_method, path, path_parameters, query_params):
    return _power_action_wrapper(event, http_method, path, path_parameters, query_params, "db", "start")

def handle_sap_db_stop(event, http_method, path, path_parameters, query_params):
    return _power_action_wrapper(event, http_method, path, path_parameters, query_params, "db", "stop")

def handle_sap_ascs_start(event, http_method, path, path_parameters, query_params):
    return _power_action_wrapper(event, http_method, path, path_parameters, query_params, "ascs", "start")

def handle_sap_ascs_stop(event, http_method, path, path_parameters, query_params):
    return _power_action_wrapper(event, http_method, path, path_parameters, query_params, "ascs", "stop")

def handle_sap_pas_start(event, http_method, path, path_parameters, query_params):
    return _power_action_wrapper(event, http_method, path, path_parameters, query_params, "pas", "start")

def handle_sap_pas_stop(event, http_method, path, path_parameters, query_params):
    return _power_action_wrapper(event, http_method, path, path_parameters, query_params, "pas", "stop")

def handle_sap_aas_start(event, http_method, path, path_parameters, query_params):
    return _power_action_wrapper(event, http_method, path, path_parameters, query_params, "aas", "start")

def handle_sap_aas_stop(event, http_method, path, path_parameters, query_params):
    return _power_action_wrapper(event, http_method, path, path_parameters, query_params, "aas", "stop")