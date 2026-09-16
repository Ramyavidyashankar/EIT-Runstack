"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code, except for the authorization changes
noted below.

CHANGES IN THIS VERSION:
- handle_batch_healthcheck: previously called
  require_team_capability(event, "gdba-sql", "sql-db-healthcheck")
  directly. Now calls authorize_action(event, "sql_healthcheck") instead —
  same underlying capability check and admin/operator bypass, but Layer 1
  (Azure AD group membership) is now checked first, mandatorily, naming
  the real Azure AD groups on denial.
- handle_instances_status: was completely unauthenticated (would trigger
  an SSM pre-check command against any account_id/region/resource_id
  supplied in the request body). Now gated by
  authorize_action(event, "sql_healthcheck").
- handle_assess_status: was completely unauthenticated (returned check
  results, including raw SSM output, for any check_id). Now gated by
  authorize_action(event, "sql_healthcheck").
"""

from shared import *
from shared import _fetch_sharepoint_server_list


def _dispatch_one_healthcheck(server, inst):
    """
    Build, validate, and dispatch a single healthcheck job for one already-
    resolved instance (or None if unresolved). Shared by both the bulk
    SharePoint sweep and the single-server path in handle_batch_healthcheck
    below, so there's exactly one place that builds a healthcheck job --
    not two copies that can drift out of sync (see the /execute vs
    /approve SQL-port bug for why that matters).
    """
    if not inst:
        return {
            "server_name": server,
            "instance_id": None,
            "job_id": None,
            "status": "NOT_FOUND",
        }

    job_id = str(uuid.uuid4())
    notify_payload = {
        "id": job_id,
        "account_id": inst.get("account_id", ""),
        "region": inst.get("region", ""),
        "resource_id": inst["instance_id"],
        "automation_type": "SSM-RunCommand",
        "automation_data": {
            "DocumentName": HEALTHCHECK_DOCUMENT_NAME,
            "InstanceIds": [inst["instance_id"]],
        },
        "server_name": server,
    }

    if not validate_message_payload(notify_payload):
        return {
            "server_name": server,
            "instance_id": inst["instance_id"],
            "job_id": None,
            "status": "DISPATCH_FAILED",
            "error": f"Could not build a valid job for {server} (missing account_id/region in instance catalog?)",
        }

    transformed = transform_message_data(notify_payload, job_id)
    if store_message_in_dynamodb(transformed):
        return {
            "server_name": server,
            "instance_id": inst["instance_id"],
            "job_id": job_id,
            "status": "PENDING",
        }
    else:
        return {
            "server_name": server,
            "instance_id": inst["instance_id"],
            "job_id": None,
            "status": "DISPATCH_FAILED",
            "error": "Failed to write job record to DynamoDB",
        }


def handle_batch_healthcheck(event, http_method, path, path_parameters, query_params):
    denied = authorize_action(event, "sql_healthcheck")
    if denied:
        return denied
    try:
        body = json.loads(event.get("body") or "{}")
        server_name = body.get("server_name")
        folder_override = body.get("sharepoint_folder")
        file_override = body.get("sharepoint_file")

        if not HEALTHCHECK_DOCUMENT_NAME:
            return {
                "statusCode": 500,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "HEALTHCHECK_DOCUMENT_NAME is not configured"})
            }

        instances = get_instances_for_apps(["ALL"])
        by_name = {}
        for inst in instances:
            key1 = inst.get("server_name", "").strip().lower()
            key2 = inst.get("name", "").strip().lower()
            if key1:
                by_name[key1] = inst
            if key2:
                by_name[key2] = inst

        # ── Single-server path ──────────────────────────────────────
        # Same authorize_action gate above covers this too. If server_name
        # is given, dispatch one job instead of running the full
        # SharePoint sweep -- same {total_servers, jobs} response shape as
        # the bulk path, so callers/pollers don't need separate handling.
        # Skips the SharePoint fetch entirely, since it isn't needed for a
        # single named server.
        if server_name:
            inst = by_name.get(server_name.strip().lower())
            job = _dispatch_one_healthcheck(server_name, inst)
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "total_servers": 1,
                    "jobs": [job],
                })
            }

        servers = _fetch_sharepoint_server_list(folder_override, file_override)

        jobs = []
        for server in servers:
            inst = by_name.get(server.strip().lower())
            jobs.append(_dispatch_one_healthcheck(server, inst))

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "total_servers": len(servers),
                "jobs": jobs,
            })
        }

    except Exception as e:
        logger.error(f"Error in batch healthcheck: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Batch healthcheck failed", "detail": str(e)})
        }

# ── POST /instances/status — trigger async pre-check ─────────

def handle_instances_status(event, http_method, path, path_parameters, query_params):
    denied = authorize_action(event, "sql_healthcheck")
    if denied:
        return denied
    try:
        body = json.loads(event.get("body", "{}"))
        account_id = body.get("account_id")
        region = body.get("region")
        resource_id = body.get("resource_id")
        check_type = body.get("check_type", "disk_usage")
        parameters = body.get("parameters", {})

        missing = [f for f in ["account_id", "region", "resource_id"] if not body.get(f)]
        if missing:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": f"Missing required fields: {', '.join(missing)}"})
            }

        if check_type not in ASSESS_SCRIPTS:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "error": f"Unsupported check_type: {check_type}",
                    "supported": list(ASSESS_SCRIPTS.keys())
                })
            }

        import uuid as _uuid
        check_id = f"chk-{_uuid.uuid4()}"

        command_id = trigger_assess_command(
            account_id, region, resource_id, check_type, parameters
        )

        table = get_dynamodb_table()
        table.put_item(Item={
            "job_id": check_id,
            "notification_id": check_id,
            "record_type": "ASSESS",
            "status": "RUNNING",
            "check_type": check_type,
            "account_id": account_id,
            "region": region,
            "resource_id": resource_id,
            "parameters": parameters,
            "ssm_command_id": command_id,
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
        })

        logger.info(f"Assess check started: check_id={check_id}, command_id={command_id}")

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "check_id": check_id,
                "status": "RUNNING",
                "check_type": check_type,
                "resource_id": resource_id,
                "message": f"Check started. Poll GET /assess/{check_id} for result."
            })
        }

    except ValueError as e:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }
    except Exception as e:
        logger.error(f"Error starting assess check: {str(e)}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to start check", "detail": str(e)})
        }

# ── GET /assess/{checkId} — poll check result ─────────────────

def handle_assess_status(event, http_method, path, path_parameters, query_params):
    denied = authorize_action(event, "sql_healthcheck")
    if denied:
        return denied
    try:
        check_id = path.split("/assess/")[-1].strip("/")
        if not check_id:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Missing checkId"})
            }

        table = get_dynamodb_table()
        response = table.get_item(Key={"job_id": check_id})
        item = response.get("Item")

        if not item:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": f"Check {check_id} not found"})
            }

        if item.get("status") in ("COMPLETE", "FAILED"):
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "check_id": check_id,
                    "status": item.get("status"),
                    "check_type": item.get("check_type"),
                    "resource_id": item.get("resource_id"),
                    "result": item.get("result", {}),
                    "proceed": item.get("proceed", False),
                    "reason": item.get("reason", ""),
                    "raw_output": item.get("raw_output", ""),
                    "created_at": item.get("created_at"),
                    "updated_at": item.get("updated_at"),
                }, default=decimal_default)
            }

        command_id = item.get("ssm_command_id")
        account_id = item.get("account_id")
        region = item.get("region")
        resource_id = item.get("resource_id")
        check_type = item.get("check_type")

        try:
            sts = boto3.client("sts")
            cross_account_role = os.environ.get("CROSS_ACCOUNT_ROLE_NAME", "runstack-cross-account-role")
            creds = sts.assume_role(
                RoleArn=f"arn:aws:iam::{account_id}:role/{cross_account_role}",
                RoleSessionName="runstack-assess-poll"
            )["Credentials"]

            ssm = boto3.client(
                "ssm", region_name=region,
                aws_access_key_id=creds["AccessKeyId"],
                aws_secret_access_key=creds["SecretAccessKey"],
                aws_session_token=creds["SessionToken"]
            )
            invocation = ssm.get_command_invocation(
                CommandId=command_id,
                InstanceId=resource_id
            )
            ssm_status = invocation.get("Status", "InProgress")

        except ClientError as e:
            if e.response["Error"]["Code"] == "InvocationDoesNotExist":
                return {
                    "statusCode": 200,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({
                        "check_id": check_id,
                        "status": "RUNNING",
                        "message": "SSM command pending pickup by agent"
                    })
                }
            raise

        if ssm_status in ("Pending", "InProgress", "Delayed"):
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "check_id": check_id,
                    "status": "RUNNING",
                    "ssm_status": ssm_status,
                    "message": "Check in progress"
                })
            }

        final_status = "COMPLETE" if ssm_status == "Success" else "FAILED"
        raw_output = invocation.get("StandardOutputContent", "")
        error_output = invocation.get("StandardErrorContent", "")

        result = {}
        proceed = False
        reason = ""

        if final_status == "COMPLETE":
            result = parse_assess_output(raw_output, check_type)
            proceed, reason = apply_threshold(check_type, result)
        else:
            reason = f"SSM command failed: {error_output or ssm_status}"

        table.update_item(
            Key={"job_id": check_id},
            UpdateExpression="SET #s = :s, #r = :r, proceed = :p, reason = :reason, raw_output = :raw, updated_at = :ua",
            ExpressionAttributeNames={"#s": "status", "#r": "result"},
            ExpressionAttributeValues={
                ":s": final_status,
                ":r": result,
                ":p": proceed,
                ":reason": reason,
                ":raw": raw_output,
                ":ua": datetime.utcnow().isoformat(),
            }
        )

        logger.info(f"Assess complete: check_id={check_id}, proceed={proceed}, reason={reason}")

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "check_id": check_id,
                "status": final_status,
                "check_type": check_type,
                "resource_id": resource_id,
                "result": result,
                "proceed": proceed,
                "reason": reason,
                "threshold": ASSESS_THRESHOLDS.get(check_type),
                "raw_output": raw_output,
                "created_at": item.get("created_at"),
                "updated_at": datetime.utcnow().isoformat(),
            }, default=decimal_default)
        }

    except Exception as e:
        logger.error(f"Error polling assess check: {str(e)}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to get check status", "detail": str(e)})
        }