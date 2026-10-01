"""
Tests for the Execution Details backend (process_messages/execution_details.py).

DynamoDB (jobs table + execution-group-index + app-access + catalog +
team-capabilities) is simulated with moto. SSM, CloudWatch Logs and Step
Functions are replaced by small fakes so each scenario controls exactly
what AWS returns, and so we can assert WHICH account/region was read.

Run:  cd RunStack-ITG-V3 && python -m pytest tests -q
"""
import base64
import json
import os
import sys
import types
from datetime import datetime, timezone, timedelta

import pytest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "src", "process_messages"))

# shared.py imports libraries that only the Lambda layer has.
for mod in ("msal", "openpyxl", "bcrypt"):
    sys.modules.setdefault(mod, types.ModuleType(mod))

os.environ.update({
    "AWS_DEFAULT_REGION": "us-east-1", "AWS_ACCESS_KEY_ID": "x", "AWS_SECRET_ACCESS_KEY": "x",
    "DYNAMODB_TABLE_NAME": "runstack-jobs-table", "APP_ACCESS_TABLE": "runstack-app-access",
    "INSTANCE_CATALOG_TABLE": "runstack-instance-catalog", "TEAM_CAPABILITIES_TABLE": "runstack-team-capabilities",
    "WORKFLOW_ARN": "arn:aws:states:us-east-1:999999999999:stateMachine:runstack-workflow",
    "RUNSTACK_CENTRAL_ACCOUNT_ID": "999999999999", "HEALTHCHECK_DOCUMENT_NAME": "SQL-Database-Healthcheck",
})

from moto import mock_aws  # noqa: E402
import boto3  # noqa: E402
from botocore.exceptions import ClientError  # noqa: E402

CENTRAL = "999999999999"
ACCT = "111111111111"
OTHER = "222222222222"
I1, I2, I3 = "i-0aaaaaaaaaaaaaaa1", "i-0bbbbbbbbbbbbbbb2", "i-0ccccccccccccccc3"
NOW = datetime.now(timezone.utc)


# ── Fakes ────────────────────────────────────────────────────────────────────
def cerr(code, msg="x"):
    return ClientError({"Error": {"Code": code, "Message": msg}}, "op")


class FakeSSM:
    def __init__(self, world, account, region):
        self.w, self.account, self.region = world, account, region

    def _log(self, op):
        self.w.calls.append((op, self.account, self.region))
        if self.w.fail.get(op):
            raise self.w.fail[op]

    def list_command_invocations(self, CommandId, Details=True, MaxResults=50, InstanceId=None, NextToken=None):
        self._log("list_command_invocations")
        self.w.calls.append(("lci_command", CommandId))
        invs = self.w.invocations.get((self.account, self.region, CommandId), [])
        if InstanceId:
            invs = [i for i in invs if i["InstanceId"] == InstanceId]
        return {"CommandInvocations": invs}

    def get_command_invocation(self, CommandId, InstanceId, PluginName=None):
        self._log("get_command_invocation")
        return self.w.full_output.get((CommandId, InstanceId, PluginName), {})

    def get_automation_execution(self, AutomationExecutionId):
        self._log("get_automation_execution")
        a = self.w.automations.get((self.account, self.region, AutomationExecutionId))
        if not a:
            raise cerr("AutomationExecutionNotFoundException")
        return {"AutomationExecution": a}

    def describe_automation_executions(self, Filters, MaxResults=5):
        self._log("describe_automation_executions")
        parent = Filters[0]["Values"][0]
        return {"AutomationExecutionMetadataList": [
            {"AutomationExecutionId": k[2]} for k, v in self.w.automations.items()
            if k[0] == self.account and k[1] == self.region and v.get("ParentAutomationExecutionId") == parent]}


class FakeLogs:
    def __init__(self, world, account, region):
        self.w, self.account, self.region = world, account, region

    def describe_log_streams(self, logGroupName, logStreamNamePrefix, nextToken=None):
        self.w.calls.append(("describe_log_streams", self.account, self.region))
        if self.w.fail.get("describe_log_streams"):
            raise self.w.fail["describe_log_streams"]
        streams = self.w.logs.get((self.account, self.region, logGroupName))
        if streams is None:
            raise cerr("ResourceNotFoundException")
        return {"logStreams": [{"logStreamName": n} for n in sorted(streams) if n.startswith(logStreamNamePrefix)]}

    def get_log_events(self, logGroupName, logStreamName, limit, startFromHead=False, nextToken=None):
        self.w.calls.append(("get_log_events", self.account, self.region, logStreamName, nextToken))
        evs = self.w.logs[(self.account, self.region, logGroupName)][logStreamName]
        # Tokens are "f:<index>" (next unread) or "b:<index>" (exclusive end).
        if nextToken and nextToken.startswith("f:"):
            start = int(nextToken[2:]); page = evs[start:start + limit]; end = start + len(page)
            return {"events": page, "nextForwardToken": f"f:{end}", "nextBackwardToken": f"b:{start}"}
        if nextToken and nextToken.startswith("b:"):
            end = int(nextToken[2:]); start = max(0, end - limit); page = evs[start:end]
            return {"events": page, "nextForwardToken": f"f:{end}", "nextBackwardToken": f"b:{start}"}
        if startFromHead:
            page = evs[:limit]
            return {"events": page, "nextForwardToken": f"f:{len(page)}", "nextBackwardToken": "b:0"}
        start = max(0, len(evs) - limit)
        return {"events": evs[start:], "nextForwardToken": f"f:{len(evs)}", "nextBackwardToken": f"b:{start}"}


