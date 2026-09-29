"""
Lambda function to process scheduled events and send messages to SQS queue.

This function is triggered by EventBridge rules, reads account_id and instance_id pairs from S3 CSV files,
and sends individual messages to the CSA notification queue for each pair.
"""

import json
import logging
import os
from typing import Dict, Any, List, Tuple
import uuid
import csv
from io import StringIO

import boto3
from botocore.exceptions import ClientError

# Configure logging
logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

# Environment variables
SQS_QUEUE_URL = os.getenv("SQS_QUEUE_URL")

# Initialize AWS clients lazily
_s3_client = None
_sqs_client = None


def get_s3_client():
    """Get S3 client (lazy initialization)."""
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client("s3")
    return _s3_client


def get_sqs_client():
    """Get SQS client (lazy initialization)."""
    global _sqs_client
    if _sqs_client is None:
        _sqs_client = boto3.client("sqs")
    return _sqs_client


def read_csv_from_s3(s3_file: str) -> List[Tuple[str, str]]:
    """
    Read account_id and instance_id pairs from S3 CSV file.
    
    Args:
        s3_file (str): S3 URI in format s3://bucket/key
        
    Returns:
        List[Tuple[str, str]]: List of (account_id, instance_id) tuples
    """
    try:
        # Parse S3 URI
        if not s3_file.startswith("s3://"):
            raise ValueError(f"Invalid S3 URI format: {s3_file}")
        
        s3_path = s3_file[5:]  # Remove 's3://'
        bucket, key = s3_path.split("/", 1)
        
        logger.info(f"Reading CSV from s3://{bucket}/{key}")
        
        s3_client = get_s3_client()
        response = s3_client.get_object(Bucket=bucket, Key=key)
        content = response["Body"].read().decode("utf-8")
        
        # Parse CSV content
        csv_reader = csv.reader(StringIO(content))
        pairs = []
        
        for row_num, row in enumerate(csv_reader, 1):
            if len(row) >= 2:
                account_id = row[0].strip()
                instance_id = row[1].strip()
                
                # Validate account_id format (12 digits)
                if len(account_id) == 12 and account_id.isdigit():
                    pairs.append((account_id, instance_id))
                else:
                    logger.warning(f"Invalid account_id format in row {row_num}: {account_id}")
            else:
                logger.warning(f"Invalid CSV row {row_num}: {row}")
        
        logger.info(f"Found {len(pairs)} valid account_id,instance_id pairs")
        return pairs
        
    except ClientError as e:
        logger.error(f"S3 ClientError: {e.response['Error']['Message']}")
        raise
    except Exception as e:
        logger.error(f"Error reading S3 CSV file {s3_file}: {str(e)}")
        raise


def replace_placeholders(payload: Dict[str, Any], account_id: str, instance_id: str) -> Dict[str, Any]:
    """
    Replace placeholder values in payload with actual account_id and instance_id.
    
    Args:
        payload (Dict[str, Any]): Original payload with placeholders
        account_id (str): Account ID to replace placeholders
        instance_id (str): Instance ID to replace placeholders
        
    Returns:
        Dict[str, Any]: Payload with replaced values
    """
    try:
        payload_str = json.dumps(payload)
        
        # Replace placeholders
        payload_str = payload_str.replace("{{ACCOUNT_ID}}", account_id)
        payload_str = payload_str.replace("${ACCOUNT_ID}", account_id)
        payload_str = payload_str.replace("{{INSTANCE_ID}}", instance_id)
        payload_str = payload_str.replace("${INSTANCE_ID}", instance_id)
        
        return json.loads(payload_str)
    except Exception as e:
        logger.error(f"Error replacing placeholders: {str(e)}")
        raise


def send_message_to_sqs(payload: Dict[str, Any]) -> bool:
    """
    Send message to SQS queue.
    
    Args:
        payload (Dict[str, Any]): Message payload
        
    Returns:
        bool: True if successful, False otherwise
    """
    try:
        sqs_client = get_sqs_client()
        
        response = sqs_client.send_message(
            QueueUrl=SQS_QUEUE_URL,
            MessageBody=json.dumps(payload)
        )
        
        logger.info(f"Message sent to SQS: {response['MessageId']}")
        return True
        
    except ClientError as e:
        logger.error(f"SQS ClientError: {e.response['Error']['Message']}")
        return False
    except Exception as e:
        logger.error(f"Error sending message to SQS: {str(e)}")
        return False


