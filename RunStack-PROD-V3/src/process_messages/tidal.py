"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code. No logic changes.
"""

from shared import *


def handle_tidal_agents(event, http_method, path, path_parameters, query_params):
    try:
        app_id = path_parameters.get("AppId")
        if not app_id:
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "AppId path parameter is required"})
            }

        ddb = boto3.resource("dynamodb")
        table = ddb.Table(TIDAL_AGENT_MAPPING_TABLE)
        resp = table.get_item(Key={"AppId": app_id})
        item = resp.get("Item")

        if not item:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "not_found", "message": f"No Tidal agent mapping found for AppId '{app_id}'"})
            }

        if not item.get("Enabled", False):
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "disabled", "message": f"AppId '{app_id}' is disabled in the agent mapping"})
            }

        agents = sorted(
            item.get("Agents", []),
            key=lambda a: int(a.get("Selection", "0"))
        )

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "app_id": app_id,
                "application_name": item.get("ApplicationName", ""),
                "agents": agents,
                "last_updated": item.get("LastUpdated", ""),
            }, default=decimal_default)
        }

    except Exception as e:
        logger.error(f"Error fetching Tidal agents for AppId: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to fetch Tidal agent mapping", "detail": str(e)})
        }

# ── POST /batch-healthcheck — SharePoint server list → per-server jobs ──
