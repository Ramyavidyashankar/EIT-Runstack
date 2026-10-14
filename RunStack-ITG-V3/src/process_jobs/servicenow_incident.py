"""
ServiceNow incident on EC2 stop/start failure.

process_jobs already receives every change to runstack-jobs-table (the stream
is NEW_AND_OLD_IMAGES). This module raises ONE incident in ServiceNow when:

  Phase 1  an EC2 stop/start job (AWS-StopEC2Instance / AWS-StartEC2Instance)
           changes to FAILED or TIMED_OUT          -> cloudops_group_sys_id
                                                      (DXC IT-PublicCloudOps)
  Phase 2  a start reached "running" but its health check ended impaired, or
           timed out with EC2 status checks not passed
  Phase 3  a start reached "running", status checks passed, but SSM never
           came Online (health_outcome timeout)     -> linux_l3_group_sys_id
                                                      (DXCIT_LinuxL3)

Steps:

  1. OAuth token   POST {instance}/oauth_token.do  (grant_type=password,
                   client from the secret + RPABotUser)   — cached while valid
  2. Duplicate     GET incident?correlation_id=<job_id>  — skip if it exists
  3. CI lookup     GET cmdb_ci by server name (catalog server_name)
  4. Create        POST {instance}/api/now/table/incident

Never raises: any problem is logged and job processing carries on unchanged.
Disabled (no-op) unless SERVICENOW_SECRET_ARN is set.
SERVICENOW_DRY_RUN=true (the default) does every step except the final POST and
logs the incident payload instead — set it to false to create real incidents.

Secret (JSON) — e.g. runstack-servicenow-qa:
  {"instance_url": "https://dxcidev.service-now.com",
   "client_id": "...", "client_secret": "...",
   "username": "RPABotUser", "password": "...",
   "cloudops_group_sys_id": "87f0215497f0bdd04b67f0c3f153afd6",   (phase 1)
   "linux_l3_group_sys_id": "9f251487db2eb010bf85ce1c29961944",     (phases 2-3)
   "caller_sys_id": "ffc8252c871796901482a9383cbb35bb"}
"""

import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request

import boto3
from boto3.dynamodb.conditions import Key

logger = logging.getLogger()

SECRET_ARN = os.getenv("SERVICENOW_SECRET_ARN", "")
CATALOG_TABLE = os.getenv("INSTANCE_CATALOG_TABLE", "runstack-instance-catalog")
HTTP_TIMEOUT = int(os.getenv("SERVICENOW_HTTP_TIMEOUT", "5"))
# Dry run: token, duplicate check and CI lookup run for real; the incident is
# NOT created — the payload is logged instead ("SERVICENOW DRY RUN").
DRY_RUN = os.getenv("SERVICENOW_DRY_RUN", "true").strip().lower() in ("1", "true", "yes")

EC2_POWER_DOCUMENTS = {"AWS-StopEC2Instance": "Stop", "AWS-StartEC2Instance": "Start"}
FAILED_STATUSES = {"FAILED", "TIMED_OUT"}
HEALTH_FAILURES = {"impaired", "timeout"}

_config = None
_token = {"value": None, "expires": 0}


# ── Entry point (called from process_jobs for MODIFY records) ────────────

def handle_job_update(old_job, new_job):
    try:
        if not SECRET_ARN:
            return
        failure = _failed_power_action(old_job, new_job) or _failed_start_health(old_job, new_job)
        if not failure:
            return
        number = _raise_incident(new_job, failure)
        if number:
            logger.info(f"servicenow: {number} raised for job {new_job.get('job_id')} "
                        f"(phase {failure['phase']}, {new_job.get('resource_id')})")
    except Exception as e:   # never affect job processing
        logger.error(f"servicenow: incident not raised for job {new_job.get('job_id')}: {e}")


def _power_action(job):
    """'Stop' / 'Start' for EC2 power jobs, else None."""
    if job.get("automation_type") != "SSM-Automation":
        return None
    data = job.get("automation_data") or {}
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except ValueError:
            return None
    return EC2_POWER_DOCUMENTS.get(data.get("DocumentName"))


