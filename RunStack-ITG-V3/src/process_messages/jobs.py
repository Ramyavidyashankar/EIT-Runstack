"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code. No logic changes.
"""

from shared import *


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
            "automation_data": job.get("automation_data"),
            "execution_id": job.get("execution_id"),
            "created_at": job.get("created_at"),
            "updated_at": job.get("updated_at"),
            "ec2_state": job.get("ec2_state"),
            "exit_code": exit_code,
            "script_result": script_result,
            "output": raw_output,
            "result": {
                "qualys_installed": qualys_installed,
                "qualys_status": qualys_status
            }
        }, default=decimal_default)
    }

# ── GET /auth/callback — Cognito OAuth2 code exchange ────────