class World:
    def __init__(self):
        self.invocations, self.automations, self.logs = {}, {}, {}
        self.calls, self.fail, self.history = [], {}, []
        self.full_output = {}


def ev(i, msg):
    return {"timestamp": 1_700_000_000_000 + i * 1000, "ingestionTime": 1_700_000_000_000 + i * 1000 + 5, "message": msg}


def invocation(inst, status="InProgress", detail=None, cw=True, plugins=None, code=-1):
    return {
        "InstanceId": inst, "InstanceName": "", "DocumentName": "AWS-RunShellScript",
        "Status": status, "StatusDetails": detail or status, "RequestedDateTime": NOW - timedelta(minutes=2),
        "CloudWatchOutputConfig": {"CloudWatchOutputEnabled": cw, "CloudWatchLogGroupName": "/aws/ssm/runstack" if cw else ""},
        "CommandPlugins": plugins if plugins is not None else [{
            "Name": "aws:runShellScript", "Status": status, "StatusDetails": detail or status, "ResponseCode": code,
            "ResponseStartDateTime": NOW - timedelta(minutes=2),
            "ResponseFinishDateTime": None if status == "InProgress" else NOW - timedelta(seconds=10),
            "Output": "final preview text"}],
    }


# ── Fixtures ─────────────────────────────────────────────────────────────────
@pytest.fixture
def env(monkeypatch):
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        ddb.create_table(
            TableName="runstack-jobs-table", BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[{"AttributeName": n, "AttributeType": "S"} for n in ("job_id", "execution_group_id", "created_at")],
            KeySchema=[{"AttributeName": "job_id", "KeyType": "HASH"}],
            GlobalSecondaryIndexes=[{"IndexName": "execution-group-index",
                                     "KeySchema": [{"AttributeName": "execution_group_id", "KeyType": "HASH"},
                                                   {"AttributeName": "created_at", "KeyType": "RANGE"}],
                                     "Projection": {"ProjectionType": "ALL"}}])
        ddb.create_table(TableName="runstack-app-access", BillingMode="PAY_PER_REQUEST",
                         AttributeDefinitions=[{"AttributeName": "user_email", "AttributeType": "S"}, {"AttributeName": "app_id", "AttributeType": "S"}],
                         KeySchema=[{"AttributeName": "user_email", "KeyType": "HASH"}, {"AttributeName": "app_id", "KeyType": "RANGE"}])
        ddb.create_table(TableName="runstack-instance-catalog", BillingMode="PAY_PER_REQUEST",
                         AttributeDefinitions=[{"AttributeName": "instance_id", "AttributeType": "S"}, {"AttributeName": "app_id", "AttributeType": "S"}],
                         KeySchema=[{"AttributeName": "instance_id", "KeyType": "HASH"}, {"AttributeName": "app_id", "KeyType": "RANGE"}],
                         GlobalSecondaryIndexes=[{"IndexName": "app_id-index",
                                                  "KeySchema": [{"AttributeName": "app_id", "KeyType": "HASH"}, {"AttributeName": "instance_id", "KeyType": "RANGE"}],
                                                  "Projection": {"ProjectionType": "ALL"}}])
        ddb.create_table(TableName="runstack-team-capabilities", BillingMode="PAY_PER_REQUEST",
                         AttributeDefinitions=[{"AttributeName": "team", "AttributeType": "S"}, {"AttributeName": "capability", "AttributeType": "S"}],
                         KeySchema=[{"AttributeName": "team", "KeyType": "HASH"}, {"AttributeName": "capability", "KeyType": "RANGE"}])
        cat = ddb.Table("runstack-instance-catalog")
        for inst, name in ((I1, "APP-SRV-01"), (I2, "APP-SRV-02"), (I3, "DB-SRV-03")):
            cat.put_item(Item={"instance_id": inst, "app_id": "APP1" if inst != I3 else "APP2", "server_name": name})
        ddb.Table("runstack-app-access").put_item(Item={"user_email": "alice@dxc.com", "app_id": "APP1"})

        import shared
        import jobs as _jobs  # noqa: F401
        import execution_details as ed
        import notify
        shared._table = None
        ed._cache.clear(); ed._creds.clear(); ed._clients.clear()
        world = World()
        monkeypatch.setattr(ed, "own_account_id", lambda: CENTRAL)

        def fake_client(service, account, region):
            assert ed._ACCOUNT_RE.match(account) and region in ed.EXECUTION_REGIONS
            return FakeSSM(world, account, region) if service == "ssm" else FakeLogs(world, account, region)
        monkeypatch.setattr(ed, "aws_client", fake_client)

        class FakeSFN:
            def get_execution_history(self, **kw):
                world.calls.append(("get_execution_history", kw["executionArn"]))
                return {"events": world.history}
        real_client = boto3.client
        monkeypatch.setattr(ed.boto3, "client", lambda svc, *a, **k: FakeSFN() if svc == "stepfunctions" else real_client(svc, *a, **k))
        yield types.SimpleNamespace(ed=ed, shared=shared, notify=notify, world=world, table=ddb.Table("runstack-jobs-table"))


