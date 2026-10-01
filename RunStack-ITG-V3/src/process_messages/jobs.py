"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code. No logic changes.
"""

from shared import *
from datetime import timedelta


def handle_jobs_dlq_list(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "operator")
    if denied:
        return denied
    try:
        sqs_client = boto3.client("sqs")
        dlq_url = os.environ.get("DLQ_URL")
        if not dlq_url:
            return {
                "statusCode": 500,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "DLQ_URL not configured"})
            }
        response = sqs_client.receive_message(
            QueueUrl=dlq_url,
            MaxNumberOfMessages=10,
            AttributeNames=["All"],
            MessageAttributeNames=["All"],
            VisibilityTimeout=30
        )
        messages = []
        for msg in response.get("Messages", []):
            body_raw = msg.get("Body", "{}")
            try:
                body_parsed = json.loads(body_raw)
            except Exception:
                body_parsed = body_raw
            messages.append({
                "id": msg["MessageId"],
                "receipt_handle": msg["ReceiptHandle"],
                "body": body_parsed,
                "body_raw": body_raw,
                "received": msg.get("Attributes", {}).get("ApproximateFirstReceiveTimestamp"),
                "receive_count": msg.get("Attributes", {}).get("ApproximateReceiveCount", "1"),
                "sent_at": msg.get("Attributes", {}).get("SentTimestamp"),
            })
        attrs_response = sqs_client.get_queue_attributes(
            QueueUrl=dlq_url,
            AttributeNames=["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"]
        )
        queue_attrs = attrs_response.get("Attributes", {})
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "messages": messages,
                "count": len(messages),
                "total_visible": queue_attrs.get("ApproximateNumberOfMessages", "0"),
                "total_in_flight": queue_attrs.get("ApproximateNumberOfMessagesNotVisible", "0"),
            }, default=decimal_default)
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── DELETE /jobs/dlq (delete/discard a DLQ message) ──────────

def handle_jobs_dlq_clear(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        body = json.loads(event.get("body", "{}"))
        receipt_handle = body.get("receipt_handle")
        if not receipt_handle:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "receipt_handle is required"})
            }
        sqs_client = boto3.client("sqs")
        dlq_url = os.environ.get("DLQ_URL")
        sqs_client.delete_message(
            QueueUrl=dlq_url,
            ReceiptHandle=receipt_handle
        )
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"status": "deleted"})
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── GET /jobs/latest ──────────────────────────────────────────

def handle_jobs_latest(event, http_method, path, path_parameters, query_params):
    filter_id           = query_params.get("id")
    filter_notification = query_params.get("notification_id")
    filter_resource     = query_params.get("resource_id")
    filter_account      = query_params.get("account_id")
    filter_region       = query_params.get("region")

    jobs = None
    try:
        import jobs_list
        if jobs_list.index_ready():
            # Truly newest 50 (the scan below only sorts the first 1 MB page).
            jobs = jobs_list.latest_full_items(50)
    except Exception as e:
        logger.error(f"latest via index failed, using scan: {e}")
        jobs = None
    if jobs is None:
        jobs = get_latest_jobs(limit=50)

    if filter_id:
        jobs = [j for j in jobs if j.get("job_id") == filter_id or j.get("notification_id") == filter_id]
    if filter_notification:
        jobs = [j for j in jobs if j.get("notification_id") == filter_notification]
    if filter_resource:
        jobs = [j for j in jobs if j.get("resource_id") == filter_resource]
    if filter_account:
        jobs = [j for j in jobs if j.get("account_id") == filter_account]
    if filter_region:
        jobs = [j for j in jobs if j.get("region") == filter_region]

    jobs = jobs[:1]

    return {
        "statusCode": 200,
        "headers": CORS_HEADERS,
        "body": json.dumps(
            {"count": len(jobs), "jobs": jobs},
            default=decimal_default
        )
    }

# ── GET /jobs/recent ──────────────────────────────────────────

def handle_jobs_recent(event, http_method, path, path_parameters, query_params):
    limit = int(query_params.get("limit", DEFAULT_LIMIT))
    status_filter = query_params.get("status")
    last_key_str = query_params.get("last_key")

    if limit < 10 or limit > 100:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Limit must be between 10 and 100"})
        }

    valid_statuses = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "TIMED_OUT", "COMPLETED"]
    if status_filter and status_filter not in valid_statuses:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "error": f"Invalid status. Must be one of: {', '.join(valid_statuses)}"
            })
        }

    last_evaluated_key = None
    if last_key_str:
        try:
            import base64
            last_evaluated_key = json.loads(base64.b64decode(last_key_str).decode('utf-8'))
        except Exception:
            pass

    result = get_recent_jobs(limit, last_evaluated_key, status_filter)
    # Mask secrets (e.g. DR SqlPassword) before they leave the API.
    result["jobs"] = [redact_job(j) for j in result.get("jobs", [])]
    result["items"] = result["jobs"]

    if "last_evaluated_key" in result:
        import base64
        result["last_key"] = base64.b64encode(
            json.dumps(result["last_evaluated_key"]).encode('utf-8')
        ).decode('utf-8')

    return {
        "statusCode": 200,
        "headers": CORS_HEADERS,
        "body": json.dumps(result, default=decimal_default)
    }

# ── GET /jobs/{jobId} ─────────────────────────────────────────

def handle_job_detail(event, http_method, path, path_parameters, query_params):
    job_id = path_parameters["jobId"]
    job = get_job_by_id(job_id)

    if job is None:
        return {
            "statusCode": 404,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": f"Job {job_id} not found"})
        }

    qualys_installed = "UNKNOWN"
    qualys_status = "UNKNOWN"
    raw_output = job.get("qualys_output", "")
    for line in raw_output.splitlines():
        line = line.strip()
        if line.startswith("QUALYS_INSTALLED="):
            qualys_installed = line.split("=", 1)[1]
        elif line.startswith("QUALYS_STATUS="):
            qualys_status = line.split("=", 1)[1]

    exit_code = job.get("exit_code")
    if exit_code == -1 or exit_code is None:
        script_result = None
    elif exit_code == 0:
        script_result = "PASSED"
    else:
        script_result = "FAILED"

    return {
        "statusCode": 200,
        "headers": CORS_HEADERS,
        "body": json.dumps({
            "job_id": job["job_id"],
            "status": job["status"],
            "resource_id": job.get("resource_id"),
            "notification_id": job.get("notification_id"),
            "account_id": job.get("account_id"),
            "region": job.get("region"),
            "automation_type": job.get("automation_type"),
            "automation_data": redact_automation_data(job.get("automation_data")),
            "execution_id": job.get("execution_id"),
            "created_at": job.get("created_at"),
            "updated_at": job.get("updated_at"),
            "ec2_state": job.get("ec2_state"),
            "exit_code": exit_code,
            "script_result": script_result,
            "output": raw_output,
            # Added for the Automation Executions detail panel. Additive
            # only — existing fields and their meaning are unchanged.
            "stderr_output": job.get("stderr_output", ""),
            "automation_label": automation_label(job),
            "document_name": document_short_name(job),
            "server_name": job.get("server_name"),
            "app_name": job.get("app_name"),
            "app_id": job.get("app_id"),
            "environment": job.get("environment"),
            "os": job.get("OS"),
            "problem_id": job.get("problem_id"),
            "automation_name": job.get("automation_name"),
            "result": {
                "qualys_installed": qualys_installed,
                "qualys_status": qualys_status
            }
        }, default=decimal_default)
    }

# ── GET /auth/callback — Cognito OAuth2 code exchange ────────


# ════════════════════════════════════════════════════════════════════════
# Automation Executions support: labels, redaction, dataset-wide query
# ════════════════════════════════════════════════════════════════════════
#
# Why a new endpoint instead of /jobs/recent:
#   /jobs/recent is a DynamoDB Scan with Limit=N. A Scan returns items in
#   hash-key order, not by time, so its "50 most recent" are really 50
#   arbitrary jobs sorted among themselves, and any count derived from them
#   describes those 50 rows only. The jobs table has no index on status or
#   created_at, so accurate newest-first ordering, totals and filtering
#   need every item. /jobs/query reads the whole table once (small
#   projection, paginated, cached ~15s per warm Lambda), then filters,
#   counts, sorts and pages in memory. /jobs/recent is unchanged for the
#   Dashboard and AQS agents.
#
#   Scale guard: JOBS_QUERY_MAX_SCAN_ITEMS (default 20000). Past that the
#   response says scan_truncated=true and the UI labels counts as partial.
#   Long term, a GSI keyed on a date bucket + created_at would remove the
#   full scan (see notes delivered with this change).

_SENSITIVE_PARAM = ("password", "passwd", "secret", "token", "apikey", "api_key",
                    "credential", "privatekey", "private_key", "accesskey", "access_key")
REDACTED = "••••••••"


def _is_sensitive(key: str) -> bool:
    k = str(key).lower().replace("-", "").replace("_", "")
    return any(s.replace("_", "") in k for s in _SENSITIVE_PARAM)


def redact_automation_data(automation_data):
    """Copy of automation_data with sensitive parameter values masked.
    DR switchover jobs store SqlPassword here (see create_ssm_document_job),
    so nothing that returns a job record should pass it through."""
    if not isinstance(automation_data, dict):
        return automation_data
    out = dict(automation_data)
    params = out.get("Parameters")
    if isinstance(params, dict):
        out["Parameters"] = {k: (REDACTED if _is_sensitive(k) else v) for k, v in params.items()}
    return out


def redact_job(job: dict) -> dict:
    if not isinstance(job, dict) or "automation_data" not in job:
        return job
    return {**job, "automation_data": redact_automation_data(job.get("automation_data"))}


# Friendly names for documents RunStack itself uses. Anything else gets a
# label derived from the document name (never invented).
_KNOWN_AUTOMATIONS = {
    "runstack-dr-status-check": "DR Status Check",
    "runstack-dr-failover": "DR Switchover",
    "sql-database-healthcheck": "SQL Database Health Check",
    "aws-stopec2instance": "Stop EC2 Instance",
    "aws-startec2instance": "Start EC2 Instance",
    "aws-restartec2instance": "Restart EC2 Instance",
    "aws-runshellscript": "Run Shell Script",
    "aws-runpowershellscript": "Run PowerShell Script",
    "aws-runremotescript": "Run Remote Script",
}
_ACRONYMS = {"ec2": "EC2", "sql": "SQL", "ssm": "SSM", "dr": "DR", "sap": "SAP", "aws": "AWS",
             "db": "DB", "os": "OS", "id": "ID", "ha": "HA", "api": "API", "dns": "DNS", "iis": "IIS"}


def document_short_name(job: dict) -> str:
    doc = str(((job.get("automation_data") or {}).get("DocumentName")) or "")
    return doc.split(":document/", 1)[1] if ":document/" in doc else doc


def automation_name_key(job: dict):
    """Normalised automation_name (top-level, or inside automation_data for
    older scheduled jobs) — what the "Automation name" filter matches.
    Must match job_stats.automation_name_of()."""
    name = job.get("automation_name_key") or job.get("automation_name") or (job.get("automation_data") or {}).get("automation_name")
    name = " ".join(str(name).split()) if name else ""
    return name[:200] or None


def automation_label(job: dict) -> str:
    if job.get("automation_type") == "EC2-Action":
        return "EC2 Status Check"
    name = document_short_name(job)
    if not name:
        return job.get("automation_type") or "Unknown automation"
    known = _KNOWN_AUTOMATIONS.get(name.lower())
    if known:
        return known
    import re as _re
    base = _re.sub(r"^(AWS|RunStack)[-_]", "", name, flags=_re.I)
    base = _re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", base)
    words = [w for w in _re.split(r"[-_\s]+", base) if w]
    return " ".join(_ACRONYMS.get(w.lower(), w[:1].upper() + w[1:]) for w in words) or name


def status_group(status: str) -> str:
    s = (status or "").upper()
    if s in ("COMPLETED", "SUCCEEDED", "SUCCESS"):
        return "COMPLETED"
    if s in ("FAILED", "TIMED_OUT", "CANCELLED", "CANCELED", "ERROR"):
        return "FAILED"
    if s == "RUNNING" or s == "IN_PROGRESS":
        return "RUNNING"
    return "PENDING"


_JOBS_QUERY_CACHE = {"items": None, "fetched": 0.0, "truncated": False}
JOBS_QUERY_CACHE_SECONDS = int(os.getenv("JOBS_QUERY_CACHE_SECONDS", "15"))
JOBS_QUERY_MAX_SCAN_ITEMS = int(os.getenv("JOBS_QUERY_MAX_SCAN_ITEMS", "20000"))

# Only what the list needs — excludes command output and Parameters, so no
# secrets and far less data per item. (RCU cost still follows item size.)
_LIST_ATTRS = ["job_id", "notification_id", "account_id", "region", "resource_id",
               "automation_type", "status", "execution_id", "created_at", "updated_at",
               "server_name", "app_name", "app_id", "environment", "automation_name",
               "problem_id", "exit_code", "ec2_state",
               # run grouping (Automation Executions shows one row per run)
               "execution_group_id", "execution_group_label", "initiated_by"]


def _scan_all_jobs(force: bool = False):
    now = time.time()
    cache = _JOBS_QUERY_CACHE
    if not force and cache["items"] is not None and now - cache["fetched"] < JOBS_QUERY_CACHE_SECONDS:
        return cache["items"], cache["truncated"], cache["fetched"]
    table = get_dynamodb_table()
    names = {f"#a{i}": a for i, a in enumerate(_LIST_ATTRS)}
    names["#ad"] = "automation_data"
    names["#dn"] = "DocumentName"
    names["#an"] = "automation_name"
    names["#nk"] = "automation_name_key"
    projection = ", ".join(list(names.keys())[:len(_LIST_ATTRS)]) + ", #ad.#dn, #ad.#an, #nk"
    kwargs = {"ProjectionExpression": projection, "ExpressionAttributeNames": names}
    items, truncated = [], False
    while True:
        resp = table.scan(**kwargs)
        items.extend(resp.get("Items", []))
        if "LastEvaluatedKey" not in resp:
            break
        if len(items) >= JOBS_QUERY_MAX_SCAN_ITEMS:
            truncated = True
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    for j in items:
        j["automation_label"] = automation_label(j)
        j["document_name"] = document_short_name(j)
        j["status_group"] = status_group(j.get("status"))
        j["automation_name_key"] = automation_name_key(j)
    cache.update(items=items, fetched=now, truncated=truncated)
    return items, truncated, now


def _iso_to_naive_utc(value: str):
    """created_at is stored as naive UTC ISO (no 'Z'). Accept either form."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        from datetime import timezone as _tz
        dt = dt.astimezone(_tz.utc).replace(tzinfo=None)
    return dt.isoformat()


