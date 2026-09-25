"""
Extracted from the handle_api_gateway_request dispatcher in app.py.
Each function corresponds to one API route branch, moved verbatim (only
de-indented) from the original code, except for the authorization changes
noted below.

CHANGES IN THIS VERSION:
- handle_dr_config: was completely unauthenticated (returned DR thresholds
  and dr_replica_override — replica topology info — to anyone). Now gated
  by authorize_action(event, "sql_dr_failover", resource_id=ag_name).
- handle_dr_plan, handle_dr_execute: previously called
  require_team_capability(event, "gdba-sql", "sql-dr-failover", ag_name)
  directly. Now call authorize_action(event, "sql_dr_failover",
  resource_id=ag_name) instead — same underlying capability check and
  admin/operator bypass, but Layer 1 (Azure AD group membership) is now
  checked first, mandatorily, naming the real Azure AD groups on denial.
- handle_dr_status: was completely unauthenticated (returned the full run
  record — hosts, execution logs, roles — for any run_id). Now gated by
  authorize_action(event, "sql_dr_failover", resource_id=ag_name), checked
  right after the run record is fetched (needed to know ag_name).
- handle_dr_approve: UNCHANGED — this is a Teams webhook callback,
  authenticated via shared secret, not a user-facing route, so it
  intentionally does not use authorize_action.
"""

from shared import *
from shared import _JOB_TERMINAL_STATUSES, _short_hostname

# Cap on automatic re-checks of post-failover role confirmation before
# giving up and reporting NEEDS_MANUAL_CHECK. Topology can lag behind the
# EXECUTING->CONFIRMING status flip, so a single incomplete read should not
# be treated as final.
_MAX_CONFIRM_ATTEMPTS = 3


def handle_dr_config(event, http_method, path, path_parameters, query_params):
    try:
        import urllib.parse as _urlparse
        ag_name = _urlparse.unquote(path.split("/dr-failover/")[-1].split("/config")[0])

        denied = authorize_action(event, "sql_dr_failover", resource_id=ag_name)
        if denied:
            return denied

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "ag_name": ag_name,
                "max_log_queue_kb": DR_MAX_LOG_QUEUE_KB,
                "max_txn_minutes": DR_MAX_TXN_MINUTES,
                "confirm_timeout_sec": DR_CONFIRM_TIMEOUT_SEC,
                "poll_interval_sec": DR_POLL_INTERVAL_SEC,
                "dr_replica_override": DR_REPLICA_OVERRIDES.get(ag_name),
            })
        }
    except Exception as e:
        logger.error(f"Error fetching DR thresholds: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to fetch DR thresholds", "detail": str(e)})
        }

# ── POST /dr-failover/{AGName}/plan — pre-validation, issues token ─

