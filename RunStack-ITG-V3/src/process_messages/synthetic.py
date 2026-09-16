"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code. No logic changes.
"""

from shared import *


def handle_synthetic_execute(event, http_method, path, path_parameters, query_params):

    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
    authorized = claims.get("runstack:authorized")
    if authorized == "false":
        return {
            "statusCode": 403,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "error": "forbidden",
                "message": "User is not authorized to trigger RunStack automations. Contact your RunStack administrator."
            })
        }
    if authorized is not None and claims.get("runstack:role", "none") == "viewer":
        return {
            "statusCode": 403,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "error": "forbidden",
                "message": "Your role is Viewer (read-only). Triggering checks requires Operator or Admin role."
            })
        }

    try:
        body = json.loads(event.get("body", "{}"))
        app_key = (body.get("app_id") or body.get("app_name") or body.get("app") or "").strip()
        if not app_key:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Provide app_id or app_name"})
            }

        catalog_row = resolve_dynatrace_monitor(app_key)
        if not catalog_row:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "error": "not_found",
                    "message": f"No Dynatrace monitor mapping found for '{app_key}'."
                })
            }
        catalog_monitor_names = catalog_row.get("monitor_names") or []

        fetch_token = get_dynatrace_synthetic_fetch_token()
        all_dynatrace_monitors = dynatrace_fetch_monitors_list(fetch_token)
        found, not_found = resolve_monitor_ids(catalog_monitor_names, all_dynatrace_monitors)

        if not found:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "error": "not_found",
                    "message": f"None of the mapped monitor(s) for '{app_key}' were found in Dynatrace (or disabled).",
                    "monitor_names_checked": catalog_monitor_names
                })
            }

        trigger_token = get_dynatrace_trigger_token()
        execution = dynatrace_trigger_execution(found, trigger_token)

        import uuid as _uuid
        job_id = str(_uuid.uuid4())
        table = get_dynamodb_table()
        now = datetime.utcnow().isoformat()
        table.put_item(Item={
            "job_id": job_id,
            "notification_id": job_id,
            "record_type": "Dynatrace-Synthetic",
            "status": "RUNNING",
            "app_id": catalog_row.get("app_id", ""),
            "app_name": catalog_row.get("app_name", ""),
            "monitors_triggered": [m["name"] for m in found],
            "monitors_not_found": not_found,
            "dynatrace_batch_id": execution["batch_id"],
            "dynatrace_executions": execution["executions"],
            "created_at": now,
            "updated_at": now,
        })

        logger.info(
            f"Dynatrace synthetic execution triggered: job_id={job_id}, "
            f"monitors={[m['name'] for m in found]}, not_found={not_found}"
        )

        response_body = {
            "job_id": job_id,
            "status": "RUNNING",
            "app_id": catalog_row.get("app_id", ""),
            "app_name": catalog_row.get("app_name", ""),
            "monitors_triggered": [m["name"] for m in found],
            "message": f"Triggered. Poll GET /synthetic/{job_id} for result."
        }
        if not_found:
            response_body["warning"] = f"{len(not_found)} mapped monitor(s) not found in Dynatrace and were skipped"
            response_body["monitors_not_found"] = not_found

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps(response_body)
        }
    except ValueError as e:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }
    except Exception as e:
        logger.error(f"Error triggering Dynatrace synthetic execution: {str(e)}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to trigger execution", "detail": str(e)})
        }

# ── GET /synthetic/{syntheticJobId} — poll Dynatrace execution ─

def handle_synthetic_status(event, http_method, path, path_parameters, query_params):
    try:
        job_id = path.split("/synthetic/")[-1].strip("/")
        if not job_id:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Missing job id"})
            }

        table = get_dynamodb_table()
        response = table.get_item(Key={"job_id": job_id})
        item = response.get("Item")
        if not item:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": f"Job {job_id} not found"})
            }

        if item.get("status") in ("COMPLETE", "FAILED"):
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "job_id": job_id,
                    "status": item.get("status"),
                    "monitors_triggered": item.get("monitors_triggered", []),
                    "app_id": item.get("app_id"),
                    "app_name": item.get("app_name"),
                    "result": item.get("dynatrace_result", {}),
                    "created_at": item.get("created_at"),
                    "updated_at": item.get("updated_at"),
                }, default=decimal_default)
            }

        trigger_token = get_dynatrace_trigger_token()
        combined = dynatrace_poll_all_executions(item["dynatrace_executions"], trigger_token)
        execution_stage = combined.get("executionStage", "TRIGGERED")

        if execution_stage != "EXECUTED":
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "job_id": job_id,
                    "status": "RUNNING",
                    "execution_stage": execution_stage,
                    "monitors_triggered": item.get("monitors_triggered", []),
                    "locations": combined.get("locations", []),
                }, default=decimal_default)
            }

        final_status = "COMPLETE" if combined.get("status") == "SUCCESS" else "FAILED"

        table.update_item(
            Key={"job_id": job_id},
            UpdateExpression="SET #s = :s, dynatrace_result = :r, updated_at = :ua",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":s": final_status,
                ":r": combined,
                ":ua": datetime.utcnow().isoformat(),
            }
        )

        logger.info(f"Dynatrace synthetic execution resolved: job_id={job_id}, status={final_status}")

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "job_id": job_id,
                "status": final_status,
                "monitors_triggered": item.get("monitors_triggered", []),
                "app_id": item.get("app_id"),
                "app_name": item.get("app_name"),
                "result": combined,
                "created_at": item.get("created_at"),
                "updated_at": datetime.utcnow().isoformat(),
            }, default=decimal_default)
        }
    except Exception as e:
        logger.error(f"Error polling Dynatrace synthetic execution: {str(e)}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to get execution status", "detail": str(e)})
        }

# ── POST /uploads/presign — get a presigned S3 PUT URL ────────
