"""
Job statistics — keeps exact execution counts and list fields up to date.

Triggered by the runstack-jobs-table DynamoDB stream (a second consumer next
to process_jobs, which only acts on INSERT and is unaffected by the
MODIFY events this function causes).

For every job insert / status change / delete it:

1. Writes list fields back onto the job item when they are missing or out
   of date:
     list_month        "YYYY-MM" from created_at — partition key of the
                       list-month-created-index GSI (sort key created_at),
                       which gives newest-first paging without a scan
     automation_label  friendly automation name (same rules as jobs.py)
     document_name     short SSM document name
     search_text       lower-case text the Executions search matches on
   Only changed values are written, so the MODIFY event that write causes
   is a no-op the second time round (no loop).

2. Maintains counters in runstack-job-stats, exactly once per job state:
     (TOTAL, ALL)            all jobs by current status group
     (HOUR, YYYY-MM-DDTHH)   jobs CREATED in that hour, by current status
     (DAY,  YYYY-MM-DD)      jobs created that day, by current status
     (FACET, account#… / automation#… / environment#… / region#…)
                             job count per filter value (for filter lists)
   Status groups: PENDING, RUNNING, COMPLETED, FAILED (same as jobs.py).
   Each job has a marker item (JOB#<job_id>, M) holding the group it is
   currently counted under. A change moves the job from its old group to
   its new one in ONE transaction that is conditional on the marker still
   holding the old group — so a PENDING → RUNNING → COMPLETED job is always
   counted once, and a stream record delivered twice (streams are
   at-least-once) changes nothing the second time.

Manual actions (aws lambda invoke --payload '{"action": …}'):
   backfill   process every existing job (safe to re-run, resumable with
              the returned start_key); run once after deploying
   verify     recount from the jobs table and report any difference
"""

import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.types import TypeDeserializer
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

JOBS_TABLE = os.getenv("DYNAMODB_TABLE_NAME", "runstack-jobs-table")
STATS_TABLE = os.getenv("JOB_STATS_TABLE", "runstack-job-stats")
GROUPS = ("PENDING", "RUNNING", "COMPLETED", "FAILED")

_ddb = None
_client = None
_deser = TypeDeserializer()


def _resource():
    global _ddb
    if _ddb is None:
        _ddb = boto3.resource("dynamodb")
    return _ddb


def _dynamo():
    global _client
    if _client is None:
        _client = boto3.client("dynamodb")
    return _client


# ── Derived fields (keep in step with process_messages/jobs.py) ──────────────

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
SEARCH_FIELDS = ("job_id", "notification_id", "resource_id", "server_name", "app_name", "account_id",
                 "execution_id", "automation_label", "document_name", "automation_name", "region", "environment")


def status_group(status):
    s = str(status or "").upper()
    if s in ("COMPLETED", "SUCCEEDED", "SUCCESS"):
        return "COMPLETED"
    if s in ("FAILED", "TIMED_OUT", "CANCELLED", "CANCELED", "ERROR"):
        return "FAILED"
    if s in ("RUNNING", "IN_PROGRESS"):
        return "RUNNING"
    return "PENDING"


def document_short_name(job):
    doc = str(((job.get("automation_data") or {}).get("DocumentName")) or "")
    return doc.split(":document/", 1)[1] if ":document/" in doc else doc


def automation_label(job):
    if job.get("automation_type") == "EC2-Action":
        return "EC2 Status Check"
    name = document_short_name(job)
    if not name:
        return job.get("record_type") or job.get("automation_type") or "Unknown automation"
    known = _KNOWN_AUTOMATIONS.get(name.lower())
    if known:
        return known
    base = re.sub(r"^(AWS|RunStack)[-_]", "", name, flags=re.I)
    base = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", base)
    words = [w for w in re.split(r"[-_\s]+", base) if w]
    return " ".join(_ACRONYMS.get(w.lower(), w[:1].upper() + w[1:]) for w in words) or name


