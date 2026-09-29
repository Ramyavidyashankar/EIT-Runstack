"""
Triggers & Schedules — EventBridge **Rules** (events API) plus a read-only
view of EventBridge **Scheduler** schedules (scheduler API).

Two different AWS resources, kept separate on purpose:
  EventBridge Rules      events:PutRule etc. A rule is EITHER scheduled
                         (ScheduleExpression — cron evaluated in UTC, no time
                         zone) OR event-triggered (EventPattern). Targets are
                         attached separately (PutTargets). This is what
                         RunStack creates and edits.
  EventBridge Scheduler  scheduler:CreateSchedule etc. A schedule has its own
                         ScheduleExpressionTimezone, so it keeps the same local
                         wall-clock time through daylight saving. RunStack
                         lists these read-only; it does not create them.

Routes (unchanged paths):
  GET    /eventbridge/schedules[?scope=runstack|other|all][&source=scheduler]
  POST   /eventbridge/schedules              create a rule (scheduled or event)
  PUT    /eventbridge/schedules/{name}       update a rule — PRESERVES pattern,
                                             bus, role and targets not changed
  DELETE /eventbridge/schedules/{name}

Fix vs. the previous version: update called put_rule with only
ScheduleExpression/Description/State. For an event-triggered rule that sent
an empty ScheduleExpression and no EventPattern (rejected, or worse), and for
any rule it silently dropped RoleArn. put_rule replaces the rule definition,
so every field that should survive must be passed back explicitly.
"""

from shared import *

RUNSTACK_MARKERS = ("runstack",)

# Tag that marks a rule as RunStack's, whatever it is named.
#   runstack:managed = true   → always shown under RunStack rules
#   runstack:managed = false  → never shown under RunStack (overrides name/target guess)
#   no tag                    → fall back to name prefix / target ARN guess
RUNSTACK_TAG_KEY = "runstack:managed"


def _events():
    return boto3.client("events", region_name=os.environ.get("AWS_REGION", "us-east-1"))


def _bad(msg, code=400):
    return {"statusCode": code, "headers": CORS_HEADERS, "body": json.dumps({"error": msg})}


def _ok(body, code=200):
    return {"statusCode": code, "headers": CORS_HEADERS, "body": json.dumps(body, default=decimal_default)}


def _target_service(arn):
    # arn:aws:<service>:<region>:<acct>:<resource>
    parts = (arn or "").split(":")
    return parts[2] if len(parts) > 2 else ""


def _target_name(arn):
    """Readable name for a target ARN: function / state machine / queue / etc."""
    if not arn:
        return ""
    tail = arn.split(":", 5)[-1] if arn.count(":") >= 5 else arn
    for sep in ("function:", "stateMachine:", "document/", "automation-definition/", "rule/", "log-group:"):
        if sep in arn:
            return arn.split(sep, 1)[1].split(":")[0]
    return tail.split("/")[-1].split(":")[-1]


def _list_targets(events, rule_name, bus=None):
    kwargs = {"Rule": rule_name}
    if bus and bus != "default":
        kwargs["EventBusName"] = bus
    out = []
    while True:
        resp = events.list_targets_by_rule(**kwargs)
        out.extend(resp.get("Targets", []))
        if not resp.get("NextToken"):
            return out
        kwargs["NextToken"] = resp["NextToken"]


def _rule_tags(events, arn):
    """Tags on a rule as a dict, or None if they can't be read (e.g. the
    Lambda role lacks events:ListTagsForResource) — then the name/target
    guess is used instead of failing the whole listing."""
    if not arn:
        return None
    try:
        return {t["Key"]: t.get("Value", "") for t in events.list_tags_for_resource(ResourceARN=arn).get("Tags", [])}
    except ClientError as e:
        logger.warning(f"list_tags_for_resource({arn}) failed: {e.response.get('Error', {}).get('Code')}")
        return None


def _runstack_reason(rule, targets, tags=None):
    tag = ((tags or {}).get(RUNSTACK_TAG_KEY) or "").strip().lower()
    if tag in ("true", "yes", "1"):
        return f"Tagged {RUNSTACK_TAG_KEY}={tag}"
    if tag in ("false", "no", "0"):
        return None
    solution = (os.environ.get("SOLUTION_NAME") or "runstack").lower()
    markers = {solution, *RUNSTACK_MARKERS}
    name = (rule.get("Name") or "").lower()
    if any(name.startswith(m) for m in markers):
        return "Name starts with RunStack prefix"
    for t in targets:
        if any(m in (t.get("Arn") or "").lower() for m in markers):
            return f"Targets RunStack resource {_target_name(t.get('Arn'))}"
    return None


