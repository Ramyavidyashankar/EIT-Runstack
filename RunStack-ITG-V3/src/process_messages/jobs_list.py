"""
Fast Dashboard / Automation Executions reads (GET /jobs/query views).

Uses two things the job_stats stream consumer maintains:
  * list-month-created-index  GSI on the jobs table (list_month, created_at)
                              → newest-first pages without a table scan
  * runstack-job-stats        exact counters by status / hour / day / facet
                              → totals and chart values without a scan

Both are only trusted once the one-off backfill has finished (META/backfill
item exists). Until then jobs.py keeps using its existing scan path, so the
pages work straight after deploy and switch over by themselves.

Views (all on GET /jobs/query, so no new API Gateway route):
  view=summary  range=24h|3d|7d|30d   cards + chart from counters
  view=recent   limit=1–25            newest executions (Dashboard table)
  (default)     rows page: limit 1–100, cursor, filters, exact total
"""

import base64
import hashlib
import json
import os
import time
from datetime import datetime, timedelta

import boto3
from boto3.dynamodb.conditions import Attr, Key

from shared import get_dynamodb_table, logger

JOB_STATS_TABLE = os.getenv("JOB_STATS_TABLE", "")
JOBS_LIST_INDEX = os.getenv("JOBS_LIST_INDEX", "list-month-created-index")
GROUPS = ("PENDING", "RUNNING", "COMPLETED", "FAILED")
COUNT_CACHE_SECONDS = int(os.getenv("JOBS_COUNT_CACHE_SECONDS", "20"))
COUNT_TIME_BUDGET_SEC = float(os.getenv("JOBS_COUNT_TIME_BUDGET_SEC", "8"))
MAX_COUNTER_KEYS = 400

# Raw status values per group — must match status_group() in jobs.py.
_RAW = {
    "COMPLETED": ["COMPLETED", "SUCCEEDED", "SUCCESS"],
    "FAILED": ["FAILED", "TIMED_OUT", "CANCELLED", "CANCELED", "ERROR"],
    "RUNNING": ["RUNNING", "IN_PROGRESS"],
}


def _variants(values):
    out = []
    for v in values:
        for x in (v, v.lower(), v.title()):
            if x not in out:
                out.append(x)
    return out


RANGES = {  # hours, bucket hours ('D' = daily buckets from DAY counters)
    "24h": {"hours": 24, "bucket": 1, "label": "Last 24 hours"},
    "3d": {"hours": 72, "bucket": 3, "label": "Last 3 days"},
    "7d": {"hours": 168, "bucket": 12, "label": "Last 7 days"},
    "30d": {"days": 30, "bucket": "D", "label": "Last 30 days"},
}

_ready = {"value": None, "checked": 0.0}
_count_cache = {}
_ddb = None


def _stats():
    global _ddb
    if _ddb is None:
        _ddb = boto3.resource("dynamodb")
    return _ddb.Table(JOB_STATS_TABLE)


def _now():
    return datetime.utcnow()


def index_ready():
    """True once the stats table exists and the backfill has completed.
    Cached for a minute per container."""
    if not JOB_STATS_TABLE:
        return False
    now = time.time()
    if _ready["value"] is not None and now - _ready["checked"] < 60:
        return _ready["value"]
    try:
        item = _stats().get_item(Key={"pk": "META", "sk": "backfill"}).get("Item")
        value = bool(item and item.get("completed_at"))
    except Exception as e:  # table missing / no permission → legacy path
        logger.warning(f"job stats not available, using scan path: {e}")
        value = False
    _ready.update(value=value, checked=now)
    return value


def _int(v):
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _batch_get(keys):
    """BatchGetItem on the stats table; returns {(pk, sk): item}."""
    out = {}
    client = _stats().meta.client
    for i in range(0, len(keys), 100):
        pending = {JOB_STATS_TABLE: {"Keys": [{"pk": pk, "sk": sk} for pk, sk in keys[i:i + 100]]}}
        for _ in range(8):
            resp = client.batch_get_item(RequestItems=pending)
            for item in resp.get("Responses", {}).get(JOB_STATS_TABLE, []):
                out[(item["pk"], item["sk"])] = item
            pending = resp.get("UnprocessedKeys") or {}
            if not pending:
                break
            time.sleep(0.05)
    return out


def _group_counts(item):
    c = {g: _int((item or {}).get(g)) for g in GROUPS}
    c["ALL"] = sum(c[g] for g in GROUPS)
    c["ACTIVE"] = c["PENDING"] + c["RUNNING"]
    return c