def put_job(env, job_id, inst=I1, status="RUNNING", account=ACCT, region="us-east-1", atype="SSM-RunCommand",
            dispatch=None, **extra):
    item = {"job_id": job_id, "notification_id": job_id, "account_id": account, "region": region, "resource_id": inst,
            "automation_type": atype, "status": status, "execution_id": job_id,
            "created_at": (NOW - timedelta(minutes=3)).replace(tzinfo=None).isoformat(),
            "updated_at": (NOW - timedelta(minutes=1)).replace(tzinfo=None).isoformat(),
            "automation_data": {"DocumentName": "AWS-RunShellScript", "InstanceIds": [inst], "Parameters": {"commands": ["echo hi"]}}}
    if dispatch:
        item["ssm_dispatch"] = dispatch
    item.update(extra)
    env.table.put_item(Item=item)
    return item


def event(path, qp=None, role="admin", username="AzureAD_admin@dxc.com", groups="", authorized="true", job_id="j1"):
    return {"httpMethod": "GET", "path": path, "pathParameters": {"jobId": job_id}, "queryStringParameters": qp or {},
            "requestContext": {"authorizer": {"claims": {"username": username, "runstack:role": role,
                                                        "runstack:groups": groups, "runstack:authorized": authorized}}}}


def call(env, kind, job_id="j1", qp=None, **who):
    fn = env.ed.handle_execution_details if kind == "execution" else env.ed.handle_execution_logs
    e = event(f"/jobs/{job_id}/{kind}", qp, job_id=job_id, **who)
    r = fn(e, "GET", e["path"], e["pathParameters"], e["queryStringParameters"])
    return r["statusCode"], json.loads(r["body"]), r


def rc_dispatch(cmd="cmd-1", account=ACCT, region="us-east-1"):
    return {"kind": "run_command", "command_id": cmd, "dispatch_account": account, "dispatch_region": region,
            "dispatched_at": NOW.isoformat()}


# ── 1. Single server, same region, running with live logs ───────────────────
def test_single_server_running_with_incremental_logs(env):
    put_job(env, "j1", dispatch=rc_dispatch())
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1)]
    prefix = f"cmd-1/{I1}/aws-runShellScript/"
    env.world.logs[(ACCT, "us-east-1", "/aws/ssm/runstack")] = {prefix + "stdout": [ev(i, f"line {i}") for i in range(5)],
                                                               prefix + "stderr": [ev(2, "warn!")]}
    code, body, _ = call(env, "execution")
    assert code == 200
    t = body["targets"][0]
    assert (t["status"], t["status_source"], t["output_mode"]) == ("running", "ssm", "live")
    assert t["server_name"] == "APP-SRV-01" and t["key"] == f"j1~{I1}"
    assert body["counts"]["running"] == 1 and body["counts"]["finished"] == 0
    assert body["execution"]["status"] == "running" and body["execution"]["is_active"] is True

    code, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert code == 200 and logs["status"] == "ok"
    assert [e["message"] for e in logs["events"]] == ["line 0", "line 1", "line 2", "warn!", "line 3", "line 4"]
    assert {e["stream"] for e in logs["events"]} == {"stdout", "stderr"}
    cur = logs["next_cursor"]

    # New output arrives; only the new lines come back.
    env.world.logs[(ACCT, "us-east-1", "/aws/ssm/runstack")][prefix + "stdout"].append(ev(9, "line 9"))
    code, logs2, _ = call(env, "logs", qp={"target": f"j1~{I1}", "cursor": cur})
    assert [e["message"] for e in logs2["events"]] == ["line 9"]
    # Nothing new → empty, cursor still valid.
    code, logs3, _ = call(env, "logs", qp={"target": f"j1~{I1}", "cursor": logs2["next_cursor"]})
    assert logs3["events"] == [] and logs3["status"] == "ok"
    # Reads went to the TARGET account in the job's region.
    assert all(c[1:3] == (ACCT, "us-east-1") for c in env.world.calls if c[0] in ("get_log_events", "list_command_invocations"))


def test_load_older_output_uses_backward_cursor(env, monkeypatch):
    monkeypatch.setattr(env.ed, "LOG_EVENTS_PER_STREAM", 20)
    put_job(env, "j1", dispatch=rc_dispatch())
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1)]
    name = f"cmd-1/{I1}/aws-runShellScript/stdout"
    env.world.logs[(ACCT, "us-east-1", "/aws/ssm/runstack")] = {name: [ev(i, f"l{i}") for i in range(100)]}
    _, first, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert first["events"][0]["message"] == "l60" and first["events"][-1]["message"] == "l99"  # latest 40
    _, older, _ = call(env, "logs", qp={"target": f"j1~{I1}", "direction": "backward", "cursor": first["older_cursor"]})
    assert older["events"][0]["message"] == "l20" and older["events"][-1]["message"] == "l59"
    _, oldest, _ = call(env, "logs", qp={"target": f"j1~{I1}", "direction": "backward", "cursor": older["older_cursor"]})
    assert oldest["events"][0]["message"] == "l0"
    _, done, _ = call(env, "logs", qp={"target": f"j1~{I1}", "direction": "backward", "cursor": oldest["older_cursor"]})
    assert done["events"] == [] and done["older_cursor"] is None