def _duration_seconds(job: dict):
    if job.get("status_group") not in ("COMPLETED", "FAILED"):
        return None
    try:
        a = datetime.fromisoformat(str(job.get("created_at")).replace("Z", ""))
        b = datetime.fromisoformat(str(job.get("updated_at")).replace("Z", ""))
        return max(0.0, (b - a).total_seconds())
    except (TypeError, ValueError):
        return None


_SEARCH_FIELDS = ("job_id", "notification_id", "resource_id", "server_name", "app_name",
                  "account_id", "execution_id", "automation_label", "document_name", "automation_name")
_QUERY_STATUS = {"ALL", "ACTIVE", "RUNNING", "PENDING", "COMPLETED", "FAILED"}
_QUERY_SORTS = {"started_desc", "started_asc", "duration_desc"}


def _bad(msg):
    return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps({"error": msg})}


# ── GET /jobs/query ───────────────────────────────────────────
# Query params (all optional):
#   status   ALL | ACTIVE (pending+running) | RUNNING | PENDING | COMPLETED | FAILED
#   from,to  ISO timestamps (UTC) on created_at
#   automation (label), account, environment, region  — exact match
#   q        case-insensitive substring over _SEARCH_FIELDS
#   sort     started_desc (default) | started_asc | duration_desc
#   limit    1–500 (default 50), offset (default 0)
#   as_of    ISO; only jobs created at/before it are paged, so rows don't
#            shift while someone reads/loads more. Newer ones are counted
#            in new_since_as_of instead.
#   refresh  "true" to bypass the short cache (manual Refresh button)
def handle_jobs_query(event, http_method, path, path_parameters, query_params):
    qp = query_params or {}
    view = qp.get("view") or "rows"
    if view not in ("rows", "summary", "recent"):
        return _bad("view must be rows, summary or recent")
    # group=runs (Automation Executions): one row per run. Runs are built
    # from the full matching set, which only the scan path has, so the
    # counter/index path is not used for grouped row queries.
    grouped_rows = view == "rows" and qp.get("group") == "runs"
    try:
        import jobs_list
        if not grouped_rows and jobs_list.index_ready():
            return _indexed_query(jobs_list, view, qp)
    except Exception as e:
        logger.error(f"Indexed jobs query failed, falling back to scan: {e}")
    if view == "summary":
        return _scan_summary(qp)
    if view == "recent":
        return _scan_recent(qp)
    return _scan_rows(qp)


