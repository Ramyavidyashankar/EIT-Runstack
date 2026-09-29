"""
runstack-ssm-region-proxy

Single region-aware Lambda handling SendCommand/GetCommandInvocation (SSM
RunCommand), StartAutomationExecution/GetAutomationExecution (SSM
Automation), GetAutomationExecution for child executions, and
DescribeInstances (EC2), since Step Functions' native aws-sdk:*
integrations have no way to target a region other than wherever the
state machine itself runs.
"""

import json
import logging
import os

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

WORKFLOW_ROLE_ACCOUNT_ID = os.environ.get("WORKFLOW_ROLE_ACCOUNT_ID", "693426599691")
CROSS_ACCOUNT_ROLE_NAME = os.environ.get("CROSS_ACCOUNT_ROLE_NAME", "runstack-cross-account-role")


def get_cross_account_client(service: str, account_id: str, region: str):
    sts = boto3.client("sts")

    # Hop 1: assume runstack-workflow-role, the platform's single broker
    # role for cross-account access - this is the role Cloud Ops granted
    # our Lambda's execution role trust on.
    workflow_creds = sts.assume_role(
        RoleArn=f"arn:aws:iam::{WORKFLOW_ROLE_ACCOUNT_ID}:role/runstack-workflow-role",
        RoleSessionName="runstack-ssm-region-proxy-broker"
    )["Credentials"]

    sts_as_workflow = boto3.client(
        "sts",
        aws_access_key_id=workflow_creds["AccessKeyId"],
        aws_secret_access_key=workflow_creds["SecretAccessKey"],
        aws_session_token=workflow_creds["SessionToken"],
    )

    # Hop 2: from runstack-workflow-role, assume the target account's
    # runstack-cross-account-role - runstack-workflow-role already has
    # this permission, so no target-account trust policy changes needed.
    target_creds = sts_as_workflow.assume_role(
        RoleArn=f"arn:aws:iam::{account_id}:role/{CROSS_ACCOUNT_ROLE_NAME}",
        RoleSessionName="runstack-ssm-region-proxy"
    )["Credentials"]

    return boto3.client(
        service, region_name=region,
        aws_access_key_id=target_creds["AccessKeyId"],
        aws_secret_access_key=target_creds["SecretAccessKey"],
        aws_session_token=target_creds["SessionToken"],
    )


def get_cross_account_ssm(account_id: str, region: str):
    """Kept for backward compatibility - equivalent to
    get_cross_account_client('ssm', account_id, region)."""
    return get_cross_account_client("ssm", account_id, region)


def handle_send_command(event, ssm):
    automation_data = event.get("automation_data", {})

    kwargs = {
        "DocumentName": automation_data.get("DocumentName"),
        "InstanceIds": automation_data.get("InstanceIds", []),
    }
    optional_fields = {
        "Comment": automation_data.get("Comment"),
        "DocumentVersion": automation_data.get("DocumentVersion"),
        "Parameters": automation_data.get("Parameters"),
        "TimeoutSeconds": automation_data.get("TimeoutSeconds"),
        "MaxConcurrency": automation_data.get("MaxConcurrency"),
        "MaxErrors": automation_data.get("MaxErrors"),
        "OutputS3BucketName": automation_data.get("OutputS3BucketName"),
        "OutputS3KeyPrefix": automation_data.get("OutputS3KeyPrefix"),
        "OutputS3Region": automation_data.get("OutputS3Region"),
        "ServiceRoleArn": automation_data.get("ServiceRoleArn"),
    }
    for key, value in optional_fields.items():
        if value is not None:
            kwargs[key] = value

    response = ssm.send_command(**kwargs)
    logger.info(f"SendCommand succeeded: {response['Command']['CommandId']}")
    return _clean_datetimes({"Command": response["Command"]})


def handle_get_invocation(event, ssm):
    command_id = event["command_result"]["Command"]["CommandId"]
    instance_id = event["resource_id"]

    try:
        response = ssm.get_command_invocation(CommandId=command_id, InstanceId=instance_id)
        return _clean_datetimes(response)
    except ClientError as e:
        if e.response["Error"]["Code"] == "InvocationDoesNotExist":
            return {"Status": "Pending"}
        raise


def handle_start_automation(event, ssm):
    automation_data = event.get("automation_data", {})

    kwargs = {
        "DocumentName": automation_data.get("DocumentName"),
    }
    optional_fields = {
        "DocumentVersion": automation_data.get("DocumentVersion"),
        "Parameters": automation_data.get("Parameters"),
        "TargetParameterName": automation_data.get("TargetParameterName"),
        "Targets": automation_data.get("Targets"),
        "TargetMaps": automation_data.get("TargetMaps"),
        "TargetLocations": automation_data.get("TargetLocations"),
        "MaxConcurrency": automation_data.get("MaxConcurrency"),
        "MaxErrors": automation_data.get("MaxErrors"),
        "Tags": automation_data.get("Tags"),
        "ClientToken": automation_data.get("ClientToken"),
        "Mode": automation_data.get("Mode"),
    }
    for key, value in optional_fields.items():
        if value is not None:
            kwargs[key] = value

    response = ssm.start_automation_execution(**kwargs)
    logger.info(f"StartAutomationExecution succeeded: {response['AutomationExecutionId']}")
    return _clean_datetimes({"AutomationExecutionId": response["AutomationExecutionId"]})


def handle_monitor_automation(event, ssm):
    automation_execution_id = event["command_result"]["AutomationExecutionId"]
    response = ssm.get_automation_execution(AutomationExecutionId=automation_execution_id)
    return _clean_datetimes({"AutomationExecution": response["AutomationExecution"]})


def handle_get_child_output(event, ssm):
    """Fetch a child automation execution's output. Used when a parent
    automation's TargetLocations spawns a child execution in another
    region - the parent's StepExecutions only contains a pointer
    (ExecutionId) to the child, not its actual output, and Step
    Functions can't natively query a different region to resolve it."""
    execution_id = event["execution_id"]
    response = ssm.get_automation_execution(AutomationExecutionId=execution_id)
    return _clean_datetimes({"AutomationExecution": response["AutomationExecution"]})


def handle_describe_ec2(event, ec2):
    instance_id = event["resource_id"]
    response = ec2.describe_instances(InstanceIds=[instance_id])
    return _clean_datetimes({"Reservations": response["Reservations"]})


def _clean_datetimes(obj):
    """Recursively convert datetime objects to ISO strings so the response
    can be JSON-serialized when Step Functions marshals the Lambda's return
    value."""
    from datetime import datetime
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {k: _clean_datetimes(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean_datetimes(v) for v in obj]
    return obj


def lambda_handler(event, context):
    logger.info(f"Received event: {json.dumps(event)}")

    action = event.get("action")
    region = event.get("region", "us-east-1")
    account_id = event.get("account_id")

    valid_actions = ("send", "monitor", "start_automation", "monitor_automation", "describe_ec2", "get_child_output")
    if not action or action not in valid_actions:
        raise ValueError(f"Missing or invalid 'action' field: {action!r} (expected one of {valid_actions})")

    if action == "describe_ec2":
        ec2 = get_cross_account_client("ec2", account_id, region)
        return handle_describe_ec2(event, ec2)

    ssm = get_cross_account_client("ssm", account_id, region)

    if action == "send":
        return handle_send_command(event, ssm)
    elif action == "monitor":
        return handle_get_invocation(event, ssm)
    elif action == "start_automation":
        return handle_start_automation(event, ssm)
    elif action == "monitor_automation":
        return handle_monitor_automation(event, ssm)
    elif action == "get_child_output":
        return handle_get_child_output(event, ssm)