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
  view=summary      range=24h|3d|7d|30d|90d|all, or from_day/to_day
                    (custom UTC dates)      cards + chart from counters
  view=automations  same range params      per-automation totals, success,
                                            avg duration, last execution
  view=recent       limit=1–25             newest executions
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
    "7d": {"hours": 168, "bucket": 24, "label": "Last 7 days"},
    "30d": {"days": 30, "bucket": "D", "label": "Last 30 days"},
    "90d": {"days": 90, "bucket": "W", "label": "Last 90 days"},
    "all": {"bucket": "M", "label": "All time"},
}
MAX_CUSTOM_DAYS = 3660
AUTOMATION_CACHE_SECONDS = int(os.getenv("JOBS_AUTOMATION_CACHE_SECONDS", "20"))

_ready = {"value": None, "checked": 0.0}
_auto_ready = {"value": None, "checked": 0.0}
_auto_cache = {}
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


# ── Time windows (shared by view=summary and view=automations) ──────────────
#
# Every window is [start, end) in UTC and is built only from whole hours or
# whole UTC days, so the counters answer it exactly:
#   24h / 3d / 7d   hour-aligned, ending after the current hour (same window
#                   as the Executions page's "Last 24 hours" / "Last 7 days")
#   30d / 90d       UTC days, today included
#   all             from the first month with a job to the end of today
#   custom          from_day … to_day (UTC dates, both included)
# The chart bucket is chosen from the window length.

