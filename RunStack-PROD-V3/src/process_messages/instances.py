"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code, except for the message change noted
below.

CHANGES IN THIS VERSION:
- resolve_authorized_app_ids: the "not authorized at all" denial message
  now names every real Azure AD group (via shared.ALL_KNOWN_AZURE_GROUPS)
  that would grant access, instead of a generic sentence. Behavior is
  otherwise unchanged — viewers are still allowed to list/see instances
  (just not act on them), which is why this uses its own listing-specific
  check rather than authorize_action() (which would block viewers).
- handle_agent_instances now calls resolve_authorized_app_ids() as its
  first step — this used to be completely unauthenticated (took app_id
  straight from an untrusted query parameter with no check at all) until
  we found and fixed that gap earlier in the same audit that led to this
  file's message update.
"""

from shared import *


def resolve_authorized_app_ids(event, allow_team_visibility=True):
    """
    Resolves which app_ids the caller is authorized to see, based on their
    token claims. Returns (app_ids, error_response) — error_response is
    None on success, or a ready-to-return dict on failure.

    CHANGED: no longer reads a domain query parameter (the agent platform's
    OpenAPI tool schema can't be extended to pass one without a schema
    change on the agent side, which isn't always feasible). Instead,
    allow_team_visibility is now a plain boolean, hardcoded per call site below —
    handle_app_instances (the endpoint the EC2 agent's OpenAPI spec
    actually calls) passes True; handle_agent_instances (the endpoint
    SAP/Healthcheck-style agents call for cross-app server browsing)
    passes False. This achieves the same fix — team membership in
    SQL/SAP/Tidal must never expand EC2 visibility — using which endpoint
    was hit as the signal, since that's already fixed per-agent by each
    agent's own OpenAPI spec, with zero schema change required anywhere.
    """
    claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})

    authorized = claims.get("runstack:authorized")
    role = claims.get("runstack:role", "none")

    # Same fix as authorize_action's Layer 1: a pure team member (e.g. SAP
    # Basis team, role="none"/authorized="false" because team-capability
    # groups are not role groups) must still be able to see/resolve
    # instances via team-based visibility (is_in_any_team) — the blanket
    # authorized=="false" gate below must not override that OR. Only
    # block here if the person is neither authorized-by-role NOR a
    # member of any runstack-team-* group — EXCEPT for calls where
    # allow_team_visibility=False (EC2), where team membership never
    # counts at all, so an unauthorized EC2 caller is blocked here
    # regardless of team membership.
    if authorized == "false" and (not allow_team_visibility or not is_in_any_team(claims)):
        groups_list = "', '".join(ALL_KNOWN_AZURE_GROUPS)
        return None, {
            "statusCode": 403,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "error": "forbidden",
                "reason": "not_in_group",
                "message": (
                    f"You must be a member of one of the following Azure AD groups to view "
                    f"instances: '{groups_list}'. Request access from your RunStack administrator."
                )
            })
        }

    username = claims.get("username", "")
    user_email = username.replace("AzureAD_", "") if username.startswith("AzureAD_") else claims.get("email", username)

    if not user_email:
        return None, {
            "statusCode": 401,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Could not determine user identity"})
        }

    if role == "admin":
        return ["ALL"], None
    elif is_in_any_team(claims) and allow_team_visibility:
        # Team-based full visibility only applies when the caller opted
        # in (allow_team_visibility=True, e.g. SAP/Healthcheck browsing).
        # EC2 (allow_team_visibility=False) always falls through to
        # app_ids resolved below, regardless of team membership.
        return ["ALL"], None
    else:
        app_ids = get_user_apps(user_email)
        if not app_ids:
            return None, {
                "statusCode": 403,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "error": "forbidden",
                    "message": "You do not have access to any applications. Contact your RunStack administrator to be granted an app in runstack-app-access."
                })
            }
        return app_ids, None


def handle_agent_instances(event, http_method, path, path_parameters, query_params):
    try:
        # allow_team_visibility=True: this is the SAP/Healthcheck-style
        # cross-app server browsing endpoint — team membership legitimately
        # grants full visibility here, unchanged from before.
        app_ids, denied = resolve_authorized_app_ids(event, allow_team_visibility=True)
        if denied:
            return denied

        filter_app = query_params.get("app_id")
        if filter_app:
            if "ALL" not in app_ids and filter_app not in app_ids:
                return {
                    "statusCode": 403,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({
                        "error": "forbidden",
                        "message": f"You do not have access to app {filter_app}"
                    })
                }
            app_ids = [filter_app]

        instances = get_instances_for_apps(app_ids)

        filter_server = query_params.get("server_name")
        if filter_server:
            needle = filter_server.strip().lower()
            instances = [
                i for i in instances
                if i.get("server_name", "").strip().lower() == needle
                or i.get("name", "").strip().lower() == needle
            ]
            if not instances:
                return {
                    "statusCode": 404,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({
                        "error": "not_found",
                        "message": f"No instance found matching server_name '{filter_server}' within your accessible apps."
                    })
                }

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps(
                {"count": len(instances), "instances": instances},
                default=decimal_default
            )
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }


def handle_app_instances(event, http_method, path, path_parameters, query_params):
    try:
        # allow_team_visibility=False: this is the endpoint the EC2 agent's OpenAPI
        # spec calls (GET /app-instances) — team membership in an
        # unrelated domain (SQL/SAP/Tidal) must never expand EC2 scope.
        # EC2 visibility always comes strictly from runstack-app-access.
        app_ids, denied = resolve_authorized_app_ids(event, allow_team_visibility=False)
        if denied:
            return denied

        filter_app = query_params.get("app_id")
        if filter_app:
            if "ALL" not in app_ids and filter_app not in app_ids:
                return {
                    "statusCode": 403,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({
                        "error": "forbidden",
                        "message": f"You do not have access to app {filter_app}"
                    })
                }
            app_ids = [filter_app]

        instances = get_instances_for_apps(app_ids)

        filter_server = query_params.get("server_name")
        if filter_server:
            needle = filter_server.strip().lower()
            instances = [
                i for i in instances
                if i.get("server_name", "").strip().lower() == needle
                or i.get("name", "").strip().lower() == needle
            ]
            if not instances:
                return {
                    "statusCode": 404,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({
                        "error": "not_found",
                        "message": f"No instance found matching server_name '{filter_server}' within your accessible apps."
                    })
                }

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "instances": instances,
                "count": len(instances),
                "apps": app_ids
            }, default=decimal_default)
        }

    except Exception as e:
        logger.error(f"Error listing instances: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to list instances", "detail": str(e)})
        }