def handle_dr_plan(event, http_method, path, path_parameters, query_params):
    try:
        import urllib.parse as _urlparse
        ag_name = _urlparse.unquote(path.split("/dr-failover/")[-1].split("/plan")[0])

        denied = authorize_action(event, "sql_dr_failover", resource_id=ag_name)
        if denied:
            return denied

        # Concurrency guard: block a second /plan for the same AG while an
        # earlier one is still in flight (awaiting Teams approval, or
        # actively EXECUTING/CONFIRMING). Without this, two people could
        # both get to Teams approval for the same AG and both get approved,
        # dispatching two competing failover jobs against the same AG.
        # Locked here — the earliest point a real run begins — not at the
        # SSM document itself, which is too late: by then both jobs would
        # already be created and racing.
        # lock_resource_id MUST stay defined even while lock acquisition
        # below is commented out: every early-return path in this handler
        # (and the PLAN_FAILED path) calls release_action_lock(lock_resource_id).
        # With the assignment commented out those calls raised NameError,
        # turning every 400 (missing job id, failed checks, unclassifiable
        # roles) into a generic 500 "Failed to plan DR failover" and hiding
        # the failed readiness checks from the UI and the AQS SQL agent.
        # Releasing a lock that was never acquired is a harmless delete.
        lock_resource_id = f"dr-failover:{ag_name}"
        #claims, _ = get_claims_and_role(event)
        #existing_lock = acquire_action_lock(
        #    lock_resource_id, claims.get("username", "unknown"), job_id="pending",
        #    ttl_seconds=DR_ACTION_LOCK_TTL_SECONDS
        #)
        #if existing_lock and existing_lock.get("locked_by") != claims.get("username", "unknown"):
        #    # Different user holds it — block. If it's the SAME user
            # re-calling /plan (e.g. the needs_target_choice round-trip
            # where /plan is legitimately called twice for one flow),
            # existing_lock.locked_by matches and we fall through instead
            # of blocking someone from continuing their own request.
        #    return {
        #        "statusCode": 409,
        #        "headers": CORS_HEADERS,
        #        "body": json.dumps({
        #            "error": f"A switchover for {ag_name} is already in progress.",
        #            "locked_by": existing_lock.get("locked_by"),
        #            "locked_at": existing_lock.get("locked_at"),
        #        })
        #    }

        body = json.loads(event.get("body") or "{}")
        role_check_job_id = body.get("role_check_job_id")
        target_replica = body.get("target_replica")

        if not role_check_job_id:
            release_action_lock(lock_resource_id)
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "role_check_job_id is required — run GET /dynatrace/ags/{AGName}/roles first, poll it to completion, then pass its job_id here."})
            }

        result = read_ag_status_job_result(role_check_job_id)
        if not result["ok"]:
            release_action_lock(lock_resource_id)
            return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps({"error": result["reason"]})}
        if not result["done"]:
            release_action_lock(lock_resource_id)
            return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps({"error": f"role_check_job_id is still {result['status']} — poll it to completion before calling /plan"})}

        classification = classify_ag_roles(result["roles"], ag_name, target_replica)
        if not classification["ok"]:
            release_action_lock(lock_resource_id)
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": f"Could not classify AG roles: {classification['reason']}", "roles": result["roles"]}, default=decimal_default)
            }

        if classification.get("needs_target_choice"):
            secondary_options = classification.get("secondary_options")
            response_body = {
                "ag_name": ag_name,
                "needs_target_choice": True,
                "primary_host": classification["primary"].get("ReplicaName"),
                "ha_option": classification["ha_candidate"].get("ReplicaName") if classification["ha_candidate"] else None,
                "dr_option": classification["dr_candidate"].get("ReplicaName") if classification["dr_candidate"] else None,
                "message": "Both HA and DR failover targets are available. Re-call /plan with target_replica set to one of ha_option or dr_option.",
            }
            if secondary_options:
                # classify_ag_roles couldn't uniquely resolve HA vs DR from
                # commit mode (e.g. the async-designated replica is currently
                # Primary, leaving 2+ sync secondaries and 0 async ones) —
                # list every secondary instead of failing outright.
                response_body["secondary_options"] = secondary_options
                response_body["message"] = (
                    "Could not automatically determine HA vs DR target from commit mode. "
                    "Re-call /plan with target_replica set to one of the ReplicaNames in secondary_options."
                )
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps(response_body)
            }

        evaluation = evaluate_dr_preconditions(result, classification)

        claims, _ = get_claims_and_role(event)
        run_id = create_dr_run_record(
            ag_name,
            status="PLANNED" if evaluation["all_pass"] else "PLAN_FAILED",
            extra={
                "checks": evaluation["checks"],
                "primary_host": evaluation["primary_host"],
                "dr_replica_host": evaluation["dr_replica_host"],
                "failover_scope": evaluation["failover_scope"],
                "requested_by": claims.get("username", "unknown"),
                "role_check_job_id": role_check_job_id,
            }
        )

        token = create_dr_confirmation_token(run_id, ag_name) if evaluation["all_pass"] else None
        teams_sent, teams_error = (False, None)
        if token:
            teams_sent, teams_error = post_teams_approval_card(ag_name, run_id, token, evaluation)
        else:
            # PLAN_FAILED — no Teams approval will ever follow this run, so
            # release the lock now rather than holding it for the full
            # DR_ACTION_LOCK_TTL_SECONDS window for no reason.
            release_action_lock(lock_resource_id)

        return {
            "statusCode": 200 if evaluation["all_pass"] else 400,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "run_id": run_id,
                "ag_name": ag_name,
                "primary_host": evaluation["primary_host"],
                "dr_replica_host": evaluation["dr_replica_host"],
                "failover_scope": evaluation["failover_scope"],
                "all_pass": evaluation["all_pass"],
                "checks": evaluation["checks"],
                "confirmation_token": token,
                "token_ttl_seconds": DR_TOKEN_TTL_SECONDS if token else None,
                "teams_notification_sent": teams_sent,
                "teams_notification_error": teams_error or None,
            }, default=decimal_default)
        }
    except Exception as e:
        logger.error(f"Error planning DR failover: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to plan DR failover", "detail": str(e)})
        }

# ── POST /dr-failover/{AGName}/execute ─────────────────────────