def _ok(body):
    return {"statusCode": 200, "headers": CORS_HEADERS, "body": json.dumps(body, default=decimal_default)}


def _list_row(j):
    j = dict(j)
    j.setdefault("automation_label", automation_label(j))
    j.setdefault("document_name", document_short_name(j))
    j["status_group"] = status_group(j.get("status"))
    # Older scheduled jobs carry automation_name inside automation_data
    # (the schedule's payload template); show it like a top-level one.
    if not j.get("automation_name"):
        nested = (j.get("automation_data") or {}).get("automation_name") or j.get("automation_name_key")
        if nested:
            j["automation_name"] = nested
    j.pop("automation_name_key", None)
    j.pop("search_text", None)
    j.pop("automation_data", None)
    return j


def _filters(qp):
    """Validated filters shared by the index and scan paths, or an error."""
    status = (qp.get("status") or "ALL").upper()
    if status not in _QUERY_STATUS:
        return None, f"status must be one of {sorted(_QUERY_STATUS)}"
    date_from = _iso_to_naive_utc(qp.get("from"))
    date_to = _iso_to_naive_utc(qp.get("to"))
    if any(qp.get(k) and v is None for k, v in (("from", date_from), ("to", date_to))):
        return None, "from and to must be ISO-8601 timestamps"
    return {"status": status, "from": date_from, "to": date_to, "sort": qp.get("sort") or "started_desc",
            "automation": qp.get("automation") or None, "name": (" ".join((qp.get("name") or "").split()) or None),
            "account": qp.get("account") or None,
            "environment": qp.get("environment") or None, "region": qp.get("region") or None,
            "q": (qp.get("q") or "").strip().lower() or None}, None