# ── 2. Delayed logs: no streams yet is "waiting", not a failure ─────────────
def test_waiting_for_output_and_no_logs_after_finish(env):
    put_job(env, "j1", dispatch=rc_dispatch())
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1)]
    # Log group does not exist yet (first upload has not happened).
    code, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert code == 200 and logs["status"] == "waiting" and logs["message"] == "Waiting for script output"
    assert "30 seconds" in logs["batching_note"]
    # Group exists, only stdout so far: stderr missing is not an error.
    env.world.logs[(ACCT, "us-east-1", "/aws/ssm/runstack")] = {f"cmd-1/{I1}/aws-runShellScript/stdout": [ev(1, "hello")]}
    env.ed._cache.clear()   # stream list is cached for 5 s while running
    code, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert logs["status"] == "ok" and [s["kind"] for s in logs["streams"]] == ["stdout"]
    # Finished with no streams at all → no_logs (still HTTP 200, not an execution failure).
    env.world.logs[(ACCT, "us-east-1", "/aws/ssm/runstack")] = {}
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1, "Success", code=0)]
    env.table.update_item(Key={"job_id": "j1"}, UpdateExpression="SET #s = :s", ExpressionAttributeNames={"#s": "status"},
                          ExpressionAttributeValues={":s": "COMPLETED"})
    env.ed._cache.clear()
    code, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert code == 200 and logs["status"] == "no_logs" and logs["target_status"] == "success"


def test_cloudwatch_not_enabled_shows_final_preview_only(env):
    put_job(env, "j1", status="COMPLETED", dispatch=rc_dispatch())
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1, "Success", cw=False, code=0)]
    _, body, _ = call(env, "execution", qp={"target": f"j1~{I1}"})
    assert body["selected"]["target"]["output_mode"] == "final_only"
    assert "CloudWatch output was not enabled" in body["selected"]["output_notes"][0]
    _, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert logs["status"] == "not_configured" and logs["final_output"][0]["text"] == "final preview text"


# ── 3. Failure, timeout, cancellation, delivery failure keep their detail ──
@pytest.mark.parametrize("status,detail,bucket", [
    ("Failed", "Failed", "failed"),
    ("TimedOut", "ExecutionTimedOut", "timed_out"),
    ("TimedOut", "DeliveryTimedOut", "timed_out"),
    ("Cancelled", "Cancelled", "cancelled"),
    ("Failed", "Undeliverable", "failed"),
])
def test_detailed_outcomes(env, status, detail, bucket):
    put_job(env, "j1", status="FAILED", dispatch=rc_dispatch())
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1, status, detail, code=1)]
    _, body, _ = call(env, "execution")
    t = body["targets"][0]
    assert t["status"] == bucket and t["status_detail"] == detail
    assert body["counts"][bucket] == 1 and body["counts"]["finished"] == 1
    # Outcome is stored so this finished job needs no SSM calls next time.
    stored = env.table.get_item(Key={"job_id": "j1"})["Item"]["exec_outcome"]
    assert stored["targets"][I1]["status"] == bucket
    env.world.calls.clear(); env.ed._cache.clear()
    _, body2, _ = call(env, "execution")
    assert body2["targets"][0]["status"] == bucket
    assert not [c for c in env.world.calls if c[0] == "list_command_invocations"]


# ── 4. Bulk run: explicit group, counts, progress, paging, search ───────────
def test_bulk_group_counts_and_paging(env):
    g = {"execution_group_id": "grp-hc-1", "execution_group_label": "SQL Database Health Check (3 servers)"}
    put_job(env, "j1", I1, dispatch=rc_dispatch("c1"), server_name="APP-SRV-01", **g)
    put_job(env, "j2", I2, status="FAILED", dispatch=rc_dispatch("c2"), server_name="APP-SRV-02",
            exec_outcome={"targets": {I2: {"status": "timed_out", "detail": "DeliveryTimedOut", "started_at": "", "ended_at": ""}}}, **g)
    put_job(env, "j3", I3, status="COMPLETED", dispatch=rc_dispatch("c3"), server_name="DB-SRV-03", **g)
    put_job(env, "unrelated", I1, dispatch=rc_dispatch("c9"))   # same server, same time, NOT in the group
    env.world.invocations[(ACCT, "us-east-1", "c1")] = [invocation(I1)]
    env.world.invocations[(ACCT, "us-east-1", "c3")] = [invocation(I3, "Success", code=0)]
    code, body, _ = call(env, "execution", qp={"limit": "2"})
    assert code == 200 and body["execution"]["scope"] == "group"
    assert body["execution"]["automation_name"] == "SQL Database Health Check (3 servers)"
    c = body["counts"]
    assert (c["total"], c["running"], c["timed_out"], c["success"], c["finished"]) == (3, 1, 1, 1, 2)
    assert body["execution"]["status"] == "running"
    assert len(body["targets"]) == 2 and body["next_cursor"]
    assert "unrelated" not in [t["job_id"] for t in body["targets"]]
    _, page2, _ = call(env, "execution", qp={"limit": "2", "cursor": body["next_cursor"]})
    assert [t["job_id"] for t in page2["targets"]] == ["j3"]
    # Stored outcome for j2 means no SSM call for it.
    assert ("lci_command", "c2") not in env.world.calls
    _, found, _ = call(env, "execution", qp={"q": "db-srv"})
    assert [t["job_id"] for t in found["targets"]] == ["j3"]
    _, bad, _ = call(env, "execution", qp={"status": "unsuccessful"})
    assert [t["status"] for t in bad["targets"]] == ["timed_out"]


def test_group_finished_with_failures_is_partial(env):
    g = {"execution_group_id": "grp-sch-1"}
    for jid, inst, st in (("j1", I1, "success"), ("j2", I2, "failed")):
        put_job(env, jid, inst, status="COMPLETED", dispatch=rc_dispatch(jid),
                exec_outcome={"targets": {inst: {"status": st, "detail": st, "started_at": "", "ended_at": ""}}}, **g)
    _, body, _ = call(env, "execution")
    assert body["execution"]["status"] == "partial" and body["counts"]["finished"] == 2
    assert body["execution"]["is_active"] is False


