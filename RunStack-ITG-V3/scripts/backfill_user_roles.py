#!/usr/bin/env python3
"""
backfill_user_roles.py

One-time migration: reads every row in runstack-app-access, derives one
role per person (highest-privilege role found across their rows, defaulting
to "viewer" for any row missing a role attribute), and writes it into the
new runstack-user-roles table — one row per person.

Does NOT modify runstack-app-access. Safe to re-run (idempotent — it's a
full overwrite of runstack-user-roles based on current app-access data).

Usage:
    pip install boto3 --break-system-packages
    python3 backfill_user_roles.py --region us-east-1 [--dry-run]
"""

import argparse
import boto3
from datetime import datetime, timezone

ROLE_RANK = {"admin": 3, "operator": 2, "viewer": 1, "none": 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--app-access-table", default="runstack-app-access")
    parser.add_argument("--user-roles-table", default="runstack-user-roles")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be written, don't write")
    args = parser.parse_args()

    ddb = boto3.resource("dynamodb", region_name=args.region)
    access_table = ddb.Table(args.app_access_table)
    roles_table = ddb.Table(args.user_roles_table)

    # Full scan with pagination
    items = []
    response = access_table.scan()
    items.extend(response.get("Items", []))
    while "LastEvaluatedKey" in response:
        response = access_table.scan(ExclusiveStartKey=response["LastEvaluatedKey"])
        items.extend(response.get("Items", []))

    print(f"Scanned {len(items)} row(s) from {args.app_access_table}")

    by_email = {}
    for item in items:
        email = item.get("user_email", "")
        if not email:
            continue
        row_role = item.get("role", "viewer")  # legacy rows with no role default to viewer
        if row_role not in ROLE_RANK:
            row_role = "viewer"
        current = by_email.get(email, "none")
        if ROLE_RANK[row_role] > ROLE_RANK[current]:
            by_email[email] = row_role

    print(f"Resolved {len(by_email)} distinct user(s):\n")
    for email, role in sorted(by_email.items()):
        print(f"  {email:40s} -> {role}")

    if args.dry_run:
        print("\n--dry-run set: nothing written.")
        return

    print(f"\nWriting to {args.user_roles_table}...")
    now = datetime.now(timezone.utc).isoformat()
    for email, role in by_email.items():
        roles_table.put_item(Item={
            "user_email": email,
            "role": role,
            "updated_by": "backfill-script",
            "updated_at": now,
        })
    print(f"Done. Wrote {len(by_email)} row(s) to {args.user_roles_table}.")
    print(
        "\nNote: runstack-app-access was not modified. Its 'role' attribute "
        "is now unused by the application but still present on existing rows "
        "— harmless to leave, or strip it later with a separate cleanup pass "
        "if you want the table strictly scoping-only at the data level too."
    )


if __name__ == "__main__":
    main()
