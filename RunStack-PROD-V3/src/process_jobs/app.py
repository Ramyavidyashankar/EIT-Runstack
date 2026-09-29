"""
Lambda function to process DynamoDB streams and trigger Step Functions.

This function receives DynamoDB stream events, filters for SSM automation types,
and starts the appropriate Step Function workflow for job processing.
"""

import json
import logging
import os
from typing import Dict, Any

import boto3
from botocore.exceptions import ClientError

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

# Environment variables
STEP_FUNCTION_ARN = os.getenv("STEP_FUNCTION_ARN")

# Initialize AWS clients lazily
_stepfunctions = None


def get_stepfunctions_client():
    """Get Step Functions client (lazy initialization)."""
    global _stepfunctions
    if _stepfunctions is None:
        _stepfunctions = boto3.client("stepfunctions")
    return _stepfunctions


def start_step_function_execution(input_data: Dict[str, Any]) -> bool:
    """
    Start the Step Function execution with the provided input data.

    Args:
        input_data (Dict[str, Any]): Input data for the Step Function

    Returns:
        bool: True if execution started successfully, False otherwise
    """
    try:
        stepfunctions = get_stepfunctions_client()
        execution_name = f"{input_data['job_id']}"

        response = stepfunctions.start_execution(
            stateMachineArn=STEP_FUNCTION_ARN,
            name=execution_name,
            input=json.dumps(input_data),
        )

        execution_arn = response["executionArn"]
        logger.info(f"Started Step Function execution: {execution_arn}")
        return True

    except ClientError as e:
        error_code = e.response["Error"]["Code"]
        error_message = e.response["Error"]["Message"]

        if error_code == "ExecutionAlreadyExists":
            logger.warning(
                f"Step Function execution already exists for job: {input_data['job_id']}"
            )
            return True  # Consider this as success since execution exists
        else:
            logger.error(f"Step Functions ClientError: {error_code} - {error_message}")
            return False

    except Exception as e:
        logger.error(f"Unexpected error starting Step Function: {str(e)}")
        return False