# ── 5. Cross-account and cross-region (TargetLocations) ─────────────────────
def test_cross_region_run_command_wrapper(env):
    d = {"kind": "run_command_wrapper", "automation_execution_id": "parent-1", "dispatch_account": CENTRAL,
         "dispatch_region": "us-east-1", "dispatched_at": NOW.isoformat()}
    put_job(env, "j1", account=OTHER, region="us-west-2", dispatch=d)
    env.world.automations[(CENTRAL, "us-east-1", "parent-1")] = {
        "AutomationExecutionId": "parent-1", "AutomationExecutionStatus": "InProgress",
        "StepExecutions": [{"StepName": "Run", "Action": "aws:executeAutomation", "StepStatus": "InProgress",
                            "TargetLocation": {"Accounts": [OTHER], "Regions": ["us-west-2"]}, "Outputs": {}}]}
    env.world.automations[(OTHER, "us-west-2", "child-1")] = {
        "AutomationExecutionId": "child-1", "ParentAutomationExecutionId": "parent-1", "AutomationExecutionStatus": "InProgress",
        "ExecutionStartTime": NOW - timedelta(minutes=2),
        "StepExecutions": [{"StepName": "runCommand", "Action": "aws:runCommand", "StepStatus": "InProgress",
                            "Outputs": {"CommandId": ["cmd-west"]}}]}
    env.world.invocations[(OTHER, "us-west-2", "cmd-west")] = [invocation(I1)]
    env.world.logs[(OTHER, "us-west-2", "/aws/ssm/runstack")] = {f"cmd-west/{I1}/aws-runShellScript/stdout": [ev(1, "west output")]}
    _, body, _ = call(env, "execution", qp={"target": f"j1~{I1}"})
    t = body["targets"][0]
    assert (t["account_id"], t["region"], t["status"]) == (OTHER, "us-west-2", "running")
    det = body["selected"]["details"]
    assert det["child_execution_id"] == "child-1" and det["child_location"] == {"account_id": OTHER, "region": "us-west-2"}
    assert det["command_id"] == "cmd-west"
    _, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert [e["message"] for e in logs["events"]] == ["west output"]
    locs = {(c[0], c[1], c[2]) for c in env.world.calls if len(c) >= 3}
    assert ("get_automation_execution", CENTRAL, "us-east-1") in locs              # parent in central
    assert ("describe_automation_executions", OTHER, "us-west-2") in locs          # child found in target
    assert ("get_log_events", OTHER, "us-west-2") in locs


def test_automation_steps_distinguish_running_output(env):
    d = {"kind": "automation", "automation_execution_id": "auto-1", "dispatch_account": ACCT, "dispatch_region": "us-east-1"}
    job = put_job(env, "j1", atype="SSM-Automation", dispatch=d)
    env.world.automations[(ACCT, "us-east-1", "auto-1")] = {
        "AutomationExecutionId": "auto-1", "AutomationExecutionStatus": "InProgress", "ExecutionStartTime": NOW,
        "StepExecutions": [
            {"StepName": "stopInstance", "Action": "aws:changeInstanceState", "StepStatus": "Success", "Outputs": {}},
            {"StepName": "runScript", "Action": "aws:runCommand", "StepStatus": "InProgress",
             "Outputs": {"CommandId": ["cmd-a"]}, "Inputs": {}},
            {"StepName": "notify", "Action": "aws:executeAwsApi", "StepStatus": "Pending",
             "Outputs": {"ApiToken": ["secret"]}}]}
    env.world.invocations[(ACCT, "us-east-1", "cmd-a")] = [invocation(I1)]
    _, body, _ = call(env, "execution", qp={"target": f"j1~{I1}"})
    steps = body["selected"]["steps"]
    assert [s["has_running_output"] for s in steps] == [False, True, False]
    assert steps[2]["outputs"]["ApiToken"] != ["secret"]           # sensitive output masked
    assert body["targets"][0]["current_step"] == "runScript"


# ── 6. Retrieval problems are NOT execution failures ────────────────────────
def test_permission_error_keeps_runstack_status(env):
    put_job(env, "j1", status="RUNNING", dispatch=rc_dispatch())
    env.world.fail["list_command_invocations"] = cerr("AccessDeniedException", "not authorized to perform ssm:ListCommandInvocations")
    code, body, _ = call(env, "execution")
    t = body["targets"][0]
    assert code == 200 and t["status"] == "running" and t["status_source"] == "runstack"
    assert t["retrieval_error"]["kind"] == "permission"
    code, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert code == 200 and logs["status"] == "unavailable" and "not an execution failure" in logs["message"]


def test_throttled_logs_return_429(env):
    put_job(env, "j1", dispatch=rc_dispatch())
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1)]
    env.world.logs[(ACCT, "us-east-1", "/aws/ssm/runstack")] = {}
    env.world.fail["describe_log_streams"] = cerr("ThrottlingException")
    code, logs, raw = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert code == 429 and raw["headers"]["Retry-After"] == "15" and logs["retrieval_error"]["kind"] == "throttled"


