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

Header names are matched loosely (case, spaces, dashes and underscores are
ignored) and common export names are mapped to the attribute names RunStack
reads — e.g. AccountId → account_id, ApplicationId → app_id,
ApplicationName → app_name, InstanceId → instance_id, InstanceName → name,
HostName → server_name, Environment → environment. Every other column is
stored under its snake_case name (OperatingSystem → operating_system).
The file may be comma- or tab-separated and may start with an Excel BOM.
"""

import json
import logging
import os
import csv
import io
import re
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

# Attribute names the rest of RunStack reads from the catalog, with the
# header spellings accepted for each. Headers are compared after
# lower-casing and removing everything except letters and digits, so
# "AccountId", "account_id", "Account ID" and "ACCOUNT-ID" all match.
HEADER_ALIASES = {
    "account_id":  ["accountid", "awsaccountid", "awsaccount"],
    "region":      ["region", "awsregion"],
    "app_id":      ["appid", "applicationid"],
    "app_name":    ["appname", "applicationname"],
    "instance_id": ["instanceid", "ec2instanceid"],
    "name":        ["name", "instancename"],
    "server_name": ["servername", "hostname"],
    "environment": ["environment", "env"],
}
_ALIAS_LOOKUP = {alias: canonical for canonical, aliases in HEADER_ALIASES.items() for alias in aliases}


def _squash(header: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (header or "").lower())


def _snake(header: str) -> str:
    """OperatingSystemVersion → operating_system_version, On-PremServer → on_prem_server."""
    h = re.sub(r"[^A-Za-z0-9]+", "_", (header or "").strip())
    h = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", h)
    h = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", h)
    return h.strip("_").lower()


def map_headers(headers):
    """Map raw CSV headers to stored attribute names. Returns (mapping, notes)."""
    mapping, used, notes = {}, set(), []
    for h in headers:
        if h is None:
            continue
        target = _ALIAS_LOOKUP.get(_squash(h)) or _snake(h)
        if not target:
            notes.append(f"ignored empty header {h!r}")
            continue
        if target in used:
            notes.append(f"ignored column {h!r}: another column already maps to {target!r}")
            continue
        used.add(target)
        mapping[h] = target
        if target != h:
            notes.append(f"{h!r} -> {target!r}")
    return mapping, notes


def _normalize_account_id(value: str) -> str:
    """Account IDs are 12 digits. Spreadsheets drop leading zeros, so pad a
    short all-digit value back to 12. Anything else is left as-is."""
    v = (value or "").strip()
    if v.isdigit() and len(v) < 12:
        return v.zfill(12)
    return v


def sync_catalog() -> Dict[str, Any]:
    """Read CSV from S3 and sync to DynamoDB."""
    s3  = boto3.client("s3")
    ddb = boto3.resource("dynamodb")
    table = ddb.Table(CATALOG_TABLE)

    # Download CSV
    logger.info(f"Downloading catalog from s3://{S3_BUCKET}/{S3_KEY}")
    try:
        obj = s3.get_object(Bucket=S3_BUCKET, Key=S3_KEY)
        # utf-8-sig drops the BOM Excel adds to "CSV UTF-8" files; without
        # this the first header reads "\ufeffAccountId" and never matches.
        content = obj["Body"].read().decode("utf-8-sig")
    except ClientError as e:
        logger.error(f"Failed to download catalog CSV: {e}")
        raise

    # Parse CSV — comma-separated, or tab-separated when the header line
    # has tabs and no commas (a sheet saved as "Text (Tab delimited)").
    first_line = content.split("\n", 1)[0]
    delimiter = "\t" if "\t" in first_line and "," not in first_line else ","
    reader = csv.DictReader(io.StringIO(content), delimiter=delimiter)
    mapping, notes = map_headers(reader.fieldnames or [])
    logger.info(f"Delimiter {'TAB' if delimiter == chr(9) else 'comma'}; header mapping: {'; '.join(notes) or 'none needed'}")

    # Validate columns before touching the table
    present = set(mapping.values())
    missing = REQUIRED_COLS - present
    if missing:
        raise ValueError(
            f"CSV missing required columns: {sorted(missing)}. "
            f"Found headers: {reader.fieldnames}. Accepted names: "
            + "; ".join(f"{c}: {', '.join(HEADER_ALIASES.get(c, [c]))}" for c in sorted(missing))
        )

    rows = list(reader)
    if not rows:
        # A full refresh with an empty file would wipe the catalog.
        raise ValueError("CSV has headers but no data rows — refusing to replace the catalog with nothing")

    logger.info(f"Parsed {len(rows)} rows from CSV. Columns stored as: {sorted(present)}")

    # Build items first, so a bad file fails before anything is deleted.
    items, skipped = [], 0
    now = datetime.utcnow().isoformat()
    for n, row in enumerate(rows, start=2):  # line 1 is the header
        item = {}
        for raw_key, value in row.items():
            key = mapping.get(raw_key)
            if not key:
                continue  # None (DictReader overflow) or an ignored duplicate
            cleaned = (value or "").strip() if isinstance(value, str) else ""
            if not cleaned and key in DEFAULTS:
                cleaned = DEFAULTS[key]
            item[key] = cleaned
        item["account_id"] = _normalize_account_id(item.get("account_id", ""))
        if not item.get("instance_id") or not item.get("app_id"):
            logger.warning(f"Skipping line {n}: instance_id and app_id are required (got {item.get('instance_id')!r}, {item.get('app_id')!r})")
            skipped += 1
            continue
        item["synced_at"] = now
        items.append(item)
    if not items:
        raise ValueError(f"No usable rows: all {len(rows)} rows are missing instance_id or app_id — catalog left unchanged")

    # Clear existing items (full refresh). Follow pagination — one scan
    # page stops at 1 MB and would leave old rows behind.
    scan_kwargs = {"ProjectionExpression": "instance_id, app_id"}
    with table.batch_writer() as batch:
        while True:
            scan = table.scan(**scan_kwargs)
            for existing in scan.get("Items", []):
                batch.delete_item(Key={"instance_id": existing["instance_id"], "app_id": existing["app_id"]})
            if not scan.get("LastEvaluatedKey"):
                break
            scan_kwargs["ExclusiveStartKey"] = scan["LastEvaluatedKey"]

    # Write new items. overwrite_by_pkeys: a repeated (instance_id, app_id)
    # row in the file replaces the earlier one instead of failing the batch.
    synced = 0
    errors = 0
    with table.batch_writer(overwrite_by_pkeys=["instance_id", "app_id"]) as batch:
        for item in items:
            try:
                batch.put_item(Item=item)
                synced += 1
            except Exception as e:
                logger.error(f"Error writing row {item.get('instance_id')}/{item.get('app_id')}: {e}")
                errors += 1

    logger.info(f"Sync complete: {synced} synced, {skipped} skipped, {errors} errors")
    return {"synced": synced, "skipped": skipped, "errors": errors, "total": len(rows)}


def lambda_handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    logger.info(f"Catalog sync triggered: {json.dumps(event)}")
    try:
        result = sync_catalog()
        return {"statusCode": 200, "body": json.dumps(result)}
    except Exception as e:
        logger.error(f"Catalog sync failed: {e}")
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
