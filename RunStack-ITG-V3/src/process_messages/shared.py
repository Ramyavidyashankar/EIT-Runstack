"""
Shared constants, boto3 helpers, and business-logic functions used by every
handlers/*.py module. Extracted verbatim from the top portion of the
original single-file app.py — no logic changes except where noted below.

CHANGES IN THIS VERSION:
- ROLE_RANK gains "app_operator" tier (between viewer and operator).
- validate_instance_access no longer bypasses for role == "operator" —
  only "admin" bypasses app-access scoping now. This closes a gap where
  operators could act on instances outside their runstack-app-access
  grant even after the caller-side fix in ec2_sync.py.
- New: ALL_KNOWN_AZURE_GROUPS, ACTION_AUTH_CONFIG, authorize_action() —
  a single, centralized two-layer authorization helper (Azure AD group
  membership, then app-access/team-capability) used by every action
  handler, so denial messages consistently name the real Azure AD groups
  required, and no handler can ship with the check silently omitted.
"""



import json
import logging
import os
import urllib.request
from datetime import datetime
from typing import Dict, Any, List, Optional
from decimal import Decimal
import csv
import io

import boto3
from botocore.exceptions import ClientError
import urllib.request as _urllib_request
from io import BytesIO
import msal
import openpyxl
import bcrypt
import hmac
import hashlib
import base64
import time
import uuid

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

DYNAMODB_TABLE_NAME = os.getenv("DYNAMODB_TABLE_NAME")
DEFAULT_JOB_STATUS = "PENDING"
DEFAULT_LIMIT = 20
APP_ACCESS_TABLE    = os.getenv("APP_ACCESS_TABLE",    "runstack-app-access")
USER_ROLES_TABLE    = os.getenv("USER_ROLES_TABLE",    "runstack-user-roles")
INSTANCE_CATALOG_TABLE = os.getenv("INSTANCE_CATALOG_TABLE", "runstack-instance-catalog")
ACTION_LOCKS_TABLE = os.getenv("ACTION_LOCKS_TABLE", "runstack-action-locks")
ACTION_LOCK_TTL_SECONDS = int(os.getenv("ACTION_LOCK_TTL_SECONDS", "120"))
UPLOADS_S3_BUCKET = os.getenv("UPLOADS_S3_BUCKET", "")
UPLOADS_S3_PREFIX = os.getenv("UPLOADS_S3_PREFIX", "uploads/")
UPLOADS_PRESIGN_EXPIRY = int(os.getenv("UPLOADS_PRESIGN_EXPIRY", "300"))
UPLOADS_MAX_BYTES = int(os.getenv("UPLOADS_MAX_BYTES", str(100 * 1024 * 1024)))


DYNATRACE_API_URL = os.getenv("DYNATRACE_API_URL", "").rstrip("/")
DYNATRACE_FETCH_TOKEN_SECRET_ARN = os.getenv("DYNATRACE_FETCH_TOKEN_SECRET_ARN", "")
DYNATRACE_TRIGGER_TOKEN_SECRET_ARN = os.getenv("DYNATRACE_TRIGGER_TOKEN_SECRET_ARN", "")
DYNATRACE_SYNTHETIC_FETCH_TOKEN_SECRET_ARN = os.getenv("DYNATRACE_SYNTHETIC_FETCH_TOKEN_SECRET_ARN", "")
DYNATRACE_CATALOG_S3_KEY = os.getenv("DYNATRACE_CATALOG_S3_KEY", "app-catalogs/dynatrace-monitor-catalog.csv")

TIDAL_AGENT_MAPPING_TABLE = os.getenv("TIDAL_AGENT_MAPPING_TABLE", "runstack-tidal-agent-mapping")

HEALTHCHECK_DOCUMENT_NAME = os.getenv("HEALTHCHECK_DOCUMENT_NAME", "SQL-Database-Healthcheck")

DR_TEST_SQL_CREDENTIALS_SECRET_ARN = os.getenv("DR_TEST_SQL_CREDENTIALS_SECRET_ARN", "")
# Local-testing overrides only — leave unset in deployed environments so the
# Secrets Manager path below is used instead.
DR_TEST_SQL_USERNAME_LOCAL = os.getenv("DR_TEST_SQL_USERNAME", "")
DR_TEST_SQL_PASSWORD_LOCAL = os.getenv("DR_TEST_SQL_PASSWORD", "")
DR_RUN_LOG_TABLE = os.getenv("DR_RUN_LOG_TABLE", "runstack-dr-run-log")
DR_TOKENS_TABLE = os.getenv("DR_TOKENS_TABLE", "runstack-dr-confirmation-tokens")
DR_TOKEN_TTL_SECONDS = int(os.getenv("DR_TOKEN_TTL_SECONDS", "300"))
DR_ROLE_QUERY_TIMEOUT_SECONDS = int(os.getenv("DR_ROLE_QUERY_TIMEOUT_SECONDS", "60"))
DR_FAILOVER_DOCUMENT_NAME = os.getenv("DR_FAILOVER_DOCUMENT_NAME", "RunStack-DR-Failover")
RUNSTACK_APPROVE_API_BASE = os.getenv("RUNSTACK_APPROVE_API_BASE", "https://ovl7azq404.execute-api.us-east-1.amazonaws.com/v1")

DR_MAX_LOG_QUEUE_KB = int(os.getenv("DR_MAX_LOG_QUEUE_KB", "1024"))
DR_MAX_TXN_MINUTES = int(os.getenv("DR_MAX_TXN_MINUTES", "5"))
DR_CONFIRM_TIMEOUT_SEC = int(os.getenv("DR_CONFIRM_TIMEOUT_SEC", "120"))
DR_POLL_INTERVAL_SEC = int(os.getenv("DR_POLL_INTERVAL_SEC", "5"))
DR_REPLICA_OVERRIDES = json.loads(os.getenv("DR_REPLICA_OVERRIDES_JSON", "{}"))
DR_ACTION_LOCK_TTL_SECONDS = int(os.getenv("DR_ACTION_LOCK_TTL_SECONDS", "1800"))

DR_MANUAL_AGS = {
    "SANDBOX-GDBA-AG": ["c40w301187", "c40w301188", "c41w301189"],
}

GDBA_ACCESS_TABLE = os.getenv("GDBA_ACCESS_TABLE", "runstack-gdba-access")
GDBA_COGNITO_GROUP = "runstack-team-gdba"
TEAM_CAPABILITIES_TABLE = os.getenv("TEAM_CAPABILITIES_TABLE", "runstack-team-capabilities")

SHAREPOINT_CLIENT_ID = "3714121a-6755-4f28-afa7-6d8b81cacd29"
SHAREPOINT_TENANT_ID_HARDCODED = "93f33571-550f-43cf-b09f-cd331338d086"
SHAREPOINT_CLIENT_SECRET_HARDCODED = ""
SHAREPOINT_SITE_HOSTNAME_HARDCODED = "dxcportal.sharepoint.com"
SHAREPOINT_SITE_PATH_HARDCODED = "/sites/dxcitRundeck"
SHAREPOINT_FOLDER_PATH = "MSSQL Auto-update SQL Version"
SHAREPOINT_TARGET_FILE_NAME = "GDBA MSSQL Auto Version Update Details.xlsx"

SHAREPOINT_TENANT_ID = os.getenv("SHAREPOINT_TENANT_ID", "") or SHAREPOINT_TENANT_ID_HARDCODED
SHAREPOINT_APP_SECRET_ARN = os.getenv("SHAREPOINT_APP_SECRET_ARN", "")

UI_LOGINS_TABLE = os.getenv("UI_LOGINS_TABLE", "runstack-ui-logins")
UI_SESSION_SECRET = os.getenv("UI_SESSION_SECRET", "")
UI_SESSION_TTL_SECONDS = int(os.getenv("UI_SESSION_TTL_SECONDS", "28800"))

DYNATRACE_FETCH_TOKEN_HARDCODED = ""
DYNATRACE_TRIGGER_TOKEN_HARDCODED = ""
DYNATRACE_SYNTHETIC_FETCH_TOKEN_HARDCODED = ""

CORS_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
}


def decimal_default(obj):
    if isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError


_dynamodb = None
_table = None


def get_dynamodb_table():
    global _dynamodb, _table
    if _table is None:
        _dynamodb = boto3.resource("dynamodb")
        _table = _dynamodb.Table(DYNAMODB_TABLE_NAME)
    return _table


def store_message_in_dynamodb(data: Dict[str, Any]) -> bool:
    try:
        table = get_dynamodb_table()
        table.put_item(Item=data)
        logger.info(f"Successfully stored job {data['job_id']} in DynamoDB")
        return True
    except ClientError as e:
        logger.error(f"DynamoDB ClientError: {e.response['Error']['Message']}")
        return False
    except Exception as e:
        logger.error(f"Unexpected error storing in DynamoDB: {str(e)}")
        return False

def normalize_runcommand_data(
    automation_data: Dict[str, Any],
    account_id: str,
    region: str
) -> Dict[str, Any]:
    """
    Generic normalization for ALL SSM-RunCommand jobs.

    DocumentName:
        Keeps the original/source document reference (normally us-east-1).

    TargetDocumentName:
        Generated for the actual target region and used ONLY by the
        RunCommand wrapper after TargetLocations hands execution to
        the target region/account.
    """

    data = dict(automation_data or {})

    document = str(data.get("DocumentName", "")).strip()

    if not document:
        return data

    owner_account = os.getenv(
        "SSM_DOCUMENT_OWNER_ACCOUNT",
        "246314649749"
    )

    primary_region = os.getenv(
        "RUNSTACK_PRIMARY_REGION",
        "us-east-1"
    )

    # ----------------------------------------------------------
    # Extract plain document name.
    #
    # Supports:
    #
    # SQL-Database-Healthcheck
    #
    # OR
    #
    # arn:aws:ssm:us-east-1:246314649749:
    # document/SQL-Database-Healthcheck
    # ----------------------------------------------------------
    if ":document/" in document:
        document_name = document.split(":document/", 1)[1]
    else:
        document_name = document

    # ----------------------------------------------------------
    # IMPORTANT:
    # Preserve the ORIGINAL source document exactly as received.
    #
    # Example:
    #
    # arn:aws:ssm:us-east-1:246314649749:
    # document/SQL-Database-Healthcheck
    # ----------------------------------------------------------
    data["DocumentName"] = document

    # ----------------------------------------------------------
    # AWS-owned public documents (e.g. AWS-RunShellScript,
    # AWS-RunPowerShellScript, AWS-StopEC2Instance) are owned by Amazon,
    # not by owner_account or any customer account. They must always be
    # referenced by bare name — qualifying them with an account-specific
    # ARN (as the cross-account branch below does for RunStack's own
    # custom documents) produces InvalidDocumentException, since no such
    # document exists under that account's ARN namespace.
    # ----------------------------------------------------------
    is_aws_owned_document = document_name.startswith("AWS-")

    # ----------------------------------------------------------
    # Cross-region RunCommand
    # ----------------------------------------------------------
    if region != primary_region:

        # This is the document that aws:runCommand must use AFTER
        # TargetLocations has moved execution into the target region.
        #
        # Example:
        #
        # arn:aws:ssm:us-west-2:246314649749:
        # document/SQL-Database-Healthcheck
        #
        # The document must exist in that region or be shared there
        # with the target account. AWS-owned documents need no
        # qualification here either — they exist in every region under
        # their bare name already.
        if not is_aws_owned_document:
            data["TargetDocumentName"] = (
                f"arn:aws:ssm:{region}:{owner_account}:"
                f"document/{document_name}"
            )
        else:
            data.pop("TargetDocumentName", None)

        data["TargetLocations"] = [
            {
                "Accounts": [account_id],
                "Regions": [region],
                "ExecutionRoleName":
                    "AWS-SystemsManager-AutomationExecutionRole",
                "TargetLocationMaxConcurrency": "1",
                "TargetLocationMaxErrors": "1"
            }
        ]

    else:

        # Same-region execution continues using the normal
        # RunCommand path.
        data.pop("TargetDocumentName", None)
        data.pop("TargetLocations", None)

        # Cross-account SendCommand (ExecuteSSMRunCommand assumes a role
        # IN account_id) requires the fully-qualified document ARN even
        # when region == primary_region — a bare name only resolves
        # within the calling account's own namespace and raises
        # InvalidDocumentException cross-account. Same-account calls can
        # keep using the bare/original form unchanged. AWS-owned
        # documents are the one exception: they are never qualified,
        # cross-account or not, since they live in Amazon's own
        # namespace and a bare name already resolves correctly from any
        # calling account.
        if str(account_id) != str(owner_account) and not is_aws_owned_document:
            data["DocumentName"] = (
                f"arn:aws:ssm:{primary_region}:{owner_account}:"
                f"document/{document_name}"
            )

    if data.get("Parameters") is None:
        data["Parameters"] = {}

    logger.info(
        "Normalized SSM-RunCommand: "
        f"source_document={data.get('DocumentName')}, "
        f"target_document={data.get('TargetDocumentName')}, "
        f"account={account_id}, "
        f"region={region}, "
        f"target_locations={data.get('TargetLocations')}"
    )

    return data

def normalize_ssm_automation_data(
    automation_data: Dict[str, Any],
    account_id: str,
    region: str
) -> Dict[str, Any]:
    """
    Generic normalization for ALL SSM-Automation jobs, mirroring
    normalize_runcommand_data() for SSM-RunCommand.

    Fixed-template callers (e.g. Dynatrace webhooks) send the same
    automation_data shape regardless of the target's actual region:
    DocumentName always pointed at the primary region (us-east-1), no
    TargetLocations, no AutomationAssumeRole. Each Step Functions branch
    needs something different filled in before it can run:

    us-east-1 (primary) path:
        ExecuteSSMAutomationCommand is a pure pass-through of Parameters
        with no AutomationAssumeRole injection — add it here.

    Cross-region (west) path:
        ExecuteSSMAutomationCommandCrossRegion reads TargetLocations
        directly from automation_data.TargetLocations and the state
        fails immediately if it's missing. Build it here from
        account_id/region. AutomationAssumeRole must NOT be added here —
        that path injects its own fixed central role inside the state
        machine already.
    """
    data = dict(automation_data or {})

    primary_region = os.getenv("RUNSTACK_PRIMARY_REGION", "us-east-1")

    if region == primary_region:
        params = dict(data.get("Parameters") or {})
        if "AutomationAssumeRole" not in params:
            params["AutomationAssumeRole"] = [
                f"arn:aws:iam::{account_id}:role/runstack-cross-account-role"
            ]
        data["Parameters"] = params
    else:
        if not data.get("TargetLocations"):
            data["TargetLocations"] = [
                {
                    "Accounts": [account_id],
                    "Regions": [region],
                    "ExecutionRoleName": "AWS-SystemsManager-AutomationExecutionRole",
                    "TargetLocationMaxConcurrency": "1",
                    "TargetLocationMaxErrors": "1"
                }
            ]

    return data