def handle_dr_execute(event, http_method, path, path_parameters, query_params):
    try:
        import urllib.parse as _urlparse
        ag_name = _urlparse.unquote(path.split("/dr-failover/")[-1].split("/execute")[0])
        body = json.loads(event.get("body") or "{}")
        token = body.get("confirmation_token")
        confirm_text = body.get("confirm", "")

        if not token or confirm_text != "YES":
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Missing confirmation_token, or confirm != 'YES'"})
            }

        token_peek = peek_dr_confirmation_token(token, ag_name)
        if not token_peek:
            return {
                "statusCode": 403,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Invalid, expired, or already-used confirmation_token. Re-run /plan."})
            }

        denied = authorize_action(event, "sql_dr_failover", resource_id=ag_name)
        if denied:
            return denied

        # Optional pre-execution freshness gate (sent by the RunStack UI).
        # When fresh_role_check_job_id is supplied, the live AG state it
        # captured must still match what the operator reviewed at /plan
        # time. Omitted = previous behaviour, so the AQS SQL agent and the
        # Teams /approve path are unchanged.
        fresh_job_id = body.get("fresh_role_check_job_id")
        if fresh_job_id:
            run_for_check = get_dr_run_record(token_peek.get("run_id")) or {}
            fresh = _verify_fresh_role_check(ag_name, fresh_job_id, run_for_check)
            if fresh["status"] == "invalid":
                # Bad request (wrong AG, not finished, too old) — token is
                # left intact so the operator can re-run the final check.
                return {
                    "statusCode": 400,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({"error": fresh["reason"], "code": "FRESH_CHECK_INVALID"})
                }
            if fresh["status"] == "changed":
                # Live state moved since review: burn the token so neither
                # this UI nor a still-open Teams card can execute the stale
                # plan, and record why on the run.
                stale_item = consume_dr_confirmation_token(token, ag_name)
                if stale_item:
                    update_dr_run_record(stale_item["run_id"], {
                        "status": "STALE_PLAN",
                        "error": "Live AG state changed before execution: " + "; ".join(fresh["differences"]),
                        "stale_check_job_id": fresh_job_id,
                    })
                release_action_lock(f"dr-failover:{ag_name}")
                return {
                    "statusCode": 409,
                    "headers": CORS_HEADERS,
                    "body": json.dumps({
                        "error": "Live AG state changed since readiness was reviewed. Review the new results and re-run readiness.",
                        "code": "STATE_CHANGED",
                        "differences": fresh["differences"],
                        "run_id": token_peek.get("run_id"),
                    })
                }

        token_item = consume_dr_confirmation_token(token, ag_name)
        if not token_item:
            return {
                "statusCode": 403,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Invalid, expired, or already-used confirmation_token. Re-run /plan."})
            }

        run_id = token_item["run_id"]
        run_record = get_dr_run_record(run_id) or {}
        dr_replica_host = run_record.get("dr_replica_host")
        primary_host = run_record.get("primary_host")
        role_check_job_id = run_record.get("role_check_job_id")

        if not dr_replica_host or not primary_host:
            update_dr_run_record(run_id, {"status": "EXECUTE_FAILED", "error": "Missing primary_host/dr_replica_host on run record — re-run /plan"})
            release_action_lock(f"dr-failover:{ag_name}")
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Run record incomplete — re-run /plan", "run_id": run_id})
            }

        # Re-derive fresh classification rather than trusting only the
        # cached primary/dr_replica strings - re-read the completed
        # role_check_job_id's roles so we can (a) determine HA vs DR
        # from the DR replica's real CommitMode, and (b) build the
        # InstanceMap covering every replica for the failover script.
        if not role_check_job_id:
            update_dr_run_record(run_id, {"status": "EXECUTE_FAILED", "error": "No role_check_job_id on run record — re-run /plan"})
            release_action_lock(f"dr-failover:{ag_name}")
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Run record missing role_check_job_id — re-run /plan", "run_id": run_id})
            }

        result = read_ag_status_job_result(role_check_job_id)
        if not result["ok"] or not result["done"]:
            update_dr_run_record(run_id, {"status": "EXECUTE_FAILED", "error": "Could not re-read role check data"})
            release_action_lock(f"dr-failover:{ag_name}")
            return {
                "statusCode": 400,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Could not re-read role check data — re-run /plan", "run_id": run_id})
            }

        roles = result["roles"]
        dr_replica_row = next((r for r in roles if r.get("ReplicaName") == dr_replica_host), None)
        failover_scope = "DR" if dr_replica_row and dr_replica_row.get("CommitMode") == "ASYNCHRONOUS_COMMIT" else "HA"

        # Build InstanceMap: ReplicaName -> connection string. Using
        # the ReplicaName itself (e.g. "c40w301187\I01") as the
        # connection string relies on SQL Browser resolving the named
        # instance on each target - matches how the script already
        # connects during discovery/pre-validation.
        DR_SQL_PORT = os.getenv("DR_SQL_PORT", "2048")
        instance_map = {r.get("ReplicaName"): f"{r.get('ReplicaName')},{DR_SQL_PORT}" for r in roles if r.get("ReplicaName")}

        # Dispatch to Primary, NOT the DR replica - SSM must run this
        # from a node that already exists and is reachable; the script
        # itself connects remotely to whichever replica is being
        # promoted, so Primary is a safe, always-up dispatch point.
        dispatch_inst = resolve_instance_for_host(_short_hostname(primary_host))
        if not dispatch_inst or not dispatch_inst.get("instance_id") or not dispatch_inst.get("account_id"):
            update_dr_run_record(run_id, {"status": "EXECUTE_FAILED", "error": f"No instance record for Primary {primary_host}"})
            release_action_lock(f"dr-failover:{ag_name}")
            return {
                "statusCode": 500,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": f"Could not resolve instance for Primary {primary_host}", "run_id": run_id})
            }

        dr_sql_creds = get_dr_test_sql_credentials()
        failover_job_id = create_ssm_document_job(
            dispatch_inst["instance_id"], dispatch_inst["account_id"], dispatch_inst.get("region", "us-east-1"),
            DR_FAILOVER_DOCUMENT_NAME,
            {
                "AGName": [ag_name],
                "InstanceMapJson": [json.dumps(instance_map)],
                "TargetReplica": [dr_replica_host],
                "FailoverScope": [failover_scope],
                "AllowDataLossFlag": ["true" if failover_scope == "DR" else "false"],
                "SqlUsername": [dr_sql_creds["username"]],
                "SqlPassword": [dr_sql_creds["password"]],
            },
            f"RunStack DR failover: {ag_name} -> {dr_replica_host} (scope={failover_scope}, dispatched via {primary_host})"
        )
        if not failover_job_id:
            update_dr_run_record(run_id, {"status": "EXECUTE_FAILED", "error": "Could not create failover job"})
            release_action_lock(f"dr-failover:{ag_name}")
            return {
                "statusCode": 500,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Could not create failover job", "run_id": run_id})
            }

        update_dr_run_record(run_id, {
            "status": "EXECUTING",
            "dr_replica_host": dr_replica_host,
            "failover_scope": failover_scope,
            "dispatched_via_host": primary_host,
            "failover_job_id": failover_job_id,
        })

        return {
            "statusCode": 202,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "run_id": run_id,
                "ag_name": ag_name,
                "dr_replica_host": dr_replica_host,
                "failover_scope": failover_scope,
                "dispatched_via_host": primary_host,
                "failover_job_id": failover_job_id,
                "status": "EXECUTING",
            })
        }
    except Exception as e:
        logger.error(f"Error executing DR failover: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to execute DR failover", "detail": str(e)})
        }

