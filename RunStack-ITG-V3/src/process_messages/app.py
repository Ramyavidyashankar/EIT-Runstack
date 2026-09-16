"""
Lambda function to process SQS messages and handle API Gateway GET requests.

This function:
- Receives messages from the RunStack notification queue, validates the payload,
  transforms the data, and stores it in the DynamoDB jobs table (SQS events)
- Handles GET requests to retrieve jobs from DynamoDB (API Gateway events)
- Handles GET /ssm/documents to list SSM documents
- Handles GET /eventbridge/schedules to list EventBridge scheduled rules
- Handles POST /instances/status — triggers async pre-check SSM command (disk, memory, etc)
- Handles GET /assess/{checkId} — polls check result and returns recommendation
- Handles POST /synthetic/execute and GET /synthetic/{jobId} — Dynatrace
  on-demand synthetic monitor execution
- Handles POST /notify-sync — synchronous status-check wrapper around the
  /notify + GET /jobs/{jobId} pattern, for Amazon Q custom plugin callers
  that only poll once

Modular layout (split from a single ~4,300-line file):
- shared.py       — constants, boto3 helpers, and business-logic functions
                     used by every handler module below
- sap_sync.py      — /notify-sync/* SAP component status checks
- notify.py        — POST /notify
- synthetic.py     — /synthetic/execute, /synthetic/{jobId}
- uploads.py       — /uploads/presign, /uploads, /uploads/{key}
- admin.py         — /admin/users, /admin/users/{username}/role
- ssm_docs.py      — /ssm/documents(/{name})
- eventbridge.py   — /eventbridge/schedules(/{name})
- jobs.py          — /jobs/dlq, /jobs/latest, /jobs/recent, /jobs/{jobId}
- auth.py          — /auth/callback, /ui/login
- instances.py     — /agent/instances, /app-instances
- tidal.py         — /tidal/apps/{AppId}/agents
- healthcheck.py   — /batch-healthcheck, /instances/status, /assess/{checkId}
- dynatrace.py     — /dynatrace/ags(/{AGName}/servers|roles(/{JobId}))
- dr_failover.py   — /dr-failover/{AGName}/config, plan, execute, approve, status
This file (app.py) stays the Lambda entry point: SQS message processing
(process_single_message) and the top-level API Gateway dispatcher
(handle_api_gateway_request), which now just routes to the modules above.
"""

from shared import *

import sap_sync
import ec2_sync
import notify
import synthetic
import uploads
import admin
import ssm_docs
import eventbridge
import jobs
import auth
import instances
import tidal
import healthcheck
import dynatrace
import dr_failover