def transform_message_data(payload: Dict[str, Any], job_id: str) -> Dict[str, Any]:
    try:

        automation_data = payload["automation_data"]

        # ------------------------------------------------------
        # Generic normalization for ALL SSM-RunCommand jobs
        # ------------------------------------------------------
        if payload["automation_type"] == "SSM-RunCommand":
            automation_data = normalize_runcommand_data(
                automation_data=automation_data,
                account_id=payload["account_id"],
                region=payload["region"]
            )

        # ------------------------------------------------------
        # Generic normalization for ALL SSM-Automation jobs
        # ------------------------------------------------------
        #if payload["automation_type"] == "SSM-Automation":
        #    automation_data = normalize_ssm_automation_data(
        #        automation_data=automation_data,
        #        account_id=payload["account_id"],
        #        region=payload["region"]
        #    )

        transformed_data = {
            "job_id": job_id,
            "notification_id": payload["id"],
            "account_id": payload["account_id"],
            "region": payload["region"],
            "resource_id": payload["resource_id"],
            "automation_type": payload["automation_type"],
            "automation_data": automation_data,
            "status": DEFAULT_JOB_STATUS,
            "execution_id": "",
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
        }

        optional_fields = [
            "problem_id",
            "account_id",
            "automation_name",
            "script_location",
            "app_id",
            "server_name",
            "environment",
            "OS",
            "app_name"
        ]

        for field in optional_fields:
            if field in payload:
                transformed_data[field] = payload[field]

        logger.info(
            f"Transformed message data for job_id: {job_id}"
        )

        return transformed_data

    except Exception as e:
        logger.error(
            f"Error transforming message data: {str(e)}"
        )
        raise


def validate_message_payload(payload: Dict[str, Any]) -> bool:
    required_fields = ["id", "account_id", "region", "resource_id", "automation_type", "automation_data"]
    try:
        for field in required_fields:
            if field not in payload:
                logger.error(f"Missing required field: {field}")
                return False

        if not isinstance(payload["account_id"], str) or len(payload["account_id"]) != 12:
            logger.error("Invalid account_id format")
            return False

        if not isinstance(payload["automation_type"], str) or payload["automation_type"] not in [
            "SSM-Automation", "SSM-RunCommand", "EC2-Action"
        ]:
            logger.error("Invalid automation_type")
            return False

        automation_data = payload["automation_data"]
        if not isinstance(automation_data, dict):
            logger.error("automation_data must be a dictionary")
            return False

        if payload["automation_type"] in ["SSM-Automation", "SSM-RunCommand"]:
            if "DocumentName" not in automation_data:
                logger.error("automation_data.DocumentName is required")
                return False

        if payload["automation_type"] == "SSM-RunCommand":
            if "InstanceIds" not in automation_data:
                logger.error("automation_data.InstanceIds is required for SSM-RunCommand")
                return False
            if not isinstance(automation_data["InstanceIds"], list):
                logger.error("automation_data.InstanceIds must be a list")
                return False

        if "Parameters" in automation_data:
            parameters = automation_data["Parameters"]
            if not isinstance(parameters, dict):
                logger.error("automation_data.Parameters must be a dictionary")
                return False
            for key, value in parameters.items():
                if not isinstance(value, list):
                    logger.error(f"Parameter '{key}' must be a list")
                    return False
                for item in value:
                    if not isinstance(item, str):
                        logger.error(f"All items in parameter '{key}' must be strings")
                        return False

        logger.info("Message payload validation successful")
        return True

    except Exception as e:
        logger.error(f"Error validating message payload: {str(e)}")
        return False


def get_job_by_id(job_id: str) -> Optional[Dict[str, Any]]:
    try:
        table = get_dynamodb_table()
        response = table.get_item(Key={"job_id": job_id})
        if "Item" in response:
            logger.info(f"Found job: {job_id}")
            return response["Item"]
        else:
            logger.info(f"Job not found: {job_id}")
            return None
    except ClientError as e:
        logger.error(f"DynamoDB ClientError: {e.response['Error']['Message']}")
        raise
    except Exception as e:
        logger.error(f"Error retrieving job: {str(e)}")
        raise


def get_latest_jobs(limit: int = DEFAULT_LIMIT) -> List[Dict[str, Any]]:
    try:
        table = get_dynamodb_table()
        response = table.scan()
        items = response.get("Items", [])
        sorted_items = sorted(items, key=lambda x: x.get("created_at", ""), reverse=True)
        result = sorted_items[:limit]
        logger.info(f"Retrieved {len(result)} latest jobs")
        return result
    except ClientError as e:
        logger.error(f"DynamoDB ClientError: {e.response['Error']['Message']}")
        raise
    except Exception as e:
        logger.error(f"Error retrieving latest jobs: {str(e)}")
        raise


def get_recent_jobs(
    limit: int = DEFAULT_LIMIT,
    last_evaluated_key: Optional[Dict[str, Any]] = None,
    status_filter: Optional[str] = None
) -> Dict[str, Any]:
    try:
        table = get_dynamodb_table()
        scan_params = {"Limit": limit}
        if last_evaluated_key:
            scan_params["ExclusiveStartKey"] = last_evaluated_key
        if status_filter:
            scan_params["FilterExpression"] = "#status = :status"
            scan_params["ExpressionAttributeNames"] = {"#status": "status"}
            scan_params["ExpressionAttributeValues"] = {":status": status_filter}
        response = table.scan(**scan_params)
        items = response.get("Items", [])
        sorted_items = sorted(items, key=lambda x: x.get("created_at", ""), reverse=True)
        result = {"jobs": sorted_items, "items": sorted_items, "count": len(sorted_items)}
        if "LastEvaluatedKey" in response:
            result["last_evaluated_key"] = response["LastEvaluatedKey"]
        logger.info(f"Retrieved {len(sorted_items)} recent jobs")
        return result
    except ClientError as e:
        logger.error(f"DynamoDB ClientError: {e.response['Error']['Message']}")
        raise
    except Exception as e:
        logger.error(f"Error retrieving recent jobs: {str(e)}")
        raise


def get_ssm_documents(doc_type: str = "Command", owner: str = "Self") -> Dict[str, Any]:
    try:
        region = os.environ.get("AWS_REGION", "us-east-1")
        ssm = boto3.client("ssm", region_name=region)

        account_id = None
        if owner in ("Self", "Private"):
            try:
                account_id = boto3.client("sts").get_caller_identity()["Account"]
            except ClientError as e:
                logger.warning(f"Could not resolve account ID for document ARNs: {e}")

        filters = [{"Key": "DocumentType", "Values": [doc_type]}]

        list_params = {
            "Filters": filters,
            "MaxResults": 50,
        }

        if owner == "Amazon":
            list_params["Filters"].append({"Key": "Owner", "Values": ["Amazon"]})
        elif owner == "Self":
            list_params["Filters"].append({"Key": "Owner", "Values": ["Self"]})
        elif owner == "Private":
            list_params["Filters"].append({"Key": "Owner", "Values": ["Private"]})

        docs = []
        response = ssm.list_documents(**list_params)

        for doc in response.get("DocumentIdentifiers", []):
            doc_name = doc.get("Name")
            docs.append({
                "name": doc_name,
                "arn": f"arn:aws:ssm:{region}:{account_id}:document/{doc_name}" if account_id else None,
                "type": doc.get("DocumentType"),
                "schema_version": doc.get("SchemaVersion"),
                "platform": doc.get("PlatformTypes", []),
                "owner": doc.get("Owner"),
                "description": doc.get("Description", ""),
                "document_format": doc.get("DocumentFormat", "JSON"),
                "target_type": doc.get("TargetType", ""),
            })

        while "NextToken" in response and len(docs) < 200:
            response = ssm.list_documents(
                **list_params,
                NextToken=response["NextToken"]
            )
            for doc in response.get("DocumentIdentifiers", []):
                doc_name = doc.get("Name")
                docs.append({
                    "name": doc_name,
                    "arn": f"arn:aws:ssm:{region}:{account_id}:document/{doc_name}" if account_id else None,
                    "type": doc.get("DocumentType"),
                    "schema_version": doc.get("SchemaVersion"),
                    "platform": doc.get("PlatformTypes", []),
                    "owner": doc.get("Owner"),
                    "description": doc.get("Description", ""),
                    "document_format": doc.get("DocumentFormat", "JSON"),
                    "target_type": doc.get("TargetType", ""),
                })

        logger.info(f"Retrieved {len(docs)} SSM documents (type={doc_type}, owner={owner})")
        return {"documents": docs, "count": len(docs)}

    except ClientError as e:
        logger.error(f"SSM ClientError: {e.response['Error']['Message']}")
        raise
    except Exception as e:
        logger.error(f"Error retrieving SSM documents: {str(e)}")
        raise


def get_eventbridge_schedules(prefix: str = "") -> Dict[str, Any]:
    try:
        region = os.environ.get("AWS_REGION", "us-east-1")
        events = boto3.client("events", region_name=region)

        solution_name = os.environ.get("SOLUTION_NAME", "runstack")
        name_prefix = prefix

        schedules = []

        list_params = {}
        if name_prefix:
            list_params["NamePrefix"] = name_prefix

        response = events.list_rules(**list_params)

        for rule in response.get("Rules", []):
            targets = []
            try:
                target_response = events.list_targets_by_rule(Rule=rule["Name"])
                for t in target_response.get("Targets", []):
                    targets.append({
                        "id": t.get("Id"),
                        "arn": t.get("Arn", "").split(":")[-1],
                        "input": t.get("Input", ""),
                    })
            except Exception:
                pass

            schedules.append({
                "name": rule.get("Name"),
                "description": rule.get("Description", ""),
                "schedule_expression": rule.get("ScheduleExpression", ""),
                "event_pattern": rule.get("EventPattern", ""),
                "state": rule.get("State", "UNKNOWN"),
                "arn": rule.get("Arn", ""),
                "targets": targets,
                "managed_by": rule.get("ManagedBy", ""),
            })

        while "NextToken" in response:
            list_params["NextToken"] = response["NextToken"]
            response = events.list_rules(**list_params)
            for rule in response.get("Rules", []):
                targets = []
                try:
                    target_response = events.list_targets_by_rule(Rule=rule["Name"])
                    for t in target_response.get("Targets", []):
                        targets.append({
                            "id": t.get("Id"),
                            "arn": t.get("Arn", "").split(":")[-1],
                            "input": t.get("Input", ""),
                        })
                except Exception:
                    pass

                schedules.append({
                    "name": rule.get("Name"),
                    "description": rule.get("Description", ""),
                    "schedule_expression": rule.get("ScheduleExpression", ""),
                    "event_pattern": rule.get("EventPattern", ""),
                    "state": rule.get("State", "UNKNOWN"),
                    "arn": rule.get("Arn", ""),
                    "targets": targets,
                    "managed_by": rule.get("ManagedBy", ""),
                })

        logger.info(f"Retrieved {len(schedules)} EventBridge schedules (prefix={name_prefix})")
        return {"schedules": schedules, "count": len(schedules)}

    except ClientError as e:
        logger.error(f"EventBridge ClientError: {e.response['Error']['Message']}")
        raise
    except Exception as e:
        logger.error(f"Error retrieving EventBridge schedules: {str(e)}")
        raise


ASSESS_THRESHOLDS = {
    "disk_usage":   85,
    "memory_usage": 90,
    "cpu_usage":    90,
}

ASSESS_SSM_DOCS = {
    "disk_usage": {"windows": "AWS-RunPowerShellScript", "linux": "AWS-RunShellScript"},
    "memory_usage": {"windows": "AWS-RunPowerShellScript", "linux": "AWS-RunShellScript"},
    "cpu_usage": {"windows": "AWS-RunPowerShellScript", "linux": "AWS-RunShellScript"},
    "service_status": {"windows": "AWS-RunPowerShellScript", "linux": "AWS-RunShellScript"},
}

ASSESS_SCRIPTS = {
    "disk_usage": {
        "windows": lambda params: [
            f"$drive = '{params.get('drive_or_path', 'C')}';",
            "$disk = Get-PSDrive $drive -ErrorAction Stop;",
            "$used = $disk.Used; $free = $disk.Free; $total = $used + $free;",
            "$usedPct = [math]::Round(($used / $total) * 100, 1);",
            "$usedGb = [math]::Round($used / 1GB, 1);",
            "$freeGb = [math]::Round($free / 1GB, 1);",
            "$totalGb = [math]::Round($total / 1GB, 1);",
            "Write-Output \"RUNSTACK_RESULT:drive=$drive,used_percent=$usedPct,used_gb=$usedGb,free_gb=$freeGb,total_gb=$totalGb\""
        ],
        "linux": lambda params: [
            f"PATH='{params.get('drive_or_path', '/')}'",
            "RESULT=$(df -BG \"$PATH\" | tail -1)",
            "USED=$(echo $RESULT | awk '{print $3}' | tr -d 'G')",
            "FREE=$(echo $RESULT | awk '{print $4}' | tr -d 'G')",
            "PCT=$(echo $RESULT | awk '{print $5}' | tr -d '%')",
            "TOTAL=$((USED + FREE))",
            "echo \"RUNSTACK_RESULT:drive=$PATH,used_percent=$PCT,used_gb=$USED,free_gb=$FREE,total_gb=$TOTAL\""
        ],
    },
    "memory_usage": {
        "windows": lambda params: [
            "$os = Get-CimInstance Win32_OperatingSystem;",
            "$total = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1);",
            "$free = [math]::Round($os.FreePhysicalMemory / 1MB, 1);",
            "$used = [math]::Round($total - $free, 1);",
            "$pct = [math]::Round(($used / $total) * 100, 1);",
            "Write-Output \"RUNSTACK_RESULT:used_percent=$pct,used_gb=$used,free_gb=$free,total_gb=$total\""
        ],
        "linux": lambda params: [
            "MEM=$(free -g | grep Mem)",
            "TOTAL=$(echo $MEM | awk '{print $2}')",
            "USED=$(echo $MEM | awk '{print $3}')",
            "FREE=$(echo $MEM | awk '{print $4}')",
            "PCT=$(awk \"BEGIN {printf \\\"%.0f\\\", ($USED/$TOTAL)*100}\")",
            "echo \"RUNSTACK_RESULT:used_percent=$PCT,used_gb=$USED,free_gb=$FREE,total_gb=$TOTAL\""
        ],
    },
    "service_status": {
        "windows": lambda params: [
            f"$svc = Get-Service -Name '{params.get('service_name', '')}' -ErrorAction SilentlyContinue;",
            "if ($svc) { $status = $svc.Status } else { $status = 'NotFound' }",
            "Write-Output \"RUNSTACK_RESULT:service={0},status=$status\" -f $svc.Name"
        ],
        "linux": lambda params: [
            f"SVC='{params.get('service_name', '')}'",
            "STATUS=$(systemctl is-active \"$SVC\" 2>/dev/null || echo 'not-found')",
            "echo \"RUNSTACK_RESULT:service=$SVC,status=$STATUS\""
        ],
    },
}


def get_instance_platform(account_id: str, region: str, instance_id: str) -> str:
    try:
        sts = boto3.client("sts")
        cross_account_role = os.environ.get("CROSS_ACCOUNT_ROLE_NAME", "runstack-cross-account-role")
        creds = sts.assume_role(
            RoleArn=f"arn:aws:iam::{account_id}:role/{cross_account_role}",
            RoleSessionName="runstack-assess-platform-check"
        )["Credentials"]

        ec2 = boto3.client(
            "ec2", region_name=region,
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"]
        )
        response = ec2.describe_instances(InstanceIds=[instance_id])
        platform = response["Reservations"][0]["Instances"][0].get("Platform", "linux")
        return "windows" if platform.lower() == "windows" else "linux"
    except Exception as e:
        logger.warning(f"Could not detect platform for {instance_id}, defaulting to linux: {e}")
        return "linux"