# ── POST /dr-failover/{AGName}/approve (Teams button callback) ─
# UNCHANGED — Teams webhook callback, shared-secret authenticated, not a
# user-facing route, so it intentionally does not use authorize_action.

def handle_dr_approve(event, http_method, path, path_parameters, query_params):
    try:
        import urllib.parse as _urlparse
        ag_name = _urlparse.unquote(path.split("/dr-failover/")[-1].split("/approve")[0])
        body = json.loads(event.get("body") or "{}")

        approve_secret = get_teams_approve_shared_secret()
        if body.get("secret") != approve_secret or not approve_secret:
            return {"statusCode": 403, "headers": CORS_HEADERS, "body": json.dumps({"error": "forbidden"})}

        token = body.get("confirmation_token")
        decision = body.get("decision")

        if not token or decision not in ("approve", "reject"):
            return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps({"error": "Missing confirmation_token or invalid decision"})}

        if decision == "reject":
            token_item = consume_dr_confirmation_token(token, ag_name)
            if token_item:
                update_dr_run_record(token_item["run_id"], {"status": "REJECTED"})
            release_action_lock(f"dr-failover:{ag_name}")
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "type": "message",
                    "attachments": [{
                        "contentType": "application/vnd.microsoft.card.adaptive",
                        "content": {
                            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                            "type": "AdaptiveCard",
                            "version": "1.4",
                            "body": [{"type": "TextBlock", "text": f"Failover for {ag_name} was rejected.", "weight": "Bolder", "color": "Attention"}]
                        }
                    }]
                })
            }

        token_peek = peek_dr_confirmation_token(token, ag_name)
        if not token_peek:
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "type": "message",
                    "attachments": [{
                        "contentType": "application/vnd.microsoft.card.adaptive",
                        "content": {
                            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                            "type": "AdaptiveCard",
                            "version": "1.4",
                            "body": [{"type": "TextBlock", "text": "This approval has expired or was already used.", "weight": "Bolder", "color": "Attention"}]
                        }
                    }]
                })
            }

        token_item = consume_dr_confirmation_token(token, ag_name)
        if not token_item:
            return {"statusCode": 200, "headers": CORS_HEADERS, "body": json.dumps({"type": "message", "attachments": []})}

        run_id = token_item["run_id"]
        run_record = get_dr_run_record(run_id) or {}
        dr_replica_host = run_record.get("dr_replica_host")
        primary_host = run_record.get("primary_host")
        role_check_job_id = run_record.get("role_check_job_id")

        if not dr_replica_host or not primary_host or not role_check_job_id:
            update_dr_run_record(run_id, {"status": "EXECUTE_FAILED", "error": "Run record incomplete"})
            release_action_lock(f"dr-failover:{ag_name}")
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "type": "message",
                    "attachments": [{
                        "contentType": "application/vnd.microsoft.card.adaptive",
                        "content": {
                            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                            "type": "AdaptiveCard",
                            "version": "1.4",
                            "body": [{"type": "TextBlock", "text": "Run record incomplete - re-run /plan.", "color": "Attention"}]
                        }
                    }]
                })
            }

        result = read_ag_status_job_result(role_check_job_id)
        roles = result["roles"]
        dr_replica_row = next((r for r in roles if r.get("ReplicaName") == dr_replica_host), None)
        failover_scope = "DR" if dr_replica_row and dr_replica_row.get("CommitMode") == "ASYNCHRONOUS_COMMIT" else "HA"

        # Same InstanceMap fix applied to /execute on 2026-08-11: bare
        # host\instance requires SQL Browser resolution on the remote
        # target, which caused error 26 in this Teams-approved path
        # since it built its own InstanceMap without the port suffix.
        DR_SQL_PORT = os.getenv("DR_SQL_PORT", "2048")
        instance_map = {r.get("ReplicaName"): f"{r.get('ReplicaName')},{DR_SQL_PORT}" for r in roles if r.get("ReplicaName")}

        dispatch_inst = resolve_instance_for_host(_short_hostname(primary_host))
        if not dispatch_inst:
            update_dr_run_record(run_id, {"status": "EXECUTE_FAILED", "error": f"No instance for Primary {primary_host}"})
            release_action_lock(f"dr-failover:{ag_name}")
            return {
                "statusCode": 200,
                "headers": CORS_HEADERS,
                "body": json.dumps({
                    "type": "message",
                    "attachments": [{
                        "contentType": "application/vnd.microsoft.card.adaptive",
                        "content": {
                            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                            "type": "AdaptiveCard",
                            "version": "1.4",
                            "body": [{"type": "TextBlock", "text": "Could not resolve Primary instance.", "color": "Attention"}]
                        }
                    }]
                })
            }

        dr_sql_creds = get_dr_test_sql_credentials()
        failover_job_id = create_ssm_document_job(
            dispatch_inst["instance_id"], dispatch_inst["account_id"], dispatch_inst.get("region", "us-east-1"),
            DR_FAILOVER_DOCUMENT_NAME,
            {
                "AGName": [ag_name],
                "InstanceMapJson": [json.dumps(instance_map)],
                "TargetReplica": [dr_replica_host],
                "FailoverScope": [failover_scope],
                "AllowDataLossFlag": ["true" if failover_scope == "DR" else "false"],
                "SqlUsername": [dr_sql_creds["username"]],
                "SqlPassword": [dr_sql_creds["password"]],
            },
            f"RunStack DR failover (Teams-approved): {ag_name} -> {dr_replica_host}"
        )

        update_dr_run_record(run_id, {
            "status": "EXECUTING",
            "dr_replica_host": dr_replica_host,
            "failover_scope": failover_scope,
            "failover_job_id": failover_job_id,
        })

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "type": "message",
                "attachments": [{
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": {
                        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                        "type": "AdaptiveCard",
                        "version": "1.4",
                        "body": [{"type": "TextBlock", "text": f"Approved. Failover to {dr_replica_host} is now executing.", "weight": "Bolder", "color": "Good"}]
                    }
                }]
            })
        }
    except Exception as e:
        logger.error(f"Error handling Teams approval: {e}")
        return {"statusCode": 500, "headers": CORS_HEADERS, "body": json.dumps({"error": "Failed to process approval", "detail": str(e)})}