def prepare_step_function_input(job_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Prepare the input payload for the Step Function execution.
    Add all missing fields to automation_data to avoid Step Function JSONPath errors.

    Args:
        job_data (Dict[str, Any]): Job data from DynamoDB (already converted to JSON)

    Returns:
        Dict[str, Any]: Formatted input for Step Function
    """
    try:
        # Get automation_data and add missing fields based on automation type
        automation_data = job_data.get("automation_data", {}).copy()
        automation_type = job_data.get("automation_type")

        # ============================================================
        # ✅ EC2-ACTION HANDLING (NEW - MUST BE FIRST)
        # ============================================================
        if automation_type == "EC2-Action":
            step_function_input = {
                "job_id": job_data.get("job_id"),
                "notification_id": job_data.get("notification_id"),
                "account_id": job_data.get("account_id"),
                "region": job_data.get("region"),
                "resource_id": job_data.get("resource_id"),
                "automation_type": automation_type,
                "automation_data": automation_data,  # pass as-is
                "status": job_data.get("status"),
            }

            logger.info(
                f"Prepared Step Function input for EC2 job: {step_function_input['job_id']}"
            )
            logger.info(
                f"Step Function input data: {json.dumps(step_function_input, indent=2)}"
            )

            return step_function_input
            
        if automation_type == "SSM-Automation":
            # Add all possible fields for StartAutomationExecution API
            automation_fields = {
                "AlarmConfiguration": None,
                "ClientToken": None,
                "DocumentName": automation_data.get("DocumentName"),
                "DocumentVersion": None,
                "MaxConcurrency": None,
                "MaxErrors": None,
                "Mode": None,
                "Parameters": automation_data.get("Parameters", {}),
                "Tags": None,
                "TargetLocations": None,
                "TargetMaps": None,
                "TargetParameterName": None,
                "Targets": None,
            }
            # Update with existing values from automation_data
            for key, value in automation_data.items():
                if key in automation_fields:
                    automation_fields[key] = value
            automation_data = automation_fields

        elif automation_type == "SSM-RunCommand":
            # Add all possible fields for SendCommand API
            automation_fields = {
                "AlarmConfiguration": None,
                "CloudWatchOutputConfig": None,
                "Comment": automation_data.get(
                    "Comment", f"RunStack execution for job {job_data.get('job_id')}"
                ),
                "DocumentHash": None,
                "DocumentHashType": None,
                "DocumentName": automation_data.get("DocumentName"),
                "DocumentVersion": None,
                "InstanceIds": automation_data.get("InstanceIds", []),
                "MaxConcurrency": None,
                "MaxErrors": None,
                "NotificationConfig": None,
                "OutputS3BucketName": None,
                "OutputS3KeyPrefix": None,
                "OutputS3Region": None,
                "Parameters": automation_data.get("Parameters", {}),
                "ServiceRoleArn": None,
                "Targets": None,
                "TimeoutSeconds": None,
                # Cross-region fields set by normalize_runcommand_data() in
                # process_messages/shared.py. Must be preserved here or the
                # ExecuteSSMRunCommandCrossRegion state has nothing to read.
                "TargetDocumentName": None,
                "TargetLocations": None,
            }
            # Update with existing values from automation_data
            for key, value in automation_data.items():
                if key in automation_fields:
                    automation_fields[key] = value
            automation_data = automation_fields

        step_function_input = {
            "job_id": job_data.get("job_id"),
            "notification_id": job_data.get("notification_id"),
            "account_id": job_data.get("account_id"),
            "region": job_data.get("region"),
            "resource_id": job_data.get("resource_id"),
            "automation_type": automation_type,
            "automation_data": automation_data,
            "status": job_data.get("status"),
        }

        logger.info(
            f"Prepared Step Function input for job: {step_function_input['job_id']}"
        )
        logger.info(
            f"Step Function input data: {json.dumps(step_function_input, indent=2)}"
        )
        return step_function_input

    except Exception as e:
        logger.error(f"Error preparing Step Function input: {str(e)}")
        raise


def convert_dynamodb_to_json(dynamodb_item):
    """
    Recursively convert DynamoDB format to standard JSON format.

    Args:
        dynamodb_item: DynamoDB item with type descriptors (S, N, M, L, etc.)

    Returns:
        Standard JSON object
    """
    if isinstance(dynamodb_item, dict):
        if len(dynamodb_item) == 1:
            key, value = next(iter(dynamodb_item.items()))
            if key == "S":  # String
                return value
            elif key == "N":  # Number
                return int(value) if value.isdigit() else float(value)
            elif key == "BOOL":  # Boolean
                return value
            elif key == "M":  # Map
                return {k: convert_dynamodb_to_json(v) for k, v in value.items()}
            elif key == "L":  # List
                return [convert_dynamodb_to_json(item) for item in value]
            elif key == "NULL":  # Null
                return None
        # If it's not a DynamoDB type descriptor, process as regular dict
        return {k: convert_dynamodb_to_json(v) for k, v in dynamodb_item.items()}
    elif isinstance(dynamodb_item, list):
        return [convert_dynamodb_to_json(item) for item in dynamodb_item]
    else:
        return dynamodb_item


def extract_dynamodb_data(record: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extract and transform DynamoDB stream record data to standard JSON format.

    Args:
        record (Dict[str, Any]): DynamoDB stream record

    Returns:
        Dict[str, Any]: Extracted data from the record in standard JSON format
    """
    try:
        # Get the new image from the stream record
        if "NewImage" not in record["dynamodb"]:
            logger.warning("No NewImage found in DynamoDB record")
            return {}

        new_image = record["dynamodb"]["NewImage"]

        # Convert DynamoDB format to standard JSON
        extracted_data = convert_dynamodb_to_json(new_image)

        logger.info(
            f"Extracted data for job_id: {extracted_data.get('job_id', 'unknown')}"
        )
        return extracted_data

    except Exception as e:
        logger.error(f"Error extracting DynamoDB data: {str(e)}")
        return {}


def process_dynamodb_record(record: Dict[str, Any]) -> bool:
    """
    Process a single DynamoDB stream record.

    Args:
        record (Dict[str, Any]): DynamoDB stream record

    Returns:
        bool: True if processing was successful, False otherwise
    """
    try:
        # Only process INSERT events (new records)
        event_name = record.get("eventName")
        if event_name != "INSERT":
            logger.info(f"Skipping {event_name} event - only processing INSERT events")
            return True

        #if event_name not in ["INSERT", "MODIFY"]:
        #    logger.info(f"Skipping {event_name} event")
        #    return True
        # Extract job data from DynamoDB record
        job_data = extract_dynamodb_data(record)
        if not job_data:
            logger.error("Failed to extract job data from DynamoDB record")
            return False

        # Check if we should process this automation type
        automation_type = job_data.get("automation_type")
        if not automation_type:
            logger.error("Missing automation_type in job data")
            return False

        # Prepare Step Function input
        step_function_input = prepare_step_function_input(job_data)

        # Start Step Function execution
        if start_step_function_execution(step_function_input):
            logger.info(
                f"Successfully triggered Step Function for job: {job_data['job_id']}"
            )
            return True
        else:
            logger.error(f"Failed to start Step Function for job: {job_data['job_id']}")
            return False

    except Exception as e:
        logger.error(f"Error processing DynamoDB record: {str(e)}")
        return False


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Main Lambda handler function to process DynamoDB stream events.

    This function processes batches of DynamoDB stream records, with each batch
    potentially containing multiple records that need to be processed individually.

    Args:
        event (Dict[str, Any]): Lambda event containing DynamoDB stream records
        context (Any): Lambda context object

    Returns:
        Dict[str, Any]: Processing results
    """
    records = event.get("Records", [])
    total_records = len(records)

    logger.info(f"Processing batch of {total_records} DynamoDB stream records")

    successful_records = 0
    failed_records = 0
    skipped_records = 0
    failed_record_details = []

    for i, record in enumerate(records):
        try:
            logger.info(f"Processing record {i+1}/{total_records}")
            # logger.info(f"Event: {json.dumps(record, indent=2)}")
            result = process_dynamodb_record(record)
            if result:
                successful_records += 1
            else:
                failed_records += 1
                failed_record_details.append(
                    {
                        "record_index": i,
                        "event_name": record.get("eventName"),
                        "reason": "Processing returned False",
                    }
                )

        except Exception as e:
            logger.error(f"Critical error processing DynamoDB record {i+1}: {str(e)}")
            failed_records += 1
            failed_record_details.append(
                {
                    "record_index": i,
                    "event_name": record.get("eventName"),
                    "error": str(e),
                }
            )

    # Log detailed results
    logger.info(
        f"Batch processing complete: {successful_records} successful, {failed_records} failed, {skipped_records} skipped"
    )

    if failed_record_details:
        logger.error(
            f"Failed record details: {json.dumps(failed_record_details, indent=2)}"
        )

    result = {
        "statusCode": 200,
        "body": {
            "batch_size": total_records,
            "processed_records": total_records,
            "successful_records": successful_records,
            "failed_records": failed_records,
            "skipped_records": skipped_records,
            "failed_record_details": failed_record_details,
        },
    }

    # If any records failed, raise an exception to trigger retry mechanism
    # This will cause the entire batch to be retried
    if failed_records > 0:
        error_msg = f"Failed to process {failed_records} out of {total_records} DynamoDB records"
        logger.error(error_msg)
        raise Exception(error_msg)

    return result