def _add(a, b):
    return {k: a.get(k, 0) + b.get(k, 0) for k in set(a) | set(b)}


def _meta_min_month():
    item = _stats().get_item(Key={"pk": "META", "sk": "range"}).get("Item") or {}
    return item.get("min_month")


# ── view=summary ─────────────────────────────────────────────────────────────

def summary(range_key):
    spec = RANGES[range_key]
    now = _now()
    hour_end = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    keys = [("TOTAL", "ALL")]
    buckets = []
    if spec["bucket"] == "D":
        today = now.replace(hour=0, minute=0, second=0, microsecond=0)
        start = today - timedelta(days=spec["days"] - 1)
        end = today + timedelta(days=1)
        for d in range(spec["days"]):
            day = start + timedelta(days=d)
            buckets.append({"start": day, "end": day + timedelta(days=1), "keys": [("DAY", day.strftime("%Y-%m-%d"))]})
    else:
        start = hour_end - timedelta(hours=spec["hours"])
        end = hour_end
        step = spec["bucket"]
        for b in range(spec["hours"] // step):
            b_start = start + timedelta(hours=b * step)
            buckets.append({"start": b_start, "end": b_start + timedelta(hours=step),
                            "keys": [("HOUR", (b_start + timedelta(hours=h)).strftime("%Y-%m-%dT%H")) for h in range(step)]})
    for b in buckets:
        keys.extend(b["keys"])
    items = _batch_get(keys)

    totals = {g: 0 for g in GROUPS}
    dur_sum = dur_n = 0
    out_buckets = []
    for b in buckets:
        c = {g: 0 for g in GROUPS}
        for k in b["keys"]:
            it = items.get(k) or {}
            for g in GROUPS:
                c[g] += _int(it.get(g))
            dur_sum += _int(it.get("dur_sum"))
            dur_n += _int(it.get("dur_n"))
        for g in GROUPS:
            totals[g] += c[g]
        out_buckets.append({"start": b["start"].isoformat() + "Z", "end": b["end"].isoformat() + "Z",
                            "total": sum(c.values()), **c})
    finished = totals["COMPLETED"] + totals["FAILED"]
    all_time = _group_counts(items.get(("TOTAL", "ALL")))
    return {
        "view": "summary",
        "range": range_key,
        "range_label": spec["label"],
        "from": start.isoformat() + "Z",
        "to": end.isoformat() + "Z",
        "bucket": "day" if spec["bucket"] == "D" else f"{spec['bucket']}h",
        "totals": {**totals, "ALL": sum(totals.values())},
        "success_rate": round(100.0 * totals["COMPLETED"] / finished, 1) if finished else None,
        "avg_duration_seconds": round(dur_sum / dur_n, 1) if dur_n else None,
        "avg_duration_sample": dur_n,
        "active_now": {"RUNNING": all_time["RUNNING"], "PENDING": all_time["PENDING"]},
        "all_time": all_time,
        "buckets": out_buckets,
        "count_source": "counters",
        "complete": True,
        "generated_at": now.isoformat() + "Z",
    }


# ── Index paging ─────────────────────────────────────────────────────────────

def _month_add(month, n):
    y, m = int(month[:4]), int(month[5:7])
    m += n
    while m < 1:
        y, m = y - 1, m + 12
    while m > 12:
        y, m = y + 1, m - 12
    return f"{y:04d}-{m:02d}"


def _months(date_from, date_to, ascending):
    """Month partitions to read, in paging order."""
    newest = (date_to or _now().isoformat())[:7]
    now_month = _now().strftime("%Y-%m")
    newest = min(newest, now_month) if date_to else now_month
    oldest = _meta_min_month() or newest
    if date_from:
        oldest = max(oldest, date_from[:7])
    months = []
    m = newest
    while m >= oldest and len(months) < 600:
        months.append(m)
        m = _month_add(m, -1)
    return list(reversed(months)) if ascending else months


def _filter_expr(f, include_status=True):
    cond = None

    def AND(c):
        nonlocal cond
        cond = c if cond is None else cond & c

    status = f.get("status") or "ALL"
    if include_status and status != "ALL":
        if status in ("COMPLETED", "FAILED", "RUNNING"):
            AND(Attr("status").is_in(_variants(_RAW[status])))
        else:  # PENDING = anything not in the other groups; ACTIVE = pending + running
            excluded = _RAW["COMPLETED"] + _RAW["FAILED"] + ([] if status == "ACTIVE" else _RAW["RUNNING"])
            AND(Attr("status").not_exists() | ~Attr("status").is_in(_variants(excluded)))
    for param, attr in (("automation", "automation_label"), ("name", "automation_name_key"), ("account", "account_id"),
                        ("environment", "environment"), ("region", "region")):
        if f.get(param):
            AND(Attr(attr).eq(f[param]))
    if f.get("q"):
        AND(Attr("search_text").contains(f["q"].lower()))
    return cond


def _key_cond(month, date_from, date_to):
    k = Key("list_month").eq(month)
    lo = date_from if date_from and date_from[:7] == month else None
    hi = date_to if date_to and date_to[:7] == month else None
    if lo and hi:
        return k & Key("created_at").between(lo, hi)  # 'to' exclusive: filtered below
    if lo:
        return k & Key("created_at").gte(lo)
    if hi:
        return k & Key("created_at").lt(hi)
    return k


def encode_cursor(obj):
    return base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).decode()


