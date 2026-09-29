"""
Generic EC2 automation dispatch (stop/start/status) for any app — not
SAP-specific. Handles auth (via authorize_action, "ec2_stop_start"), job
creation, and synchronous polling.

Extracted from sap_sync.py, where it originally lived alongside the
SAP-specific handlers. Moved here because this function has never been
SAP-specific — it serves EC2 stop/start/status for any app (LH1, Compass,
etc.) — and keeping it in a file named sap_sync.py was misleading.

SAP-domain requests ({"domain": "sap", ...}) are dispatched to
handle_sap_action in sap_sync.py; everything else is handled here.
"""

import json
import uuid
import time as _time

from shared import *
from sap_sync import handle_sap_action


# ── POST /notify-sync — synchronous status-check wrapper ──────────────
# IMPORTANT: this must be checked BEFORE the /notify branch in app.py's
# dispatcher, since path.endswith("/notify") would also match
# "/notify-sync" if that elif were placed first.
#
# Recognizes {"domain": "sap", ...} bodies and dispatches them to
# handle_sap_action, so an agent caller can use this same existing,
# already-deployed route instead of needing a new API Gateway resource.
# Bodies without "domain": "sap" fall through to the original generic
# job-record flow below.

def handle_notify_sync(event, http_method, path, path_parameters, query_params):
    body_peek = json.loads(event.get("body", "{}"))
    if body_peek.get("domain") == "sap":
        return handle_sap_action(event, http_method, path, path_parameters, query_params)

    body = json.loads(event.get("body", "{}"))
    job_id = str(uuid.uuid4())
    body["job_id"] = job_id
    body["id"] = job_id

    # Two-layer authorization: (1) must be a member of one of the Azure AD
    # groups mapped to admin/operator/app_operator for EC2 — named
    # explicitly in the denial message if not; (2) app-access scoping via
    # validate_instance_access, admin bypasses, everyone else (including
    # app_operator) must have a matching runstack-app-access row for this
    # instance's app_id; (3) for non-admin, non-status-check calls, the
    # target instance's environment must be in EC2_ALLOWED_ENVIRONMENTS
    # (Phase 1 rollout guard) — status checks (automation_type ==
    # "EC2-Action") are exempt, so PROD/DR servers can still be listed and
    # their state checked, only the real start/stop is blocked.
    is_status_check = body.get("automation_type") == "EC2-Action"
    denied = authorize_action(
        event, "ec2_stop_start",
        resource_id=body.get("resource_id", ""),
        skip_environment_check=is_status_check,
    )
    if denied:
        return denied

    if not validate_message_payload(body):
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Invalid payload"})
        }

    transformed = transform_message_data(body, job_id)
    if not store_message_in_dynamodb(transformed):
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to create job"})
        }

    TIMEOUT_SEC, POLL_SEC, elapsed = 18, 2, 0
    job = None
    terminal = ("COMPLETED", "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED")
    while elapsed < TIMEOUT_SEC:
        _time.sleep(POLL_SEC)
        elapsed += POLL_SEC
        job = get_job_by_id(job_id)
        if job and job.get("status") in terminal:
            break

    if not job or job.get("status") not in terminal:
        return {
            "statusCode": 202,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "job_id": job_id,
                "status": "RUNNING",
                "message": "Still running after 18s — poll GET /jobs/{jobId} to continue."
            })
        }

    raw_output = job.get("qualys_output", "")
    exit_code = job.get("exit_code")
    script_result = None if exit_code in (-1, None) else ("PASSED" if exit_code == 0 else "FAILED")

    return {
        "statusCode": 200,
        "headers": CORS_HEADERS,
        "body": json.dumps({
            "job_id": job["job_id"],
            "status": job["status"],
            "resource_id": job.get("resource_id"),
            "account_id": job.get("account_id"),
            "region": job.get("region"),
            "automation_type": job.get("automation_type"),
            "ec2_state": job.get("ec2_state"),
            "exit_code": exit_code,
            "script_result": script_result,
            "output": raw_output,
            "created_at": job.get("created_at"),
            "updated_at": job.get("updated_at"),
        }, default=decimal_default)
    }