def trigger_assess_command(
    account_id: str, region: str, instance_id: str,
    check_type: str, parameters: dict
) -> str:
    sts = boto3.client("sts")
    cross_account_role = os.environ.get("CROSS_ACCOUNT_ROLE_NAME", "runstack-cross-account-role")
    creds = sts.assume_role(
        RoleArn=f"arn:aws:iam::{account_id}:role/{cross_account_role}",
        RoleSessionName="runstack-assess-command"
    )["Credentials"]

    ssm = boto3.client(
        "ssm", region_name=region,
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"]
    )

    platform = get_instance_platform(account_id, region, instance_id)
    doc_name = ASSESS_SSM_DOCS.get(check_type, {}).get(platform, "AWS-RunShellScript")
    script_builder = ASSESS_SCRIPTS.get(check_type, {}).get(platform)

    if not script_builder:
        raise ValueError(f"Unsupported check_type: {check_type}")

    commands = script_builder(parameters)
    param_key = "commands"

    response = ssm.send_command(
        InstanceIds=[instance_id],
        DocumentName=doc_name,
        Parameters={param_key: commands},
        Comment=f"RunStack assess: {check_type} on {instance_id}",
        TimeoutSeconds=60,
    )
    return response["Command"]["CommandId"]


def parse_assess_output(raw_output: str, check_type: str) -> dict:
    result = {}
    for line in raw_output.splitlines():
        if line.startswith("RUNSTACK_RESULT:"):
            pairs = line.replace("RUNSTACK_RESULT:", "").split(",")
            for pair in pairs:
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    try:
                        result[k.strip()] = float(v.strip()) if "." in v else int(v.strip())
                    except ValueError:
                        result[k.strip()] = v.strip()
    return result


def apply_threshold(check_type: str, result: dict) -> tuple:
    threshold = ASSESS_THRESHOLDS.get(check_type)

    if check_type in ("disk_usage", "memory_usage", "cpu_usage"):
        used_pct = result.get("used_percent", 0)
        if threshold and used_pct >= threshold:
            return True, f"{check_type.replace('_', ' ').title()} at {used_pct}% — exceeds {threshold}% threshold, action recommended"
        return False, f"{check_type.replace('_', ' ').title()} at {used_pct}% — below {threshold}% threshold, no action needed"

    if check_type == "service_status":
        status = result.get("status", "")
        service = result.get("service", "")
        if status in ("stopped", "inactive", "failed", "not-found", "NotFound"):
            return True, f"Service '{service}' is {status} — action may be needed"
        return False, f"Service '{service}' is {status} — running normally"

    return False, "Check completed"


def get_user_apps(user_email: str) -> list:
    try:
        ddb = boto3.resource("dynamodb")
        table = ddb.Table(APP_ACCESS_TABLE)
        response = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("user_email").eq(user_email)
        )
        apps = [item["app_id"] for item in response.get("Items", [])]
        logger.info(f"User {user_email} has access to apps: {apps}")
        return apps
    except Exception as e:
        logger.error(f"Error querying app access for {user_email}: {e}")
        return []


SAP_DETAILS_TABLE = os.getenv("SAP_DETAILS_TABLE", "runstack-sap-instance-details")


def get_sap_instance(sid: str, component: str) -> Optional[Dict[str, Any]]:
    """
    Lookup one SAP component's details (script paths, args, hostname, etc.)
    from runstack-sap-instance-details, keyed by sid (partition) + component
    (sort key, stored uppercase in the table regardless of caller casing).

    ADDED: this function, along with get_sap_components below, was
    referenced throughout sap_sync.py's handle_sap_action but was missing
    from this reconstructed shared.py, causing
    "name 'get_sap_instance' is not defined" in production — this is the
    fix, recovered from the original session where this table/split was
    first built.
    """
    if not sid or not component:
        return None
    try:
        ddb = boto3.resource("dynamodb")
        table = ddb.Table(SAP_DETAILS_TABLE)
        response = table.get_item(Key={"sid": sid, "component": component.upper()})
        return response.get("Item")
    except Exception as e:
        logger.error(f"Error fetching SAP instance {sid}/{component}: {e}")
        return None


def get_sap_components(sid: str) -> list:
    """
    All components registered for a given SID (e.g. DB/ASCS/PAS/AAS for
    G1D), used by handle_sap_action's "run every component for this SID"
    path when no specific component is given in the request.
    """
    if not sid:
        return []
    try:
        ddb = boto3.resource("dynamodb")
        table = ddb.Table(SAP_DETAILS_TABLE)
        response = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("sid").eq(sid)
        )
        return response.get("Items", [])
    except Exception as e:
        logger.error(f"Error fetching SAP components for {sid}: {e}")
        return []


def get_catalog_instance(instance_id: str) -> Optional[Dict[str, Any]]:
    """
    Lookup of one instance from runstack-instance-catalog by instance_id.

    IMPORTANT: this table's primary key is composite — instance_id
    (partition) + app_id (sort key) — so a plain get_item with only
    instance_id is INVALID (DynamoDB requires the full key) and throws a
    ClientError. Use query on the partition key alone instead, which only
    needs instance_id, and take the first (should be only) match.

    An earlier version of this function used get_item with only
    instance_id, which silently failed (caught by the broad except below,
    returning None) for every real lookup — producing misleading
    "instance not in catalog" / "unrecognized environment" errors even
    when the catalog data was completely correct. This is the fix.
    """
    if not instance_id:
        return None
    try:
        ddb = boto3.resource("dynamodb")
        table = ddb.Table(INSTANCE_CATALOG_TABLE)
        response = table.query(
            KeyConditionExpression=boto3.dynamodb.conditions.Key("instance_id").eq(instance_id)
        )
        items = response.get("Items", [])
        return items[0] if items else None
    except Exception as e:
        logger.error(f"Error fetching catalog instance {instance_id}: {e}")
        return None


def get_instances_for_apps(app_ids: list) -> list:
    try:
        ddb = boto3.resource("dynamodb")
        table = ddb.Table(INSTANCE_CATALOG_TABLE)

        if "ALL" in app_ids:
            items = []
            response = table.scan()
            items.extend(response.get("Items", []))
            while "LastEvaluatedKey" in response:
                response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
                items.extend(response.get("Items", []))
            return items

        instances = []
        for app_id in app_ids:
            # Follow LastEvaluatedKey, same as the scan above — one query
            # page stops at 1 MB.
            kwargs = {
                "IndexName": "app_id-index",
                "KeyConditionExpression": boto3.dynamodb.conditions.Key("app_id").eq(app_id),
            }
            while True:
                response = table.query(**kwargs)
                instances.extend(response.get("Items", []))
                if not response.get("LastEvaluatedKey"):
                    break
                kwargs["ExclusiveStartKey"] = response["LastEvaluatedKey"]

        seen = set()
        unique = []
        for i in instances:
            if i["instance_id"] not in seen:
                seen.add(i["instance_id"])
                unique.append(i)

        logger.info(f"Found {len(unique)} instances for apps: {app_ids}")
        return unique
    except Exception as e:
        logger.error(f"Error querying instance catalog: {e}")
        return []


def _resolve_sharepoint_client_secret() -> str:
    if SHAREPOINT_CLIENT_SECRET_HARDCODED:
        return SHAREPOINT_CLIENT_SECRET_HARDCODED

    local_secret = os.getenv("SHAREPOINT_CLIENT_SECRET", "")
    if local_secret:
        return local_secret

    if not SHAREPOINT_APP_SECRET_ARN:
        raise ValueError("SHAREPOINT_APP_SECRET_ARN is not configured (and no hardcoded/env override set)")
    secrets = boto3.client("secretsmanager")
    secret = secrets.get_secret_value(SecretId=SHAREPOINT_APP_SECRET_ARN)
    return json.loads(secret["SecretString"])["client_secret"]


def _fetch_sharepoint_server_list(folder_path: str = None, file_name: str = None) -> list:
    folder_path = folder_path or SHAREPOINT_FOLDER_PATH
    file_name = file_name or SHAREPOINT_TARGET_FILE_NAME
    client_secret = _resolve_sharepoint_client_secret()

    app = msal.ConfidentialClientApplication(
        SHAREPOINT_CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{SHAREPOINT_TENANT_ID}",
        client_credential=client_secret,
    )
    token_result = app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    if "access_token" not in token_result:
        raise RuntimeError(f"SharePoint Graph auth failed: {token_result}")

    headers = {"Authorization": f"Bearer {token_result['access_token']}"}

    site_req = _urllib_request.Request(
        f"https://graph.microsoft.com/v1.0/sites/{SHAREPOINT_SITE_HOSTNAME_HARDCODED}:{SHAREPOINT_SITE_PATH_HARDCODED}",
        headers=headers,
    )
    with _urllib_request.urlopen(site_req) as r:
        site_id = json.loads(r.read())["id"]

    from urllib.parse import quote
    graph_path = quote(f"{folder_path}/{file_name}")
    file_req = _urllib_request.Request(
        f"https://graph.microsoft.com/v1.0/sites/{site_id}/drive/root:/{graph_path}:/content",
        headers=headers,
    )
    with _urllib_request.urlopen(file_req) as r:
        file_bytes = r.read()

    wb = openpyxl.load_workbook(BytesIO(file_bytes), data_only=True)
    ws = wb.active
    header_row = [c.value for c in ws[1]]
    col_idx = header_row.index("Computer Name")

    servers = set()
    for row in ws.iter_rows(min_row=2, values_only=True):
        val = row[col_idx]
        if val:
            servers.add(str(val).strip())
    return sorted(servers)


def record_app_access_usage(user_email: str, app_id: str) -> None:
    """
    Best-effort stamp of last_used_at on the matching runstack-app-access
    row, so a stale grant (never actually used) is visible during periodic
    access review. Called only when access is genuinely exercised (a real
    authorization success), not on every listing/view — this is meant to
    answer "has this grant ever been used," not "was it queried."
    Failures here are logged and swallowed — a usage-tracking write should
    never block or fail the actual authorization decision.
    """
    try:
        ddb = boto3.resource("dynamodb")
        table = ddb.Table(APP_ACCESS_TABLE)
        table.update_item(
            Key={"user_email": user_email, "app_id": app_id},
            UpdateExpression="SET last_used_at = :now",
            ExpressionAttributeValues={":now": datetime.utcnow().isoformat()},
        )
    except Exception as e:
        logger.warning(f"Could not record app-access usage for {user_email}/{app_id}: {e}")


def validate_instance_access(user_email: str, instance_id: str, role: str) -> bool:
    """
    CHANGED: only "admin" bypasses app-access scoping now. "operator" used
    to bypass here too, which meant a plain operator could act on ANY
    instance regardless of their runstack-app-access rows — even after
    fixing the caller-side condition in ec2_sync.py to route operators
    into this function at all, this second bypass silently defeated the
    fix. Operators (and app_operator) now always go through the app-access
    lookup below, same as any other non-admin role.

    Also now records last_used_at on the matching app-access row whenever
    access is actually granted, via record_app_access_usage() above.
    """
    if role == "admin":
        return True

    user_apps = get_user_apps(user_email)
    if not user_apps:
        return False

    if "ALL" in user_apps:
        record_app_access_usage(user_email, "ALL")
        return True

    ddb = boto3.resource("dynamodb")
    table = ddb.Table(INSTANCE_CATALOG_TABLE)
    for app_id in user_apps:
        try:
            resp = table.query(
                IndexName="app_id-index",
                KeyConditionExpression=boto3.dynamodb.conditions.Key("app_id").eq(app_id)
                    & boto3.dynamodb.conditions.Key("instance_id").eq(instance_id)
            )
            if resp.get("Items"):
                record_app_access_usage(user_email, app_id)
                return True
        except Exception:
            pass
    return False


import re as _re

_SAFE_NAME_RE = _re.compile(r"[^A-Za-z0-9._\-]")

def acquire_action_lock(resource_id: str, user_email: str, job_id: str, ttl_seconds: int = None) -> Optional[Dict[str, Any]]:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(ACTION_LOCKS_TABLE)
    now = datetime.utcnow()
    expires_at = int(time.time()) + (ttl_seconds if ttl_seconds is not None else ACTION_LOCK_TTL_SECONDS)

    try:
        table.put_item(
            Item={
                "resource_id": resource_id,
                "locked_by": user_email,
                "job_id": job_id,
                "locked_at": now.isoformat(),
                "expires_at": expires_at,
            },
            ConditionExpression="attribute_not_exists(resource_id) OR expires_at < :now",
            ExpressionAttributeValues={":now": int(time.time())},
        )
        return None
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            existing = table.get_item(Key={"resource_id": resource_id}).get("Item", {})
            return {
                "locked_by": existing.get("locked_by", "unknown"),
                "locked_at": existing.get("locked_at", "unknown"),
            }
        raise

def check_and_acquire_lock(event, lock_key, ttl_seconds=None, job_id="n/a (debounce lock)"):
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
    username = claims.get("username", "")
    user_email = username.replace("AzureAD_", "") if username.startswith("AzureAD_") else claims.get("email", username)
    user_email = user_email or "unknown"

    lock_conflict = acquire_action_lock(lock_key, user_email, job_id=job_id, ttl_seconds=ttl_seconds)
    if lock_conflict and lock_conflict.get("locked_by") != user_email:
        return lock_conflict
    return None

def release_action_lock(resource_id: str) -> None:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(ACTION_LOCKS_TABLE)
    table.delete_item(Key={"resource_id": resource_id})

def _sanitize_filename(name: str) -> str:
    name = name.replace("\\", "/").split("/")[-1].strip()
    name = _SAFE_NAME_RE.sub("_", name)
    return name[:200] or "file"


def create_presigned_upload(filename: str, content_type: str, user_email: str) -> Dict[str, Any]:
    if not UPLOADS_S3_BUCKET:
        raise ValueError("Uploads are not configured (UPLOADS_S3_BUCKET is not set)")

    import uuid as _uuid
    safe_name = _sanitize_filename(filename or "file")
    date_prefix = datetime.utcnow().strftime("%Y/%m/%d")
    key = f"{UPLOADS_S3_PREFIX.rstrip('/')}/{date_prefix}/{_uuid.uuid4().hex[:10]}-{safe_name}"

    s3 = boto3.client("s3")
    put_url = s3.generate_presigned_url(
        ClientMethod="put_object",
        Params={
            "Bucket": UPLOADS_S3_BUCKET,
            "Key": key,
            "ContentType": content_type or "application/octet-stream",
        },
        ExpiresIn=UPLOADS_PRESIGN_EXPIRY,
    )
    logger.info(f"Issued presigned upload URL for key={key} user={user_email}")
    return {
        "upload_url": put_url,
        "key": key,
        "bucket": UPLOADS_S3_BUCKET,
        "expires_in": UPLOADS_PRESIGN_EXPIRY,
        "max_bytes": UPLOADS_MAX_BYTES,
        "required_headers": {"Content-Type": content_type or "application/octet-stream"},
    }


