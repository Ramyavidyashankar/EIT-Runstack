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
        # ?for_document=<approved document>: Run Automations asks which servers
        # it may offer for that automation. A document approved with a team
        # action (SQL/SAP/Tidal capability) lists the servers in the caller's
        # team scope; any other document falls through to app access below,
        # exactly as without the parameter. The run itself re-checks each server.
        for_document = (query_params or {}).get("for_document")
        if for_document:
            import runs
            if for_document not in runs.approved_config():
                return {"statusCode": 400, "headers": CORS_HEADERS,
                        "body": json.dumps({"error": "bad_request", "reason": "document_not_approved",
                                            "message": f"'{for_document}' is not an approved automation."})}
            team_instances, denied = runs.instances_for_document(event, for_document)
            if denied:
                return denied
            if team_instances is not None:
                if query_params.get("app_id"):
                    team_instances = [i for i in team_instances if str(i.get("app_id")) == str(query_params["app_id"])]
                return {"statusCode": 200, "headers": CORS_HEADERS,
                        "body": json.dumps({"instances": team_instances, "count": len(team_instances),
                                            "scope": "team"}, default=decimal_default)}

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

        state_errors = []
        if str((query_params or {}).get("include_state") or "").lower() == "true":
            instances = [dict(i) for i in instances]
            state_errors = attach_live_states(instances)

        return {
            "statusCode": 200,
            "headers": CORS_HEADERS,
            "body": json.dumps({
                "instances": instances,
                "count": len(instances),
                "apps": app_ids,
                **({"state_errors": state_errors} if state_errors else {}),
            }, default=decimal_default)
        }

    except Exception as e:
        logger.error(f"Error listing instances: {e}")
        return {
            "statusCode": 500,
            "headers": CORS_HEADERS,
            "body": json.dumps({"error": "Failed to list instances", "detail": str(e)})
        }


# ── Live EC2 state (EC2 Start/Stop page) ──────────────────────────────────
# GET /app-instances?include_state=true adds each instance's current state,
# read with ec2:DescribeInstances through the existing runstack-cross-account-
# role (the same role get_instance_platform already uses for describe_instances).
# One call per account/region per 100 instances; no jobs are created. A read
# failure leaves state empty with state_error — it never blocks the list.

_STATE_CACHE = {}
_STATE_CACHE_SECONDS = 15
# API Gateway gives up at 29 s. State is read within this budget; whatever
# isn't back by then is returned as unknown (state_error "timeout") rather
# than failing the whole list. Very large lists aren't read at all — the UI
# asks per application.
EC2_STATE_TIME_BUDGET_SEC = float(os.getenv("EC2_STATE_TIME_BUDGET_SEC", "12"))
EC2_STATE_MAX_INSTANCES = int(os.getenv("EC2_STATE_MAX_INSTANCES", "500"))


def _aws_config():
    from botocore.config import Config
    return Config(connect_timeout=3, read_timeout=6, retries={"max_attempts": 2, "mode": "standard"})


def _ec2_client_for(account_id, region):
    import boto3 as _b
    role = os.environ.get("CROSS_ACCOUNT_ROLE_NAME", "runstack-cross-account-role")
    creds = _b.client("sts", config=_aws_config()).assume_role(
        RoleArn=f"arn:aws:iam::{account_id}:role/{role}", RoleSessionName="runstack-ec2-state")["Credentials"]
    return _b.client("ec2", region_name=region, aws_access_key_id=creds["AccessKeyId"], config=_aws_config(),
                     aws_secret_access_key=creds["SecretAccessKey"], aws_session_token=creds["SessionToken"])


def _read_states(account_id, region, ids):
    key = (account_id, region, tuple(sorted(ids)))
    hit = _STATE_CACHE.get(key)
    if hit and time.time() - hit[0] < _STATE_CACHE_SECONDS:
        return hit[1]
    ec2 = _ec2_client_for(account_id, region)
    states = {}
    for i in range(0, len(ids), 100):
        batch = ids[i:i + 100]
        kw = {"Filters": [{"Name": "instance-id", "Values": batch}]}
        while True:
            page = ec2.describe_instances(**kw)
            for r in page.get("Reservations", []):
                for inst in r.get("Instances", []):
                    states[inst["InstanceId"]] = (inst.get("State") or {}).get("Name")
            if not page.get("NextToken"):
                break
            kw["NextToken"] = page["NextToken"]
    _STATE_CACHE[key] = (time.time(), states)
    return states


def attach_live_states(instances):
    from concurrent.futures import ThreadPoolExecutor, wait
    checked_at = datetime.utcnow().isoformat() + "Z"
    if len(instances) > EC2_STATE_MAX_INSTANCES:
        for i in instances:
            i.update(state=None, state_error="too_many_instances", state_checked_at=checked_at)
        return [{"account_id": "*", "region": "*", "code": "too_many_instances",
                 "message": f"Live state is read for up to {EC2_STATE_MAX_INSTANCES} instances; choose an application."}]
    groups = {}
    for i in instances:
        if i.get("instance_id") and i.get("account_id") and i.get("region"):
            groups.setdefault((str(i["account_id"]), i["region"]), []).append(i["instance_id"])
    errors, results = [], {}

    def work(item):
        (acct, region), ids = item
        try:
            return (acct, region), _read_states(acct, region, ids), None
        except Exception as e:
            code = getattr(e, "response", {}).get("Error", {}).get("Code") if hasattr(e, "response") else type(e).__name__
            return (acct, region), None, code or "error"

    pool = ThreadPoolExecutor(max_workers=min(16, max(1, len(groups))))
    futures = {pool.submit(work, item): item[0] for item in groups.items()}
    done, pending = wait(futures, timeout=EC2_STATE_TIME_BUDGET_SEC)
    for fut in done:
        k, states, err = fut.result()
        results[k] = (states, err)
        if err:
            errors.append({"account_id": k[0], "region": k[1], "code": err})
            logger.warning(f"app-instances: EC2 state read failed for {k[0]}/{k[1]}: {err}")
    for fut in pending:
        k = futures[fut]
        results[k] = (None, "timeout")
        errors.append({"account_id": k[0], "region": k[1], "code": "timeout"})
        logger.warning(f"app-instances: EC2 state read for {k[0]}/{k[1]} exceeded {EC2_STATE_TIME_BUDGET_SEC}s")
    pool.shutdown(wait=False, cancel_futures=True)
    for i in instances:
        states, err = results.get((str(i.get("account_id")), i.get("region")), (None, "not_checked"))
        if states is not None and i.get("instance_id") in states:
            i["state"] = states[i["instance_id"]]
        else:
            i["state"] = None
            i["state_error"] = err or "not_found"
        i["state_checked_at"] = checked_at
    return errors