def _failed_power_action(old_job, new_job):
    """Phase 1: this update is the stop/start job's transition into failure."""
    action = _power_action(new_job)
    if not action or new_job.get("status") not in FAILED_STATUSES:
        return None
    if (old_job or {}).get("status") in FAILED_STATUSES:
        return None          # already failed before this update
    return {"phase": 1, "action": action, "group_key": "cloudops_group_sys_id",
            "correlation": new_job.get("job_id", ""),
            "title": f"EC2 {action} Failed",
            "summary": f"EC2 {action.lower()} requested through EIT RunStack did not complete.",
            "details": [f"Job status: {new_job.get('status')}"]}


def _failed_start_health(old_job, new_job):
    """Phases 2-3: a start reached running, then its health check failed.
    Fires once, when health_outcome is first set to impaired / timeout."""
    if _power_action(new_job) != "Start":
        return None
    outcome = new_job.get("health_outcome")
    if outcome not in HEALTH_FAILURES or (old_job or {}).get("health_outcome") == outcome:
        return None
    checks = _status_checks(new_job)
    ping = _ssm_ping(new_job)
    if outcome == "timeout" and checks["passed"] and ping != "Online":
        phase, title = 3, "Server Connectivity Failed After Start"
        summary = ("The server started and EC2 status checks passed, but the SSM agent "
                   "did not come Online within the health-check window.")
    else:
        phase, title = 2, "EC2 Status Checks Failed After Start"
        summary = ("The server started (running) but EC2 status checks "
                   f"{'reported impaired' if outcome == 'impaired' else 'did not pass within the health-check window'}.")
    return {"phase": phase, "action": "Start", "group_key": "linux_l3_group_sys_id",
            "correlation": f"{new_job.get('job_id', '')}:health",
            "title": title, "summary": summary,
            "details": [f"Health outcome: {outcome}",
                        f"EC2 status checks: {checks['text']}",
                        f"SSM connectivity (ping status): {ping}",
                        f"Health checked at (UTC): {new_job.get('health_checked_at') or 'Not available'}"]}


def _status_checks(job):
    data = _json_field(job, "ec2_health_raw") or {}
    st = (data.get("InstanceStatuses") or [{}])[0]
    vals = {name: ((st.get(key) or {}).get("Status") or "not-reported").lower()
            for name, key in (("system", "SystemStatus"), ("instance", "InstanceStatus"),
                              ("ebs", "AttachedEbsStatus"))}
    reported = {k: v for k, v in vals.items() if v != "not-reported"}
    ok = sum(1 for v in reported.values() if v == "ok")
    text = (f"{ok}/{len(reported)} passed ("
            + ", ".join(f"{k}: {v}" for k, v in reported.items()) + ")") if reported else "Not available"
    return {"passed": bool(reported) and ok == len(reported), "text": text}


def _ssm_ping(job):
    data = _json_field(job, "ssm_info_raw")
    if not data or not data.get("available", True):
        return "Not available"
    items = data.get("InstanceInformationList") or []
    return (items[0].get("PingStatus") or "unknown") if items else "NotRegistered"


def _json_field(job, key):
    raw = job.get(key)
    if not raw:
        return None
    try:
        return json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return None


# ── Incident ─────────────────────────────────────────────────────────────

