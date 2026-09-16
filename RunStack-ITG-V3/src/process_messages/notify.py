"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code, except for the authorization change
noted below.

CHANGES IN THIS VERSION:
- handle_notify previously had its own inline authorized/viewer/app-access
  checks, INCLUDING the same bug ec2_sync.py's handle_notify_sync had
  before its fix: `role not in ("admin", "operator")` let operators bypass
  app-access scoping entirely (POST /notify is a separate route from
  /notify-sync, so fixing one did not fix the other). Both the bug and the
  inline checks are now replaced by a single call to
  authorize_action(event, "ec2_stop_start", resource_id=...) — the same
  centralized, two-layer check ec2_sync.py uses, so both EC2 entry points
  now behave identically and can't drift out of sync again.
"""

from shared import *


def inject_target_locations(body):
    """
    For any SSM-Automation or SSM-RunCommand job targeting a
    non-us-east-1 region, automatically add the TargetLocations block
    if the caller didn't already supply one. This lets Dynatrace/callers
    send a simple, region-agnostic payload without knowing about
    TargetLocations at all.
    """
    logger.info(f"DEBUG inject_target_locations called with automation_type={body.get('automation_type')!r}, region={body.get('region')!r}, account_id={body.get('account_id')!r}")

    if body.get("automation_type") not in ("SSM-Automation", "SSM-RunCommand"):
        logger.info("DEBUG automation_type did not match - skipping injection")
        return body

    automation_data = body.get("automation_data", {})
    region = body.get("region", "us-east-1")
    account_id = body.get("account_id")

    logger.info(f"DEBUG before check: region={region!r}, account_id={account_id!r}, 'TargetLocations' in automation_data={'TargetLocations' in automation_data}")

    if region != "us-east-1" and account_id and "TargetLocations" not in automation_data:
        automation_data["TargetLocations"] = [
            {
                "Accounts": [account_id],
                "Regions": [region],
                "ExecutionRoleName": "AWS-SystemsManager-AutomationExecutionRole",
                "TargetLocationMaxConcurrency": "1",
                "TargetLocationMaxErrors": "1"
            }
        ]
        body["automation_data"] = automation_data
        logger.info(f"DEBUG injected TargetLocations: {json.dumps(automation_data['TargetLocations'])}")
    else:
        logger.info("DEBUG condition was False - no injection happened")

    return body


def handle_notify(event, http_method, path, path_parameters, query_params):
    sqs = boto3.client("sqs")
    QUEUE_URL = os.getenv("QUEUE_URL")

    body = json.loads(event.get("body", "{}"))
    job_id = str(uuid.uuid4())
    body["job_id"] = job_id
    body["id"] = job_id

    logger.info(f"DEBUG BEFORE injection call: automation_type={body.get('automation_type')!r}, region={body.get('region')!r}, automation_data={json.dumps(body.get('automation_data'))}")

    body = inject_target_locations(body)

    logger.info(f"DEBUG AFTER injection call: automation_data={json.dumps(body.get('automation_data'))}")

    # Two-layer authorization: (1) must be a member of one of the Azure AD
    # groups mapped to admin/operator/app_operator for EC2 — named
    # explicitly in the denial message if not; (2) app-access scoping via
    # validate_instance_access, admin bypasses, everyone else (including
    # app_operator) must have a matching runstack-app-access row for this
    # instance's app_id; (3) for non-admin, non-status-check calls, the
    # target instance's environment must be in EC2_ALLOWED_ENVIRONMENTS
    # (Phase 1 rollout guard) — status checks (automation_type ==
    # "EC2-Action") are exempt ONLY if EC2_STATUS_CHECK_EXEMPT_FROM_ENV_RESTRICTION
    # is True (currently False, so status checks are blocked too, same as
    # ec2_sync.py). Replaces the old inline checks, which had the same
    # "operator bypasses app-access" bug ec2_sync.py had before its fix —
    # this route shares the bug fix now too.
    resource_id = body.get("resource_id", "")
    is_status_check = body.get("automation_type") == "EC2-Action"
    denied = authorize_action(
        event, "ec2_stop_start",
        resource_id=resource_id,
        skip_environment_check=is_status_check,
    )
    if denied:
        claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
        logger.warning(f"User {claims.get('username', 'unknown')} denied for /notify: {denied.get('body')}")
        return denied

    #if resource_id:
    #    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
    #    username = claims.get("username", "")
    #    user_email = username.replace("AzureAD_", "") if username.startswith("AzureAD_") else claims.get("email", username)
    #    lock_conflict = acquire_action_lock(resource_id, user_email or "unknown", job_id)
    #    if lock_conflict:
    #        return {
    #            "statusCode": 423,
    #            "headers": CORS_HEADERS,
    #            "body": json.dumps({
    #                "error": "locked",
    #                "message": f"Someone is already performing an action on this instance ({lock_conflict['locked_by']}, started {lock_conflict['locked_at']}). Please wait and try again shortly."
    #            })
    #        }

    logger.info(f"DEBUG about to send to SQS: {json.dumps(body)}")

    sqs.send_message(
        QueueUrl=QUEUE_URL,
        MessageBody=json.dumps(body)
    )

    return {
        "statusCode": 200,
        "headers": CORS_HEADERS,
        "body": json.dumps({"status": "accepted", "job_id": job_id})
    }

# ── POST /synthetic/execute — Dynatrace on-demand synthetic run ─