def _indexed_query(jl, view, qp):
    if view == "summary":
        rng = qp.get("range") or "24h"
        if rng not in jl.RANGES:
            return _bad(f"range must be one of {list(jl.RANGES)}")
        return _ok(jl.summary(rng))
    if view == "recent":
        try:
            limit = int(qp.get("limit", 10))
        except ValueError:
            return _bad("limit must be an integer")
        if not 1 <= limit <= 25:
            return _bad("limit must be 1–25 for view=recent")
        rows = [_list_row(j) for j in jl.recent(limit)]
        return _ok({"view": "recent", "jobs": rows, "returned": len(rows),
                    "total_in_table": jl.total_in_table(), "generated_at": datetime.utcnow().isoformat() + "Z"})
    f, err = _filters(qp)
    if err:
        return _bad(err)
    if f["sort"] not in ("started_desc", "started_asc"):
        return _bad("sort must be started_desc or started_asc")
    try:
        limit = int(qp.get("limit", 50))
    except ValueError:
        return _bad("limit must be an integer")
    if not 1 <= limit <= 100:
        return _bad("limit must be 1–100")
    cursor = qp.get("cursor") or None
    try:
        rows, next_cursor = jl.page(f, limit, cursor)
    except (ValueError, KeyError) as e:
        return _bad(f"invalid cursor: {e}")
    body = {"view": "rows", "jobs": [_list_row(j) for j in rows], "limit": limit, "returned": len(rows),
            "has_more": bool(next_cursor), "next_cursor": next_cursor, "sort": f["sort"],
            "generated_at": datetime.utcnow().isoformat() + "Z"}
    if qp.get("include_counts", "true") != "false":
        c, source, complete = jl.counts(f, force=qp.get("refresh") == "true")
        body.update(status_counts=c, total_matching=c.get(f["status"], 0), count_source=source,
                    counts_complete=complete, total_in_table=jl.total_in_table())
    if qp.get("include_facets") == "true":
        body["facets"] = jl.facets()
    return _ok(body)