def _parse_day(v):
    try:
        return datetime.strptime(str(v), "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def window(range_key=None, from_day=None, to_day=None):
    """(window dict, error message). window: start, end, bucket kind
    ('hour' | 'day' | 'week' | 'month'), bucket size, range, label."""
    now = _now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow = today + timedelta(days=1)
    if from_day or to_day:
        a, b = _parse_day(from_day), _parse_day(to_day)
        if not a or not b:
            return None, "from_day and to_day must both be dates (YYYY-MM-DD)"
        if b < a:
            return None, "to_day must be on or after from_day"
        end = min(b + timedelta(days=1), tomorrow)
        if end <= a:
            return None, "the range is in the future"
        days = (end - a).days
        if days > MAX_CUSTOM_DAYS:
            return None, f"a custom range can cover at most {MAX_CUSTOM_DAYS} days"
        kind, size = ("hour", 1) if days <= 2 else ("day", 1) if days <= 92 else ("week", 7) if days <= 400 else ("month", 1)
        label = f"{a.strftime('%d %b %Y')} – {(end - timedelta(days=1)).strftime('%d %b %Y')} (UTC)"
        return {"start": a, "end": end, "kind": kind, "size": size, "range": "custom", "label": label}, None
    range_key = range_key or "24h"
    spec = RANGES.get(range_key)
    if not spec:
        return None, f"range must be one of {list(RANGES)}"
    if "hours" in spec:
        end = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
        return {"start": end - timedelta(hours=spec["hours"]), "end": end, "kind": "hour", "size": spec["bucket"],
                "range": range_key, "label": spec["label"]}, None
    if range_key == "all":
        try:
            mm = _meta_min_month()
        except Exception:   # stats table not set up yet (scan fallback)
            mm = None
        start = datetime.strptime(mm + "-01", "%Y-%m-%d") if mm else today
        return {"start": start, "end": tomorrow, "kind": "month", "size": 1, "range": "all", "label": spec["label"]}, None
    kind, size = ("day", 1) if spec["bucket"] == "D" else ("week", 7)
    return {"start": today - timedelta(days=spec["days"] - 1), "end": tomorrow, "kind": kind, "size": size,
            "range": range_key, "label": spec["label"]}, None


def _next_month(d):
    return (d.replace(day=28) + timedelta(days=4)).replace(day=1)


def _buckets(w):
    """[{start, end, keys}] covering the window; keys are HOUR or DAY counters."""
    out, cur = [], w["start"]
    while cur < w["end"]:
        if w["kind"] == "hour":
            nxt = cur + timedelta(hours=w["size"])
        elif w["kind"] == "month":
            nxt = _next_month(cur.replace(day=1))
        else:
            nxt = cur + timedelta(days=w["size"])
        nxt = min(nxt, w["end"])
        if w["kind"] == "hour":
            keys = [("HOUR", (cur + timedelta(hours=h)).strftime("%Y-%m-%dT%H")) for h in range(int((nxt - cur).total_seconds() // 3600))]
        else:
            keys = [("DAY", (cur + timedelta(days=d)).strftime("%Y-%m-%d")) for d in range((nxt - cur).days)]
        out.append({"start": cur, "end": nxt, "keys": keys})
        cur = nxt
    return out


_BUCKET_NAME = {"hour": lambda w: f"{w['size']}h", "day": lambda w: "day", "week": lambda w: "week", "month": lambda w: "month"}


# ── view=summary ─────────────────────────────────────────────────────────────

def summary(range_key=None, from_day=None, to_day=None):
    """Summary dict, or {"error": message} for a bad range."""
    w, err = window(range_key, from_day, to_day)
    if err:
        return {"error": err}
    now = _now()
    buckets = _buckets(w)
    keys = [("TOTAL", "ALL")]
    for b in buckets:
        keys.extend(b["keys"])
    # Long-running: jobs still RUNNING that started before the previous UTC
    # hour began (so every one counted has run for over an hour). Exact from
    # the counters: all-time RUNNING minus RUNNING in the last two hours.
    hour_now = now.replace(minute=0, second=0, microsecond=0)
    long_cutoff = hour_now - timedelta(hours=1)
    recent_hours = [("HOUR", hour_now.strftime("%Y-%m-%dT%H")), ("HOUR", long_cutoff.strftime("%Y-%m-%dT%H"))]
    keys.extend(k for k in recent_hours if k not in keys)
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
    running_recent = sum(_int((items.get(k) or {}).get("RUNNING")) for k in recent_hours)
    return {
        "view": "summary",
        "range": w["range"],
        "range_label": w["label"],
        "from": w["start"].isoformat() + "Z",
        "to": w["end"].isoformat() + "Z",
        "bucket": _BUCKET_NAME[w["kind"]](w),
        "totals": {**totals, "ALL": sum(totals.values())},
        "success_rate": round(100.0 * totals["COMPLETED"] / finished, 1) if finished else None,
        "avg_duration_seconds": round(dur_sum / dur_n, 1) if dur_n else None,
        "avg_duration_sample": dur_n,
        "active_now": {"RUNNING": all_time["RUNNING"], "PENDING": all_time["PENDING"]},
        "all_time": all_time,
        "long_running": {"RUNNING": max(0, all_time["RUNNING"] - running_recent),
                         "started_before": long_cutoff.isoformat() + "Z"},
        "buckets": out_buckets,
        "count_source": "counters",
        "complete": True,
        "generated_at": now.isoformat() + "Z",
    }


# ── view=automations ─────────────────────────────────────────────────────────

def automations_ready():
    """True once job_stats' backfill_automations has completed."""
    if not JOB_STATS_TABLE:
        return False
    now = time.time()
    if _auto_ready["value"] is not None and now - _auto_ready["checked"] < 60:
        return _auto_ready["value"]
    try:
        item = _stats().get_item(Key={"pk": "META", "sk": "automations"}).get("Item")
        value = bool(item and item.get("completed_at"))
    except Exception as e:
        logger.warning(f"automation counters not available: {e}")
        value = False
    _auto_ready.update(value=value, checked=now)
    return value


def automation_partitions(w):
    """Counter partitions covering the window: whole months, then whole
    days, then hours at the edges. 'all' is the single all-time partition."""
    if w["range"] == "all":
        return ["AUTO"]
    out, cur, end = [], w["start"], w["end"]
    while cur < end:
        if cur.day == 1 and cur.hour == 0 and _next_month(cur) <= end:
            out.append(f"AUTOM#{cur.strftime('%Y-%m')}")
            cur = _next_month(cur)
        elif cur.hour == 0 and cur + timedelta(days=1) <= end:
            out.append(f"AUTOD#{cur.strftime('%Y-%m-%d')}")
            cur += timedelta(days=1)
        else:
            out.append(f"AUTOH#{cur.strftime('%Y-%m-%dT%H')}")
            cur += timedelta(hours=1)
    return out


def _query_partition(pk):
    client = boto3.client("dynamodb")   # low-level clients are thread-safe
    items, kwargs = [], {"TableName": JOB_STATS_TABLE, "KeyConditionExpression": "pk = :p",
                         "ExpressionAttributeValues": {":p": {"S": pk}}}
    while True:
        resp = client.query(**kwargs)
        items.extend(resp.get("Items", []))
        if not resp.get("LastEvaluatedKey"):
            return items
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]


def automations(range_key=None, from_day=None, to_day=None, force=False):
    """Per-automation usage for the window, newest data from the counters.
    Returns {"error": …} for a bad range, or available False before the
    backfill has run."""
    w, err = window(range_key, from_day, to_day)
    if err:
        return {"error": err}
    base = {"view": "automations", "range": w["range"], "range_label": w["label"],
            "from": w["start"].isoformat() + "Z", "to": w["end"].isoformat() + "Z"}
    if not automations_ready():
        return {**base, "available": False, "automations": [],
                "reason": "Per-automation counters are not set up yet (job_stats backfill_automations)."}
    cache_key = (w["range"], base["from"], base["to"])
    hit = _auto_cache.get(cache_key)
    if hit and not force and time.time() - hit[0] < AUTOMATION_CACHE_SECONDS:
        return hit[1]
    from concurrent.futures import ThreadPoolExecutor
    parts = automation_partitions(w)
    with ThreadPoolExecutor(max_workers=min(16, len(parts))) as pool:
        results = list(pool.map(_query_partition, parts))
    agg = {}
    for items in results:
        for it in items:
            label = it["sk"]["S"]
            a = agg.setdefault(label, {g: 0 for g in GROUPS} | {"dur_sum": 0, "dur_n": 0, "last_at": None})
            for g in GROUPS:
                a[g] += int(it.get(g, {}).get("N", 0))
            a["dur_sum"] += int(it.get("dur_sum", {}).get("N", 0))
            a["dur_n"] += int(it.get("dur_n", {}).get("N", 0))
            last = it.get("last_at", {}).get("S")
            if last and (a["last_at"] is None or last > a["last_at"]):
                a["last_at"] = last
    rows = []
    for label, a in agg.items():
        total = sum(a[g] for g in GROUPS)
        if total <= 0:
            continue
        finished = a["COMPLETED"] + a["FAILED"]
        rows.append({
            "automation": label, "total": total, **{g: a[g] for g in GROUPS},
            "success_rate": round(100.0 * a["COMPLETED"] / finished, 1) if finished else None,
            "avg_duration_seconds": round(a["dur_sum"] / a["dur_n"], 1) if a["dur_n"] else None,
            "avg_duration_sample": a["dur_n"],
            "last_at": (a["last_at"] + "Z") if a["last_at"] and not a["last_at"].endswith("Z") else a["last_at"],
        })
    rows.sort(key=lambda r: (-r["total"], r["automation"].lower()))
    body = {**base, "available": True, "automations": rows, "count": len(rows), "partitions_read": len(parts),
            "generated_at": _now().isoformat() + "Z"}
    _auto_cache[cache_key] = (time.time(), body)
    if len(_auto_cache) > 50:
        _auto_cache.pop(next(iter(_auto_cache)))
    return body


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