def list_uploads(prefix: str = "") -> Dict[str, Any]:
    if not UPLOADS_S3_BUCKET:
        raise ValueError("Uploads are not configured (UPLOADS_S3_BUCKET is not set)")

    s3 = boto3.client("s3")
    full_prefix = f"{UPLOADS_S3_PREFIX.rstrip('/')}/"
    if prefix:
        full_prefix += _sanitize_filename(prefix).lstrip("/")

    files = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=UPLOADS_S3_BUCKET, Prefix=full_prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith("/"):
                continue
            download_url = s3.generate_presigned_url(
                ClientMethod="get_object",
                Params={"Bucket": UPLOADS_S3_BUCKET, "Key": key},
                ExpiresIn=UPLOADS_PRESIGN_EXPIRY,
            )
            files.append({
                "key": key,
                "filename": key.split("/")[-1],
                "size": obj["Size"],
                "last_modified": obj["LastModified"].isoformat(),
                "download_url": download_url,
            })

    files.sort(key=lambda f: f["last_modified"], reverse=True)
    return {"files": files, "count": len(files)}


def delete_upload(key: str) -> None:
    if not UPLOADS_S3_BUCKET:
        raise ValueError("Uploads are not configured (UPLOADS_S3_BUCKET is not set)")

    full_prefix = f"{UPLOADS_S3_PREFIX.rstrip('/')}/"
    if not key.startswith(full_prefix):
        raise ValueError("Refusing to delete object outside the uploads prefix")

    s3 = boto3.client("s3")
    s3.delete_object(Bucket=UPLOADS_S3_BUCKET, Key=key)


ROLE_RANK = {"admin": 4, "operator": 3, "app_operator": 2, "viewer": 1, "none": 0}


def get_claims_and_role(event: Dict[str, Any]) -> tuple:
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})

    if not claims.get("username") and claims.get("token_use") == "access":
        return claims, "admin"   # changed from "operator" — admin is the only
                                   # role that bypasses per-instance app-access
                                   # scoping, and a machine caller has no stable
                                   # user_email to register an app-access row for

    role = claims.get("runstack:role", "none")
    return claims, role


def require_role(event: Dict[str, Any], min_role: str) -> Optional[Dict[str, Any]]:
    claims, role = get_claims_and_role(event)
    if ROLE_RANK.get(role, 0) < ROLE_RANK.get(min_role, 99):
        username = claims.get("username", "unknown")
        logger.warning(f"User {username} (role={role}) denied — requires role>={min_role}")
        return {
            "statusCode": 403,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "error": "forbidden",
                "message": f"This action requires the '{min_role}' role or higher. Your role: {role}."
            })
        }
    return None


def is_gdba_member(claims: Dict[str, Any]) -> bool:
    groups = [g.strip() for g in claims.get("runstack:groups", "").split(",") if g.strip()]
    return GDBA_COGNITO_GROUP in groups


def get_gdba_capability(capability: str) -> Optional[Dict[str, Any]]:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(GDBA_ACCESS_TABLE)
    return table.get_item(Key={"capability": capability}).get("Item")


def require_gdba_capability(event: Dict[str, Any], capability: str, resource_id: str = None) -> Optional[Dict[str, Any]]:
    claims, role = get_claims_and_role(event)
    if ROLE_RANK.get(role, 0) >= ROLE_RANK.get("operator", 99):
        return None

    username = claims.get("username", "unknown")

    if not is_gdba_member(claims):
        logger.warning(f"User {username} (role={role}) denied — not in {GDBA_COGNITO_GROUP} and role < operator")
        return {
            "statusCode": 403,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "error": "forbidden",
                "message": f"This action requires the 'operator' role, or GDBA team membership with '{capability}' access."
            })
        }

    item = get_gdba_capability(capability)
    if not item or not item.get("enabled"):
        logger.warning(f"User {username} denied — GDBA capability '{capability}' not enabled")
        return {
            "statusCode": 403,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "forbidden", "message": f"GDBA capability '{capability}' is not enabled."})
        }

    scope = item.get("scope")
    allowed = scope == "ALL" or (resource_id is not None and isinstance(scope, list) and resource_id in scope)
    if not allowed:
        logger.warning(f"User {username} denied — GDBA capability '{capability}' not scoped for resource '{resource_id}'")
        return {
            "statusCode": 403,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "forbidden", "message": f"GDBA '{capability}' access does not include '{resource_id}'."})
        }
    return None


# ── Generic team capability checks (runstack-team-capabilities) ────────────
# Generalized version of the GDBA-only pattern above. New teams onboard by
# adding rows to runstack-team-capabilities — no code or template change.
# The existing is_gdba_member / get_gdba_capability / require_gdba_capability
# functions above are unchanged and keep reading rCsaGdbaAccessTable directly;
# use these for any *new* team capability checks going forward.

_TEAM_META_CACHE: Dict[str, Dict[str, Any]] = {}


def get_team_meta(team: str) -> Optional[Dict[str, Any]]:
    if team in _TEAM_META_CACHE:
        return _TEAM_META_CACHE[team]
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(TEAM_CAPABILITIES_TABLE)
    item = table.get_item(Key={"team": team, "capability": "_meta"}).get("Item")
    if item:
        _TEAM_META_CACHE[team] = item
    return item


def is_in_any_team(claims: Dict[str, Any]) -> bool:
    """
    True if the caller is a member of ANY runstack-team-* Cognito group,
    regardless of which team. Used only to grant full instance-catalog
    VISIBILITY (see servers across all apps) — e.g. GDBA SQL/Oracle DBAs
    who manage database servers spread across many different applications,
    not tied to one app_id. Action-level authorization is unaffected:
    require_team_capability() still gates DR Failover/Healthcheck per
    team+capability+scope, and validate_instance_access() still requires
    an explicit app_id grant for EC2 start/stop.

    Only recognizes the runstack-team-{team} naming convention — a team
    using a custom _meta cognito_group override that doesn't start with
    "runstack-team-" won't be picked up here.
    """
    groups = [g.strip() for g in claims.get("runstack:groups", "").split(",") if g.strip()]
    return any(g.startswith("runstack-team-") for g in groups)


def is_team_member(claims: Dict[str, Any], team: str) -> bool:
    meta = get_team_meta(team)
    cognito_group = meta.get("cognito_group") if meta else f"runstack-team-{team}"
    groups = [g.strip() for g in claims.get("runstack:groups", "").split(",") if g.strip()]
    return cognito_group in groups


def list_cognito_groups() -> Dict[str, Any]:
    """
    Real ListGroups call against the actual user pool — used so the "Edit
    group" picker in Users & Roles shows groups that genuinely exist in
    Cognito, instead of a free-text field guessing at a runstack-team-{team}
    naming convention that was never verified against anything.
    """
    user_pool_id = os.getenv("COGNITO_USER_POOL_ID")
    if not user_pool_id:
        raise ValueError("COGNITO_USER_POOL_ID is not configured")

    client = boto3.client("cognito-idp")
    groups = []
    kwargs = {"UserPoolId": user_pool_id, "Limit": 60}
    while True:
        resp = client.list_groups(**kwargs)
        for g in resp.get("Groups", []):
            groups.append({
                "group_name": g.get("GroupName"),
                "description": g.get("Description", ""),
            })
        token = resp.get("NextToken")
        if not token:
            break
        kwargs["NextToken"] = token

    groups.sort(key=lambda g: g["group_name"].lower())
    return {"groups": groups, "count": len(groups)}


def list_cognito_group_members(group_name: str) -> Dict[str, Any]:
    """
    Real ListUsersInGroup call — who is actually in a given Cognito group,
    e.g. runstack-admins/runstack-operators/runstack-app-operators/
    runstack-readonly (legacy role fallback) or a team's
    runstack-team-{team} group. Returns email where available (falls back
    to the raw Cognito username, e.g. AzureAD_x@y.com).
    """
    if not group_name:
        raise ValueError("group_name is required")
    user_pool_id = os.getenv("COGNITO_USER_POOL_ID")
    if not user_pool_id:
        raise ValueError("COGNITO_USER_POOL_ID is not configured")

    client = boto3.client("cognito-idp")
    members = []
    kwargs = {"UserPoolId": user_pool_id, "GroupName": group_name, "Limit": 60}
    while True:
        resp = client.list_users_in_group(**kwargs)
        for u in resp.get("Users", []):
            attrs = {a["Name"]: a["Value"] for a in u.get("Attributes", [])}
            username = u.get("Username", "")
            email = attrs.get("email") or (username[len("AzureAD_"):] if username.startswith("AzureAD_") else username)
            members.append({"username": username, "email": email, "enabled": u.get("Enabled", True)})
        token = resp.get("NextToken")
        if not token:
            break
        kwargs["NextToken"] = token

    members.sort(key=lambda m: (m["email"] or "").lower())
    return {"group_name": group_name, "members": members, "count": len(members)}


def get_team_capability(team: str, capability: str) -> Optional[Dict[str, Any]]:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(TEAM_CAPABILITIES_TABLE)
    return table.get_item(Key={"team": team, "capability": capability}).get("Item")


def require_team_capability(event: Dict[str, Any], team: str, capability: str,
                             resource_id: str = None) -> Optional[Dict[str, Any]]:
    claims, role = get_claims_and_role(event)
    if ROLE_RANK.get(role, 0) >= ROLE_RANK.get("operator", 99):
        return None

    username = claims.get("username", "unknown")

    if not is_team_member(claims, team):
        logger.warning(f"User {username} (role={role}) denied — not in team '{team}' and role < operator")
        return {
            "statusCode": 403,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "error": "forbidden",
                "reason": "not_in_team",
                "message": f"This action requires the 'operator' role, or '{team}' team membership with '{capability}' access."
            })
        }

    item = get_team_capability(team, capability)
    if not item or not item.get("enabled"):
        logger.warning(f"User {username} denied — team '{team}' capability '{capability}' not enabled")
        return {
            "statusCode": 403,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "error": "forbidden",
                "reason": "capability_not_enabled",
                "message": f"'{team}' capability '{capability}' is not enabled."
            })
        }

    scope = item.get("scope")
    allowed = scope == "ALL" or (resource_id is not None and isinstance(scope, list) and resource_id in scope)
    if not allowed:
        logger.warning(f"User {username} denied — team '{team}' capability '{capability}' not scoped for resource '{resource_id}'")
        return {
            "statusCode": 403,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "error": "forbidden",
                "reason": "scope_excluded",
                "message": f"'{team}' '{capability}' access does not include '{resource_id}'."
            })
        }
    return None


# ── Centralized, per-action two-layer authorization ─────────────────────
# Layer 1: must hold SOME recognized role (not "none"), and not be
#   "viewer" (read-only) — checked here, mandatorily, before Layer 2, for
#   every action. On denial, names every real Azure AD group that would
#   satisfy this specific action, so the person knows exactly what to
#   request instead of a generic "forbidden".
# Layer 2: action-specific — either require_team_capability (SQL/SAP/
#   Tidal, admin/operator bypass team membership as confirmed) or
#   app-access scoping via validate_instance_access (EC2 — admin bypasses,
#   everyone else including app_operator must have a matching app-access
#   row).
#
# Each new action should get one entry here rather than a bespoke inline
# check in its handler — this is what keeps denial messages consistent
# and prevents a route from shipping with the check silently omitted.

# Phase 1 rollout guard for EC2 stop/start — see authorize_action below.
# Values are matched case-insensitively against runstack-instance-catalog's
# "environment" field. NOTE: catalog data observed so far has been
# inconsistent ("itg", "ITG", "Development", "Test", "Production", empty
# string) — verify actual values in your catalog match one of these before
# relying on this gate, or normalize the catalog data / this set together.
EC2_ALLOWED_ENVIRONMENTS = {"ITG", "DEV", "DEVELOPMENT", "STAGING", "TEST"}

# Temporary, Phase 1 only: whether a read-only EC2 status check is exempt
# from the environment restriction above (i.e. can still run against
# PROD/DR instances). Currently False because PROD cross-account/SSM
# connectivity has not yet been verified — a failed status check on an
# unreachable/misconfigured PROD instance produces a confusing
# FAILED/Unavailable result for the end user with no real benefit, since
# nobody is authorized to act on PROD yet anyway. Flip to True once PROD's
# cross-account role and SSM agent registration are confirmed working.
EC2_STATUS_CHECK_EXEMPT_FROM_ENV_RESTRICTION = False

ALL_KNOWN_AZURE_GROUPS = [
    "Runstack-700067-Automation-Admin",
    "Runstack-700067-Automation-Operator",
    "Runstack-700067-EC2 Admin-Operator",
    "Runstack-700067-GDBA MS SQL-Operators",
    "Runstack-700067-SAP Basis-Operator",
    "Runstack-700067-Tidal-Operator",
]

ACTION_AUTH_CONFIG = {
    "ec2_stop_start": {
        "azure_groups": [
            "Runstack-700067-Automation-Admin",
            "Runstack-700067-Automation-Operator",
            "Runstack-700067-EC2 Admin-Operator",
        ],
        "team_capability": None,  # app-access scoped instead, see authorize_action below
    },
    "sql_healthcheck": {
        "azure_groups": [
            "Runstack-700067-Automation-Admin",
            "Runstack-700067-Automation-Operator",
            "Runstack-700067-GDBA MS SQL-Operators",
        ],
        "team_capability": ("gdba-sql", "sql-db-healthcheck"),
    },
    "sql_dr_failover": {
        "azure_groups": [
            "Runstack-700067-Automation-Admin",
            "Runstack-700067-Automation-Operator",
            "Runstack-700067-GDBA MS SQL-Operators",
        ],
        "team_capability": ("gdba-sql", "sql-dr-failover"),
    },
    "sap_status_check": {
        "azure_groups": [
            "Runstack-700067-Automation-Admin",
            "Runstack-700067-Automation-Operator",
            "Runstack-700067-SAP Basis-Operator",
        ],
        "team_capability": ("sap", "sap-status-check"),
    },
    "sap_start_stop": {
        "azure_groups": [
            "Runstack-700067-Automation-Admin",
            "Runstack-700067-Automation-Operator",
            "Runstack-700067-SAP Basis-Operator",
        ],
        "team_capability": ("sap", "sap-start-stop"),
    },
    "tidal_action": {
        "azure_groups": [
            "Runstack-700067-Automation-Admin",
            "Runstack-700067-Automation-Operator",
            "Runstack-700067-Tidal-Operator",
        ],
        # Placeholder capability name — confirm the real (team, capability)
        # pair once Tidal action gating is actually built; require_team_capability
        # will just report "not enabled" until a matching row exists in
        # runstack-team-capabilities, which is safe (fails closed).
        "team_capability": ("tidal", "tidal-manage"),
    },
}