# ── Scan fallback (before the job_stats backfill has run) ─────────────────────

def _scan_summary(qp):
    import jobs_list as jl
    rng = qp.get("range") or "24h"
    if rng not in jl.RANGES:
        return _bad(f"range must be one of {list(jl.RANGES)}")
    spec = jl.RANGES[rng]
    items, truncated, fetched = _scan_all_jobs(force=qp.get("refresh") == "true")
    now = datetime.utcnow()
    if spec["bucket"] == "D":
        today = now.replace(hour=0, minute=0, second=0, microsecond=0)
        start, step, n = today - timedelta(days=spec["days"] - 1), timedelta(days=1), spec["days"]
    else:
        hour_end = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        start, step, n = hour_end - timedelta(hours=spec["hours"]), timedelta(hours=spec["bucket"]), spec["hours"] // spec["bucket"]
    buckets = [{"start": start + i * step, "end": start + (i + 1) * step, **{g: 0 for g in jl.GROUPS}} for i in range(n)]
    all_time = {g: 0 for g in jl.GROUPS}
    durs = []
    lo, hi = start.isoformat(), (start + n * step).isoformat()
    for j in items:
        all_time[j["status_group"]] += 1
        created = _iso_to_naive_utc(j.get("created_at"))
        if not created or not lo <= created < hi:
            continue
        idx = int((datetime.fromisoformat(created) - start) / step)
        buckets[idx][j["status_group"]] += 1
        if j["status_group"] == "COMPLETED":
            d = _duration_seconds(j)
            if d is not None:
                durs.append(d)
    totals = {g: sum(b[g] for b in buckets) for g in jl.GROUPS}
    finished = totals["COMPLETED"] + totals["FAILED"]
    return _ok({
        "view": "summary", "range": rng, "range_label": spec["label"], "from": lo + "Z", "to": hi + "Z",
        "bucket": "day" if spec["bucket"] == "D" else f"{spec['bucket']}h",
        "totals": {**totals, "ALL": sum(totals.values())},
        "success_rate": round(100.0 * totals["COMPLETED"] / finished, 1) if finished else None,
        "avg_duration_seconds": round(sum(durs) / len(durs), 1) if durs else None, "avg_duration_sample": len(durs),
        "active_now": {"RUNNING": all_time["RUNNING"], "PENDING": all_time["PENDING"]},
        "all_time": {**all_time, "ALL": len(items), "ACTIVE": all_time["RUNNING"] + all_time["PENDING"]},
        "buckets": [{**b, "start": b["start"].isoformat() + "Z", "end": b["end"].isoformat() + "Z",
                     "total": sum(b[g] for g in jl.GROUPS)} for b in buckets],
        "count_source": "scan", "complete": not truncated,
        "generated_at": datetime.utcfromtimestamp(fetched).isoformat() + "Z",
    })


