"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code. No logic changes.
"""

from shared import *


def handle_admin_users_list(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        result = list_runstack_users()
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps(result, default=decimal_default)
        }
    except ValueError as e:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── POST /admin/users/{username}/role — change a user's role ─

def handle_admin_set_role(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        import urllib.parse as _urlparse
        email = path.split("/admin/users/")[-1].rsplit("/role", 1)[0]
        email = _urlparse.unquote(email)
        body = json.loads(event.get("body", "{}"))
        role = body.get("role")
        apps = body.get("apps")
        if role is None and apps is None:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Provide at least one of: role, apps"})
            }
        result = set_user_role(email, role=role, apps=apps)
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps(result)
        }
    except ValueError as e:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── GET /admin/team-capabilities — list all capability rows + team meta ─

def handle_admin_team_capabilities_list(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        result = list_team_capabilities()
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps(result, default=decimal_default)
        }
    except ValueError as e:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── POST /admin/team-capabilities — create/update a capability row,
#    or the team's "_meta" row when body.capability == "_meta" ──────────

def handle_admin_team_capabilities_set(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        body = json.loads(event.get("body", "{}"))
        team = body.get("team")
        capability = body.get("capability")
        if not team or not capability:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "team and capability are required"})
            }
        if capability == "_meta":
            result = set_team_meta(team, cognito_group=body.get("cognito_group"), description=body.get("description"))
        else:
            result = set_team_capability(team, capability, enabled=body.get("enabled"), scope=body.get("scope"))
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps(result)
        }
    except ValueError as e:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── DELETE /admin/team-capabilities — remove one capability row ─────────

def handle_admin_team_capabilities_delete(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        body = json.loads(event.get("body", "{}"))
        result = delete_team_capability(body.get("team"), body.get("capability"))
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps(result)
        }
    except ValueError as e:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── GET /admin/cognito-groups — list real Cognito groups ────────

def handle_admin_cognito_groups_list(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        result = list_cognito_groups()
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps(result)
        }
    except ValueError as e:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── GET /admin/cognito-groups/{group}/members — who's actually in a group ─

def handle_admin_cognito_group_members(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        import urllib.parse as _urlparse
        group_name = path.split("/admin/cognito-groups/")[-1].rsplit("/members", 1)[0]
        group_name = _urlparse.unquote(group_name)
        result = list_cognito_group_members(group_name)
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps(result)
        }
    except ValueError as e:
        return {
            "statusCode": 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }
    except ClientError as e:
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": str(e)})
        }

# ── GET /ssm/documents/{name} — get document content ─────────