# ── GET /dr-failover/{AGName}/status/{RunId} ───────────────────

def handle_dr_status(event, http_method, path, path_parameters, query_params):
    try:
        run_id = path.split("/status/")[-1].strip("/")
        record = get_dr_run_record(run_id)
        if not record:
            return {
                "statusCode": 404,
                "headers": CORS_HEADERS,
                "body": json.dumps({"error": f"No run found for run_id '{run_id}'"})
            }

        # Authorize using this run's own ag_name — record must be fetched
        # first to know it. Previously this endpoint had NO authorization
        # at all, meaning anyone who could guess/obtain a run_id could read
        # the full run record (hosts, execution logs, roles).
        denied = authorize_action(event, "sql_dr_failover", resource_id=record.get("ag_name"))
        if denied:
            return denied

        status = record.get("status")
        ag_name = record.get("ag_name")
        dr_replica_host = record.get("dr_replica_host")

        if status == "EXECUTING" and record.get("failover_job_id"):
            job_info = get_job_raw_output(record["failover_job_id"])
            if not job_info["found"]:
                record = {**record, "note": "failover_job_id not found — check job pipeline"}
            elif job_info["status"] not in _JOB_TERMINAL_STATUSES:
                pass
            else:
                # Prefer the script's own structured RUNSTACK_RESULT marker
                # (Outcome, DurationSeconds, PassCount/FailCount/FailDetails,
                # evidence paths) over the old substring check against
                # colored console text. Fall back to the substring heuristic
                # only if a run's SSM document doesn't emit the marker yet
                # (e.g. an older document version).
                script_result_list = parse_runstack_tagged_json(job_info["raw_output"], "RESULT")
                script_result = script_result_list[0] if script_result_list else None

                job_failed = job_info["status"] in ("FAILED", "TIMED_OUT", "CANCELLED")
                if not job_failed and script_result is None:
                    job_failed = "New Primary :" not in job_info["raw_output"]

                script_fields = {}
                if script_result:
                    script_fields = {
                        "script_outcome": script_result.get("Outcome"),
                        "script_reason": script_result.get("Reason"),
                        "duration_seconds": script_result.get("DurationSeconds"),
                        "pass_count": script_result.get("PassCount"),
                        "fail_count": script_result.get("FailCount"),
                        "fail_details": script_result.get("FailDetails"),
                        "evidence_report_path": script_result.get("EvidenceReportPath"),
                        "transcript_path": script_result.get("TranscriptPath"),
                    }
                # Save the full script console output regardless of outcome —
                # previously this was only captured on the EXECUTE_FAILED
                # path (as "ssm_output"). "execution_log" is the generic name
                # used on every path so the agent/email can quote the actual
                # Step 3/Step 4 execution transcript, not just fail cases.
                script_fields["execution_log"] = job_info["raw_output"]

                if job_failed or (script_result and script_result.get("Outcome") in ("ABORTED", "CRITICAL")):
                    update_dr_run_record(run_id, {
                        "status": "EXECUTE_FAILED",
                        "ssm_output": job_info["raw_output"],
                        "stderr_output": job_info.get("stderr_output", ""),
                        **script_fields,
                    })
                    release_action_lock(f"dr-failover:{ag_name}")
                    record = get_dr_run_record(run_id)
                else:
                    groups = get_all_ag_groups()
                    servers = groups.get(ag_name, [])
                    trigger = trigger_ag_status_check_job(ag_name, [s["host"] for s in servers]) if servers else {"ok": False, "reason": "AG not found in Dynatrace"}
                    if not trigger["ok"]:
                        update_dr_run_record(run_id, {
                            "status": "NEEDS_MANUAL_CHECK",
                            "error": f"Failover ran but could not start confirmation check: {trigger['reason']}",
                            **script_fields,
                        })
                        release_action_lock(f"dr-failover:{ag_name}")
                    else:
                        update_dr_run_record(run_id, {
                            "status": "CONFIRMING",
                            "confirm_job_id": trigger["job_id"],
                            "confirm_attempts": 0,
                            **script_fields,
                        })
                        # still in progress — lock stays held
                    record = get_dr_run_record(run_id)

        elif status == "CONFIRMING" and record.get("confirm_job_id"):
            result = read_ag_status_job_result(record["confirm_job_id"])
            if not result["ok"]:
                update_dr_run_record(run_id, {"status": "NEEDS_MANUAL_CHECK", "error": f"Could not confirm post-failover state: {result['reason']}"})
                release_action_lock(f"dr-failover:{ag_name}")
                record = get_dr_run_record(run_id)
            elif result["done"]:
                target_needle = _short_hostname(dr_replica_host)
                target_row = next(
                    (r for r in result["roles"] if target_needle in (r.get("ReplicaName") or "").lower()), None
                )
                confirmed = bool(target_row and target_row.get("Role") == "PRIMARY")
                if confirmed:
                    update_dr_run_record(run_id, {
                        "status": "SUCCESS",
                        "final_roles": result["roles"],
                    })
                    release_action_lock(f"dr-failover:{ag_name}")
                else:
                    # Don't lock in NEEDS_MANUAL_CHECK on the first incomplete
                    # read — status can flip to CONFIRMING before the AG's
                    # topology has fully settled on every host. Re-trigger a
                    # fresh confirm job up to MAX_CONFIRM_ATTEMPTS times before
                    # giving up and asking for a manual check.
                    attempts = int(record.get("confirm_attempts", 0)) + 1
                    if attempts < _MAX_CONFIRM_ATTEMPTS:
                        groups = get_all_ag_groups()
                        servers = groups.get(ag_name, [])
                        retrigger = trigger_ag_status_check_job(ag_name, [s["host"] for s in servers]) if servers else {"ok": False, "reason": "AG not found in Dynatrace"}
                        if retrigger["ok"]:
                            update_dr_run_record(run_id, {
                                "status": "CONFIRMING",
                                "confirm_job_id": retrigger["job_id"],
                                "confirm_attempts": attempts,
                                "last_partial_roles": result["roles"],
                            })
                            # still in progress — lock stays held
                        else:
                            update_dr_run_record(run_id, {
                                "status": "NEEDS_MANUAL_CHECK",
                                "error": f"Could not re-trigger confirmation check: {retrigger['reason']}",
                                "final_roles": result["roles"],
                                "confirm_attempts": attempts,
                            })
                            release_action_lock(f"dr-failover:{ag_name}")
                    else:
                        update_dr_run_record(run_id, {
                            "status": "NEEDS_MANUAL_CHECK",
                            "final_roles": result["roles"],
                            "confirm_attempts": attempts,
                            "error": f"Target replica role not confirmed as PRIMARY after {attempts} confirmation attempts.",
                        })
                        release_action_lock(f"dr-failover:{ag_name}")
                record = get_dr_run_record(run_id)

        return {"statusCode": 200, "headers": CORS_HEADERS, "body": json.dumps(record, default=decimal_default)}
    except Exception as e:
        logger.error(f"Error fetching DR run status: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to fetch run status", "detail": str(e)})
        }

