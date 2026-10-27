"""
UiPath Orchestrator integration (read-only).

Route:  GET /uipath/robots/{robotId}/running-job
Caller: AQS agent / RunStack UI via API Gateway (Cognito authorizer,
        runstack-api/notify scope) -> process_messages -> this module.
"""

import json
import os
import re
import socket
import urllib.error
import urllib.parse
import urllib.request

from shared import *  # boto3, logger, CORS_HEADERS, require_role, require_team_capability

UIPATH_SECRET_ARN = os.getenv("UIPATH_SECRET_ARN", "")
UIPATH_BASE_URL = os.getenv("UIPATH_BASE_URL", "").rstrip("/")
UIPATH_ORG_UNIT_ID = os.getenv("UIPATH_ORG_UNIT_ID", "")
UIPATH_TEAM = os.getenv("UIPATH_TEAM", "")
UIPATH_CAPABILITY = os.getenv("UIPATH_CAPABILITY", "uipath-robot-status")
UIPATH_TIMEOUT_SEC = int(os.getenv("UIPATH_TIMEOUT_SEC", "20"))

# Numeric only: robotId is interpolated into an OData $filter, so anything
# else (e.g. "1 or 1 eq 1") must be rejected before reaching UiPath.
ROBOT_ID_RE = re.compile(r"^[0-9]{1,12}$")

_uipath_token_cache = None  # reused across warm invocations


def _resp(status, body):
    return {"statusCode": status, "headers": CORS_HEADERS, "body": json.dumps(body, default=str)}


def _authorize(event):
    if UIPATH_TEAM:
        return require_team_capability(event, UIPATH_TEAM, UIPATH_CAPABILITY)
    # No team configured yet -> fail closed to platform operators/admins only.
    logger.warning("UIPATH_TEAM not set - UiPath route limited to operator role or higher")
    return require_role(event, "operator")


def _get_token(force_refresh=False):
    global _uipath_token_cache

    # TEMPORARY (ITG only): direct token via env var until the Lambda role
    # has secretsmanager:GetSecretValue. Remove UIPATH_TOKEN once IAM is granted;
    # the Secrets Manager path below is then used automatically.
    env_token = os.getenv("UIPATH_TOKEN", "").strip()
    if env_token:
        if env_token.lower().startswith("bearer "):
            env_token = env_token[7:].strip()
        return env_token

    if _uipath_token_cache and not force_refresh:
        return _uipath_token_cache

    if not UIPATH_SECRET_ARN:
        raise ValueError("Neither UIPATH_TOKEN nor UIPATH_SECRET_ARN is configured")

    secret = boto3.client("secretsmanager").get_secret_value(SecretId=UIPATH_SECRET_ARN)
    parsed = json.loads(secret["SecretString"])
    # Tolerate either key casing; the original script used both at different times.
    token = (parsed.get("Authorization") or parsed.get("authorization") or "").strip()
    if not token:
        raise ValueError("UiPath secret has no 'Authorization' key")
    if token.lower().startswith("bearer "):
        token = token[7:].strip()

    _uipath_token_cache = token
    return token


def _query_running_job(robot_id, token):
    """Returns (http_status, parsed_json_or_text)."""
    params = urllib.parse.urlencode({
        "$top": "1",
        "$filter": "Robot/Id eq {} and State eq 'Running'".format(robot_id),
    })
    req = urllib.request.Request(
        "{}/odata/Jobs?{}".format(UIPATH_BASE_URL, params),
        method="GET",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            # UiPath's edge blocks the default "Python-urllib/x" User-Agent
            # with an HTML 403 page, so send an explicit one.
            "User-Agent": "RunStack-UiPath/1.0",
            "X-UIPATH-OrganizationUnitId": UIPATH_ORG_UNIT_ID,
            "Authorization": "Bearer {}".format(token),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=UIPATH_TIMEOUT_SEC) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        if body.lstrip().lower().startswith(("<!doctype", "<html")):
            body = "UiPath returned an HTML page instead of an API response (blocked at UiPath edge)"
        return e.code, body[:500]


def _normalize_job(job):
    return {
        "id": job.get("Id"),
        "key": job.get("Key"),
        "state": job.get("State"),
        "process_name": job.get("ReleaseName"),
        "host_machine": job.get("HostMachineName"),
        "start_time": job.get("StartTime"),
        "creation_time": job.get("CreationTime"),
        "source": job.get("Source"),
        "info": job.get("Info"),
    }


# ── GET /uipath/robots/{robotId}/running-job ───────────────────────────────

def handle_uipath_running_job(event, http_method, path, path_parameters, query_params):
    robot_id = str((path_parameters or {}).get("robotId") or "").strip()
    if not ROBOT_ID_RE.match(robot_id):
        return _resp(400, {"error": "bad_request", "message": "robotId must be a numeric UiPath robot ID"})

    #denied = _authorize(event)
    #if denied:
        #return denied

    if not (UIPATH_BASE_URL and UIPATH_ORG_UNIT_ID):
        logger.error("UiPath integration not configured (UIPATH_BASE_URL / UIPATH_ORG_UNIT_ID)")
        return _resp(500, {"error": "not_configured", "message": "UiPath integration is not configured"})

    try:
        status, data = _query_running_job(robot_id, _get_token())
        if status == 401:
            # Token may have been rotated in Secrets Manager since we cached it.
            status, data = _query_running_job(robot_id, _get_token(force_refresh=True))

        if status != 200:
            logger.error(f"UiPath Jobs query failed for robot {robot_id}: HTTP {status} {data}")
            return _resp(502, {"error": "uipath_error", "uipath_status": status, "detail": data})

        jobs = (data or {}).get("value", []) if isinstance(data, dict) else []
        if not jobs:
            return _resp(200, {"robot_id": robot_id, "running": False, "job": None,
                               "message": f"No running job found for robot {robot_id}"})

        return _resp(200, {"robot_id": robot_id, "running": True, "job": _normalize_job(jobs[0])})

    except (socket.timeout, urllib.error.URLError) as e:
        logger.error(f"UiPath request timed out/unreachable for robot {robot_id}: {e}")
        return _resp(504, {"error": "uipath_timeout", "message": "UiPath Orchestrator did not respond in time"})
    except Exception as e:
        logger.error(f"UiPath running-job lookup failed for robot {robot_id}: {e}")
        return _resp(500, {"error": "internal_error", "message": "Failed to query UiPath running job"})