def utc_created(value):
    """created_at is naive UTC ISO; accept Z/offset forms too. Returns
    'YYYY-MM-DDTHH:MM:SS…' naive UTC or None."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.isoformat()


def list_fields(job):
    created = utc_created(job.get("created_at"))
    if not created:
        return {}
    label = automation_label(job)
    doc = document_short_name(job)
    probe = {**job, "automation_label": label, "document_name": doc}
    text = " | ".join(str(probe.get(f) or "") for f in SEARCH_FIELDS if probe.get(f)).lower()[:2000]
    return {"list_month": created[:7], "automation_label": label, "document_name": doc, "search_text": text}


FACET_FIELDS = (("account", "account_id"), ("environment", "environment"), ("region", "region"))


def facet_keys(job, label=None):
    """Filter values this job contributes to: 'account#…', 'automation#…',
    'environment#…', 'region#…'. Counted once per job, never moved."""
    keys = [f"{name}#{job.get(field)}" for name, field in FACET_FIELDS if job.get(field) not in (None, "")]
    label = label or automation_label(job)
    if label:
        keys.insert(1, f"automation#{label}")
    return keys


def duration_seconds(job):
    try:
        a = datetime.fromisoformat(str(job.get("created_at")).replace("Z", ""))
        b = datetime.fromisoformat(str(job.get("updated_at")).replace("Z", ""))
        return max(0, int((b - a).total_seconds()))
    except (TypeError, ValueError):
        return None


# ── Write list fields back ───────────────────────────────────────────────────

def write_list_fields(job):
    fields = list_fields(job)
    changed = {k: v for k, v in fields.items() if job.get(k) != v}
    if not changed:
        return False
    names = {f"#f{i}": k for i, k in enumerate(changed)}
    values = {f":v{i}": v for i, v in enumerate(changed.values())}
    try:
        _resource().Table(JOBS_TABLE).update_item(
            Key={"job_id": job["job_id"]},
            UpdateExpression="SET " + ", ".join(f"#f{i} = :v{i}" for i in range(len(changed))),
            ConditionExpression="attribute_exists(job_id)",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False  # job deleted meanwhile
        raise


# ── Exactly-once counters ────────────────────────────────────────────────────

def _counter_update(pk, sk, deltas):
    """TransactWriteItems Update that ADDs the given deltas (skips zeros)."""
    deltas = {k: v for k, v in deltas.items() if v}
    if not deltas:
        return None
    names = {f"#c{i}": k for i, k in enumerate(deltas)}
    values = {f":c{i}": {"N": str(v)} for i, v in enumerate(deltas.values())}
    return {"Update": {
        "TableName": STATS_TABLE,
        "Key": {"pk": {"S": pk}, "sk": {"S": sk}},
        "UpdateExpression": "ADD " + ", ".join(f"#c{i} :c{i}" for i in range(len(deltas))),
        "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": values,
    }}


def apply_job_state(job, removed=False):
    """Count `job` under its current status group exactly once. Returns
    'unchanged' | 'counted' | 'moved' | 'removed'."""
    job_id = job.get("job_id")
    created = utc_created(job.get("created_at"))
    if not job_id or not created:
        return "skipped"
    new_group = None if removed else status_group(job.get("status"))
    new_dur = duration_seconds(job) if new_group == "COMPLETED" else None
    hour, day = created[:13], created[:10]
    account = str(job.get("account_id") or "")
    label = job.get("automation_label") or automation_label(job)
    facets = facet_keys(job, label)
    stats = _resource().Table(STATS_TABLE)
    marker_key = {"pk": f"JOB#{job_id}", "sk": "M"}

    for attempt in range(6):
        marker = stats.get_item(Key=marker_key, ConsistentRead=True).get("Item")
        old_group = marker.get("group") if marker else None
        if old_group == new_group:
            return "unchanged"
        # Counts are keyed by the hour/day the marker recorded (created_at
        # never changes, but using the marker keeps removal symmetric).
        m_hour = marker.get("hour", hour) if marker else hour
        m_day = marker.get("day", day) if marker else day
        old_dur = int(marker["dur"]) if marker and marker.get("dur") is not None else None

        deltas = {}
        if old_group:
            deltas[old_group] = -1
        if new_group:
            deltas[new_group] = deltas.get(new_group, 0) + 1
        if old_group is None:
            deltas["total"] = 1
        if new_group is None:
            deltas["total"] = -1
        if old_group == "COMPLETED" and old_dur is not None:
            deltas["dur_sum"] = -old_dur
            deltas["dur_n"] = -1
        if new_group == "COMPLETED" and new_dur is not None:
            deltas["dur_sum"] = deltas.get("dur_sum", 0) + new_dur
            deltas["dur_n"] = deltas.get("dur_n", 0) + 1

        ops = []
        cond_values = {":g": {"S": old_group}} if old_group else {}
        if new_group is None:
            ops.append({"Delete": {"TableName": STATS_TABLE, "Key": {"pk": {"S": marker_key["pk"]}, "sk": {"S": "M"}},
                                   "ConditionExpression": "#g = :g", "ExpressionAttributeNames": {"#g": "group"},
                                   "ExpressionAttributeValues": cond_values}})
        else:
            item = {"pk": {"S": marker_key["pk"]}, "sk": {"S": "M"}, "group": {"S": new_group},
                    "hour": {"S": m_hour}, "day": {"S": m_day}, "account": {"S": account}, "automation": {"S": label},
                    "facets": {"L": [{"S": f} for f in (marker.get("facets", facets) if marker else facets)]},
                    "updated": {"S": datetime.utcnow().isoformat()}}
            if new_dur is not None:
                item["dur"] = {"N": str(new_dur)}
            put = {"TableName": STATS_TABLE, "Item": item}
            if old_group:
                put.update(ConditionExpression="#g = :g", ExpressionAttributeNames={"#g": "group"}, ExpressionAttributeValues=cond_values)
            else:
                put.update(ConditionExpression="attribute_not_exists(pk)")
            ops.append({"Put": put})
        for pk, sk in (("TOTAL", "ALL"), ("HOUR", m_hour), ("DAY", m_day)):
            op = _counter_update(pk, sk, deltas)
            if op:
                ops.append(op)
        facet_delta = 1 if old_group is None else (-1 if new_group is None else 0)
        if facet_delta:
            # Remove exactly what was added: the marker's facet list.
            for f in (marker.get("facets", facets) if marker else facets):
                ops.append(_counter_update("FACET", f, {"count": facet_delta}))
        try:
            _dynamo().transact_write_items(TransactItems=ops)
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code in ("TransactionCanceledException", "TransactionConflictException"):
                time.sleep(0.05 * (attempt + 1))
                continue  # someone else changed the marker — re-read and retry
            raise
        if old_group is None and new_group:
            _note_month(created[:7])
        return "removed" if new_group is None else ("counted" if old_group is None else "moved")
    raise RuntimeError(f"Could not update counters for job {job_id} after retries")


def _note_month(month):
    """Earliest list_month seen — lets the API stop paging back through
    empty months."""
    try:
        _resource().Table(STATS_TABLE).update_item(
            Key={"pk": "META", "sk": "range"},
            UpdateExpression="SET min_month = :m",
            ConditionExpression="attribute_not_exists(min_month) OR min_month > :m",
            ExpressionAttributeValues={":m": month},
        )
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise


# ── Handlers ────────────────────────────────────────────────────────────────

def _image(record, key):
    img = (record.get("dynamodb") or {}).get(key)
    return {k: _deser.deserialize(v) for k, v in img.items()} if img else None


def handle_record(record):
    name = record.get("eventName")
    if name == "REMOVE":
        old = _image(record, "OldImage")
        return apply_job_state(old, removed=True) if old else "skipped"
    new = _image(record, "NewImage")
    if not new:
        return "skipped"
    write_list_fields(new)
    return apply_job_state(new)


def backfill(start_key=None, context=None):
    """Process every existing job. Safe to re-run; resumes from start_key."""
    table = _resource().Table(JOBS_TABLE)
    kwargs = {}
    if start_key:
        kwargs["ExclusiveStartKey"] = start_key
    seen = changed = 0
    results = {}
    while True:
        page = table.scan(**kwargs)
        for scanned in page.get("Items", []):
            seen += 1
            # Re-read: the stream may have moved this job on since the scan
            # page was read, and counting the stale status would undo that.
            job = table.get_item(Key={"job_id": scanned["job_id"]}, ConsistentRead=True).get("Item")
            if not job:
                continue
            if write_list_fields(job):
                changed += 1
                job = {**job, **list_fields(job)}
            r = apply_job_state(job)
            results[r] = results.get(r, 0) + 1
        next_key = page.get("LastEvaluatedKey")
        if not next_key:
            _resource().Table(STATS_TABLE).put_item(Item={
                "pk": "META", "sk": "backfill", "completed_at": datetime.utcnow().isoformat(), "jobs_seen": seen,
            })
            return {"done": True, "jobs_seen": seen, "list_fields_written": changed, "results": results}
        if context is not None and context.get_remaining_time_in_millis() < 60_000:
            return {"done": False, "jobs_seen": seen, "list_fields_written": changed, "results": results,
                    "start_key": json.loads(json.dumps(next_key, default=str)),
                    "next": "invoke again with this start_key"}
        kwargs["ExclusiveStartKey"] = next_key


def verify():
    """Recount from the jobs table and compare with the counters."""
    jobs = _resource().Table(JOBS_TABLE)
    stats = _resource().Table(STATS_TABLE)
    expected_total = {g: 0 for g in GROUPS}
    expected_days = {}
    kwargs = {"ProjectionExpression": "#s, created_at", "ExpressionAttributeNames": {"#s": "status"}}
    n = 0
    while True:
        page = jobs.scan(**kwargs)
        for j in page.get("Items", []):
            created = utc_created(j.get("created_at"))
            if not created:
                continue
            g = status_group(j.get("status"))
            expected_total[g] += 1
            expected_days.setdefault(created[:10], {x: 0 for x in GROUPS})[g] += 1
            n += 1
        if not page.get("LastEvaluatedKey"):
            break
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    actual = stats.get_item(Key={"pk": "TOTAL", "sk": "ALL"}).get("Item") or {}
    diffs = {g: {"expected": expected_total[g], "counted": int(actual.get(g, 0))} for g in GROUPS if int(actual.get(g, 0)) != expected_total[g]}
    day_diffs = []
    for day, exp in sorted(expected_days.items()):
        got = stats.get_item(Key={"pk": "DAY", "sk": day}).get("Item") or {}
        bad = {g: (exp[g], int(got.get(g, 0))) for g in GROUPS if int(got.get(g, 0)) != exp[g]}
        if bad:
            day_diffs.append({"day": day, "expected_vs_counted": bad})
    return {"jobs_checked": n, "total_matches": not diffs, "total_diffs": diffs, "day_diffs": day_diffs[:50]}


def _plain(o):
    if isinstance(o, Decimal):
        return int(o) if o % 1 == 0 else float(o)
    raise TypeError


def lambda_handler(event, context):
    action = (event or {}).get("action")
    if action == "backfill":
        return json.loads(json.dumps(backfill(event.get("start_key"), context), default=_plain))
    if action == "verify":
        return json.loads(json.dumps(verify(), default=_plain))
    records = (event or {}).get("Records", [])
    failures = []
    for rec in records:
        try:
            handle_record(rec)
        except Exception as e:  # report so only this record is retried
            logger.error(f"job_stats failed for record {rec.get('eventID')}: {e}")
            seq = (rec.get("dynamodb") or {}).get("SequenceNumber")
            if seq:
                failures.append({"itemIdentifier": seq})
            else:
                raise
    return {"batchItemFailures": failures}