# ── 7. Authorization and untrusted input ────────────────────────────────────
def test_unauthorized_user_gets_404_and_no_aws_calls(env):
    put_job(env, "j1", I3, dispatch=rc_dispatch())         # I3 is APP2; alice only has APP1
    code, _, _ = call(env, "execution", role="viewer", username="AzureAD_alice@dxc.com")
    assert code == 404
    code, _, _ = call(env, "logs", qp={"target": f"j1~{I3}"}, role="operator", username="AzureAD_alice@dxc.com")
    assert code == 404
    assert env.world.calls == []
    code, _, _ = call(env, "execution", role="none", username="AzureAD_nobody@dxc.com", authorized="false")
    assert code == 404


def test_app_access_user_and_initiator_can_view(env):
    put_job(env, "j1", I1, dispatch=rc_dispatch())
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1)]
    assert call(env, "execution", role="viewer", username="AzureAD_alice@dxc.com")[0] == 200
    put_job(env, "j2", I3, dispatch=rc_dispatch("c2"), initiated_by="bob@dxc.com")
    env.world.invocations[(ACCT, "us-east-1", "c2")] = [invocation(I3)]
    assert call(env, "execution", job_id="j2", role="app_operator", username="AzureAD_Bob@dxc.com")[0] == 200


def test_group_hides_members_user_cannot_see(env):
    g = {"execution_group_id": "grp-1"}
    put_job(env, "j1", I1, dispatch=rc_dispatch("c1"), **g)
    put_job(env, "j2", I3, dispatch=rc_dispatch("c2"), **g)
    env.world.invocations[(ACCT, "us-east-1", "c1")] = [invocation(I1)]
    _, body, _ = call(env, "execution", role="viewer", username="AzureAD_alice@dxc.com")
    assert [t["instance_id"] for t in body["targets"]] == [I1] and body["hidden_jobs"] == 1
    # Asking for the hidden member's logs through a visible job is refused.
    code, _, _ = call(env, "logs", qp={"target": f"j2~{I3}"}, role="viewer", username="AzureAD_alice@dxc.com")
    assert code == 404


def test_browser_cannot_redirect_reads(env):
    put_job(env, "j1", I1, dispatch=rc_dispatch())
    put_job(env, "other", I2, dispatch=rc_dispatch("c2"))      # not in a group with j1
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1)]
    name = f"cmd-1/{I1}/aws-runShellScript/stdout"
    env.world.logs[(ACCT, "us-east-1", "/aws/ssm/runstack")] = {name: [ev(1, "mine")],
                                                               f"cmd-9/{I2}/x/stdout": [ev(1, "someone else's")]}
    assert call(env, "logs", qp={"target": f"other~{I2}"})[0] == 404          # target from another job
    assert call(env, "logs", qp={"target": f"j1~{I2}"})[0] == 404             # instance not in this job
    assert call(env, "logs", qp={"target": "j1~../../etc"})[0] == 400
    # A forged cursor naming another stream is ignored; only server-derived streams are read.
    forged = base64.urlsafe_b64encode(json.dumps({"f": {f"cmd-9/{I2}/x/stdout": "f:0"}}).encode()).decode().rstrip("=")
    _, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}", "cursor": forged})
    assert [e["message"] for e in logs["events"]] == ["mine"]
    # A tampered dispatch location on the job record is refused too.
    env.table.update_item(Key={"job_id": "j1"}, UpdateExpression="SET ssm_dispatch.dispatch_account = :a",
                          ExpressionAttributeValues={":a": OTHER})
    env.ed._cache.clear()
    _, body, _ = call(env, "execution")
    assert body["targets"][0]["retrieval_error"]["code"] == "DispatchLocationMismatch"


# ── 8. Jobs dispatched before the workflow change: history fallback ─────────
def test_dispatch_from_step_functions_history_is_persisted(env):
    put_job(env, "j1")
    env.world.history = [{"timestamp": NOW, "taskSucceededEventDetails": {
        "resourceType": "aws-sdk:ssm", "resource": "sendCommand", "output": json.dumps({"Command": {"CommandId": "hist-cmd"}})}}]
    env.world.invocations[(ACCT, "us-east-1", "hist-cmd")] = [invocation(I1)]
    _, body, _ = call(env, "execution")
    assert body["targets"][0]["status_source"] == "ssm"
    item = env.table.get_item(Key={"job_id": "j1"})["Item"]
    assert item["ssm_dispatch"]["command_id"] == "hist-cmd" and item["ssm_dispatch"]["dispatch_account"] == ACCT
    assert ("get_execution_history", "arn:aws:states:us-east-1:999999999999:execution:runstack-workflow:j1") in env.world.calls


def test_pending_job_without_dispatch(env):
    put_job(env, "j1", status="PENDING")
    code, body, _ = call(env, "execution")
    assert body["targets"][0]["status"] == "pending" and body["execution"]["status"] == "pending"
    _, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert logs["status"] == "waiting"


def test_ec2_status_check_has_no_output(env):
    put_job(env, "j1", atype="EC2-Action", status="COMPLETED", ec2_state="running")
    _, body, _ = call(env, "execution", qp={"target": f"j1~{I1}"})
    assert body["targets"][0]["output_mode"] == "none" and env.world.calls == []
    _, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert logs["status"] == "no_output"


