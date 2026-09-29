"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code. No logic changes.
"""

from shared import *


def handle_uploads_presign(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        claims = event.get("requestContext", {}).get("authorizer", {}).get("claims", {})
        username = claims.get("username", "")
        user_email = username.replace("AzureAD_", "") if username.startswith("AzureAD_") else claims.get("email", username)

        body = json.loads(event.get("body", "{}"))
        filename = body.get("filename")
        content_type = body.get("content_type", "application/octet-stream")
        if not filename:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "filename is required"})
            }
        result = create_presigned_upload(filename, content_type, user_email or "unknown")
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

# ── GET /uploads — list uploaded files with download links ───

def handle_uploads_list(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        prefix = query_params.get("prefix", "")
        result = list_uploads(prefix)
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

# ── DELETE /uploads/{key+} — delete an uploaded file ──────────

def handle_uploads_delete(event, http_method, path, path_parameters, query_params):
    denied = require_role(event, "admin")
    if denied:
        return denied
    try:
        key = path.split("/uploads/", 1)[-1]
        import urllib.parse as _urlparse
        key = _urlparse.unquote(key)
        delete_upload(key)
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"status": "deleted", "key": key})
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

# ── GET /admin/users — list users with their current role ────