# ════════════════════════════════════════════════════════════════════════
# Pre-execution freshness check (used by handle_dr_execute)
# ════════════════════════════════════════════════════════════════════════
#
# Why: /plan evaluates readiness against a role-check job the operator ran
# earlier. By the time they click "Start switchover" the AG may have moved
# (automatic failover, a replica disconnecting, a log queue building up).
# The UI runs a NEW role-check job immediately before execution and passes
# its job_id as fresh_role_check_job_id. This helper checks that job
# belongs to this AG, finished recently, and still describes the same
# primary/target with every readiness check passing.

DR_FRESH_CHECK_MAX_AGE_SECONDS = int(os.getenv("DR_FRESH_CHECK_MAX_AGE_SECONDS", "600"))


def _parse_utc_iso(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00").split("+")[0])
    except ValueError:
        return None


def _verify_fresh_role_check(ag_name: str, fresh_job_id: str, run_record: dict) -> dict:
    """Returns {"status": "ok"}, {"status": "invalid", "reason": str} or
    {"status": "changed", "differences": [str, ...]}.

    "invalid" = the supplied job cannot be used as evidence (caller error).
    "changed" = the job is valid evidence and shows the reviewed plan no
    longer holds — execution must be blocked."""
    job = get_job_by_id(fresh_job_id)
    if not job:
        return {"status": "invalid", "reason": f"Final check job '{fresh_job_id}' was not found."}

    automation_data = job.get("automation_data") or {}
    job_ag = ((automation_data.get("Parameters") or {}).get("AGName") or [None])[0]
    doc_name = str(automation_data.get("DocumentName", ""))
    if job_ag != ag_name or not doc_name.endswith(DR_STATUS_CHECK_DOCUMENT_NAME):
        return {"status": "invalid", "reason": "Final check job is not a role check for this availability group."}

    if fresh_job_id == run_record.get("role_check_job_id"):
        return {"status": "invalid", "reason": "Final check must be a new role check, not the one readiness was reviewed against."}

    created = _parse_utc_iso(job.get("created_at"))
    run_created = _parse_utc_iso(run_record.get("created_at"))
    if not created:
        return {"status": "invalid", "reason": "Final check job has no creation time."}
    if run_created and created < run_created:
        return {"status": "invalid", "reason": "Final check was started before readiness was reviewed — run it again."}
    age = (datetime.utcnow() - created).total_seconds()
    if age > DR_FRESH_CHECK_MAX_AGE_SECONDS:
        return {"status": "invalid", "reason": f"Final check is {int(age)}s old (limit {DR_FRESH_CHECK_MAX_AGE_SECONDS}s) — run it again."}

    result = read_ag_status_job_result(fresh_job_id)
    if not result["ok"]:
        return {"status": "invalid", "reason": f"Final check did not complete: {result['reason']}"}
    if not result["done"]:
        return {"status": "invalid", "reason": f"Final check is still {result['status']}."}

    reviewed_primary = run_record.get("primary_host")
    reviewed_target = run_record.get("dr_replica_host")
    differences = []

    classification = classify_ag_roles(result["roles"], ag_name, reviewed_target)
    if not classification.get("ok"):
        return {"status": "changed", "differences": [classification.get("reason", "Could not classify live roles.")]}

    live_primary = classification["primary"].get("ReplicaName")
    if live_primary != reviewed_primary:
        differences.append(f"Primary changed from {reviewed_primary} to {live_primary}")

    evaluation = evaluate_dr_preconditions(result, classification)
    for check in evaluation["checks"]:
        if check["result"] != "PASS":
            differences.append(check["detail"])

    if differences:
        return {"status": "changed", "differences": differences}
    return {"status": "ok"}


# ════════════════════════════════════════════════════════════════════════
# Saved switchover plans (drafts)
# ════════════════════════════════════════════════════════════════════════
#
#   GET  /dr-failover/{AGName}/plans            → list saved plans for AG
#   POST /dr-failover/{AGName}/plans            → save a new draft plan
#   POST /dr-failover/{AGName}/plans/{PlanId}   → update / cancel / mark executed
#
# A saved plan is a DRAFT ONLY. Nothing reads proposed_time to trigger an
# execution — there is no scheduler behind it. Executing still requires the
# full live flow: live check → readiness (/plan) → final check → /execute.
#
# Storage: the existing runstack-dr-run-log table (same pattern as the
# "roles-retry-{AG}" helper items already stored there). Items use a
# "plan-" run_id prefix and record_type SWITCHOVER_PLAN, and are listed
# per-AG through the existing ag_name-created_at-index GSI. No new table,
# no IAM change (the Lambda already has runstack-* table/index access).
# Authorization is the same sql_dr_failover action check as /plan.

_PLAN_RECORD_TYPE = "SWITCHOVER_PLAN"
_PLAN_STATUSES = {"DRAFT", "CANCELLED", "EXECUTED"}
_PLAN_TEXT_LIMITS = {"intended_target": 200, "change_reference": 100, "notes": 2000}


def _plan_ag_name(path: str) -> str:
    import urllib.parse as _urlparse
    return _urlparse.unquote(path.split("/dr-failover/")[-1].split("/plans")[0])


def _clean_plan_fields(body: dict, require_all: bool) -> tuple:
    """Validates user-supplied plan fields. Returns (fields, error)."""
    fields = {}
    for key, limit in _PLAN_TEXT_LIMITS.items():
        if key in body:
            value = str(body.get(key) or "").strip()
            if len(value) > limit:
                return None, f"{key} must be {limit} characters or fewer"
            fields[key] = value

    if "proposed_time" in body:
        raw = str(body.get("proposed_time") or "").strip()
        if raw:
            try:
                parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                return None, "proposed_time must be an ISO-8601 timestamp"
            # Store as UTC ISO with explicit Z so every consumer reads the
            # same instant regardless of the operator's browser timezone.
            if parsed.tzinfo is not None:
                from datetime import timezone as _tz
                parsed = parsed.astimezone(_tz.utc).replace(tzinfo=None)
            fields["proposed_time"] = parsed.isoformat(timespec="minutes") + "Z"
        else:
            fields["proposed_time"] = ""

    if require_all:
        missing = [k for k in ("intended_target", "proposed_time", "change_reference") if not fields.get(k)]
        if missing:
            return None, f"Missing required field(s): {', '.join(missing)}"
    return fields, None


def _public_plan(item: dict) -> dict:
    keys = ("run_id", "ag_name", "status", "intended_target", "proposed_time",
            "change_reference", "notes", "created_by", "created_at",
            "updated_by", "updated_at", "executed_run_id")
    out = {k: item.get(k) for k in keys if k in item}
    out["plan_id"] = out.pop("run_id", None)
    return out


def handle_dr_plans_list(event, http_method, path, path_parameters, query_params):
    try:
        ag_name = _plan_ag_name(path)
        denied = authorize_action(event, "sql_dr_failover", resource_id=ag_name)
        if denied:
            return denied

        from boto3.dynamodb.conditions import Key, Attr
        table = boto3.resource("dynamodb").Table(DR_RUN_LOG_TABLE)
        include_closed = (query_params or {}).get("include_closed") == "true"
        items, kwargs = [], {
            "IndexName": "ag_name-created_at-index",
            "KeyConditionExpression": Key("ag_name").eq(ag_name),
            "FilterExpression": Attr("record_type").eq(_PLAN_RECORD_TYPE),
            "ScanIndexForward": False,
        }
        while True:
            resp = table.query(**kwargs)
            items.extend(resp.get("Items", []))
            if not resp.get("LastEvaluatedKey") or len(items) >= 200:
                break
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]

        plans = [_public_plan(i) for i in items if include_closed or i.get("status") == "DRAFT"]
        return {"statusCode": 200, "headers": CORS_HEADERS,
                "body": json.dumps({"ag_name": ag_name, "plans": plans}, default=decimal_default)}
    except Exception as e:
        logger.error(f"Error listing switchover plans: {e}")
        return {"statusCode": 500, "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Failed to list switchover plans", "detail": str(e)})}


