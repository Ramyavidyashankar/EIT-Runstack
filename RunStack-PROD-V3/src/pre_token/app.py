"""
Pre Token Generation Lambda trigger for RunStack.

Fires during Cognito authorization_code flow (user logins via AzureAD SSO).
Does NOT fire for client_credentials flow (Dynatrace, EventBridge, schedulers).

Injects two custom claims into the access/id token:
  runstack:authorized  → "true" if the user has a role in runstack-user-roles,
                          OR is in a legacy Cognito admin/operator group
                       → "false" if neither condition is met
  runstack:role        → "admin" | "operator" | "app_operator" | "viewer" | "none"

Note: which apps a user can access is deliberately NOT carried as a
token claim. It is looked up live from runstack-app-access on every
GET /app-instances and POST /notify call by process_messages, so that
revoking a user's access to an app takes effect immediately rather than
waiting up to an hour for their token to expire/refresh. Only `role` is
baked into the token, since role changes are rarer and tolerating some
staleness there is an acceptable tradeoff against a live lookup cost.

ROLE MODEL (single source of truth: Cognito group membership, synced from
Azure AD group membership via the mapping below)
─────────────────────────────────────────────────────────────────
Four tiers, highest precedence wins if someone is in multiple groups:
  admin        — Runstack-700067-Automation-Admin     -> runstack-admins
  operator     — Runstack-700067-Automation-Operator  -> runstack-operators
  app_operator — Runstack-700067-EC2 Admin-Operator    -> runstack-app-operators
  viewer       — (legacy fallback only, see below)     -> runstack-readonly

admin and operator both auto-bypass team-capability checks (SQL/SAP/Tidal)
and app-access scoping entirely. app_operator does NOT auto-bypass
team-capability checks — it exists specifically for EC2 stop/start,
app-scoped via runstack-app-access per user, for app teams (e.g. LH1,
Compass) who should never see or touch each other's instances, and who
are not general-purpose RunStack operators.

Team-capability groups (runstack-team-gdba-sql, runstack-team-sap,
runstack-team-tidal) are separate from role — they grant capability-gated
action access (see require_team_capability in shared.py), independent of
whether the person also holds a role above.

LEGACY FALLBACK
─────────────────────────────────────────────────────────────────
runstack-readonly (viewer) has no known live Azure AD group feeding it
today — kept for any account onboarded before this table-driven model
existed, or for manual read-only grants made directly in Cognito.
"""

import json
import logging
import os
import urllib.parse
import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

USER_ROLES_TABLE = os.getenv("USER_ROLES_TABLE", "runstack-user-roles")

# Legacy Cognito group fallback — still honored, but no longer the primary path
LEGACY_GROUP_ROLE_MAP = {
    "runstack-admins": "admin",
    "runstack-operators": "operator",
    "runstack-app-operators": "app_operator",
    "runstack-readonly": "viewer",
}

# Role precedence — used both for legacy group resolution and for combining
# the table role with the legacy group role
ROLE_RANK = {"admin": 4, "operator": 3, "app_operator": 2, "viewer": 1, "none": 0}

# ── AD group -> Cognito team group sync ─────────────────────────────────────
# Entra emits the "custom:group" SAML attribute as a bracketed,
# URL-encoded, comma-separated list, e.g.:
#   "[All+Users+%28Workplace+Services%29, Runstack-700067-Automation-Admin]"
# Only AD group names present in this map are synced; anything else (like
# the "All Users" noise group above) is ignored, not an error.
#
# NOTE: "Runstack-700067-Automation-Admin" and "Runstack-700067-Automation-Operator"
# are the two general-purpose role groups. "Runstack-700067-EC2 Admin-Operator"
# is intentionally separate and lower-privilege (app_operator, not operator) —
# it's for app teams who need EC2 stop/start scoped to only their own app via
# runstack-app-access, not general RunStack operators.
AD_TO_COGNITO_GROUP_MAP = {
    "Runstack-700067-Automation-Admin": "runstack-admins",
    "Runstack-700067-Automation-Operator": "runstack-operators",
    "Runstack-700067-EC2 Admin-Operator": "runstack-app-operators",
    "Runstack-700067-GDBA MS SQL-Operators": "runstack-team-gdba-sql",
    "Runstack-700067-SAP Basis-Operator": "runstack-team-sap",
    "Runstack-700067-Tidal-Operator": "runstack-team-tidal",
}