def handle_api_gateway_request(event: Dict[str, Any]) -> Dict[str, Any]:
    import uuid

    try:
        http_method = event.get("httpMethod")
        path = event.get("path", "")
        path_parameters = event.get("pathParameters") or {}
        query_params = event.get("queryStringParameters") or {}

        logger.info(f"API Gateway request: {http_method} {path}")

        sqs = boto3.client("sqs")
        QUEUE_URL = os.getenv("QUEUE_URL")

        # ── POST /notify-sync/ec2-statuscheck ──────────────────────────
        # ── POST /notify-sync/db-status-check ───────────────────────────
        # ── POST /notify-sync/ascs-status-check ─────────────────────────
        # ── POST /notify-sync/pas-status-check ──────────────────────────
        # ── POST /notify-sync/aas-status-check ──────────────────────────
        # Named, demo-friendly wrappers around the same sync-wait pattern as
        # /notify-sync below. Each is hardcoded to its own component's
        # resource_id/script (except EC2 check, which still takes resource_id
        # since it's one check reused across all four instances). Checked
        # FIRST in this chain since they're more specific paths than the
        # generic /notify-sync further down.
        # ── POST /notify-sync/{component}-status-check/start|stop ─────────
        # Fixed-instance SAP power actions, nested under each component's
        # existing status-check path rather than new sibling routes. Checked
        # before the bare -status-check branches above since e.g.
        # "/db-status-check/start" does not match endswith("/db-status-check")
        # anyway (different suffix), but keeping the more specific paths
        # together here for readability.
        if path.endswith("/db-status-check/start") and http_method == "POST":
            return sap_sync.handle_sap_db_start(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/db-status-check/stop") and http_method == "POST":
            return sap_sync.handle_sap_db_stop(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/ascs-status-check/start") and http_method == "POST":
            return sap_sync.handle_sap_ascs_start(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/ascs-status-check/stop") and http_method == "POST":
            return sap_sync.handle_sap_ascs_stop(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/pas-status-check/start") and http_method == "POST":
            return sap_sync.handle_sap_pas_start(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/pas-status-check/stop") and http_method == "POST":
            return sap_sync.handle_sap_pas_stop(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/aas-status-check/start") and http_method == "POST":
            return sap_sync.handle_sap_aas_start(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/aas-status-check/stop") and http_method == "POST":
            return sap_sync.handle_sap_aas_stop(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/ec2-statuscheck") and http_method == "POST":
            return sap_sync.handle_ec2_statuscheck(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/db-status-check") and http_method == "POST":
            return sap_sync.handle_db_status_check(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/ascs-status-check") and http_method == "POST":
            return sap_sync.handle_ascs_status_check(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/pas-status-check") and http_method == "POST":
            return sap_sync.handle_pas_status_check(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/aas-status-check") and http_method == "POST":
            return sap_sync.handle_aas_status_check(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/notify-sync") and http_method == "POST":
            return ec2_sync.handle_notify_sync(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/notify") and http_method == "POST":
            return notify.handle_notify(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/synthetic/execute") and http_method == "POST":
            return synthetic.handle_synthetic_execute(event, http_method, path, path_parameters, query_params)
        elif "/synthetic/" in path and http_method == "GET":
            return synthetic.handle_synthetic_status(event, http_method, path, path_parameters, query_params)
        elif "/uploads/presign" in path and http_method == "POST":
            return uploads.handle_uploads_presign(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/uploads") and http_method == "GET":
            return uploads.handle_uploads_list(event, http_method, path, path_parameters, query_params)
        elif "/uploads/" in path and http_method == "DELETE":
            return uploads.handle_uploads_delete(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/admin/users") and http_method == "GET":
            return admin.handle_admin_users_list(event, http_method, path, path_parameters, query_params)
        elif "/admin/users/" in path and path.endswith("/role") and http_method == "POST":
            return admin.handle_admin_set_role(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/admin/team-capabilities") and http_method == "GET":
            return admin.handle_admin_team_capabilities_list(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/admin/team-capabilities") and http_method == "POST":
            return admin.handle_admin_team_capabilities_set(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/admin/team-capabilities") and http_method == "DELETE":
            return admin.handle_admin_team_capabilities_delete(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/admin/cognito-groups") and http_method == "GET":
            return admin.handle_admin_cognito_groups_list(event, http_method, path, path_parameters, query_params)
        elif "/admin/cognito-groups/" in path and path.endswith("/members") and http_method == "GET":
            return admin.handle_admin_cognito_group_members(event, http_method, path, path_parameters, query_params)
        elif "/ssm/documents/" in path and http_method == "GET":
            return ssm_docs.handle_ssm_document_detail(event, http_method, path, path_parameters, query_params)
        elif "/ssm/documents" in path and http_method == "GET":
            return ssm_docs.handle_ssm_documents_list(event, http_method, path, path_parameters, query_params)
        elif "/eventbridge/schedules" in path and http_method == "GET":
            return eventbridge.handle_eventbridge_list(event, http_method, path, path_parameters, query_params)
        elif "/eventbridge/schedules" in path and http_method == "POST":
            return eventbridge.handle_eventbridge_create(event, http_method, path, path_parameters, query_params)
        elif "/eventbridge/schedules/" in path and http_method == "PUT":
            return eventbridge.handle_eventbridge_update(event, http_method, path, path_parameters, query_params)
        elif "/eventbridge/schedules/" in path and http_method == "DELETE":
            return eventbridge.handle_eventbridge_delete(event, http_method, path, path_parameters, query_params)
        elif "/jobs/dlq" in path and http_method == "GET":
            return jobs.handle_jobs_dlq_list(event, http_method, path, path_parameters, query_params)
        elif "/jobs/dlq" in path and http_method == "DELETE":
            return jobs.handle_jobs_dlq_clear(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/latest"):
            return jobs.handle_jobs_latest(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/recent"):
            return jobs.handle_jobs_recent(event, http_method, path, path_parameters, query_params)
        elif "jobId" in path_parameters:
            return jobs.handle_job_detail(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/auth/callback") and http_method == "GET":
            return auth.handle_auth_callback(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/agent/instances") and http_method == "GET":
            return instances.handle_agent_instances(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/app-instances") and http_method == "GET":
            return instances.handle_app_instances(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/ui/login") and http_method == "POST":
            return auth.handle_ui_login(event, http_method, path, path_parameters, query_params)
        elif "/tidal/apps/" in path and path.endswith("/agents") and http_method == "GET":
            return tidal.handle_tidal_agents(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/batch-healthcheck") and http_method == "POST":
            return healthcheck.handle_batch_healthcheck(event, http_method, path, path_parameters, query_params)
        elif "/instances/status" in path and http_method == "POST":
            return healthcheck.handle_instances_status(event, http_method, path, path_parameters, query_params)
        elif "/assess/" in path and http_method == "GET":
            return healthcheck.handle_assess_status(event, http_method, path, path_parameters, query_params)
        elif path.endswith("/dynatrace/ags") and http_method == "GET":
            return dynatrace.handle_dynatrace_ags_list(event, http_method, path, path_parameters, query_params)
        elif "/dynatrace/ags/" in path and path.endswith("/servers") and http_method == "GET":
            return dynatrace.handle_dynatrace_ag_servers(event, http_method, path, path_parameters, query_params)
        elif "/dynatrace/ags/" in path and "/roles/" not in path and path.endswith("/roles") and http_method == "GET":
            return dynatrace.handle_dynatrace_ag_roles(event, http_method, path, path_parameters, query_params)
        elif "/dynatrace/ags/" in path and "/roles/" in path and http_method == "GET":
            return dynatrace.handle_dynatrace_ag_role_job(event, http_method, path, path_parameters, query_params)
        elif "/dr-failover/" in path and path.endswith("/config") and http_method == "GET":
            return dr_failover.handle_dr_config(event, http_method, path, path_parameters, query_params)
        elif "/dr-failover/" in path and path.endswith("/plan") and http_method == "POST":
            return dr_failover.handle_dr_plan(event, http_method, path, path_parameters, query_params)
        elif "/dr-failover/" in path and path.endswith("/execute") and http_method == "POST":
            return dr_failover.handle_dr_execute(event, http_method, path, path_parameters, query_params)
        elif "/dr-failover/" in path and path.endswith("/approve") and http_method == "POST":
            return dr_failover.handle_dr_approve(event, http_method, path, path_parameters, query_params)
        elif "/dr-failover/" in path and "/status/" in path and http_method == "GET":
            return dr_failover.handle_dr_status(event, http_method, path, path_parameters, query_params)
        # ── 404 fallthrough ───────────────────────────────────────────
        else:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Not found"})
            }

    except Exception as e:
        logger.error(f"Error processing API Gateway request: {str(e)}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Internal server error", "detail": str(e)})
        }


def process_single_message(record: Dict[str, Any]) -> bool:
    try:
        message_body = record["body"]
        logger.info(f"Processing message: {record['messageId']}")

        try:
            payload = json.loads(message_body)
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON in message body: {str(e)}")
            return False

        if not validate_message_payload(payload):
            logger.error("Message payload validation failed")
            return False

        payload = json.loads(message_body)
        job_id = payload.get("job_id", record["messageId"])

        transformed_data = transform_message_data(payload, job_id)

        if store_message_in_dynamodb(transformed_data):
            logger.info(f"Successfully processed message {record['messageId']}")
            return True
        else:
            logger.error("Failed to store message in DynamoDB")
            return False

    except Exception as e:
        logger.error(f"Unexpected error processing message: {str(e)}")
        return False


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    logger.info(f"Event source: {event.get('Records', [{}])[0].get('eventSource') if 'Records' in event else event.get('requestContext', {}).get('requestId', 'API Gateway')}")

    if "httpMethod" in event:
        logger.info(f"Full API Gateway event payload: {json.dumps(event)}")
        return handle_api_gateway_request(event)

    if "Records" not in event:
        logger.error("Unknown event type - neither SQS nor API Gateway")
        return {
            "statusCode": 400,
            "body": json.dumps({"error": "Invalid event type"}),
        }

    logger.info(f"Processing {len(event['Records'])} SQS messages")

    successful_messages = 0
    failed_messages = 0

    for record in event["Records"]:
        try:
            if process_single_message(record):
                successful_messages += 1
            else:
                failed_messages += 1
        except Exception as e:
            logger.error(f"Critical error processing record {record.get('messageId', 'unknown')}: {str(e)}")
            failed_messages += 1

    result = {
        "statusCode": 200,
        "body": {
            "processed_messages": len(event["Records"]),
            "successful_messages": successful_messages,
            "failed_messages": failed_messages,
        },
    }

    logger.info(f"Processing complete: {successful_messages} successful, {failed_messages} failed")

    if failed_messages > 0:
        raise Exception(f"Failed to process {failed_messages} messages")

    return result