def handle_dr_plans_create(event, http_method, path, path_parameters, query_params):
    try:
        ag_name = _plan_ag_name(path)
        denied = authorize_action(event, "sql_dr_failover", resource_id=ag_name)
        if denied:
            return denied

        body = json.loads(event.get("body") or "{}")
        fields, error = _clean_plan_fields(body, require_all=True)
        if error:
            return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps({"error": error})}

        claims, _ = get_claims_and_role(event)
        now = datetime.utcnow().isoformat()
        item = {
            "run_id": f"plan-{uuid.uuid4()}",
            "record_type": _PLAN_RECORD_TYPE,
            "ag_name": ag_name,
            "status": "DRAFT",
            "created_by": claims.get("username", "unknown"),
            "created_at": now,
            "updated_by": claims.get("username", "unknown"),
            "updated_at": now,
            **fields,
        }
        boto3.resource("dynamodb").Table(DR_RUN_LOG_TABLE).put_item(Item=item)
        return {"statusCode": 201, "headers": CORS_HEADERS,
                "body": json.dumps({"plan": _public_plan(item)}, default=decimal_default)}
    except Exception as e:
        logger.error(f"Error saving switchover plan: {e}")
        return {"statusCode": 500, "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Failed to save switchover plan", "detail": str(e)})}