def _scan_recent(qp):
    try:
        limit = int(qp.get("limit", 10))
    except ValueError:
        return _bad("limit must be an integer")
    if not 1 <= limit <= 25:
        return _bad("limit must be 1–25 for view=recent")
    items, truncated, fetched = _scan_all_jobs(force=qp.get("refresh") == "true")
    rows = sorted(items, key=lambda j: str(j.get("created_at", "")), reverse=True)[:limit]
    return _ok({"view": "recent", "jobs": [_list_row(j) for j in rows], "returned": len(rows),
                "total_in_table": len(items), "count_source": "scan", "complete": not truncated,
                "generated_at": datetime.utcfromtimestamp(fetched).isoformat() + "Z"})


def _scan_rows(qp):
    """Original scan implementation. Accepts the new `cursor` (an encoded
    offset) as well as `offset`, so the new UI works before the backfill."""
    qp = dict(qp)
    if qp.get("cursor"):
        try:
            import jobs_list as jl
            qp["offset"] = str(int(jl.decode_cursor(qp["cursor"]).get("o", 0)))
        except Exception:
            return _bad("invalid cursor")
    res = _legacy_query(qp)
    if res.get("statusCode") == 200:
        import jobs_list as jl
        body = json.loads(res["body"])
        nxt = body["offset"] + body["returned"]
        body.update(view="rows", next_cursor=jl.encode_cursor({"o": nxt}) if body["has_more"] else None,
                    count_source="scan", counts_complete=not body.get("scan_truncated"))
        body["jobs"] = [_list_row(j) for j in body["jobs"]]
        res["body"] = json.dumps(body, default=decimal_default)
    return res


