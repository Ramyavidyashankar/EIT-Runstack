"""
"Automation name" filter: job_stats facets / list field / one-off backfill,
and the /jobs/query name filter (scan path). moto-backed.

Run:  cd RunStack-ITG-V3 && python -m pytest tests -q
"""
import importlib.util
import json
import os
import sys
import types

import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "src", "process_messages"))
for mod in ("msal", "openpyxl", "bcrypt"):
    sys.modules.setdefault(mod, types.ModuleType(mod))
os.environ.update({"AWS_DEFAULT_REGION": "us-east-1", "AWS_ACCESS_KEY_ID": "x", "AWS_SECRET_ACCESS_KEY": "x",
                   "DYNAMODB_TABLE_NAME": "runstack-jobs-table", "JOB_STATS_TABLE": "runstack-job-stats"})

from moto import mock_aws  # noqa: E402
import boto3  # noqa: E402

NAME = "SQL DB  Instance Version CMDB Update"          # double space, as submitted
KEY = "SQL DB Instance Version CMDB Update"            # normalised


def load_job_stats():
    spec = importlib.util.spec_from_file_location("job_stats_app", os.path.join(HERE, "..", "src", "job_stats", "app.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


@pytest.fixture
def env():
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(TableName="runstack-jobs-table", BillingMode="PAY_PER_REQUEST",
                         AttributeDefinitions=[{"AttributeName": "job_id", "AttributeType": "S"}],
                         KeySchema=[{"AttributeName": "job_id", "KeyType": "HASH"}])
        ddb.create_table(TableName="runstack-job-stats", BillingMode="PAY_PER_REQUEST",
                         AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                               {"AttributeName": "sk", "AttributeType": "S"}],
                         KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}])
        js = load_job_stats()
        js._ddb = None
        js._client = None
        yield types.SimpleNamespace(js=js, jobs=ddb.Table("runstack-jobs-table"), stats=ddb.Table("runstack-job-stats"))


def job(jid, name=None, nested=None, status="COMPLETED"):
    ad = {"DocumentName": "AWS-RunRemoteScript", "InstanceIds": ["i-0e9976e84ddf92031"]}
    if nested:
        ad["automation_name"] = nested
    j = {"job_id": jid, "status": status, "account_id": "246314649749", "region": "us-east-1",
         "automation_type": "SSM-RunCommand", "created_at": "2026-09-30T15:00:46.641783", "automation_data": ad}
    if name:
        j["automation_name"] = name
    return j


def facet_count(env, key):
    it = env.stats.get_item(Key={"pk": "FACET", "sk": key}).get("Item") or {}
    return int(it.get("count", 0))


def test_new_jobs_are_counted_under_their_name(env):
    j = job("j1", nested=NAME)
    env.jobs.put_item(Item=j)
    env.js.write_list_fields(j)
    assert env.js.apply_job_state(env.jobs.get_item(Key={"job_id": "j1"})["Item"]) == "counted"
    assert facet_count(env, f"name#{KEY}") == 1
    assert facet_count(env, "automation#Run Remote Script") == 1        # document filter unchanged
    item = env.jobs.get_item(Key={"job_id": "j1"})["Item"]
    assert item["automation_name_key"] == KEY and "cmdb" in item["search_text"]


def test_backfill_names_counts_existing_jobs_once(env):
    # Jobs counted before the filter existed: marker without a name facet.
    for jid, kw in (("a", {"nested": NAME}), ("b", {"name": KEY}), ("c", {})):
        j = job(jid, **kw)
        env.jobs.put_item(Item=j)
        facets = [f for f in env.js.facet_keys(j) if not f.startswith("name#")]
        env.stats.put_item(Item={"pk": f"JOB#{jid}", "sk": "M", "group": "COMPLETED", "facets": facets})
    r = env.js.backfill_names()
    assert r == {"done": True, "jobs_seen": 3, "jobs_with_name": 2, "name_facets_added": 2}
    assert facet_count(env, f"name#{KEY}") == 2
    # Idempotent: a second run adds nothing.
    r2 = env.js.backfill_names()
    assert r2["name_facets_added"] == 0 and facet_count(env, f"name#{KEY}") == 2
    # Deleting a job later removes it from the name count too (marker lists it).
    old = env.jobs.get_item(Key={"job_id": "a"})["Item"]
    env.js.apply_job_state(old, removed=True)
    assert facet_count(env, f"name#{KEY}") == 1


def test_query_filters_by_name_on_scan_path(env, monkeypatch):
    import jobs
    import shared
    shared._table = None
    jobs._JOBS_QUERY_CACHE.update(items=None, fetched=0.0)
    for jid, kw in (("a", {"nested": NAME}), ("b", {"name": KEY}), ("c", {})):
        env.jobs.put_item(Item=job(jid, **kw))
    res = jobs._legacy_query({"name": KEY, "refresh": "true"})
    body = json.loads(res["body"])
    assert sorted(j["job_id"] for j in body["jobs"]) == ["a", "b"]
    assert body["facets"]["names"] == [{"value": KEY, "count": 2}]
    rows = [jobs._list_row(j) for j in body["jobs"]]
    assert all(r["automation_name"] and "automation_name_key" not in r for r in rows)


def test_index_filter_expression_includes_name():
    import jobs_list
    expr = jobs_list._filter_expr({"name": KEY})
    values = expr.get_expression()["values"]
    assert values[0].name == "automation_name_key" and values[1] == KEY