# Only these Cognito groups are AD-managed; add/remove during sync is
# restricted to this set so a manually-assigned group outside AD's control
# is never touched.
AD_MANAGED_COGNITO_GROUPS = set(AD_TO_COGNITO_GROUP_MAP.values())


def parse_ad_groups(raw_claim: str) -> list:
    """
    Parses Entra's "custom:group" claim format into a clean list of group
    names. Format: "[Name+One, Name%20Two]" -> ["Name One", "Name Two"].
    Returns [] for an empty/missing claim rather than raising.
    """
    if not raw_claim:
        return []
    cleaned = raw_claim.strip().lstrip("[").rstrip("]")
    parts = [p.strip() for p in cleaned.split(",") if p.strip()]
    return [urllib.parse.unquote_plus(p) for p in parts]


def sync_cognito_groups_from_ad(user_pool_id: str, username: str, ad_groups: list) -> None:
    """
    Reconciles this user's AD-managed Cognito group membership to match
    their current AD groups. Adds missing AD-managed groups, removes
    AD-managed groups no longer present in AD -- never touches a Cognito
    group outside AD_MANAGED_COGNITO_GROUPS, so manually-assigned
    membership (if any) is left alone. Failures are logged, not raised --
    a sync problem should not block login/token issuance.
    """
    target_groups = {
        AD_TO_COGNITO_GROUP_MAP[g] for g in ad_groups if g in AD_TO_COGNITO_GROUP_MAP
    }

    client = boto3.client("cognito-idp")
    try:
        response = client.admin_list_groups_for_user(UserPoolId=user_pool_id, Username=username)
        current_groups = {g["GroupName"] for g in response.get("Groups", [])}
        while "NextToken" in response:
            response = client.admin_list_groups_for_user(
                UserPoolId=user_pool_id, Username=username, NextToken=response["NextToken"]
            )
            current_groups.update(g["GroupName"] for g in response.get("Groups", []))
    except ClientError as e:
        logger.error(f"AD group sync: could not list current groups for {username}: {e.response['Error']['Message']}")
        return

    to_add = target_groups - current_groups
    to_remove = (current_groups & AD_MANAGED_COGNITO_GROUPS) - target_groups

    for group in to_add:
        try:
            client.admin_add_user_to_group(UserPoolId=user_pool_id, Username=username, GroupName=group)
            logger.info(f"AD group sync: added {username} to {group}")
        except ClientError as e:
            logger.error(f"AD group sync: failed to add {username} to {group}: {e.response['Error']['Message']}")

    for group in to_remove:
        try:
            client.admin_remove_user_from_group(UserPoolId=user_pool_id, Username=username, GroupName=group)
            logger.info(f"AD group sync: removed {username} from {group}")
        except ClientError as e:
            logger.error(f"AD group sync: failed to remove {username} from {group}: {e.response['Error']['Message']}")


def get_user_groups(user_pool_id: str, username: str) -> list:
    """Fetch all Cognito groups the user belongs to (legacy fallback)."""
    client = boto3.client("cognito-idp")
    groups = []
    paginator_kwargs = {
        "UserPoolId": user_pool_id,
        "Username": username,
    }
    try:
        response = client.admin_list_groups_for_user(**paginator_kwargs)
        groups = [g["GroupName"] for g in response.get("Groups", [])]
        while "NextToken" in response:
            response = client.admin_list_groups_for_user(
                **paginator_kwargs, NextToken=response["NextToken"]
            )
            groups.extend([g["GroupName"] for g in response.get("Groups", [])])
        logger.info(f"User {username} is in groups: {groups}")
    except ClientError as e:
        logger.error(f"Error fetching groups for {username}: {e.response['Error']['Message']}")
    return groups