# ── 9. Job creation changes ─────────────────────────────────────────────────
def test_cloudwatch_output_added_only_for_same_region_commands(env, monkeypatch):
    s = env.shared
    same = s.normalize_runcommand_data({"DocumentName": "AWS-RunShellScript", "InstanceIds": [I1]}, ACCT, "us-east-1")
    assert same["CloudWatchOutputConfig"] == {"CloudWatchLogGroupName": "/aws/ssm/runstack", "CloudWatchOutputEnabled": True}
    west = s.normalize_runcommand_data({"DocumentName": "AWS-RunShellScript", "InstanceIds": [I1]}, ACCT, "us-west-2")
    assert "CloudWatchOutputConfig" not in west
    own = s.normalize_runcommand_data({"DocumentName": "X", "InstanceIds": [I1],
                                       "CloudWatchOutputConfig": {"CloudWatchOutputEnabled": False}}, ACCT, "us-east-1")
    assert own["CloudWatchOutputConfig"] == {"CloudWatchOutputEnabled": False}
    monkeypatch.setenv("SSM_CLOUDWATCH_OUTPUT_ENABLED", "false")
    off = s.normalize_runcommand_data({"DocumentName": "AWS-RunShellScript", "InstanceIds": [I1]}, ACCT, "us-east-1")
    assert "CloudWatchOutputConfig" not in off


def test_notify_cannot_spoof_initiator_or_group(env):
    body = {"initiated_by": "ceo@dxc.com", "execution_group_id": "grp-hc-victim", "execution_group_label": "x", "resource_id": I1}
    ev_ = event("/notify", username="AzureAD_Alice@DXC.com")
    env.shared.stamp_job_origin(body, ev_)
    assert body["initiated_by"] == "alice@dxc.com" and "execution_group_id" not in body and "execution_group_label" not in body
    machine = {"requestContext": {"authorizer": {"claims": {"client_id": "abc123", "token_use": "access"}}}}
    assert env.shared.job_initiator(machine) == "client:abc123"
    t = env.shared.transform_message_data({"id": "n", "account_id": ACCT, "region": "us-east-1", "resource_id": I1,
                                           "automation_type": "EC2-Action", "automation_data": {},
                                           "initiated_by": "alice@dxc.com", "execution_group_id": "grp-sch-1"}, "jx")
    assert t["initiated_by"] == "alice@dxc.com" and t["execution_group_id"] == "grp-sch-1"


def test_router_sends_new_paths_to_execution_details(env, monkeypatch):
    import app
    seen = []
    monkeypatch.setattr(app.execution_details, "handle_execution_details", lambda *a: seen.append("exec") or {"statusCode": 200})
    monkeypatch.setattr(app.execution_details, "handle_execution_logs", lambda *a: seen.append("logs") or {"statusCode": 200})
    monkeypatch.setattr(app.jobs, "handle_job_detail", lambda *a: seen.append("detail") or {"statusCode": 200})
    for p in ("/jobs/j1/execution", "/jobs/j1/logs", "/jobs/j1"):
        app.handle_api_gateway_request({"httpMethod": "GET", "path": p, "pathParameters": {"jobId": "j1"}})
    assert seen == ["exec", "logs", "detail"]


def test_team_capability_allows_viewing_team_documents(env):
    boto3.resource("dynamodb", region_name="us-east-1").Table("runstack-team-capabilities").put_item(
        Item={"team": "gdba-sql", "capability": "sql-db-healthcheck", "enabled": True, "scope": "ALL"})
    put_job(env, "j1", I3, dispatch=rc_dispatch(),
            automation_data={"DocumentName": "SQL-Database-Healthcheck", "InstanceIds": [I3]})
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I3)]
    # GDBA team member with no RunStack role and no app access to I3.
    code, body, _ = call(env, "execution", role="none", authorized="false", username="AzureAD_dba@dxc.com",
                         groups="runstack-team-gdba-sql")
    assert code == 200 and body["targets"][0]["instance_id"] == I3
    # Someone outside the team with no app access for I3 cannot.
    assert call(env, "execution", role="viewer", username="AzureAD_alice@dxc.com")[0] == 404
    # A generic (non-team) document is NOT opened up by team membership.
    put_job(env, "j2", I3, dispatch=rc_dispatch("c2"))
    assert call(env, "execution", job_id="j2", role="none", authorized="false", username="AzureAD_dba@dxc.com",
                groups="runstack-team-gdba-sql")[0] == 404


def test_without_workflow_arn_older_jobs_are_not_errors(env, monkeypatch):
    monkeypatch.setattr(env.ed, "WORKFLOW_ARN", "")
    put_job(env, "j1", status="COMPLETED")          # older job: no ssm_dispatch
    _, body, _ = call(env, "execution")
    t = body["targets"][0]
    assert t["status"] == "success" and t["retrieval_error"] is None
    _, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert logs["status"] == "no_output" and "couldn't find the Systems Manager command" in logs["message"]
    assert not [c for c in env.world.calls if c[0] == "get_execution_history"]


def test_dispatch_error_recorded_by_workflow_is_shown_without_history(env, monkeypatch):
    monkeypatch.setattr(env.ed, "WORKFLOW_ARN", "")
    put_job(env, "j1", status="FAILED", atype="SSM-Automation",
            dispatch_error={"error": "Ssm.InvalidDocumentException", "cause": "Document SQL-HealthCheck-Bulk does not exist",
                            "step": "ExecuteSSMAutomationCommand", "at": NOW.isoformat()})
    _, body, _ = call(env, "execution", qp={"target": f"j1~{I1}"})
    assert "InvalidDocumentException" in body["targets"][0]["status_detail"]
    assert body["selected"]["details"]["workflow_error"]["step"] == "ExecuteSSMAutomationCommand"
    _, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert "does not exist" in logs["message"]