def _raise_incident(job, failure):
    cfg = _load_config()
    base = cfg["instance_url"].rstrip("/")
    job_id = job.get("job_id", "")
    instance_id = job.get("resource_id", "")
    action = failure["action"]
    group = cfg.get(failure["group_key"])
    if not group:
        logger.warning(f"servicenow: secret has no {failure['group_key']}; phase {failure['phase']} incident skipped")
        return None
    token = _get_token(cfg)

    # Duplicate guard: one incident per job and phase, even if the stream redelivers.
    existing = _get(base, token, "incident", {"sysparm_query": f"correlation_id={failure['correlation']}",
                                              "sysparm_fields": "number", "sysparm_limit": "1"})
    if existing:
        logger.info(f"servicenow: {existing[0].get('number')} already exists for {failure['correlation']}")
        return None

    catalog = _catalog_entry(instance_id)
    server = job.get("server_name") or catalog.get("server_name") or catalog.get("name") or ""
    app = job.get("app_name") or catalog.get("app_name") or job.get("app_id") or catalog.get("app_id") or ""
    env = job.get("environment") or catalog.get("environment") or ""
    label = server or instance_id

    ci_sys_id = _find_ci(base, token, server) if server else None

    payload = {
        "assignment_group": group,
        "impact": "3",
        "urgency": "3",
        "priority": "4",
        "correlation_id": failure["correlation"],
        "correlation_display": "EIT RunStack",
        "short_description": f"[RunStack] {failure['title']} — {label} ({instance_id})",
        "description": "\n".join([
            failure["summary"],
            "",
            f"Failure phase: {failure['phase']} — {failure['title']}",
            f"Server: {server or 'Not available'}",
            f"Instance ID: {instance_id}",
            f"AWS account: {job.get('account_id', '')} | Region: {job.get('region', '')}",
            f"Application / Environment: {app or 'Not available'} / {env or 'Not available'}",
            f"Requested action: {action}",
            *failure["details"],
            f"Requested by: {job.get('initiated_by') or 'Not available'}",
            f"Requested at (UTC): {job.get('created_at', '')}",
            f"Failed at (UTC): {job.get('updated_at', '')}",
            f"RunStack job ID: {job_id}",
            f"Step Functions execution: {job.get('execution_id') or 'Not available'}",
            "",
            "Raised automatically by EIT RunStack.",
        ]),
    }
    if cfg.get("caller_sys_id"):
        payload["caller_id"] = cfg["caller_sys_id"]
    if ci_sys_id:
        payload["cmdb_ci"] = ci_sys_id

    if DRY_RUN:
        logger.warning("SERVICENOW DRY RUN — incident NOT created. Would POST to "
                       f"{base}/api/now/table/incident: {json.dumps(payload)}")
        return "DRY-RUN"

    status, body = _http("POST", f"{base}/api/now/table/incident", _headers(token), json.dumps(payload).encode())
    if status not in (200, 201):
        raise RuntimeError(f"create incident failed: HTTP {status} {str(body)[:300]}")
    return (body.get("result") or {}).get("number")


def _find_ci(base, token, server):
    """Server CI by exact name, FQDN, or 'name.<domain>'. None if not exactly one."""
    rows = _get(base, token, "cmdb_ci", {
        "sysparm_query": f"name={server}^ORfqdn={server}^ORnameSTARTSWITH{server}.",
        "sysparm_fields": "sys_id,name", "sysparm_limit": "2"})
    if len(rows) == 1:
        return rows[0]["sys_id"]
    logger.warning(f"servicenow: CI for '{server}' {'not found' if not rows else 'ambiguous'}; "
                   "incident raised without cmdb_ci")
    return None


# ── Helpers ──────────────────────────────────────────────────────────────

def _load_config():
    global _config
    if _config is None:
        raw = boto3.client("secretsmanager").get_secret_value(SecretId=SECRET_ARN)["SecretString"]
        cfg = json.loads(raw)
        missing = [k for k in ("instance_url", "client_id", "client_secret", "username",
                               "password", "cloudops_group_sys_id") if not cfg.get(k)]
        if missing:
            raise RuntimeError(f"secret is missing {missing}")
        _config = cfg
    return _config


def _get_token(cfg):
    if _token["value"] and time.time() < _token["expires"]:
        return _token["value"]
    form = urllib.parse.urlencode({
        "grant_type": "password", "client_id": cfg["client_id"], "client_secret": cfg["client_secret"],
        "username": cfg["username"], "password": cfg["password"]}).encode()
    status, body = _http("POST", f"{cfg['instance_url'].rstrip('/')}/oauth_token.do",
                         {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}, form)
    if status != 200 or "access_token" not in body:
        raise RuntimeError(f"token request failed: HTTP {status}")
    _token["value"] = body["access_token"]
    _token["expires"] = time.time() + int(body.get("expires_in", 1800)) - 120
    return _token["value"]


def _catalog_entry(instance_id):
    try:
        resp = boto3.resource("dynamodb").Table(CATALOG_TABLE).query(
            KeyConditionExpression=Key("instance_id").eq(instance_id), Limit=1)
        return (resp.get("Items") or [{}])[0]
    except Exception as e:
        logger.warning(f"servicenow: catalog lookup failed for {instance_id}: {e}")
        return {}


def _get(base, token, table, params):
    status, body = _http("GET", f"{base}/api/now/table/{table}?{urllib.parse.urlencode(params)}", _headers(token))
    if status != 200:
        raise RuntimeError(f"GET {table} failed: HTTP {status}")
    return body.get("result") or []


def _headers(token):
    return {"Authorization": f"Bearer {token}", "Accept": "application/json", "Content-Type": "application/json"}


def _http(method, url, headers, data=None):
    req = urllib.request.Request(url, method=method, headers=headers, data=data)
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except ValueError:
            return e.code, {}