def resolve_legacy_group_role(groups: list) -> str:
    """Return the highest-privilege legacy role from the user's Cognito group list."""
    best = "none"
    for group in groups:
        role = LEGACY_GROUP_ROLE_MAP.get(group)
        if role and ROLE_RANK[role] > ROLE_RANK[best]:
            best = role
    return best


def get_table_role(email: str) -> str:
    """
    Look up this user's single role row in runstack-user-roles.
    Returns "none" if no row exists or on any lookup failure —
    fails closed, never grants access on error.

    NOTE: dead code as of the switch to Cognito-group-only role resolution
    below — kept only for a rollback path. Not called from lambda_handler.
    """
    if not email:
        return "none"
    try:
        ddb = boto3.resource("dynamodb")
        table = ddb.Table(USER_ROLES_TABLE)
        response = table.get_item(Key={"user_email": email})
        item = response.get("Item")
        role = item.get("role", "none") if item else "none"
        logger.info(f"Table role for {email}: {role}")
        return role if role in ROLE_RANK else "none"
    except ClientError as e:
        logger.error(f"Error querying user-roles for {email}: {e.response['Error']['Message']}")
        return "none"
    except Exception as e:
        logger.error(f"Unexpected error querying user-roles for {email}: {e}")
        return "none"


def lambda_handler(event: dict, context) -> dict:
    """
    Pre Token Generation trigger handler.

    Event structure (Cognito):
    {
      "triggerSource": "TokenGeneration_Authentication" | "TokenGeneration_RefreshTokens",
      "userPoolId": "us-east-1_xxx",
      "userName": "AzureAD_user@domain.com",
      "request": { "userAttributes": {...}, "groupConfiguration": {...} },
      "response": {}
    }
    """
    logger.info(f"Pre Token trigger: source={event.get('triggerSource')}, user={event.get('userName')}")

    user_pool_id = event.get("userPoolId", "")
    username = event.get("userName", "")

    # Only process AzureAD federated users — skip internal/service accounts
    if not username.lower().startswith("azuread_"):
        logger.info(f"Skipping non-AzureAD user: {username}")
        event["response"] = {"claimsOverrideDetails": {}}
        return event

    email = username[len("azuread_"):] if username.lower().startswith("azuread_") else username

    # AD group sync -- reconcile Cognito team-group membership from the
    # SAML "custom:group" claim before reading groups for the token, so
    # this same invocation's token reflects the just-synced state rather
    # than lagging one login behind.
    raw_ad_groups_claim = event.get("request", {}).get("userAttributes", {}).get("custom:group", "")
    ad_groups = parse_ad_groups(raw_ad_groups_claim)
    if ad_groups:
        sync_cognito_groups_from_ad(user_pool_id, username, ad_groups)

    # Role source of truth: Cognito group membership only
    # (runstack-admins/runstack-operators/runstack-app-operators/
    # runstack-readonly) — runstack-user-roles is not consulted here.
    groups = get_user_groups(user_pool_id, username)
    final_role = resolve_legacy_group_role(groups)

    is_authorized = final_role != "none"

    logger.info(
        f"User {username} → authorized={is_authorized}, role={final_role} "
        f"(from Cognito groups: {groups})"
    )

    claims_to_add = {
        "runstack:authorized": "true" if is_authorized else "false",
        "runstack:role": final_role,
        "runstack:groups": ",".join(groups) if groups else "",
    }

    event["response"] = {
        "claimsAndScopeOverrideDetails": {
            "idTokenGeneration": {
                "claimsToAddOrOverride": claims_to_add
            },
            "accessTokenGeneration": {
                "claimsToAddOrOverride": claims_to_add
            }
        }
    }

    return event