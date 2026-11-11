"""
Create a ServiceNow incident from process_messages (e.g. the SAP full-stack
"disable / enable backup" request to the backup team).

Uses the SAME secret and switches as process_jobs/servicenow_incident.py:
  SERVICENOW_SECRET_ARN  secret JSON (instance_url, client_id, client_secret,
                         username, password, caller_sys_id, ...). Blank = off.
  Temporary alternative while the Lambda role cannot read that secret:
  SNOW_CLIENT_ID, SNOW_CLIENT_SECRET, SNOW_PASSWORD (only the secret values;
  the QA instance URL, RPABotUser and caller sys_id below are the defaults and
  can be overridden with SNOW_URL / SNOW_USER / SNOW_CALLER_SYS_ID). When
  SNOW_CLIENT_SECRET is set these are used and the secret is not read. Move
  back to the secret as soon as IAM allows it.
  SERVICENOW_DRY_RUN     "true" (default): token, duplicate check and group
                         lookup run for real, the incident is NOT created and
                         the payload is logged ("SERVICENOW DRY RUN").

Steps: OAuth token -> duplicate check by correlation_id -> assignment group
sys_id (by name, unless a sys_id is given) -> POST incident.
create_incident() never raises; it returns
  {"status": "created" | "dry_run" | "exists" | "not_raised", "number", "url", "error"}
"""

import json
import logging
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

import boto3

logger = logging.getLogger()

SECRET_ARN = os.getenv("SERVICENOW_SECRET_ARN", "")
# Non-secret QA defaults (same values as process_jobs/servicenow_incident.py).
QA_DEFAULTS = {"instance_url": "https://dxcidev.service-now.com", "username": "RPABotUser",
               "caller_sys_id": "ffc8252c871796901482a9383cbb35bb"}
ENV_CONFIG = {k: (os.getenv(v, "").strip() or QA_DEFAULTS.get(k, "")) for k, v in (
    ("instance_url", "SNOW_URL"), ("client_id", "SNOW_CLIENT_ID"), ("client_secret", "SNOW_CLIENT_SECRET"),
    ("username", "SNOW_USER"), ("password", "SNOW_PASSWORD"), ("caller_sys_id", "SNOW_CALLER_SYS_ID"))}
DRY_RUN = os.getenv("SERVICENOW_DRY_RUN", "true").strip().lower() in ("1", "true", "yes")
HTTP_TIMEOUT = int(os.getenv("SERVICENOW_HTTP_TIMEOUT", "5"))

_config = None
_token = {"value": None, "expires": 0}
_groups = {}


def configured():
    return bool(SECRET_ARN or ENV_CONFIG["client_secret"])


def create_incident(short_description, description, group, correlation_id,
                    impact="3", urgency="3"):
    """group: assignment group name (e.g. "W INCLV3 DXCIT-COHESITY") or a 32-char sys_id."""
    if not configured():
        return {"status": "not_raised", "error": "ServiceNow is not configured (SERVICENOW_SECRET_ARN or SNOW_*)"}
    try:
        cfg = _load_config()
        base = cfg["instance_url"].rstrip("/")
        token = _get_token(cfg)
        existing = _get(base, token, "incident", {"sysparm_query": f"correlation_id={correlation_id}",
                                                  "sysparm_fields": "number,sys_id", "sysparm_limit": "1"})
        if existing:
            return {"status": "exists", "number": existing[0].get("number"),
                    "url": _url(base, existing[0].get("sys_id"))}
        group_id = _group_sys_id(base, token, group)
        if not group_id:
            return {"status": "not_raised", "error": f"Assignment group '{group}' not found in ServiceNow"}
        payload = {"assignment_group": group_id, "impact": str(impact), "urgency": str(urgency),
                   "correlation_id": correlation_id, "correlation_display": "EIT RunStack",
                   "short_description": short_description[:160], "description": description}
        if cfg.get("caller_sys_id"):
            payload["caller_id"] = cfg["caller_sys_id"]
        if DRY_RUN:
            logger.warning("SERVICENOW DRY RUN — incident NOT created. Would POST to "
                           f"{base}/api/now/table/incident: {json.dumps(payload)}")
            return {"status": "dry_run"}
        status, body = _http("POST", f"{base}/api/now/table/incident", _headers(token),
                             json.dumps(payload).encode())
        if status not in (200, 201):
            return {"status": "not_raised", "error": f"create incident failed: HTTP {status} {str(body)[:300]}"}
        created = body.get("result") or {}
        return {"status": "created", "number": created.get("number"), "url": _url(base, created.get("sys_id"))}
    except Exception as e:
        logger.error(f"servicenow: incident {correlation_id} not raised: {e}")
        return {"status": "not_raised", "error": str(e)[:300]}


def _group_sys_id(base, token, group):
    group = str(group or "").strip()
    if re.fullmatch(r"[0-9a-f]{32}", group):
        return group
    if group not in _groups:
        rows = _get(base, token, "sys_user_group", {"sysparm_query": f"name={group}",
                                                    "sysparm_fields": "sys_id,name", "sysparm_limit": "2"})
        _groups[group] = rows[0]["sys_id"] if len(rows) == 1 else None
    return _groups[group]


def _url(base, sys_id):
    return f"{base}/nav_to.do?uri=incident.do%3Fsys_id%3D{sys_id}" if sys_id else None


def _load_config():
    global _config
    if _config is None:
        if ENV_CONFIG["client_secret"]:
            cfg = {k: v for k, v in ENV_CONFIG.items() if v}
        else:
            raw = boto3.client("secretsmanager").get_secret_value(SecretId=SECRET_ARN)["SecretString"]
            cfg = json.loads(raw)
        missing = [k for k in ("instance_url", "client_id", "client_secret", "username", "password") if not cfg.get(k)]
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