"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code. No logic changes.
"""

from shared import *
from shared import _short_hostname


def handle_dynatrace_ags_list(event, http_method, path, path_parameters, query_params):
    try:
        groups = get_all_ag_groups()
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"ag_names": sorted(groups.keys())})
        }
    except Exception as e:
        logger.error(f"Error listing Dynatrace AGs: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to list AGs from Dynatrace", "detail": str(e)})
        }

# ── GET /dynatrace/ags/{AGName}/servers ────────────────────────

def handle_dynatrace_ag_servers(event, http_method, path, path_parameters, query_params):
    try:
        import urllib.parse as _urlparse
        ag_name = _urlparse.unquote(path.split("/dynatrace/ags/")[-1].split("/servers")[0])
        groups = get_all_ag_groups()
        servers = groups.get(ag_name, [])
        if not servers:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": f"AG '{ag_name}' not found in Dynatrace"})
            }
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({"ag_name": ag_name, "servers": servers})
        }
    except Exception as e:
        logger.error(f"Error fetching servers for AG: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to fetch AG servers", "detail": str(e)})
        }

# ── GET /dynatrace/ags/{AGName}/roles ─────────────────────────

def handle_dynatrace_ag_roles(event, http_method, path, path_parameters, query_params):
    try:
        import urllib.parse as _urlparse
        ag_name = _urlparse.unquote(path.split("/dynatrace/ags/")[-1].split("/roles")[0])
        groups = get_all_ag_groups()
        servers = groups.get(ag_name, [])
        if not servers:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": f"AG '{ag_name}' not found in Dynatrace"})
            }

        # Guard against an accidental re-trigger while a retry chain is
        # already in progress (e.g. a "retry" action that re-calls this
        # trigger tool instead of polling the existing job). Without this,
        # clear_tried_hosts() below would silently discard tried_hosts and
        # every retry would restart from candidate_hosts[0].
        active = get_active_retry_state(ag_name)
        if active and active.get("tried_hosts") and active.get("last_job_id"):
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "ag_name": ag_name,
                    "status": "RETRYING",
                    "message": (
                        "A role check is already in progress for this AG "
                        f"(already tried: {', '.join(active['tried_hosts'])}) - "
                        "continue polling the existing job instead of starting a new one."
                    ),
                    "retry_job_id": active["last_job_id"],
                })
            }

        clear_tried_hosts(ag_name)
        trigger = trigger_ag_status_check_job(ag_name, [s["host"] for s in servers])
        if not trigger["ok"]:
            return {"statusCode": 404, "headers": CORS_HEADERS, "body": json.dumps({"error": trigger["reason"]})}
        record_retry_job_id(ag_name, trigger["job_id"])
        return {
            "statusCode": 202,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "ag_name": ag_name,
                "resolved_via_host": trigger["resolved_via_host"],
                "instance_id": trigger["instance_id"],
                "job_id": trigger["job_id"],
                "status": "PENDING",
            })
        }
    except Exception as e:
        logger.error(f"Error triggering AG status check: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to trigger AG status check", "detail": str(e)})
        }

# ── GET /dynatrace/ags/{AGName}/roles/{JobId} — poll + parse result ─

def handle_dynatrace_ag_role_job(event, http_method, path, path_parameters, query_params):
    try:
        import urllib.parse as _urlparse
        remainder = path.split("/dynatrace/ags/")[-1]
        ag_name = _urlparse.unquote(remainder.split("/roles/")[0])
        job_id = remainder.split("/roles/")[-1].strip("/")
        result = read_ag_status_job_result(job_id)
        if not result["ok"]:
            return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps({"error": result["reason"], "ag_name": ag_name})}
        if not result["done"]:
            return {"statusCode": 200, "headers": CORS_HEADERS, "body": json.dumps({"ag_name": ag_name, "status": result["status"]})}

        roles = result["roles"]
        primary_seen = any(r.get("Role") == "PRIMARY" for r in roles)

        if len(roles) < 2 and not primary_seen:
            if roles:
                add_tried_host(ag_name, _short_hostname(roles[0].get("ReplicaName", "")))
                accumulate_ag_partial_result(ag_name, roles, result["db_sync"])

            tried = set(h.lower() for h in get_tried_hosts(ag_name))
            groups = get_all_ag_groups()
            servers = groups.get(ag_name, [])
            all_hosts = [s["host"] for s in servers]
            remaining_hosts = [h for h in all_hosts if h.lower() not in tried]

            if remaining_hosts:
                retry_trigger = trigger_ag_status_check_job(ag_name, remaining_hosts)
                if retry_trigger["ok"]:
                    record_retry_job_id(ag_name, retry_trigger["job_id"])
                    return {
                        "statusCode": 200,
                        "headers": CORS_HEADERS,
                        "body": json.dumps({
                            "ag_name": ag_name,
                            "status": "RETRYING",
                            "message": "Initial host only reported itself - retrying against a different host.",
                            "retry_job_id": retry_trigger["job_id"],
                        })
                    }
            else:
                # Every host has been tried and none had full topology
                # visibility (i.e. we never successfully queried Primary).
                # Return the union of every partial view collected across
                # all attempts, rather than just this last host's single row.
                merged = get_accumulated_ag_result(ag_name)
                clear_tried_hosts(ag_name)
                return {
                    "statusCode": 200,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({
                        "ag_name": ag_name,
                        "status": "COMPLETED",
                        "roles": merged["roles"],
                        "db_sync": merged["db_sync"],
                        "warning": (
                            "Could not find a host with full AG visibility (i.e. Primary) "
                            "after trying all replicas. The roles/db_sync below are the "
                            "combined partial views collected from each host tried - some "
                            "fields (which replica is Primary, another replica's live "
                            "state) may still be missing or stale if no host reported them."
                        ),
                    }, default=decimal_default)
                }

        clear_tried_hosts(ag_name)  # success - reset history for next time
        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "ag_name": ag_name,
                "status": "COMPLETED",
                "roles": roles,
                "db_sync": result["db_sync"],
            }, default=decimal_default)
        }
    except Exception as e:
        logger.error(f"Error reading AG status job result: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to read AG status job result", "detail": str(e)})
        }

# ── GET /dr-failover/{AGName}/config ───────────────────────────