def _describe_rule_for_ui(rule, targets, tags=None):
    reason = _runstack_reason(rule, targets, tags)
    return {
        "resource_type": "rule",
        "name": rule.get("Name"),
        "arn": rule.get("Arn", ""),
        "description": rule.get("Description", ""),
        "state": rule.get("State", "UNKNOWN"),
        "kind": "scheduled" if rule.get("ScheduleExpression") else "event",
        "schedule_expression": rule.get("ScheduleExpression", ""),
        "event_pattern": rule.get("EventPattern", ""),
        "event_bus_name": rule.get("EventBusName", "default"),
        "role_arn": rule.get("RoleArn"),
        "managed_by": rule.get("ManagedBy", ""),
        "runstack_managed": bool(reason) and not rule.get("ManagedBy"),
        "runstack_reason": reason,
        "runstack_tag": (tags or {}).get(RUNSTACK_TAG_KEY),   # None = no tag (or tags unreadable)
        "targets": [{
            "id": t.get("Id"),
            "arn": _target_name(t.get("Arn")),         # kept for older UI builds (short name)
            "target_arn": t.get("Arn", ""),
            "name": _target_name(t.get("Arn")),
            "service": _target_service(t.get("Arn")),
            "input": t.get("Input", ""),
            "input_path": t.get("InputPath"),
            "has_input_transformer": "InputTransformer" in t,
            "role_arn": t.get("RoleArn"),
        } for t in targets],
    }


def list_rules(scope="all"):
    events = _events()
    out, kwargs = [], {}
    while True:
        resp = events.list_rules(**kwargs)
        for rule in resp.get("Rules", []):
            try:
                targets = _list_targets(events, rule["Name"], rule.get("EventBusName"))
            except ClientError as e:
                logger.warning(f"list_targets_by_rule({rule['Name']}) failed: {e}")
                targets = []
            item = _describe_rule_for_ui(rule, targets, _rule_tags(events, rule.get("Arn")))
            if scope == "runstack" and not item["runstack_managed"]:
                continue
            if scope == "other" and item["runstack_managed"]:
                continue
            out.append(item)
        if not resp.get("NextToken"):
            break
        kwargs["NextToken"] = resp["NextToken"]
    return out