def authorize_action(event: Dict[str, Any], action_key: str, resource_id: str = None,
                      skip_environment_check: bool = False) -> Optional[Dict[str, Any]]:
    """
    Two-layer authorization for a named action (see ACTION_AUTH_CONFIG).
    Returns None if allowed, or a ready-to-return 403/401 dict if denied.

    skip_environment_check: pass True when this call is for a read-only
    status/state lookup (e.g. the EC2-Action status check the EC2 agent
    runs before ever asking the user to confirm start/stop) rather than
    the actual state-changing action. This lets servers in restricted
    environments (PROD/DR during Phase 1) still be listed and have their
    current state checked — only the real SSM-Automation start/stop call
    should be blocked by EC2_ALLOWED_ENVIRONMENTS, not the ability to see
    that the server exists or what state it's in.
    """
    config = ACTION_AUTH_CONFIG[action_key]
    claims, role = get_claims_and_role(event)
    authorized = claims.get("runstack:authorized")
    username = claims.get("username", "unknown")

    # EC2 gets a role-differentiated message rather than a flat "one of
    # these groups" list, since the two groups serve different populations:
    # Runstack-700067-Automation-Operator is for the RunStack operations/
    # support team (broad, cross-app), while Runstack-700067-EC2
    # Admin-Operator is for individual application teams who only need
    # their own app's instances. Both still functionally grant access
    # (see ACTION_AUTH_CONFIG / authorize_action Layer 1 logic below) —
    # this only changes what the denial message tells the person to
    # request, not who is actually allowed through.
    if action_key == "ec2_stop_start":
        groups_message = (
            "If you're part of the RunStack operations/support team, request membership in "
            "'Runstack-700067-Automation-Operator'. If you're on an application team needing "
            "EC2 access for your own app, request membership in 'Runstack-700067-EC2 Admin-Operator'."
        )
    else:
        groups_list = "', '".join(config["azure_groups"])
        groups_message = (
            f"You must be a member of one of the following Azure AD groups to perform "
            f"this action: '{groups_list}'."
        )

    # Layer 1 — for capability-gated actions (SQL/SAP/Tidal), a person can
    # legitimately reach Layer 2 via EITHER a role (admin/operator, which
    # bypasses team membership inside require_team_capability) OR plain
    # team membership alone, with role="none"/authorized="false" — that
    # is the exact "operator role, OR team membership" design already
    # built into require_team_capability. The blanket role-based block
    # below must not override that OR: only block here if the person is
    # NEITHER a role-holder NOR a member of this action's team.
    if config["team_capability"]:
        team, capability = config["team_capability"]
        is_member_of_this_team = is_team_member(claims, team)

        if not is_member_of_this_team and (authorized == "false" or role == "none"):
            logger.info(f"authorize_action[{action_key}] DENIED for {username}: reason=not_in_group (role={role}, authorized={authorized}, team_member={is_member_of_this_team})")
            return {
                "statusCode": 403,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "error": "forbidden",
                    "reason": "not_in_group",
                    "message": f"{groups_message} Request access from your RunStack administrator."
                })
            }
        if not is_member_of_this_team and role == "viewer":
            logger.info(f"authorize_action[{action_key}] DENIED for {username}: reason=viewer_role (team_member={is_member_of_this_team})")
            return {
                "statusCode": 403,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "error": "forbidden",
                    "reason": "viewer_role",
                    "message": (
                        f"Your role is Viewer (read-only). {groups_message} "
                        f"Request access from your RunStack administrator."
                    )
                })
            }
        # Team member (or role-holder) confirmed reachable — let
        # require_team_capability do the full, authoritative check
        # (role bypass, team membership, capability enabled, scope).
        logger.info(f"authorize_action[{action_key}] for {username}: role={role}, team_member={is_member_of_this_team} — deferring to require_team_capability(team={team}, capability={capability})")
        result = require_team_capability(event, team, capability, resource_id)
        if result:
            # require_team_capability's own logger.warning already fires
            # inside that function for each specific denial reason (not in
            # team / capability not enabled / scope mismatch) — no need to
            # duplicate that log here, just note the overall outcome.
            logger.info(f"authorize_action[{action_key}] DENIED for {username} by require_team_capability (statusCode={result.get('statusCode')})")
        else:
            logger.info(f"authorize_action[{action_key}] ALLOWED for {username} via require_team_capability")
        return result

    # Layer 1 — EC2 has no team-only path (app-access is always
    # user/app-scoped, never team-derived today), so this remains a
    # hard, unconditional gate.
    # Layer 1a — not in ANY recognized RunStack group at all
    if authorized == "false" or role == "none":
        logger.info(f"authorize_action[{action_key}] DENIED for {username}: reason=not_in_group (role={role}, authorized={authorized})")
        return {
            "statusCode": 403,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "error": "forbidden",
                "reason": "not_in_group",
                "message": f"{groups_message} Request access from your RunStack administrator."
            })
        }

    # Layer 1b — recognized, but read-only
    if role == "viewer":
        logger.info(f"authorize_action[{action_key}] DENIED for {username}: reason=viewer_role")
        return {
            "statusCode": 403,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "error": "forbidden",
                "reason": "viewer_role",
                "message": (
                    f"Your role is Viewer (read-only). {groups_message} "
                    f"Request access from your RunStack administrator."
                )
            })
        }

    # Layer 2 — app-access scoped actions (EC2)
    if action_key == "ec2_stop_start":
        if role == "admin":
            logger.info(f"authorize_action[{action_key}] ALLOWED for {username}: admin bypass")
            return None  # admin bypasses both app-access AND the Phase 1 environment gate below
        username_claim = claims.get("username", "")
        user_email = username_claim.replace("AzureAD_", "") if username_claim.startswith("AzureAD_") else claims.get("email", username_claim)
        if resource_id and not validate_instance_access(user_email, resource_id, role):
            logger.info(f"authorize_action[{action_key}] DENIED for {username}: reason=app_access_denied (resource_id={resource_id})")
            return {
                "statusCode": 403,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "error": "forbidden",
                    "reason": "app_access_denied",
                    "message": f"You do not have access to instance {resource_id}. Contact your RunStack administrator to be granted this app in runstack-app-access."
                })
            }

        # Phase 1 rollout guard: non-admin EC2 *actions* (start/stop) are
        # restricted to non-production environments while app-scoping is
        # validated against real traffic. Admin already returned above and
        # is exempt. Read-only status/state checks are NOT restricted —
        # callers pass skip_environment_check=True for those, so PROD/DR
        # servers can still be listed and their current state checked;
        # only the actual state-changing call is blocked here. Remove or
        # expand EC2_ALLOWED_ENVIRONMENTS once PROD/DR is ready to onboard.
        if resource_id and not (skip_environment_check and EC2_STATUS_CHECK_EXEMPT_FROM_ENV_RESTRICTION):
            catalog = get_catalog_instance(resource_id)
            env_raw = (catalog.get("environment") or "").strip() if catalog else ""
            env = env_raw.upper()
            if env not in EC2_ALLOWED_ENVIRONMENTS:
                logger.info(f"authorize_action[{action_key}] DENIED for {username}: reason=environment_restricted (resource_id={resource_id}, environment={env_raw!r})")
                return {
                    "statusCode": 403,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({
                        "error": "forbidden",
                        "reason": "environment_restricted",
                        "message": (
                            f"EC2 operations are currently restricted to {', '.join(sorted(EC2_ALLOWED_ENVIRONMENTS))} "
                            f"environments during Phase 1. Instance {resource_id} is in "
                            f"'{env_raw or 'an unrecognized environment'}' and is not yet enabled for self-service actions. "
                            f"Contact your RunStack administrator if you need this instance managed sooner."
                        )
                    })
                }
        logger.info(f"authorize_action[{action_key}] ALLOWED for {username} (resource_id={resource_id})")

    return None


# ── Admin CRUD for runstack-team-capabilities ───────────────────────────────
# Read-side (get_team_capability / require_team_capability / is_team_member)
# lives above, added when the DR failover capability gate was built. These
# are the write/list side so the Users & Roles UI can manage rows without
# touching DynamoDB by hand.

def list_team_capabilities() -> Dict[str, Any]:
    """
    List every row in runstack-team-capabilities, split into capability
    grants and per-team "_meta" config rows (team → Cognito group mapping).
    """
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(TEAM_CAPABILITIES_TABLE)

    response = table.scan()
    items = response.get("Items", [])
    while "LastEvaluatedKey" in response:
        response = table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
        items.extend(response.get("Items", []))

    capabilities = []
    teams_meta = []
    for item in items:
        if item.get("capability") == "_meta":
            teams_meta.append({
                "team": item.get("team"),
                "cognito_group": item.get("cognito_group"),
                "description": item.get("description", ""),
            })
        else:
            capabilities.append({
                "team": item.get("team"),
                "capability": item.get("capability"),
                "enabled": bool(item.get("enabled", False)),
                "scope": item.get("scope", "ALL"),
                "updated_by": item.get("updated_by"),
                "updated_at": item.get("updated_at"),
            })

    capabilities.sort(key=lambda c: ((c["team"] or "").lower(), (c["capability"] or "").lower()))
    teams_meta.sort(key=lambda t: (t["team"] or "").lower())
    return {"capabilities": capabilities, "teams_meta": teams_meta, "count": len(capabilities)}


def set_team_capability(team: str, capability: str, enabled: Optional[bool] = None,
                         scope: Optional[Any] = None) -> Dict[str, Any]:
    """
    Create or update one (team, capability) row. enabled/scope are
    independently optional — an omitted field keeps its existing value
    (or a safe default on first create), same contract as set_user_role().
    "_meta" is reserved for team config — use set_team_meta() for that.
    """
    if not team or not capability:
        raise ValueError("team and capability are required")
    if capability == "_meta":
        raise ValueError("'_meta' is reserved for team config — use set_team_meta() instead")
    if scope is not None and scope != "ALL" and not isinstance(scope, list):
        raise ValueError('scope must be "ALL" or a list of resource IDs')

    ddb = boto3.resource("dynamodb")
    table = ddb.Table(TEAM_CAPABILITIES_TABLE)
    existing = table.get_item(Key={"team": team, "capability": capability}).get("Item", {})

    item = {
        "team": team,
        "capability": capability,
        "enabled": enabled if enabled is not None else existing.get("enabled", False),
        "scope": scope if scope is not None else existing.get("scope", "ALL"),
        "updated_by": "runstack-ui-admin",
        "updated_at": datetime.utcnow().isoformat(),
    }
    table.put_item(Item=item)
    logger.info(f"Team capability set: team={team} capability={capability} enabled={item['enabled']} scope={item['scope']}")
    return item


def delete_team_capability(team: str, capability: str) -> Dict[str, Any]:
    """Delete one (team, capability) row. Refuses '_meta' — that's team config, not a grant."""
    if not team or not capability:
        raise ValueError("team and capability are required")
    if capability == "_meta":
        raise ValueError("'_meta' is reserved for team config, not a deletable grant")
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(TEAM_CAPABILITIES_TABLE)
    table.delete_item(Key={"team": team, "capability": capability})
    logger.info(f"Team capability deleted: team={team} capability={capability}")
    return {"status": "deleted", "team": team, "capability": capability}


def set_team_meta(team: str, cognito_group: Optional[str] = None,
                   description: Optional[str] = None) -> Dict[str, Any]:
    """
    Create or update the reserved "_meta" row for a team — this is what
    is_team_member() reads to know which Cognito group grants membership.
    Defaults cognito_group to "runstack-team-{team}" on first create, same
    default is_team_member() already falls back to when no _meta row exists.
    """
    if not team:
        raise ValueError("team is required")
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(TEAM_CAPABILITIES_TABLE)
    existing = table.get_item(Key={"team": team, "capability": "_meta"}).get("Item", {})

    item = {
        "team": team,
        "capability": "_meta",
        "cognito_group": cognito_group if cognito_group is not None else existing.get("cognito_group", f"runstack-team-{team}"),
        "description": description if description is not None else existing.get("description", ""),
        "updated_by": "runstack-ui-admin",
        "updated_at": datetime.utcnow().isoformat(),
    }
    table.put_item(Item=item)
    _TEAM_META_CACHE.pop(team, None)  # invalidate get_team_meta()'s cache so the change takes effect immediately
    logger.info(f"Team meta set: team={team} cognito_group={item['cognito_group']}")
    return item


VALID_ROLES = {"admin", "operator", "app_operator", "viewer"}

# Same groups pre_token.py checks, same precedence — role must match
# exactly what actually ends up in the person's JWT, or this UI would show
# something different from what's actually enforced.
ROLE_GROUPS = (
    ("runstack-admins", "admin"),
    ("runstack-operators", "operator"),
    ("runstack-app-operators", "app_operator"),
    ("runstack-readonly", "viewer"),
)


def list_runstack_users() -> Dict[str, Any]:
    """
    Role now comes exclusively from Cognito group membership — matches
    pre_token.py's resolve_legacy_group_role() exactly, not
    runstack-user-roles (no longer read here; see set_user_role()). App
    access is unchanged — still table-driven via runstack-app-access,
    still manually managed through this UI.
    """
    ddb = boto3.resource("dynamodb")
    access_table = ddb.Table(APP_ACCESS_TABLE)

    response = access_table.scan()
    access_items = response.get("Items", [])
    while "LastEvaluatedKey" in response:
        response = access_table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
        access_items.extend(response.get("Items", []))

    # key = lowercased email (for matching across sources with inconsistent
    # casing), value = (role, display_email as seen from Cognito)
    role_by_email: Dict[str, tuple] = {}
    for group_name, role in ROLE_GROUPS:
        try:
            result = list_cognito_group_members(group_name)
        except Exception as e:
            logger.error(f"Could not list members of {group_name} while building user list: {e}")
            continue
        for m in result.get("members", []):
            email = m.get("email") or ""
            if not email:
                continue
            key = email.lower()
            current_role, _ = role_by_email.get(key, ("none", email))
            if ROLE_RANK.get(role, 0) > ROLE_RANK.get(current_role, 0):
                role_by_email[key] = (role, email)

    by_user: Dict[str, Dict[str, Any]] = {}
    for item in access_items:
        email = item.get("user_email", "")
        app_id = item.get("app_id", "")
        key = email.lower()
        if key not in by_user:
            role, _ = role_by_email.get(key, ("none", email))
            by_user[key] = {"email": email, "role": role, "apps": []}
        if app_id and app_id not in by_user[key]["apps"]:
            by_user[key]["apps"].append(app_id)

    for key, (role, display_email) in role_by_email.items():
        if key not in by_user:
            by_user[key] = {"email": display_email, "role": role, "apps": []}

    users = sorted(by_user.values(), key=lambda u: u["email"].lower())
    return {"users": users, "count": len(users)}


def set_user_role(email: str, role: Optional[str] = None, apps: Optional[list] = None) -> Dict[str, Any]:
    """
    Apps-only, as of the switch to Cognito-only role resolution. `role` is
    no longer settable here — add/remove the person from
    runstack-admins/runstack-operators/runstack-app-operators/
    runstack-readonly in Cognito instead (or via SailPoint/AD once that
    sync exists). Rejecting explicitly rather than silently ignoring
    `role`, since a silent no-op would look like it worked while doing
    nothing.
    """
    if not email:
        raise ValueError("email is required")
    if role is not None:
        raise ValueError(
            "Role is managed via Cognito group membership now, not here — "
            "add or remove the person from runstack-admins / runstack-operators / "
            "runstack-app-operators / runstack-readonly in Cognito instead."
        )
    if apps is None:
        raise ValueError("Provide apps to update")

    ddb = boto3.resource("dynamodb")
    access_table = ddb.Table(APP_ACCESS_TABLE)

    existing = access_table.query(
        KeyConditionExpression=boto3.dynamodb.conditions.Key("user_email").eq(email)
    ).get("Items", [])
    existing_app_ids = {item["app_id"] for item in existing}
    target_app_ids = set(apps)
    for app_id in existing_app_ids - target_app_ids:
        access_table.delete_item(Key={"user_email": email, "app_id": app_id})
    for app_id in target_app_ids:
        access_table.put_item(Item={
            "user_email": email,
            "app_id": app_id,
            "granted_by": "runstack-ui-admin",
            "granted_at": datetime.utcnow().isoformat(),
        })
    logger.info(f"Set apps={sorted(target_app_ids)} for user={email}")
    return {"email": email, "apps": sorted(target_app_ids)}