def validate_event_payload(event: Dict[str, Any]) -> bool:
    """
    Validate the EventBridge event payload structure and required fields.

    Args:
        event (Dict[str, Any]): The event payload to validate

    Returns:
        bool: True if payload is valid, False otherwise
    """
    try:
        # Check required fields
        if "payload" not in event:
            logger.error("Missing required field: payload")
            return False
            
        if "s3_file" not in event:
            logger.error("Missing required field: s3_file")
            return False
        
        payload = event["payload"]
        if not isinstance(payload, dict):
            logger.error("payload must be a dictionary")
            return False
        
        # Validate required payload fields
        required_fields = ["id", "automation_type", "automation_data"]
        for field in required_fields:
            if field not in payload:
                logger.error(f"Missing required payload field: {field}")
                return False
        
        # Validate automation_type
        if payload["automation_type"] not in ["SSM-Automation", "SSM-RunCommand"]:
            logger.error("Invalid automation_type. Must be 'SSM-Automation' or 'SSM-RunCommand'")
            return False
        
        # Validate automation_data
        automation_data = payload["automation_data"]
        if not isinstance(automation_data, dict):
            logger.error("automation_data must be a dictionary")
            return False
        
        if "DocumentName" not in automation_data:
            logger.error("automation_data.DocumentName is required")
            return False
        
        logger.info("Event payload validation successful")
        return True
        
    except Exception as e:
        logger.error(f"Error validating event payload: {str(e)}")
        return False


def process_scheduled_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """
    Process a scheduled EventBridge event.
    
    Args:
        event (Dict[str, Any]): EventBridge event
        
    Returns:
        Dict[str, Any]: Processing results
    """
    try:
        # Validate event payload
        if not validate_event_payload(event):
            raise ValueError("Event payload validation failed")
        
        # Extract payload from event
        payload_template = event["payload"]
        s3_file = event["s3_file"]
        rule_name = event.get("rule_name", "unknown")
        
        # Get current region
        current_region = boto3.Session().region_name or "us-east-1"
        
        # Read account_id,instance_id pairs from S3 CSV
        account_instance_pairs = read_csv_from_s3(s3_file)
        
        if not account_instance_pairs:
            logger.warning("No valid account_id,instance_id pairs found in S3 file")
            return {
                "processed_pairs": 0,
                "successful_sends": 0,
                "failed_sends": 0
            }
        
        # Process each account_id,instance_id pair
        successful_sends = 0
        failed_sends = 0
        
        for account_id, instance_id in account_instance_pairs:
            try:
                # Replace placeholders in payload
                processed_payload = replace_placeholders(payload_template, account_id, instance_id)
                
                # Set required fields
                processed_payload["id"] = f"sch-{rule_name}-{account_id}-{instance_id}-{uuid.uuid4().hex[:8]}"
                processed_payload["account_id"] = account_id
                processed_payload["region"] = current_region
                processed_payload["resource_id"] = instance_id
                
                # Send message to SQS
                if send_message_to_sqs(processed_payload):
                    successful_sends += 1
                else:
                    failed_sends += 1
                    
            except Exception as e:
                logger.error(f"Error processing pair {account_id},{instance_id}: {str(e)}")
                failed_sends += 1
        
        logger.info(f"Processing complete. Successful: {successful_sends}, Failed: {failed_sends}")
        
        return {
            "processed_pairs": len(account_instance_pairs),
            "successful_sends": successful_sends,
            "failed_sends": failed_sends
        }
        
    except Exception as e:
        logger.error(f"Error processing scheduled event: {str(e)}")
        raise


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Main Lambda handler function to process scheduled automation events.

    Args:
        event (Dict[str, Any]): EventBridge event
        context (Any): Lambda context object

    Returns:
        Dict[str, Any]: Processing results
    """
    logger.info(f"Processing scheduled event: {json.dumps(event)}")
    
    try:
        result = process_scheduled_event(event)
        
        response = {
            "statusCode": 200,
            "body": {
                "message": "Processing complete",
                "total_pairs": result["processed_pairs"],
                "successful_sends": result["successful_sends"],
                "failed_sends": result["failed_sends"]
            }
        }
        
        # If any sends failed, raise an exception for monitoring
        if result["failed_sends"] > 0:
            raise Exception(f"Failed to send {result['failed_sends']} messages to SQS")
        
        return response
        
    except Exception as e:
        logger.error(f"Error in lambda_handler: {str(e)}")
        return {
            "statusCode": 500,
            "body": {
                "error": str(e)
            }
        }