def test_final_output_when_cloudwatch_disabled_or_unreadable(env):
    put_job(env, "j1", status="COMPLETED", dispatch=rc_dispatch())
    env.world.full_output[("cmd-1", I1, "aws:runShellScript")] = {"StandardOutputContent": "line1\nline2", "StandardErrorContent": "warn"}
    # (a) CloudWatch output not enabled
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1, "Success", cw=False, code=0)]
    _, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert logs["status"] == "final_only" and logs["replace"] is True
    assert [(e["stream"], e["message"]) for e in logs["events"]] == [("stdout", "line1\nline2"), ("stderr", "warn")]
    # (b) CloudWatch enabled but reading it is denied
    env.ed._cache.clear()
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1, "Success", cw=True, code=0)]
    env.world.logs[(ACCT, "us-east-1", "/aws/ssm/runstack")] = {}
    env.world.fail["describe_log_streams"] = cerr("AccessDeniedException", "not authorized to perform logs:DescribeLogStreams")
    _, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert logs["status"] == "final_only" and logs["retrieval_error"]["kind"] == "permission"
    # (c) still running + denied → unavailable (no final output yet)
    env.ed._cache.clear()
    env.table.update_item(Key={"job_id": "j1"}, UpdateExpression="SET #s = :s", ExpressionAttributeNames={"#s": "status"},
                          ExpressionAttributeValues={":s": "RUNNING"})
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1, "InProgress")]
    _, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert logs["status"] == "unavailable"


def test_own_account_falls_back_to_lambda_credentials(monkeypatch):
    import execution_details as ed
    ed._creds.clear(); ed._clients.clear()
    monkeypatch.setattr(ed, "own_account_id", lambda: CENTRAL)

    class DenySTS:
        def assume_role(self, **kw):
            raise cerr("AccessDenied", "not authorized to perform: sts:AssumeRole")
    real = ed.boto3.client
    made = []
    monkeypatch.setattr(ed.boto3, "client", lambda svc, *a, **k: DenySTS() if svc == "sts" else made.append((svc, k)) or object())
    ed.aws_client("ssm", CENTRAL, "us-east-1")
    assert made == [("ssm", {"region_name": "us-east-1"})] and ed._creds[CENTRAL] == "own"
    with pytest.raises(ClientError):
        ed.aws_client("ssm", ACCT, "us-east-1")      # other accounts never fall back
    ed._creds.clear(); ed._clients.clear()
    monkeypatch.setattr(ed.boto3, "client", real)


def test_failure_before_ssm_shows_workflow_error(env):
    put_job(env, "j1", status="FAILED", atype="SSM-Automation")
    env.world.history = [{"timestamp": NOW, "taskFailedEventDetails": {
        "resourceType": "aws-sdk:ssm", "resource": "startAutomationExecution", "error": "Ssm.InvalidAutomationExecutionParametersException",
        "cause": "Parameter AutomationAssumeRole is required. (Service: Ssm, Status Code: 400)"}}]
    _, body, _ = call(env, "execution", qp={"target": f"j1~{I1}"})
    t = body["targets"][0]
    assert t["status"] == "failed" and "InvalidAutomationExecutionParametersException" in t["status_detail"]
    assert body["selected"]["details"]["workflow_error"]["step"] == "aws-sdk:ssm:startAutomationExecution"
    _, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert logs["status"] == "no_output" and "AutomationAssumeRole" in logs["message"]


def test_stored_job_output_is_shown_when_ssm_cannot_be_read(env):
    d = {"kind": "automation", "automation_execution_id": "auto-1", "dispatch_account": ACCT, "dispatch_region": "us-east-1"}
    put_job(env, "j1", status="COMPLETED", atype="SSM-Automation", dispatch=d,
            qualys_output="Space before zipping logs:\n/dev/xvda1 10G 9G\nFiles have been zipped.", stderr_output="")
    env.world.fail["get_automation_execution"] = cerr("AccessDeniedException", "not authorized to perform: ssm:GetAutomationExecution")
    _, body, _ = call(env, "execution", qp={"target": f"j1~{I1}"})
    assert body["selected"]["target"]["output_mode"] == "final_only"      # Output tab offered
    _, logs, _ = call(env, "logs", qp={"target": f"j1~{I1}"})
    assert logs["status"] == "final_only" and logs["source"] == "runstack_record"
    assert "Files have been zipped." in logs["events"][0]["message"]
    assert logs["retrieval_error"]["kind"] == "permission"


def test_stored_output_not_used_for_other_instances_or_running_jobs(env):
    put_job(env, "j1", status="RUNNING", dispatch=rc_dispatch(), qualys_output="partial?")
    assert env.ed._record_output(env.table.get_item(Key={"job_id": "j1"})["Item"], I1) is None
    put_job(env, "j2", status="COMPLETED", qualys_output="out")
    assert env.ed._record_output(env.table.get_item(Key={"job_id": "j2"})["Item"], I2) is None


def test_automation_name_inside_automation_data_is_used(env):
    put_job(env, "j1", status="FAILED", dispatch=rc_dispatch(), execution_group_id="grp-sch-x",
            execution_group_label="Schedule unknown",
            automation_data={"DocumentName": "AWS-RunRemoteScript", "InstanceIds": [I1],
                             "automation_name": "SQL DB  Instance Version CMDB Update"})
    env.world.invocations[(ACCT, "us-east-1", "cmd-1")] = [invocation(I1, "Failed", code=1)]
    _, body, _ = call(env, "execution")
    assert body["execution"]["automation_name"] == "SQL DB  Instance Version CMDB Update"