_dynatrace_token_cache: Dict[str, str] = {}


def _resolve_dynatrace_token(cache_key: str, hardcoded: str, local_env_var: str, secret_arn: str) -> str:
    if cache_key in _dynatrace_token_cache:
        return _dynatrace_token_cache[cache_key]

    if hardcoded:
        _dynatrace_token_cache[cache_key] = hardcoded
        return _dynatrace_token_cache[cache_key]

    local_token = os.getenv(local_env_var, "")
    if local_token:
        _dynatrace_token_cache[cache_key] = local_token
        return _dynatrace_token_cache[cache_key]

    if not secret_arn:
        raise ValueError(f"{local_env_var}_SECRET_ARN is not configured (and {local_env_var} not set)")
    secrets = boto3.client("secretsmanager")
    secret = secrets.get_secret_value(SecretId=secret_arn)
    _dynatrace_token_cache[cache_key] = secret["SecretString"]
    return _dynatrace_token_cache[cache_key]


def get_dynatrace_fetch_token() -> str:
    return _resolve_dynatrace_token(
        "fetch", DYNATRACE_FETCH_TOKEN_HARDCODED, "DYNATRACE_FETCH_API_TOKEN", DYNATRACE_FETCH_TOKEN_SECRET_ARN
    )


def get_dynatrace_trigger_token() -> str:
    return _resolve_dynatrace_token(
        "trigger", DYNATRACE_TRIGGER_TOKEN_HARDCODED, "DYNATRACE_TRIGGER_API_TOKEN", DYNATRACE_TRIGGER_TOKEN_SECRET_ARN
    )

def get_dynatrace_synthetic_fetch_token() -> str:
    return _resolve_dynatrace_token(
        "synthetic_fetch", DYNATRACE_SYNTHETIC_FETCH_TOKEN_HARDCODED,
        "DYNATRACE_SYNTHETIC_FETCH_API_TOKEN", DYNATRACE_SYNTHETIC_FETCH_TOKEN_SECRET_ARN
    )


# ── DR test SQL credentials + Teams approval secrets (Secrets Manager) ─────
_dr_test_sql_credentials_cache: Optional[Dict[str, str]] = None


def get_dr_test_sql_credentials() -> Dict[str, str]:
    """Returns {"username": ..., "password": ...}. Local env var overrides
    win if set (matches the local-testing pattern used elsewhere); otherwise
    reads the JSON secret {"username": "...", "password": "..."} at
    DR_TEST_SQL_CREDENTIALS_SECRET_ARN."""
    global _dr_test_sql_credentials_cache
    if _dr_test_sql_credentials_cache is not None:
        return _dr_test_sql_credentials_cache

    if DR_TEST_SQL_USERNAME_LOCAL or DR_TEST_SQL_PASSWORD_LOCAL:
        _dr_test_sql_credentials_cache = {
            "username": DR_TEST_SQL_USERNAME_LOCAL,
            "password": DR_TEST_SQL_PASSWORD_LOCAL,
        }
        return _dr_test_sql_credentials_cache

    if not DR_TEST_SQL_CREDENTIALS_SECRET_ARN:
        _dr_test_sql_credentials_cache = {"username": "", "password": ""}
        return _dr_test_sql_credentials_cache

    secrets = boto3.client("secretsmanager")
    secret = secrets.get_secret_value(SecretId=DR_TEST_SQL_CREDENTIALS_SECRET_ARN)
    parsed = json.loads(secret["SecretString"])
    _dr_test_sql_credentials_cache = {
        "username": parsed.get("username", ""),
        "password": parsed.get("password", ""),
    }
    return _dr_test_sql_credentials_cache


def get_teams_approve_shared_secret() -> str:
    return _resolve_dynatrace_token(
        "teams_approve_shared_secret", "", "TEAMS_APPROVE_SHARED_SECRET", TEAMS_APPROVE_SHARED_SECRET_SECRET_ARN
    )


def get_teams_dr_approval_webhook_url() -> str:
    return _resolve_dynatrace_token(
        "teams_dr_approval_webhook_url", "", "TEAMS_DR_APPROVAL_WEBHOOK_URL", TEAMS_DR_APPROVAL_WEBHOOK_URL_SECRET_ARN
    )

def resolve_dynatrace_monitor(app_key: str) -> Optional[Dict[str, Any]]:
    local_path = os.getenv("DYNATRACE_CATALOG_LOCAL_PATH", "")
    if local_path:
        with open(local_path, "r", encoding="utf-8") as f:
            content = f.read()
    else:
        if not UPLOADS_S3_BUCKET:
            raise ValueError("Catalog bucket is not configured (UPLOADS_S3_BUCKET)")
        s3 = boto3.client("s3")
        obj = s3.get_object(Bucket=UPLOADS_S3_BUCKET, Key=DYNATRACE_CATALOG_S3_KEY)
        content = obj["Body"].read().decode("utf-8")

    reader = csv.DictReader(io.StringIO(content))
    needle = (app_key or "").strip().lower()
    if not needle:
        return None

    matched_rows = []
    for row in reader:
        row_app_id = (row.get("app_id") or "").strip().lower()
        raw_app_name = (row.get("app_name") or "").strip()
        app_aliases_lower = [a.strip().lower() for a in raw_app_name.split("|") if a.strip()]

        if needle == row_app_id or needle in app_aliases_lower:
            matched_rows.append(row)

    if not matched_rows:
        return None

    monitor_names = []
    for row in matched_rows:
        raw_monitor_name = (row.get("monitor_name") or "").strip()
        for m in raw_monitor_name.split("|"):
            m = m.strip()
            if m and m not in monitor_names:
                monitor_names.append(m)

    first_row = matched_rows[0]
    first_app_name_raw = (first_row.get("app_name") or "").strip()
    first_app_aliases = [a.strip() for a in first_app_name_raw.split("|") if a.strip()]

    return {
        "app_id": (first_row.get("app_id") or "").strip(),
        "app_name": first_app_aliases[0] if first_app_aliases else first_app_name_raw,
        "monitor_names": monitor_names,
        "monitor_name": monitor_names[0] if monitor_names else "",
    }


def _dynatrace_request(method: str, path: str, token: str, body: Optional[dict] = None) -> dict:
    import urllib.request
    import urllib.error

    url = f"{DYNATRACE_API_URL}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Api-Token {token}",
            "Accept": "application/json; charset=utf-8",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Dynatrace API {method} {path} failed ({e.code}): {detail}")


def dynatrace_fetch_monitors_list(token: str) -> list:
    result = _dynatrace_request(
        "GET", "/api/v1/synthetic/monitors?type=BROWSER&enabled=true", token
    )
    return result.get("monitors", [])


def dynatrace_fetch_monitor_id(monitor_name: str, token: str) -> Optional[str]:
    for monitor in dynatrace_fetch_monitors_list(token):
        if monitor.get("name") == monitor_name:
            return monitor.get("entityId")
    return None


def resolve_monitor_ids(monitor_names: list, monitors: list) -> tuple:
    by_name = {m.get("name"): m.get("entityId") for m in monitors}
    found, not_found = [], []
    for name in monitor_names:
        monitor_id = by_name.get(name)
        if monitor_id:
            found.append({"name": name, "monitor_id": monitor_id})
        else:
            not_found.append(name)
    return found, not_found


def dynatrace_trigger_execution(monitors: list, token: str) -> Dict[str, Any]:
    payload = {
        "takeScreenshotsOnSuccess": True,
        "monitors": [{"monitorId": m["monitor_id"], "customizedScript": {}} for m in monitors],
    }
    result = _dynatrace_request("POST", "/api/v2/synthetic/executions/batch/", token, payload)
    triggered = result.get("triggered", [])
    if not triggered:
        raise RuntimeError(f"Dynatrace trigger returned no 'triggered' entries: {result}")

    id_to_name = {m["monitor_id"]: m["name"] for m in monitors}
    executions = []
    for entry in triggered:
        monitor_id = entry.get("monitorId", "")
        for e in entry.get("executions", []):
            executions.append({
                "execution_id": e["executionId"],
                "location_id": e.get("locationId", ""),
                "monitor_id": monitor_id,
                "monitor_name": id_to_name.get(monitor_id, monitor_id),
            })
    if not executions:
        raise RuntimeError(f"Dynatrace trigger returned no executions: {result}")
    return {"batch_id": result.get("batchId", ""), "executions": executions}


def dynatrace_get_execution_status(execution_id: str, token: str) -> dict:
    return _dynatrace_request("GET", f"/api/v2/synthetic/executions/{execution_id}", token)


def dynatrace_poll_all_executions(executions: list, token: str) -> Dict[str, Any]:
    per_execution = []
    all_executed = True
    for ex in executions:
        status = dynatrace_get_execution_status(ex["execution_id"], token)
        stage = status.get("executionStage", "TRIGGERED")
        simple = status.get("simpleResults", {})
        # Dynatrace's real stage value is "Data retrieved" once results are in,
        # not the literal string "EXECUTED" — treat a real simpleResults.status
        # (SUCCESS/FAILED) as done, regardless of the exact stage wording.
        if simple.get("status") not in ("SUCCESS", "FAILED"):
            all_executed = False
        per_execution.append({
            "execution_id": ex["execution_id"],
            "location_id": ex.get("location_id", ""),
            "monitor_id": ex.get("monitor_id", ""),
            "monitor_name": ex.get("monitor_name", ""),
            "execution_stage": stage,
            "status": simple.get("status"),
            "executed_steps": simple.get("executedSteps"),
            "total_time": simple.get("totalTime"),
            "failure_message": simple.get("failureMessage"),
        })

    if not all_executed:
        return {"executionStage": "RUNNING", "locations": per_execution}

    overall_status = "SUCCESS" if all(loc["status"] == "SUCCESS" for loc in per_execution) else "FAILED"
    return {"executionStage": "EXECUTED", "status": overall_status, "locations": per_execution}


def fetch_dynatrace_ag_entities() -> list:
    token = get_dynatrace_fetch_token()
    query = ('?entitySelector=type("sql:sql_server_availability_group")'
             '&fields=+properties,+tags,+managementZones&from=now-2h')
    result = _dynatrace_request("GET", f"/api/v2/entities{query}", token)
    return result.get("entities", [])


def _parse_dynatrace_host(entity: dict) -> str:
    device = entity.get("properties", {}).get("device", "")
    return device.split(":")[0].split("/")[0]


def group_dynatrace_ags(entities: list) -> Dict[str, list]:
    groups: Dict[str, list] = {}
    for e in entities:
        ag_name = e.get("properties", {}).get("ag_name")
        if not ag_name:
            continue
        groups.setdefault(ag_name, []).append({
            "host": _parse_dynatrace_host(e),
            "display_name": e.get("displayName"),
            "sync_health": e.get("properties", {}).get("ag_sync_health"),
            "sec_rec_health": e.get("properties", {}).get("ag_sec_rec_health"),
            "backup_preference": e.get("properties", {}).get("ag_backup_preference"),
        })
    return groups


def get_all_ag_groups() -> Dict[str, list]:
    groups = group_dynatrace_ags(fetch_dynatrace_ag_entities())
    for ag_name, hosts in DR_MANUAL_AGS.items():
        if ag_name in groups:
            continue
        groups[ag_name] = [
            {
                "host": host,
                "display_name": f"{ag_name} (via: {host}) [manually registered]",
                "sync_health": None,
                "sec_rec_health": None,
                "backup_preference": None,
            }
            for host in hosts
        ]
    return groups


def classify_ag_roles(roles: list, ag_name: str = None, target_replica: str = None) -> Dict[str, Any]:
    primaries = [r for r in roles if r.get("Role") == "PRIMARY"]
    secondaries = [r for r in roles if r.get("Role") == "SECONDARY"]

    if len(primaries) != 1:
        return {"ok": False, "reason": f"Expected exactly 1 PRIMARY replica, found {len(primaries)}"}
    primary = primaries[0]

    sync_secondaries = [r for r in secondaries if r.get("CommitMode") == "SYNCHRONOUS_COMMIT"]
    async_secondaries = [r for r in secondaries if r.get("CommitMode") == "ASYNCHRONOUS_COMMIT"]

    ha_candidate = sync_secondaries[0] if len(sync_secondaries) == 1 else None
    dr_candidate = async_secondaries[0] if len(async_secondaries) == 1 else None

    override_host = DR_REPLICA_OVERRIDES.get(ag_name) if ag_name else None
    if override_host:
        needle = override_host.strip().lower()
        dr_candidate = next((r for r in secondaries if needle in (r.get("ReplicaName") or "").lower()), dr_candidate)

    # If the caller specified which target they want, select it explicitly.
    # Checked before the ha/dr-candidate ambiguity bailout below, so an
    # explicit target_replica works even when auto-classification can't
    # cleanly tell HA and DR apart from commit mode alone (e.g. after a
    # prior failover promotes the async-designated replica to Primary,
    # leaving 2+ sync secondaries and 0 async ones).
    if target_replica:
        chosen = next((r for r in secondaries if r.get("ReplicaName") == target_replica), None)
        if not chosen:
            return {"ok": False, "reason": f"Requested target_replica '{target_replica}' not found among secondaries."}
        scope = "DR" if chosen.get("CommitMode") == "ASYNCHRONOUS_COMMIT" else "HA"
        return {
            "ok": True, "primary": primary, "dr_replica": chosen, "failover_scope": scope,
            "ha_candidate": ha_candidate, "dr_candidate": dr_candidate,
        }

    if not ha_candidate and not dr_candidate:
        # Commit-mode counting couldn't uniquely resolve HA vs DR. Rather
        # than failing outright, surface every secondary as a pickable
        # option so /plan can prompt for an explicit target_replica on the
        # next call, same as the needs_target_choice path below.
        if not secondaries:
            return {"ok": False, "reason": "No secondary replicas found for this AG."}
        return {
            "ok": True, "needs_target_choice": True,
            "primary": primary, "ha_candidate": None, "dr_candidate": None,
            "secondary_options": [
                {"replica_name": r.get("ReplicaName"), "commit_mode": r.get("CommitMode")}
                for r in secondaries
            ],
        }

    # No target specified yet - return both options so /plan can ask the user.
    return {
        "ok": True, "needs_target_choice": True,
        "primary": primary, "ha_candidate": ha_candidate, "dr_candidate": dr_candidate,
    }


def resolve_instance_for_host(host: str) -> Optional[Dict[str, Any]]:
    instances = get_instances_for_apps(["ALL"])
    needle = (host or "").strip().lower()
    if not needle:
        return None
    for inst in instances:
        if (inst.get("server_name", "").strip().lower() == needle
                or inst.get("name", "").strip().lower() == needle):
            return inst
    return None


def get_cross_account_ssm_client(account_id: str, region: str):
    sts = boto3.client("sts")
    cross_account_role = os.environ.get("CROSS_ACCOUNT_ROLE_NAME", "runstack-cross-account-role")
    creds = sts.assume_role(
        RoleArn=f"arn:aws:iam::{account_id}:role/{cross_account_role}",
        RoleSessionName="runstack-dr-failover"
    )["Credentials"]
    return boto3.client(
        "ssm", region_name=region,
        aws_access_key_id=creds["AccessKeyId"],
        aws_secret_access_key=creds["SecretAccessKey"],
        aws_session_token=creds["SessionToken"]
    )