def handle_dr_plan_update(event, http_method, path, path_parameters, query_params):
    try:
        ag_name = _plan_ag_name(path)
        plan_id = path.split("/plans/")[-1].strip("/")
        denied = authorize_action(event, "sql_dr_failover", resource_id=ag_name)
        if denied:
            return denied

        existing = get_dr_run_record(plan_id)
        # The AG in the path must match the stored plan, otherwise a caller
        # authorized for AG-A could edit a plan for AG-B.
        if (not existing or existing.get("record_type") != _PLAN_RECORD_TYPE
                or existing.get("ag_name") != ag_name):
            return {"statusCode": 404, "headers": CORS_HEADERS,
                    "body": json.dumps({"error": f"No saved plan '{plan_id}' for {ag_name}"})}
        if existing.get("status") != "DRAFT":
            return {"statusCode": 409, "headers": CORS_HEADERS,
                    "body": json.dumps({"error": f"Plan is {existing.get('status')} and can no longer be changed"})}

        body = json.loads(event.get("body") or "{}")
        fields, error = _clean_plan_fields(body, require_all=False)
        if error:
            return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps({"error": error})}

        new_status = body.get("status")
        if new_status is not None:
            if new_status not in _PLAN_STATUSES:
                return {"statusCode": 400, "headers": CORS_HEADERS,
                        "body": json.dumps({"error": f"status must be one of {sorted(_PLAN_STATUSES)}"})}
            fields["status"] = new_status
        if new_status == "EXECUTED":
            executed_run_id = str(body.get("executed_run_id") or "")
            linked = get_dr_run_record(executed_run_id) if executed_run_id.startswith("dr-") else None
            if not linked or linked.get("ag_name") != ag_name:
                return {"statusCode": 400, "headers": CORS_HEADERS,
                        "body": json.dumps({"error": "executed_run_id must be a switchover run for this AG"})}
            fields["executed_run_id"] = executed_run_id

        if not fields:
            return {"statusCode": 400, "headers": CORS_HEADERS, "body": json.dumps({"error": "Nothing to update"})}

        claims, _ = get_claims_and_role(event)
        fields["updated_by"] = claims.get("username", "unknown")
        update_dr_run_record(plan_id, fields)
        return {"statusCode": 200, "headers": CORS_HEADERS,
                "body": json.dumps({"plan": _public_plan(get_dr_run_record(plan_id) or {})}, default=decimal_default)}
    except Exception as e:
        logger.error(f"Error updating switchover plan: {e}")
        return {"statusCode": 500, "headers": CORS_HEADERS,
                "body": json.dumps({"error": "Failed to update switchover plan", "detail": str(e)})}
