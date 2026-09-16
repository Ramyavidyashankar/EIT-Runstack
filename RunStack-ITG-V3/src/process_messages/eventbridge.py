"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code. No logic changes.
"""

from shared import *


def handle_eventbridge_list(event, http_method, path, path_parameters, query_params):
    prefix = query_params.get("prefix", "")
    result = get_eventbridge_schedules(prefix)
    return {
        "statusCode": 200,
        "headers": CORS_HEADERS,
        "body": json.dumps(result, default=decimal_default)
    }

# ── POST /eventbridge/schedules — create new rule ─────────────

def handle_eventbridge_create(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        body = json.loads(event.get("body", "{}"))
        name = body.get("name")
        schedule_expression = body.get("schedule_expression")
        description = body.get("description", "")
        state = body.get("state", "ENABLED")
        target_arn = body.get("target_arn")
        target_input = body.get("target_input", "{}")

        if not name or not schedule_expression:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "name and schedule_expression are required"})
            }

        region = os.environ.get("AWS_REGION", "us-east-1")
        events_client = boto3.client("events", region_name=region)

        rule_response = events_client.put_rule(
            Name=name,
            ScheduleExpression=schedule_expression,
            Description=description,
            State=state
        )

        if target_arn:
            events_client.put_targets(
                Rule=name,
                Targets=[{
                    "Id": f"{name}-target",
                    "Arn": target_arn,
                    "Input": target_input
                }]
            )

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "status": "created",
                "rule_arn": rule_response.get("RuleArn"),
                "name": name
            })
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── PUT /eventbridge/schedules/{name} — update rule ───────────

def handle_eventbridge_update(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        rule_name = path.split("/eventbridge/schedules/")[-1]
        body = json.loads(event.get("body", "{}"))
        region = os.environ.get("AWS_REGION", "us-east-1")
        events_client = boto3.client("events", region_name=region)

        existing = events_client.describe_rule(Name=rule_name)

        events_client.put_rule(
            Name=rule_name,
            ScheduleExpression=body.get("schedule_expression", existing.get("ScheduleExpression", "")),
            Description=body.get("description", existing.get("Description", "")),
            State=body.get("state", existing.get("State", "ENABLED"))
        )

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"status": "updated", "name": rule_name})
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── DELETE /eventbridge/schedules/{name} — delete rule ────────

def handle_eventbridge_delete(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        rule_name = path.split("/eventbridge/schedules/")[-1]
        region = os.environ.get("AWS_REGION", "us-east-1")
        events_client = boto3.client("events", region_name=region)

        targets = events_client.list_targets_by_rule(Rule=rule_name)
        target_ids = [t["Id"] for t in targets.get("Targets", [])]
        if target_ids:
            events_client.remove_targets(Rule=rule_name, Ids=target_ids)

        events_client.delete_rule(Name=rule_name)

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"status": "deleted", "name": rule_name})
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── GET /jobs/dlq ─────────────────────────────────────────────