def create_ssm_runcommand_job(instance_id: str, account_id: str, region: str, commands: list, comment: str) -> Optional[str]:
    job_id = str(uuid.uuid4())
    payload = {
        "id": job_id,
        "account_id": account_id,
        "region": region,
        "resource_id": instance_id,
        "automation_type": "SSM-RunCommand",
        "automation_data": {
            "DocumentName": "AWS-RunPowerShellScript",
            "InstanceIds": [instance_id],
            "Parameters": {"commands": commands},
        },
    }
    if not validate_message_payload(payload):
        return None
    transformed = transform_message_data(payload, job_id)
    if not store_message_in_dynamodb(transformed):
        return None
    return job_id

DR_STATUS_CHECK_DOCUMENT_NAME = os.getenv("DR_STATUS_CHECK_DOCUMENT_NAME", "RunStack-DR-Status-Check")
DR_DOCUMENT_OWNER_ACCOUNT = os.getenv("DR_DOCUMENT_OWNER_ACCOUNT", "246314649749")
TEAMS_DR_APPROVAL_WEBHOOK_URL_SECRET_ARN = os.getenv("TEAMS_DR_APPROVAL_WEBHOOK_URL_SECRET_ARN", "")
TEAMS_APPROVE_SHARED_SECRET_SECRET_ARN = os.getenv("TEAMS_APPROVE_SHARED_SECRET_SECRET_ARN", "")
# Local-testing overrides only — leave unset in deployed environments.
TEAMS_DR_APPROVAL_WEBHOOK_URL_LOCAL = os.getenv("TEAMS_DR_APPROVAL_WEBHOOK_URL", "")
TEAMS_APPROVE_SHARED_SECRET_LOCAL = os.getenv("TEAMS_APPROVE_SHARED_SECRET", "")

def create_ssm_document_job(
    instance_id: str,
    account_id: str,
    region: str,
    document_name: str,
    parameters: dict,
    comment: str
) -> Optional[str]:

    job_id = str(uuid.uuid4())

    automation_data = {
        "DocumentName": document_name,
        "InstanceIds": [instance_id],
        "Parameters": parameters or {},
    }

    payload = {
        "id": job_id,
        "account_id": account_id,
        "region": region,
        "resource_id": instance_id,
        "automation_type": "SSM-RunCommand",
        "automation_data": automation_data,
    }

    if not validate_message_payload(payload):
        return None

    # Generic normalization happens here
    transformed = transform_message_data(payload, job_id)

    if not store_message_in_dynamodb(transformed):
        return None

    return job_id

def get_job_raw_output(job_id: str) -> Dict[str, Any]:
    job = get_job_by_id(job_id)
    if not job:
        return {"found": False}
    return {
        "found": True,
        "status": job.get("status", "PENDING"),
        "raw_output": job.get("qualys_output", ""),
        "stderr_output": job.get("stderr_output", ""),
        "exit_code": job.get("exit_code"),
    }


_JOB_TERMINAL_STATUSES = {"COMPLETED", "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED"}


_DR_ROLE_QUERY = (
    "SELECT ar.replica_server_name AS Replica, rs.role_desc AS Role, "
    "rs.synchronization_health_desc AS SyncHealth, "
    "rs.connected_state_desc AS ConnState, "
    "ar.availability_mode_desc AS CommitMode "
    "FROM sys.dm_hadr_availability_replica_states rs "
    "JOIN sys.availability_replicas ar ON rs.replica_id = ar.replica_id "
    "JOIN sys.availability_groups ag ON ag.group_id = ar.group_id "
    "WHERE ag.name = '{ag}' ORDER BY rs.role_desc, ar.replica_server_name;"
)

_DR_DBSYNC_QUERY = (
    "SELECT DB_NAME(drs.database_id) AS DBName, "
    "drs.synchronization_state_desc AS SyncState, "
    "drs.log_send_queue_size AS LogQueueKB, drs.redo_queue_size AS RedoQueueKB, "
    "drs.is_suspended AS Suspended "
    "FROM sys.dm_hadr_database_replica_states drs "
    "JOIN sys.availability_replicas ar ON drs.replica_id = ar.replica_id "
    "JOIN sys.availability_groups ag ON ag.group_id = ar.group_id "
    "WHERE ag.name = '{ag}' AND drs.is_local = 1;"
)


def _ado_ps_script(query: str, tag: str) -> str:
    escaped = query.replace('"', '`"')
    return (
        f'$q_{tag} = "{escaped}"; '
        f"$conn_{tag} = New-Object System.Data.SqlClient.SqlConnection("
        "'Server=localhost;Database=master;Integrated Security=True;"
        "TrustServerCertificate=True;Encrypt=Optional;Connection Timeout=15'); "
        f"$cmd_{tag} = New-Object System.Data.SqlClient.SqlCommand($q_{tag}, $conn_{tag}); "
        f"$cmd_{tag}.CommandTimeout = 30; "
        f"$da_{tag} = New-Object System.Data.SqlClient.SqlDataAdapter($cmd_{tag}); "
        f"$dt_{tag} = New-Object System.Data.DataTable; "
        f"$conn_{tag}.Open(); $da_{tag}.Fill($dt_{tag}) | Out-Null; $conn_{tag}.Close(); "
        f"Write-Output ('RUNSTACK_{tag}:' + ($dt_{tag} | ConvertTo-Json -Compress))"
    )


def build_dr_status_script(ag_name: str) -> list:
    role_ps = _ado_ps_script(_DR_ROLE_QUERY.format(ag=ag_name), "ROLES")
    dbsync_ps = _ado_ps_script(_DR_DBSYNC_QUERY.format(ag=ag_name), "DBSYNC")
    return [role_ps, dbsync_ps]


def build_dr_failover_script(ag_name: str) -> list:
    query = f"ALTER AVAILABILITY GROUP [{ag_name}] FAILOVER;"
    escaped = query.replace('"', '`"')
    return [
        '$ErrorActionPreference = "Stop"; '
        f'$q = "{escaped}"; '
        "$instProps = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Microsoft SQL Server\\Instance Names\\SQL' -ErrorAction SilentlyContinue; "
        "$instName = if ($instProps) { ($instProps.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | Select-Object -First 1 -ExpandProperty Name) } else { $null }; "
        "$srv = if ($instName) { \"localhost\\$instName\" } else { 'localhost' }; "
        "$conn = New-Object System.Data.SqlClient.SqlConnection("
        "\"Server=$srv;Database=master;Integrated Security=True;"
        "TrustServerCertificate=True;Encrypt=Optional;Connection Timeout=15\"); "
        "$cmd = New-Object System.Data.SqlClient.SqlCommand($q, $conn); "
        "$cmd.CommandTimeout = 300; "
        "try { $conn.Open(); $cmd.ExecuteNonQuery() | Out-Null; $conn.Close(); "
        "Write-Output 'RUNSTACK_FAILOVER:OK' } "
        "catch { Write-Output ('RUNSTACK_FAILOVER:ERROR:' + $_.Exception.Message) }"
    ]


def parse_runstack_tagged_json(raw_output: str, tag: str) -> list:
    prefix = f"RUNSTACK_{tag}:"
    for line in (raw_output or "").splitlines():
        if line.startswith(prefix):
            try:
                data = json.loads(line[len(prefix):])
            except (json.JSONDecodeError, ValueError):
                # SSM's StandardOutputContent keeps only the FIRST 24,000
                # characters of stdout (AWS-documented). A marker printed
                # late in a verbose script can be truncated mid-line or
                # dropped entirely once total output crosses that limit.
                # Treat that as "no data" rather than letting a JSON
                # decode error bubble up and 500 the whole status check —
                # this is enrichment data, not something callers should
                # crash over.
                logger.warning(
                    f"parse_runstack_tagged_json: truncated/invalid JSON "
                    f"for tag '{tag}' (likely SSM 24,000-char output cap) — "
                    f"ignoring marker, falling back to other signals."
                )
                return []
            return data if isinstance(data, list) else [data]
    return []


def poll_ssm_invocation(ssm, command_id: str, instance_id: str, timeout_sec: int = 60) -> str:
    start = time.time()
    while time.time() - start < timeout_sec:
        try:
            inv = ssm.get_command_invocation(CommandId=command_id, InstanceId=instance_id)
        except ssm.exceptions.InvocationDoesNotExist:
            time.sleep(DR_POLL_INTERVAL_SEC)
            continue
        if inv["Status"] in ("Success", "Failed", "Cancelled", "TimedOut"):
            if inv["Status"] != "Success":
                raise RuntimeError(f"SSM command {inv['Status']}: {inv.get('StandardErrorContent','')}")
            return inv["StandardOutputContent"]
        time.sleep(DR_POLL_INTERVAL_SEC)
    raise TimeoutError(f"SSM command {command_id} on {instance_id} did not complete in {timeout_sec}s")


def trigger_ag_status_check_job(ag_name: str, candidate_hosts: list) -> Dict[str, Any]:
    if not candidate_hosts:
        return {"ok": False, "reason": f"No candidate hosts for AG {ag_name}"}

    # Prefer whichever host is currently Primary - Secondaries can have
    # restricted visibility into the full AG replica topology via
    # sys.dm_hadr_availability_replica_states, while Primary always has
    # the complete picture. Fall back to the first host if none resolve
    # (existing behavior, preserved as a safety net).
    host = candidate_hosts[0]
    for candidate in candidate_hosts:
        inst = resolve_instance_for_host(candidate)
        if inst and inst.get("instance_id"):
            host = candidate
            break  # TODO: this just finds the first *resolvable* host, not
                    # necessarily Primary - see note below

    inst = resolve_instance_for_host(host)
    if not inst or not inst.get("instance_id") or not inst.get("account_id"):
        return {"ok": False, "reason": f"No instance mapping for host '{host}' in instance catalog"}

    job_id = create_ssm_document_job(
        inst["instance_id"], inst["account_id"], inst.get("region", "us-east-1"),
        DR_STATUS_CHECK_DOCUMENT_NAME, {"AGName": [ag_name]}, f"RunStack DR status: {ag_name}"
    )
    if not job_id:
        return {"ok": False, "reason": f"Could not create status-check job for host '{host}'"}
    return {"ok": True, "job_id": job_id, "resolved_via_host": host, "instance_id": inst["instance_id"]}

def trigger_ag_status_check_job_parallel(ag_name: str, candidate_hosts: list) -> Dict[str, Any]:
    """
    Like trigger_ag_status_check_job, but dispatches an SSM status-check job
    to EVERY resolvable host in candidate_hosts at once instead of one at a
    time. Returns a single opaque group job_id (stored in DR_RUN_LOG_TABLE)
    that read_ag_status_job_result() resolves transparently — callers in
    dynatrace.py and dr_failover.py don't need to know the difference
    between a plain job_id and a parallel group id. Cuts multi-host
    discovery from up to N sequential SSM round trips to 1.
    """
    if not candidate_hosts:
        return {"ok": False, "reason": f"No candidate hosts for AG {ag_name}"}

    dispatched = []  # [{"host":..., "job_id":..., "instance_id":...}]
    for host in candidate_hosts:
        inst = resolve_instance_for_host(host)
        if not inst or not inst.get("instance_id") or not inst.get("account_id"):
            continue
        job_id = create_ssm_document_job(
            inst["instance_id"], inst["account_id"], inst.get("region", "us-east-1"),
            DR_STATUS_CHECK_DOCUMENT_NAME, {"AGName": [ag_name]},
            f"RunStack DR status: {ag_name} (parallel, host={host})"
        )
        if job_id:
            dispatched.append({"host": host, "job_id": job_id, "instance_id": inst["instance_id"]})

    if not dispatched:
        return {"ok": False, "reason": f"No instance mapping resolved for any of: {', '.join(candidate_hosts)}"}

    group_id = f"grp-{uuid.uuid4()}"
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_RUN_LOG_TABLE)
    table.put_item(Item={
        "run_id": group_id,
        "ag_name": ag_name,
        "type": "parallel_group",
        "member_jobs": dispatched,
        "created_at": datetime.utcnow().isoformat(),
        "expires_at": int(time.time()) + 600,
    })
    return {
        "ok": True,
        "job_id": group_id,
        "resolved_via_host": ",".join(d["host"] for d in dispatched),
        "instance_id": ",".join(d["instance_id"] for d in dispatched),
    }


def _get_parallel_group(group_id: str) -> Optional[Dict[str, Any]]:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_RUN_LOG_TABLE)
    item = table.get_item(Key={"run_id": group_id}).get("Item")
    if not item or item.get("type") != "parallel_group":
        return None
    return item


def _read_parallel_group_result(group_id: str) -> Dict[str, Any]:
    """
    Resolves an opaque parallel-dispatch group id the same way
    read_ag_status_job_result resolves a plain job_id. Returns as soon as
    ANY member job reports full AG topology (saw PRIMARY); if all member
    jobs are terminal and none saw full topology, merges every partial
    view collected — same "warning" semantics as the old sequential-retry
    exhaustion path.
    """
    group = _get_parallel_group(group_id)
    if not group:
        return {"ok": False, "reason": f"No parallel status-check group found for id '{group_id}' (may have expired)"}

    member_jobs = group.get("member_jobs", [])
    if not member_jobs:
        return {"ok": False, "reason": f"Parallel status-check group '{group_id}' has no member jobs"}

    any_pending = False
    merged_roles: Dict[str, Any] = {}
    merged_db_sync: Dict[tuple, Any] = {}

    for member in member_jobs:
        info = get_job_raw_output(member["job_id"])
        if not info["found"]:
            continue
        status = info["status"]
        if status not in _JOB_TERMINAL_STATUSES:
            any_pending = True
            continue
        if status in ("FAILED", "TIMED_OUT", "CANCELLED"):
            continue
        roles = parse_runstack_tagged_json(info["raw_output"], "ROLES")
        db_sync = parse_runstack_tagged_json(info["raw_output"], "DBSYNC")
        if roles and len(roles) >= 2 and any(r.get("Role") == "PRIMARY" for r in roles):
            # This host has full topology visibility — done, use it directly.
            return {"ok": True, "done": True, "roles": roles, "db_sync": db_sync}
        for r in roles:
            if r.get("ReplicaName"):
                merged_roles[r["ReplicaName"]] = r
        for d in db_sync:
            merged_db_sync[(d.get("DBName"), d.get("Replica"))] = d

    if any_pending:
        return {"ok": True, "done": False, "status": "RUNNING"}

    if not merged_roles:
        return {"ok": False, "reason": "All parallel status-check jobs completed but no host returned role data — check SSM output"}

    return {
        "ok": True,
        "done": True,
        "roles": list(merged_roles.values()),
        "db_sync": list(merged_db_sync.values()),
        "warning": (
            "Could not find a host with full AG visibility (i.e. Primary) among any "
            "of the hosts checked in parallel. The roles/db_sync below are the combined "
            "partial views collected from each host - some fields (which replica is "
            "Primary, another replica's live state) may still be missing or stale."
        ),
    }

