"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code. No logic changes.
"""

from shared import *


def handle_auth_callback(event, http_method, path, path_parameters, query_params):
    try:
        import urllib.request
        import urllib.parse
        import base64
        code = query_params.get("code")
        if not code:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Missing authorization code"})
            }
        cognito_domain = os.getenv("COGNITO_DOMAIN")
        client_id = os.getenv("COGNITO_CLIENT_ID")
        redirect_uri = os.getenv("COGNITO_REDIRECT_URI")
        token_url = f"{cognito_domain}/oauth2/token"
        params = urllib.parse.urlencode({
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "redirect_uri": redirect_uri
        }).encode("utf-8")
        req = urllib.request.Request(
            token_url,
            data=params,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST"
        )
        with urllib.request.urlopen(req) as resp:
            tokens = json.loads(resp.read().decode("utf-8"))
        id_token_payload = tokens.get("id_token", "").split(".")[1]
        id_token_payload += "=" * (4 - len(id_token_payload) % 4)
        user_info = json.loads(base64.b64decode(id_token_payload).decode("utf-8"))
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "access_token": tokens.get("access_token"),
                "id_token": tokens.get("id_token"),
                "token_type": tokens.get("token_type"),
                "expires_in": tokens.get("expires_in"),
                "user": {
                    "email": user_info.get("email"),
                    "sub": user_info.get("sub"),
                    "name": user_info.get("name", "")
                }
            })
        }
    except Exception as e:
        logger.error(f"Auth callback error: {str(e)}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Token exchange failed", "detail": str(e)})
        }

# ── GET /agent/instances — machine-only catalog lookup ────────

def handle_ui_login(event, http_method, path, path_parameters, query_params):
    try:
        body = json.loads(event.get("body") or "{}")
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""

        if not username or not password:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "username and password are required"})
            }

        ddb = boto3.resource("dynamodb")
        logins_table = ddb.Table(UI_LOGINS_TABLE)

        resp = logins_table.get_item(Key={"username": username})
        user_record = resp.get("Item")

        auth_failed = {
            "statusCode": 401,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "invalid_credentials", "message": "Invalid username or password."})
        }

        if not user_record:
            return auth_failed

        stored_hash = user_record.get("password_hash", "")
        if not stored_hash:
            return auth_failed

        if not bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("utf-8")):
            return auth_failed

        if user_record.get("disabled"):
            return {
                "statusCode": 403,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "account_disabled", "message": "This account has been disabled."})
            }

        roles_table = ddb.Table(USER_ROLES_TABLE)
        role_resp = roles_table.get_item(Key={"user_email": username})
        role = role_resp.get("Item", {}).get("role", "viewer")

        issued_at = int(time.time())
        expires_at = issued_at + UI_SESSION_TTL_SECONDS

        session_payload = {
            "username": username,
            "role": role,
            "iat": issued_at,
            "exp": expires_at,
        }
        payload_b64 = base64.urlsafe_b64encode(
            json.dumps(session_payload, separators=(",", ":")).encode("utf-8")
        ).decode("utf-8").rstrip("=")

        signature = hmac.new(
            UI_SESSION_SECRET.encode("utf-8"),
            payload_b64.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        session_token = f"{payload_b64}.{signature}"

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "session_token": session_token,
                "username": username,
                "role": role,
                "expires_at": expires_at,
            })
        }

    except Exception as e:
        logger.error(f"Error during UI login: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "login_failed", "detail": str(e)})
        }

# ── GET /tidal/apps/{AppId}/agents — Tidal agent lookup ─────────────
