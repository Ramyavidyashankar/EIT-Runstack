"""
Lambda function to sync instance catalog from S3 CSV to DynamoDB.
Triggered by S3 upload event or EventBridge schedule.

CSV format — only app_id, instance_id, name, account_id, region are
required. Any additional columns (app_name, server_name, environment,
description, os_type, etc.) are copied through automatically — there is
no fixed allowlist, so new columns can be added to the CSV at any time
without needing a code change here.

Example:
app_id,instance_id,name,account_id,region,environment,description,app_name,server_name
500579,i-0555494bdfd9d21ca,ec2-dxcitrundeck-01,975050354211,us-east-1,ITG,Rundeck Server,EIT Rundeck,EC2_LNX_C40T300293
"""

import json
import logging
import os
import csv
import io
from datetime import datetime
from typing import Dict, Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

CATALOG_TABLE = os.getenv("INSTANCE_CATALOG_TABLE", "runstack-instance-catalog")
S3_BUCKET     = os.getenv("CATALOG_S3_BUCKET", "runstack-job-scheduler-246314649749-us-east-1")
S3_KEY        = os.getenv("CATALOG_S3_KEY", "app-catalogs/instance-catalog.csv")

REQUIRED_COLS = {"app_id", "instance_id", "name", "account_id", "region"}

# Defaults applied only when these specific columns are absent from the CSV
# entirely — if present (even empty), the CSV's value is used as-is.
DEFAULTS = {"region": "us-east-1"}


def sync_catalog() -> Dict[str, Any]:
    """Read CSV from S3 and sync to DynamoDB."""
    s3  = boto3.client("s3")
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(CATALOG_TABLE)

    # Download CSV
    logger.info(f"Downloading catalog from s3://{S3_BUCKET}/{S3_KEY}")
    try:
        obj = s3.get_object(Bucket=S3_BUCKET, Key=S3_KEY)
        content = obj["Body"].read().decode("utf-8")
    except ClientError as e:
        logger.error(f"Failed to download catalog CSV: {e}")
        raise

    # Parse CSV
    reader = csv.DictReader(io.StringIO(content))
    rows = list(reader)

    # Validate columns
    if rows:
        missing = REQUIRED_COLS - set(rows[0].keys())
        if missing:
            raise ValueError(f"CSV missing required columns: {missing}")

    logger.info(f"Parsed {len(rows)} rows from CSV. Columns: {list(rows[0].keys()) if rows else []}")

    # Clear existing items (full refresh)
    scan = table.scan(ProjectionExpression="instance_id, app_id")
    with table.batch_writer() as batch:
        for item in scan.get("Items", []):
            batch.delete_item(Key={
                "instance_id": item["instance_id"],
                "app_id":      item["app_id"]
            })

    # Write new items — every column present in the CSV is copied through
    # as-is (after stripping whitespace), not just a fixed allowlist. This
    # means adding a new column to the CSV (e.g. server_name, os_type,
    # app_name) automatically makes it into DynamoDB without any code change.
    synced = 0
    errors = 0
    with table.batch_writer() as batch:
        for row in rows:
            try:
                item = {}
                for key, value in row.items():
                    if key is None:
                        continue  # csv.DictReader artifact for malformed rows
                    cleaned = (value or "").strip()
                    if not cleaned and key in DEFAULTS:
                        cleaned = DEFAULTS[key]
                    item[key.strip()] = cleaned
                item["synced_at"] = datetime.utcnow().isoformat()

                batch.put_item(Item=item)
                synced += 1
            except Exception as e:
                logger.error(f"Error writing row {row}: {e}")
                errors += 1

    logger.info(f"Sync complete: {synced} synced, {errors} errors")
    return {"synced": synced, "errors": errors, "total": len(rows)}


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    logger.info(f"Catalog sync triggered: {json.dumps(event)}")
    try:
        result = sync_catalog()
        return {"statusCode": 200, "body": json.dumps(result)}
    except Exception as e:
        logger.error(f"Catalog sync failed: {e}")
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