def read_ag_status_job_result(job_id: str) -> Dict[str, Any]:
    if job_id.startswith("grp-"):
        return _read_parallel_group_result(job_id)

    info = get_job_raw_output(job_id)
    if not info["found"]:
        return {"ok": False, "reason": f"No job found for job_id '{job_id}'"}
    status = info["status"]
    if status not in _JOB_TERMINAL_STATUSES:
        return {"ok": True, "done": False, "status": status}
    if status in ("FAILED", "TIMED_OUT", "CANCELLED"):
        return {"ok": False, "reason": f"Status-check job {status.lower()}", "raw_output": info["raw_output"]}
    roles = parse_runstack_tagged_json(info["raw_output"], "ROLES")
    db_sync = parse_runstack_tagged_json(info["raw_output"], "DBSYNC")
    if not roles:
        return {"ok": False, "reason": "Job completed but no role data was returned — check SSM output", "raw_output": info["raw_output"]}
    return {"ok": True, "done": True, "roles": roles, "db_sync": db_sync}


def _short_hostname(instance_name: str) -> str:
    return (instance_name or "").split("\\")[0].split(",")[0].strip().lower()


def evaluate_dr_preconditions(status: Dict[str, Any], classification: Dict[str, Any]) -> Dict[str, Any]:
    roles = status["roles"]
    db_sync = status["db_sync"]
    max_queue_kb = DR_MAX_LOG_QUEUE_KB

    primary = classification["primary"]
    dr_replica = classification["dr_replica"]
    scope_label = classification.get("failover_scope", "DR")  # NEW
    target_label = f"{scope_label} target"  # NEW - e.g. "HA target" or "DR target"
    checks = []

    checks.append({"result": "PASS", "detail": f"Primary = {primary.get('ReplicaName')}"})

    if dr_replica.get("Role") == "SECONDARY" and dr_replica.get("ConnState") == "CONNECTED":
        checks.append({"result": "PASS", "detail": f"{target_label} ({dr_replica.get('ReplicaName')}) role = SECONDARY, CONNECTED"})
    else:
        checks.append({"result": "FAIL", "detail": f"{target_label} ({dr_replica.get('ReplicaName')}) not SECONDARY/CONNECTED (got {dr_replica})"})

    unhealthy = [r.get("ReplicaName") for r in roles if r.get("SyncHealth") != "HEALTHY"]
    if not unhealthy:
        checks.append({"result": "PASS", "detail": "All replicas report SyncHealth = HEALTHY"})
    else:
        checks.append({"result": "FAIL", "detail": f"Replicas not HEALTHY: {unhealthy}"})

    db_fail = []
    for d in db_sync:
        if (d.get("SyncState") != "SYNCHRONIZED" or d.get("Suspended")
                or (d.get("LogQueueKB") or 0) > max_queue_kb
                or (d.get("RedoQueueKB") or 0) > max_queue_kb):
            db_fail.append(d.get("DBName"))
    if db_sync and not db_fail:
        checks.append({"result": "PASS", "detail": f"All {len(db_sync)} databases SYNCHRONIZED, queues within {max_queue_kb} KB"})
    elif db_fail:
        checks.append({"result": "FAIL", "detail": f"Databases not safe to fail over: {db_fail}"})
    else:
        checks.append({"result": "FAIL", "detail": "No per-database sync rows returned — could not verify"})

    return {
        "checks": checks,
        "all_pass": all(c["result"] == "PASS" for c in checks),
        "primary_row": primary,
        "dr_replica_row": dr_replica,
        "primary_host": primary.get("ReplicaName"),
        "dr_replica_host": dr_replica.get("ReplicaName"),
        "failover_scope": scope_label,  # NEW - so /plan can pass this through to the run record
    }


def create_dr_run_record(ag_name: str, status: str, extra: dict = None) -> str:
    run_id = f"dr-{uuid.uuid4()}"
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_RUN_LOG_TABLE)
    item = {
        "run_id": run_id,
        "ag_name": ag_name,
        "status": status,
        "created_at": datetime.utcnow().isoformat(),
        "updated_at": datetime.utcnow().isoformat(),
    }
    if extra:
        item.update(extra)
    table.put_item(Item=item)
    return run_id


def _floats_to_decimal(value):
    """DynamoDB's boto3 Table resource rejects native Python floats outright
    (TypeError: Float types are not supported. Use Decimal types instead).
    duration_seconds and similar fields parsed from the switchover script's
    JSON marker arrive as floats, so anything written via
    update_dr_run_record() needs this conversion — recursing through
    dicts/lists since fields like fail_details or final_roles can nest
    further values."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: _floats_to_decimal(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_floats_to_decimal(v) for v in value]
    return value


def update_dr_run_record(run_id: str, updates: dict) -> None:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_RUN_LOG_TABLE)
    expr_names, expr_values, set_clauses = {}, {}, []
    for i, (k, v) in enumerate(updates.items()):
        expr_names[f"#f{i}"] = k
        expr_values[f":v{i}"] = _floats_to_decimal(v)
        set_clauses.append(f"#f{i} = :v{i}")
    expr_values[":ua"] = datetime.utcnow().isoformat()
    set_clauses.append("updated_at = :ua")
    table.update_item(
        Key={"run_id": run_id},
        UpdateExpression="SET " + ", ".join(set_clauses),
        ExpressionAttributeNames=expr_names,
        ExpressionAttributeValues=expr_values,
    )


def get_dr_run_record(run_id: str) -> Optional[Dict[str, Any]]:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_RUN_LOG_TABLE)
    return table.get_item(Key={"run_id": run_id}).get("Item")

def get_tried_hosts(ag_name: str) -> list:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_RUN_LOG_TABLE)
    item = table.get_item(Key={"run_id": f"roles-retry-{ag_name}"}).get("Item")
    return item.get("tried_hosts", []) if item else []


def add_tried_host(ag_name: str, host: str) -> None:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_RUN_LOG_TABLE)
    tried = get_tried_hosts(ag_name)
    if host.lower() not in [h.lower() for h in tried]:
        tried.append(host)
    table.put_item(Item={
        "run_id": f"roles-retry-{ag_name}",
        "ag_name": ag_name,
        "tried_hosts": tried,
        "updated_at": datetime.utcnow().isoformat(),
        "expires_at": int(time.time()) + 600,
    })

def _get_retry_record(ag_name: str) -> Optional[Dict[str, Any]]:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_RUN_LOG_TABLE)
    return table.get_item(Key={"run_id": f"roles-retry-{ag_name}"}).get("Item")


def get_active_retry_state(ag_name: str) -> Optional[Dict[str, Any]]:
    """Returns the in-progress retry record for this AG if one exists and
    hasn't expired, else None. Used by the top-level trigger endpoint to
    detect an accidental re-trigger mid-retry-chain (e.g. a UI 'retry'
    button or agent re-calling the trigger tool instead of polling)."""
    item = _get_retry_record(ag_name)
    if not item:
        return None
    if int(item.get("expires_at", 0)) < int(time.time()):
        return None
    return item


def record_retry_job_id(ag_name: str, job_id: str) -> None:
    """Records the most recently dispatched job_id for this AG's retry
    chain, without altering tried_hosts/collected data. Called at both the
    initial trigger and every subsequent retry dispatch, so an accidental
    re-trigger mid-chain can be handed the correct job_id to poll instead
    of silently restarting."""
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_RUN_LOG_TABLE)
    existing = _get_retry_record(ag_name) or {}
    table.put_item(Item={
        "run_id": f"roles-retry-{ag_name}",
        "ag_name": ag_name,
        "tried_hosts": existing.get("tried_hosts", []),
        "collected_roles": existing.get("collected_roles", []),
        "collected_db_sync": existing.get("collected_db_sync", []),
        "last_job_id": job_id,
        "updated_at": datetime.utcnow().isoformat(),
        "expires_at": int(time.time()) + 600,
    })


def accumulate_ag_partial_result(ag_name: str, roles: list, db_sync: list) -> None:
    """Merges one attempt's partial roles/db_sync into the AG's retry-cycle
    accumulator (deduped by ReplicaName / DBName+Replica), so once all
    hosts have been tried, the union of every partial view collected can
    be returned instead of just the last host's single row."""
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_RUN_LOG_TABLE)
    existing = _get_retry_record(ag_name) or {}

    roles_by_name = {r.get("ReplicaName"): r for r in existing.get("collected_roles", [])}
    for r in roles:
        if r.get("ReplicaName"):
            roles_by_name[r["ReplicaName"]] = r

    dbsync_by_key = {
        (d.get("DBName"), d.get("Replica")): d for d in existing.get("collected_db_sync", [])
    }
    for d in db_sync:
        dbsync_by_key[(d.get("DBName"), d.get("Replica"))] = d

    table.put_item(Item={
        "run_id": f"roles-retry-{ag_name}",
        "ag_name": ag_name,
        "tried_hosts": existing.get("tried_hosts", []),
        "last_job_id": existing.get("last_job_id"),
        "collected_roles": list(roles_by_name.values()),
        "collected_db_sync": list(dbsync_by_key.values()),
        "updated_at": datetime.utcnow().isoformat(),
        "expires_at": int(time.time()) + 600,
    })


def get_accumulated_ag_result(ag_name: str) -> Dict[str, list]:
    item = _get_retry_record(ag_name)
    if not item:
        return {"roles": [], "db_sync": []}
    return {
        "roles": item.get("collected_roles", []),
        "db_sync": item.get("collected_db_sync", []),
    }

def clear_tried_hosts(ag_name: str) -> None:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_RUN_LOG_TABLE)
    table.delete_item(Key={"run_id": f"roles-retry-{ag_name}"})

def create_dr_confirmation_token(run_id: str, ag_name: str) -> str:
    token = uuid.uuid4().hex
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_TOKENS_TABLE)
    table.put_item(Item={
        "token": token,
        "run_id": run_id,
        "ag_name": ag_name,
        "consumed": False,
        "created_at": datetime.utcnow().isoformat(),
        "expires_at": int(time.time()) + DR_TOKEN_TTL_SECONDS,
    })
    return token

def post_teams_approval_card(ag_name: str, run_id: str, token: str, evaluation: dict) -> tuple:
    """Returns (sent: bool, detail: str). detail is empty on success, or the
    actual reason on failure — surfaced in the /plan API response so this is
    diagnosable from the browser Network tab without needing CloudWatch access."""
    webhook_url = get_teams_dr_approval_webhook_url()
    if not webhook_url:
        msg = "TEAMS_DR_APPROVAL_WEBHOOK_URL not configured - skipping Teams notification"
        logger.warning(msg)
        return False, msg

    check_lines = []
    for c in evaluation.get("checks", []):
        icon = "PASS" if c["result"] == "PASS" else "FAIL"
        check_lines.append(f"[{icon}] {c['detail']}")

    checks_summary = "\n".join(check_lines) if check_lines else "No checks available"

    payload = {
        "ag_name": ag_name or "",
        "run_id": run_id or "",
        "confirmation_token": token or "",
        "primary_host": evaluation.get("primary_host") or "unknown",
        "dr_replica_host": evaluation.get("dr_replica_host") or "unknown",
        "failover_scope": evaluation.get("failover_scope") or "unknown",
        "checks_summary": checks_summary,
    }

    try:
        req = urllib.request.Request(
            webhook_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            ok = resp.status in (200, 202)
            return ok, "" if ok else f"Webhook returned HTTP {resp.status}"
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        logger.error(f"Failed to post Teams approval card: {msg}")
        return False, msg

def peek_dr_confirmation_token(token: str, ag_name: str) -> Optional[Dict[str, Any]]:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_TOKENS_TABLE)
    item = table.get_item(Key={"token": token}).get("Item")
    if not item or item.get("consumed") or item.get("ag_name") != ag_name:
        return None
    if int(item.get("expires_at", 0)) < int(time.time()):
        return None
    return item


def consume_dr_confirmation_token(token: str, ag_name: str) -> Optional[Dict[str, Any]]:
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(DR_TOKENS_TABLE)
    item = table.get_item(Key={"token": token}).get("Item")
    if not item or item.get("consumed") or item.get("ag_name") != ag_name:
        return None
    if int(item.get("expires_at", 0)) < int(time.time()):
        return None
    table.update_item(
        Key={"token": token},
        UpdateExpression="SET #c = :c",
        ExpressionAttributeNames={"#c": "consumed"},
        ExpressionAttributeValues={":c": True},
    )
    return item



def _run_sync_check(event, claims, resource_id, region, account_id,
                     automation_type, automation_data, id_prefix):
    """Shared internal helper for the named demo status-check endpoints
    (EC2, DB, ASCS, PAS, AAS) — builds the job, waits up to 18s internally,
    returns the same response shape /notify-sync itself returns.

    REMOVED: the authorized/viewer check that used to live here. Every
    caller (handle_ec2_statuscheck, the "status" branch of
    handle_sap_action) already calls authorize_action() before reaching
    this helper — that redundant check assumed "authorized == false"
    always means "block," but it doesn't: a pure team member (e.g. SAP
    Basis team, no separate role group) can be legitimately ALLOWED by
    authorize_action via team membership alone while still carrying
    authorized="false" on their token (that field only reflects role-group
    membership, not team membership). This stale duplicate check was
    silently re-blocking exactly the population authorize_action's team
    bypass was built to let through, producing a confusing nested 403
    ("User is not authorized.") even after the outer call had already
    succeeded. Trust the caller's gate; do not re-check here."""
    job_id = str(uuid.uuid4())
    body = {
        "id": f"{id_prefix}-{job_id[:8]}",
        "job_id": job_id,
        "region": region,
        "account_id": account_id,
        "resource_id": resource_id,
        "automation_type": automation_type,
        "automation_data": automation_data,
    }

    if not validate_message_payload(body):
        return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps({"error": "Invalid payload"})}

    transformed = transform_message_data(body, job_id)
    if not store_message_in_dynamodb(transformed):
        return {"statusCode": 500, "headers": CORS_HEADERS, "body": json.dumps({"error": "Failed to create job"})}

    import time as _time
    TIMEOUT_SEC, POLL_SEC, elapsed = 18, 2, 0
    job = None
    terminal = ("COMPLETED", "SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED")
    while elapsed < TIMEOUT_SEC:
        _time.sleep(POLL_SEC)
        elapsed += POLL_SEC
        job = get_job_by_id(job_id)
        if job and job.get("status") in terminal:
            break

    if not job or job.get("status") not in terminal:
        return {"statusCode": 202, "headers": CORS_HEADERS,
                "body": json.dumps({"job_id": job_id, "status": "RUNNING",
                    "message": "Still running after 18s -- poll GET /jobs/{jobId} to continue."})}

    raw_output = job.get("qualys_output", "")
    exit_code = job.get("exit_code")
    script_result = None if exit_code in (-1, None) else ("PASSED" if exit_code == 0 else "FAILED")

    return {"statusCode": 200, "headers": CORS_HEADERS, "body": json.dumps({
        "job_id": job["job_id"], "status": job["status"],
        "resource_id": job.get("resource_id"), "account_id": job.get("account_id"),
        "region": job.get("region"), "automation_type": job.get("automation_type"),
        "ec2_state": job.get("ec2_state"), "exit_code": exit_code,
        "script_result": script_result, "output": raw_output,
        "created_at": job.get("created_at"), "updated_at": job.get("updated_at"),
    }, default=decimal_default)}