def _run_status(c):
    """Run-level status group from its servers' status groups.
    Still active → RUNNING (or PENDING if nothing has started or finished);
    finished → COMPLETED only when every server completed, else FAILED."""
    if c["PENDING"] or c["RUNNING"]:
        return "RUNNING" if (c["RUNNING"] or c["COMPLETED"] or c["FAILED"]) else "PENDING"
    return "FAILED" if c["FAILED"] else "COMPLETED"


def _only(members, key):
    """The single value every member shares, else None; and how many distinct."""
    vals = {str(m.get(key)) for m in members if m.get(key) not in (None, "")}
    return (next(iter(vals)) if len(vals) == 1 else None), len(vals)


def _run_row(group_id, members):
    members = sorted(members, key=lambda m: (str(m.get("created_at", "")), str(m.get("job_id", ""))))
    rep = members[0]
    c = {"PENDING": 0, "RUNNING": 0, "COMPLETED": 0, "FAILED": 0}
    for m in members:
        c[m["status_group"]] += 1
    group = _run_status(c)
    row = {
        "is_run": True,
        "job_id": rep.get("job_id"),          # opening the run opens Execution Details via this job
        "execution_group_id": group_id,
        "execution_group_label": rep.get("execution_group_label"),
        "automation_label": rep.get("automation_label"),
        "document_name": rep.get("document_name"),
        "automation_name": rep.get("automation_name") or rep.get("execution_group_label"),
        "automation_name_key": rep.get("automation_name_key"),
        "automation_type": rep.get("automation_type"),
        "initiated_by": rep.get("initiated_by"),
        "status": group,
        "status_group": group,
        "run_outcome": "partial" if group == "FAILED" and c["COMPLETED"] else None,
        "server_count": len(members),
        "run_counts": c,
        "created_at": rep.get("created_at"),
        "updated_at": max((str(m.get("updated_at") or "") for m in members), default=None) or None,
    }
    for key, plural in (("account_id", "account_count"), ("region", "region_count"),
                        ("environment", "environment_count"), ("app_name", "app_count")):
        row[key], row[plural] = _only(members, key)
    if len(members) == 1:
        row.update(server_name=rep.get("server_name"), resource_id=rep.get("resource_id"))
    return row


def _collapse_runs(matching_jobs, snapshot):
    """Jobs → list units: each grouped run becomes one row (once, at its
    first matching job); jobs without a group stay as they are."""
    by_group = {}
    for j in snapshot:
        gid = j.get("execution_group_id")
        if gid:
            by_group.setdefault(gid, []).append(j)
    units, seen = [], set()
    for j in matching_jobs:
        gid = j.get("execution_group_id")
        if not gid:
            units.append(j)
        elif gid not in seen:
            seen.add(gid)
            units.append(_run_row(gid, by_group.get(gid) or [j]))
    return units