def decode_cursor(s):
    return json.loads(base64.urlsafe_b64decode(s.encode()).decode())


def page(f, limit, cursor=None):
    """One page of rows, newest (or oldest) first. Reads only as many index
    items as it needs; the cursor is the index key of the last row shown."""
    ascending = f.get("sort") == "started_asc"
    table = get_dynamodb_table()
    months = _months(f.get("from"), f.get("to"), ascending)
    start_month_idx, start_key = 0, None
    if cursor:
        c = decode_cursor(cursor)
        if c.get("m") in months:
            start_month_idx = months.index(c["m"])
            start_key = c.get("k")
    fexpr = _filter_expr(f)
    rows, next_cursor = [], None
    reads = 0
    for mi in range(start_month_idx, len(months)):
        month = months[mi]
        kwargs = {"IndexName": JOBS_LIST_INDEX, "KeyConditionExpression": _key_cond(month, f.get("from"), f.get("to")),
                  "ScanIndexForward": ascending}
        if fexpr is not None:
            kwargs["FilterExpression"] = fexpr
        esk = start_key if mi == start_month_idx else None
        while True:
            need = limit - len(rows)
            # Unfiltered: read exactly what the page needs (+1 to know there is
            # more). Filtered: DynamoDB applies Limit BEFORE the filter, so a
            # rare match would take many small reads — grow the read size on
            # each round trip (100, 200, 400 … 2000 items).
            if fexpr is None:
                kwargs["Limit"] = need + 1
            else:
                kwargs["Limit"] = min(max(need * 2, 100) * (2 ** reads), 2000)
            reads += 1
            if esk:
                kwargs["ExclusiveStartKey"] = esk
            else:
                kwargs.pop("ExclusiveStartKey", None)
            resp = table.query(**kwargs)
            items = [i for i in resp.get("Items", []) if not f.get("to") or str(i.get("created_at")) < f["to"]]
            for it in items:
                if len(rows) == limit:
                    # There is at least one more row: cursor after the last shown.
                    last = rows[-1]
                    next_cursor = encode_cursor({"m": last["list_month"], "k": {
                        "job_id": last["job_id"], "list_month": last["list_month"], "created_at": last["created_at"]}})
                    return rows, next_cursor
                rows.append(it)
            esk = resp.get("LastEvaluatedKey")
            if not esk:
                break
    return rows, None


# ── Totals ───────────────────────────────────────────────────────────────────

def _hour_aligned(iso):
    return iso is None or iso[13:] in ("", ":00:00", ":00:00.000000", ":00", ":00:00.000")


def _counter_keys(date_from, date_to):
    """Stats keys covering [from, to) using whole days where possible."""
    now = _now()
    end = datetime.fromisoformat(date_to) if date_to else now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    min_month = _meta_min_month()
    if date_from:
        cur = datetime.fromisoformat(date_from)
    elif min_month:
        cur = datetime.fromisoformat(min_month + "-01T00:00:00")
    else:
        return []
    keys = []
    while cur < end:
        if cur.hour == 0 and cur + timedelta(days=1) <= end:
            keys.append(("DAY", cur.strftime("%Y-%m-%d")))
            cur += timedelta(days=1)
        else:
            keys.append(("HOUR", cur.strftime("%Y-%m-%dT%H")))
            cur += timedelta(hours=1)
        if len(keys) > MAX_COUNTER_KEYS:
            return None
    return keys