def list_scheduler_schedules():
    """Read-only EventBridge Scheduler listing. Needs scheduler:ListSchedules
    and scheduler:GetSchedule; returns available=False if not permitted."""
    client = boto3.client("scheduler", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    out, kwargs = [], {}
    try:
        while True:
            resp = client.list_schedules(**kwargs)
            for s in resp.get("Schedules", []):
                detail = {}
                try:
                    detail = client.get_schedule(Name=s["Name"], GroupName=s.get("GroupName", "default"))
                except ClientError as e:
                    logger.warning(f"get_schedule({s['Name']}) failed: {e}")
                target = detail.get("Target") or s.get("Target") or {}
                out.append({
                    "resource_type": "scheduler",
                    "name": s.get("Name"),
                    "group": s.get("GroupName", "default"),
                    "arn": s.get("Arn", ""),
                    "state": s.get("State", "UNKNOWN"),
                    "kind": "scheduled",
                    "schedule_expression": detail.get("ScheduleExpression", ""),
                    "timezone": detail.get("ScheduleExpressionTimezone") or "UTC",
                    "description": detail.get("Description", ""),
                    "runstack_managed": any(m in (s.get("Name", "") + target.get("Arn", "")).lower() for m in RUNSTACK_MARKERS),
                    "targets": [{"target_arn": target.get("Arn", ""), "name": _target_name(target.get("Arn")),
                                 "service": _target_service(target.get("Arn")), "input": target.get("Input", "")}] if target else [],
                })
            if not resp.get("NextToken"):
                break
            kwargs["NextToken"] = resp["NextToken"]
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        logger.warning(f"EventBridge Scheduler listing unavailable: {code}")
        return {"available": False, "reason": code or str(e), "schedules": []}
    return {"available": True, "schedules": out}


# ── GET /eventbridge/schedules ────────────────────────────────

def handle_eventbridge_list(event, http_method, path, path_parameters, query_params):
    qp = query_params or {}
    try:
        if qp.get("source") == "scheduler":
            return _ok(list_scheduler_schedules())
        scope = qp.get("scope", "all")
        if scope not in ("all", "runstack", "other"):
            return _bad("scope must be runstack, other or all")
        rules = list_rules(scope)
        prefix = qp.get("prefix")
        if prefix:
            rules = [r for r in rules if r["name"].startswith(prefix)]
        return _ok({"schedules": rules, "count": len(rules), "scope": scope})
    except ClientError as e:
        return _bad(str(e), 500)


# ── Validation helpers ────────────────────────────────────────

def _validate_schedule_expression(expr):
    if not isinstance(expr, str):
        return "schedule_expression must be a string"
    expr = expr.strip()
    if expr.startswith("rate(") and expr.endswith(")"):
        parts = expr[5:-1].split()
        if len(parts) == 2 and parts[0].isdigit() and int(parts[0]) > 0 and parts[1] in (
                "minute", "minutes", "hour", "hours", "day", "days"):
            return None
        return "rate() must look like rate(5 minutes)"
    if expr.startswith("cron(") and expr.endswith(")"):
        fields = expr[5:-1].split()
        if len(fields) != 6:
            return "cron() needs 6 fields: minutes hours day-of-month month day-of-week year"
        if not ((fields[2] == "?") ^ (fields[4] == "?")):
            return "cron(): exactly one of day-of-month and day-of-week must be '?'"
        return None
    return "schedule_expression must be cron(...) or rate(...)"


def _validate_pattern(pattern):
    if isinstance(pattern, dict):
        pattern = json.dumps(pattern)
    try:
        parsed = json.loads(pattern)
    except (TypeError, ValueError):
        return None, "event_pattern must be valid JSON"
    if not isinstance(parsed, dict) or not parsed:
        return None, "event_pattern must be a non-empty JSON object"
    return json.dumps(parsed, separators=(",", ":")), None


def _validate_input(text):
    if text in (None, ""):
        return None
    try:
        json.loads(text)
        return None
    except ValueError:
        return "target input must be valid JSON"


# ── POST /eventbridge/schedules — create a rule ───────────────

def handle_eventbridge_create(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        body = json.loads(event.get("body") or "{}")
        name = (body.get("name") or "").strip()
        schedule_expression = body.get("schedule_expression")
        event_pattern = body.get("event_pattern")
        state = body.get("state", "ENABLED")
        target_arn = body.get("target_arn")
        target_input = body.get("target_input", "{}")

        if not name:
            return _bad("name is required")
        if bool(schedule_expression) == bool(event_pattern):
            return _bad("Provide either schedule_expression (scheduled rule) or event_pattern (event-triggered rule), not both")
        if state not in ("ENABLED", "DISABLED"):
            return _bad("state must be ENABLED or DISABLED")
        err = _validate_input(target_input)
        if err:
            return _bad(err)

        params = {"Name": name, "Description": body.get("description", ""), "State": state,
                  "Tags": [{"Key": RUNSTACK_TAG_KEY, "Value": "true"}]}
        if schedule_expression:
            err = _validate_schedule_expression(schedule_expression)
            if err:
                return _bad(err)
            params["ScheduleExpression"] = schedule_expression.strip()
        else:
            pattern, err = _validate_pattern(event_pattern)
            if err:
                return _bad(err)
            params["EventPattern"] = pattern

        events = _events()
        try:
            events.describe_rule(Name=name)
            return _bad(f"A rule named '{name}' already exists", 409)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") != "ResourceNotFoundException":
                raise

        rule_response = events.put_rule(**params)
        if target_arn:
            events.put_targets(Rule=name, Targets=[{"Id": f"{name}-target"[:64], "Arn": target_arn, "Input": target_input or "{}"}])
        return _ok({"status": "created", "rule_arn": rule_response.get("RuleArn"), "name": name})
    except ClientError as e:
        return _bad(str(e), 500)


# ── PUT /eventbridge/schedules/{name} — update, preserving everything else ──

def handle_eventbridge_update(event, http_method, path, path_parameters, query_params):
    """
    Body (all optional): description, state, schedule_expression (scheduled
    rules only), event_pattern (event rules only),
    target_updates: [{id, input}] — change the constant Input of an
    existing target; every other target field is kept as-is.
    runstack_managed: true/false — sets the runstack:managed tag (only the
    tag; the rule itself is not rewritten).
    Omitted fields are preserved. Switching a rule between scheduled and
    event-triggered is refused.
    """
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        import urllib.parse as _urlparse
        rule_name = _urlparse.unquote(path.split("/eventbridge/schedules/")[-1])
        body = json.loads(event.get("body") or "{}")
        events = _events()
        existing = events.describe_rule(Name=rule_name)

        if existing.get("ManagedBy"):
            return _bad(f"This rule is managed by {existing['ManagedBy']} and can't be edited here.")

        is_scheduled = bool(existing.get("ScheduleExpression"))
        if is_scheduled and body.get("event_pattern"):
            return _bad("This is a scheduled rule; it can't be given an event pattern. Create an event-triggered rule instead.")
        if not is_scheduled and body.get("schedule_expression"):
            return _bad("This is an event-triggered rule; it can't be given a schedule. Create a scheduled rule instead.")

        params = {
            "Name": rule_name,
            "Description": body.get("description", existing.get("Description", "")),
            "State": body.get("state", existing.get("State", "ENABLED")),
        }
        if params["State"] not in ("ENABLED", "DISABLED"):
            return _bad("state must be ENABLED or DISABLED")
        if existing.get("RoleArn"):
            params["RoleArn"] = existing["RoleArn"]
        if existing.get("EventBusName") and existing["EventBusName"] != "default":
            params["EventBusName"] = existing["EventBusName"]

        if is_scheduled:
            expr = body.get("schedule_expression") or existing["ScheduleExpression"]
            err = _validate_schedule_expression(expr)
            if err:
                return _bad(err)
            params["ScheduleExpression"] = expr.strip()
        else:
            if body.get("event_pattern"):
                pattern, err = _validate_pattern(body["event_pattern"])
                if err:
                    return _bad(err)
                params["EventPattern"] = pattern
            else:
                params["EventPattern"] = existing["EventPattern"]

        changes = []
        for key, label in (("Description", "description"), ("State", "state"),
                           ("ScheduleExpression", "schedule"), ("EventPattern", "event pattern")):
            if key in params and _norm(key, params[key]) != _norm(key, existing.get(key, "")):
                changes.append(label)

        # Target input changes — only for listed targets, full target kept.
        target_updates = body.get("target_updates") or []
        new_targets = []
        if target_updates:
            current = {t["Id"]: t for t in _list_targets(events, rule_name, existing.get("EventBusName"))}
            for upd in target_updates:
                tid = upd.get("id")
                if tid not in current:
                    return _bad(f"Target '{tid}' not found on this rule")
                t = dict(current[tid])
                if "InputTransformer" in t or "InputPath" in t:
                    return _bad(f"Target '{tid}' uses an input transformer/path and can't be edited here")
                new_input = upd.get("input", "")
                err = _validate_input(new_input)
                if err:
                    return _bad(err)
                if _norm("Input", new_input) != _norm("Input", t.get("Input", "")):
                    t["Input"] = new_input if new_input else "{}"
                    new_targets.append(t)
                    changes.append(f"input of target {tid}")

        tag_value = None
        if "runstack_managed" in body:
            if not isinstance(body["runstack_managed"], bool):
                return _bad("runstack_managed must be true or false")
            tag_value = "true" if body["runstack_managed"] else "false"
            current_tags = _rule_tags(events, existing.get("Arn")) or {}
            if (current_tags.get(RUNSTACK_TAG_KEY) or "").lower() == tag_value:
                tag_value = None
            else:
                changes.append("runstack tag")

        if not changes:
            return _ok({"status": "unchanged", "name": rule_name, "changes": []})

        if tag_value is not None:
            events.tag_resource(ResourceARN=existing["Arn"], Tags=[{"Key": RUNSTACK_TAG_KEY, "Value": tag_value}])

        if any(c in changes for c in ("description", "state", "schedule", "event pattern")):
            events.put_rule(**params)
        if new_targets:
            kwargs = {"Rule": rule_name, "Targets": new_targets}
            if params.get("EventBusName"):
                kwargs["EventBusName"] = params["EventBusName"]
            resp = events.put_targets(**kwargs)
            if resp.get("FailedEntryCount"):
                return _bad(f"Rule saved, but updating targets failed: {resp.get('FailedEntries')}", 500)

        return _ok({"status": "updated", "name": rule_name, "changes": changes})
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
            return _bad("Rule not found", 404)
        return _bad(str(e), 500)


def _norm(key, value):
    if key in ("EventPattern", "Input") and value:
        try:
            return json.dumps(json.loads(value), sort_keys=True, separators=(",", ":"))
        except (TypeError, ValueError):
            return value
    return (value or "").strip() if isinstance(value, str) else value


# ── DELETE /eventbridge/schedules/{name} ──────────────────────

def handle_eventbridge_delete(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        import urllib.parse as _urlparse
        rule_name = _urlparse.unquote(path.split("/eventbridge/schedules/")[-1])
        events = _events()
        existing = events.describe_rule(Name=rule_name)
        if existing.get("ManagedBy"):
            return _bad(f"This rule is managed by {existing['ManagedBy']} and can't be deleted here.")
        target_ids = [t["Id"] for t in _list_targets(events, rule_name, existing.get("EventBusName"))]
        if target_ids:
            events.remove_targets(Rule=rule_name, Ids=target_ids)
        events.delete_rule(Name=rule_name)
        return _ok({"status": "deleted", "name": rule_name})
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
            return _bad("Rule not found", 404)
        return _bad(str(e), 500)