def _legacy_query(qp):
    try:
        status = (qp.get("status") or "ALL").upper()
        sort = qp.get("sort") or "started_desc"
        if status not in _QUERY_STATUS:
            return _bad(f"status must be one of {sorted(_QUERY_STATUS)}")
        if sort not in _QUERY_SORTS:
            return _bad(f"sort must be one of {sorted(_QUERY_SORTS)}")
        try:
            limit = int(qp.get("limit", 50))
            offset = int(qp.get("offset", 0))
        except ValueError:
            return _bad("limit and offset must be integers")
        if not 1 <= limit <= 500 or offset < 0:
            return _bad("limit must be 1–500 and offset >= 0")
        date_from = _iso_to_naive_utc(qp.get("from"))
        date_to = _iso_to_naive_utc(qp.get("to"))
        as_of = _iso_to_naive_utc(qp.get("as_of"))
        if any(qp.get(k) and v is None for k, v in (("from", date_from), ("to", date_to), ("as_of", as_of))):
            return _bad("from, to and as_of must be ISO-8601 timestamps")

        items, truncated, fetched = _scan_all_jobs(force=qp.get("refresh") == "true")
        new_since = sum(1 for j in items if as_of and str(j.get("created_at", "")) > as_of)
        snapshot = [j for j in items if not as_of or str(j.get("created_at", "")) <= as_of]

        automation = qp.get("automation")
        name_filter = " ".join((qp.get("name") or "").split()) or None
        account = qp.get("account")
        environment = qp.get("environment")
        region = qp.get("region")
        q = (qp.get("q") or "").strip().lower()

        def matches_non_status(j):
            created = str(j.get("created_at", ""))
            if date_from and created < date_from:
                return False
            if date_to and created > date_to:
                return False
            if automation and j.get("automation_label") != automation:
                return False
            if name_filter and j.get("automation_name_key") != name_filter:
                return False
            if account and str(j.get("account_id", "")) != account:
                return False
            if environment and str(j.get("environment", "")) != environment:
                return False
            if region and str(j.get("region", "")) != region:
                return False
            if q and not any(q in str(j.get(f, "") or "").lower() for f in _SEARCH_FIELDS):
                return False
            return True

        base = [j for j in snapshot if matches_non_status(j)]
        jobs_matching = len(base)
        grouped = qp.get("group") == "runs"
        if grouped:
            # A run is listed when any of its servers matches the filters;
            # its row summarises ALL of its servers (from the snapshot).
            base = _collapse_runs(base, snapshot)
        counts = {"ALL": len(base), "PENDING": 0, "RUNNING": 0, "COMPLETED": 0, "FAILED": 0}
        for j in base:
            counts[j["status_group"]] += 1
        counts["ACTIVE"] = counts["PENDING"] + counts["RUNNING"]

        if status == "ALL":
            matching = base
        elif status == "ACTIVE":
            matching = [j for j in base if j["status_group"] in ("PENDING", "RUNNING")]
        else:
            matching = [j for j in base if j["status_group"] == status]

        if sort == "duration_desc":
            matching = sorted(matching, key=lambda j: (_duration_seconds(j) is not None, _duration_seconds(j) or 0,
                                                       str(j.get("created_at", ""))), reverse=True)
        else:
            matching = sorted(matching, key=lambda j: (str(j.get("created_at", "")), str(j.get("job_id", ""))),
                              reverse=(sort == "started_desc"))

        # Filter choices come from the whole snapshot (not the filtered set)
        # so picking one value never hides the others.
        def facet(key):
            seen = {}
            for j in snapshot:
                v = j.get(key)
                if v not in (None, ""):
                    seen[str(v)] = seen.get(str(v), 0) + 1
            return [{"value": k, "count": c} for k, c in sorted(seen.items())]

        page = matching[offset:offset + limit]
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "jobs": page,
                "offset": offset,
                "limit": limit,
                "returned": len(page),
                "total_matching": len(matching),
                "has_more": offset + len(page) < len(matching),
                "status_counts": counts,
                "total_in_table": len(items),
                "new_since_as_of": new_since,
                "as_of": as_of or max((str(j.get("created_at", "")) for j in items), default=None),
                "facets": {
                    "automations": facet("automation_label"),
                    "names": facet("automation_name_key"),
                    "accounts": facet("account_id"),
                    "environments": facet("environment"),
                    "regions": facet("region"),
                },
                "grouped": grouped,
                "jobs_matching": jobs_matching,
                "scan_truncated": truncated,
                "max_scan_items": JOBS_QUERY_MAX_SCAN_ITEMS,
                "data_as_of": datetime.utcfromtimestamp(fetched).isoformat() + "Z",
            }, default=decimal_default),
        }
    except Exception as e:
        logger.error(f"Error querying jobs: {e}")
        return {"statusCode": 500, "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Failed to query jobs", "detail": str(e)})}