def _counts_from_counters(f):
    if not f.get("from") and not f.get("to"):
        return _group_counts(_stats().get_item(Key={"pk": "TOTAL", "sk": "ALL"}).get("Item"))
    keys = _counter_keys(f.get("from"), f.get("to"))
    if keys is None:
        return None
    items = _batch_get(keys)
    total = {g: 0 for g in GROUPS}
    for k in keys:
        for g in GROUPS:
            total[g] += _int((items.get(k) or {}).get(g))
    return _group_counts(total)


def _counts_from_index(f):
    """Exact counts by status for the non-status filters: reads the matching
    months of the index, projecting only status. Returns (counts, complete)."""
    table = get_dynamodb_table()
    fexpr = _filter_expr(f, include_status=False)
    counts = {g: 0 for g in GROUPS}
    deadline = time.time() + COUNT_TIME_BUDGET_SEC
    for month in _months(f.get("from"), f.get("to"), False):
        kwargs = {"IndexName": JOBS_LIST_INDEX, "KeyConditionExpression": _key_cond(month, f.get("from"), f.get("to")),
                  "ProjectionExpression": "#s, created_at", "ExpressionAttributeNames": {"#s": "status"}}
        if fexpr is not None:
            kwargs["FilterExpression"] = fexpr
        while True:
            resp = table.query(**kwargs)
            for it in resp.get("Items", []):
                if f.get("to") and str(it.get("created_at")) >= f["to"]:
                    continue
                counts[_group(it.get("status"))] += 1
            if not resp.get("LastEvaluatedKey"):
                break
            if time.time() > deadline:
                return _group_counts(counts), False
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    return _group_counts(counts), True


def _group(status):
    s = str(status or "").upper()
    for g, raw in _RAW.items():
        if s in raw:
            return g
    return "PENDING"


def counts(f, force=False):
    """(status_counts, source, complete). status_counts ignore the status
    filter so the status tabs can show every group's number."""
    only_time = not any(f.get(k) for k in ("automation", "name", "account", "environment", "region", "q"))
    if only_time and _hour_aligned(f.get("from")) and _hour_aligned(f.get("to")):
        c = _counts_from_counters(f)
        if c is not None:
            return c, "counters", True
    cache_key = hashlib.sha1(json.dumps({k: f.get(k) for k in ("from", "to", "automation", "name", "account", "environment",
                                                                "region", "q")}, sort_keys=True).encode()).hexdigest()
    hit = _count_cache.get(cache_key)
    if hit and not force and time.time() - hit[0] < COUNT_CACHE_SECONDS:
        return hit[1], "index", hit[2]
    c, complete = _counts_from_index(f)
    if complete:
        _count_cache[cache_key] = (time.time(), c, complete)
        if len(_count_cache) > 200:
            _count_cache.pop(next(iter(_count_cache)))
    return c, "index", complete


def facets():
    """Filter choices with all-time counts from FACET counters."""
    out = {"automations": [], "names": [], "accounts": [], "environments": [], "regions": []}
    names = {"automation": "automations", "name": "names", "account": "accounts", "environment": "environments",
             "region": "regions"}
    kwargs = {"KeyConditionExpression": Key("pk").eq("FACET")}
    while True:
        resp = _stats().query(**kwargs)
        for it in resp.get("Items", []):
            kind, _, value = it["sk"].partition("#")
            n = _int(it.get("count"))
            if kind in names and value and n > 0:
                out[names[kind]].append({"value": value, "count": n})
        if not resp.get("LastEvaluatedKey"):
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    for v in out.values():
        v.sort(key=lambda x: x["value"])
    return out


def total_in_table():
    return _group_counts(_stats().get_item(Key={"pk": "TOTAL", "sk": "ALL"}).get("Item"))["ALL"]


def recent(limit):
    rows, _ = page({"sort": "started_desc"}, limit)
    return rows


def latest_full_items(limit):
    """Newest jobs as full items (for /jobs/latest): index for order, then
    BatchGetItem on the jobs table for every attribute."""
    rows = recent(limit)
    if not rows:
        return []
    table = get_dynamodb_table()
    client = table.meta.client
    got = {}
    pending = {table.name: {"Keys": [{"job_id": r["job_id"]} for r in rows]}}
    for _ in range(8):
        resp = client.batch_get_item(RequestItems=pending)
        for it in resp.get("Responses", {}).get(table.name, []):
            got[it["job_id"]] = it
        pending = resp.get("UnprocessedKeys") or {}
        if not pending:
            break
    return [got[r["job_id"]] for r in rows if r["job_id"] in got]
