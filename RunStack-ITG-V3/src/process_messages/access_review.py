"""
Effective-access review for the Users & Access admin page.

WHAT THIS IS
  A read-only explanation of what each person can do in RunStack today,
  computed by applying the SAME rules the enforcement code applies:
    - pre_token/app.py            → platform role from Cognito role groups
    - shared.authorize_action     → Layer 1 gates (role / team membership)
    - shared.require_team_capability → SQL/SAP/Tidal: role bypass,
                                    membership, capability enabled, scope
    - shared.validate_instance_access → EC2: admin bypass, app-access rows
    - shared.EC2_ALLOWED_ENVIRONMENTS → Phase 1 environment guard

WHAT THIS IS NOT
  Authorization. Nothing here grants or denies anything; the handlers
  still call authorize_action on every request. If this file and
  authorize_action ever disagree, authorize_action is right and this file
  has a bug — tests/process_messages/test_access_review.py pins the rules
  so a change to one without the other is caught.

Statuses returned per item:
  active        — the rules above would allow it today
  inactive      — assigned, but a rule currently blocks it (amber in UI)
  invalid       — assigned in a way that can never work (red in UI)
  not_enforced  — assigned, but no RunStack action checks it yet
"""

from shared import (  # noqa: F401  (re-exported names used by tests)
    ACTION_AUTH_CONFIG, EC2_ALLOWED_ENVIRONMENTS, ROLE_GROUPS, ROLE_RANK,
)

# ── Friendly names ───────────────────────────────────────────────────────

ROLE_LABELS = {
    "admin": "Admin",
    "operator": "Operator",
    "app_operator": "App Operator",
    "viewer": "Viewer",
    "none": "No platform role",
}

# Azure AD group that feeds each Cognito group (mirrors
# pre_token/app.py AD_TO_COGNITO_GROUP_MAP — separate Lambda, so restated).
ROLE_AD_GROUPS = {
    "admin": "Runstack-700067-Automation-Admin",
    "operator": "Runstack-700067-Automation-Operator",
    "app_operator": "Runstack-700067-EC2 Admin-Operator",
    "viewer": None,  # runstack-readonly has no Azure AD source today (legacy)
}
ROLE_COGNITO_GROUPS = {role: group for group, role in ROLE_GROUPS}

TEAM_LABELS = {"gdba-sql": "GDBA SQL", "sap": "SAP Basis", "tidal": "Tidal"}
TEAM_AD_GROUPS = {
    "gdba-sql": "Runstack-700067-GDBA MS SQL-Operators",
    "sap": "Runstack-700067-SAP Basis-Operator",
    "tidal": "Runstack-700067-Tidal-Operator",
}

# One entry per ACTION_AUTH_CONFIG key that uses a team capability.
#   wired     — some API route actually calls authorize_action with this key
#   resource  — what resource_id that route passes (None = no resource, so a
#               list-scoped capability can never match and is always denied)
# Keep in sync with the call sites (grep: authorize_action(event, "...")).
TEAM_ACTIONS = {
    "sql_healthcheck":  {"label": "SQL database health check", "wired": True,  "resource": None},
    "sql_dr_failover":  {"label": "SQL DR switchover",         "wired": True,  "resource": "availability group"},
    "sap_status_check": {"label": "SAP status check",          "wired": True,  "resource": None},
    "sap_start_stop":   {"label": "SAP start / stop",          "wired": True,  "resource": None},
    "tidal_action":     {"label": "Tidal job management",      "wired": False, "resource": None},
}

ROLE_CAN_DO = {
    "admin": [
        "Run EC2 actions on every application (no assignment needed)",
        "Run every SQL, SAP and Tidal team action (no team membership needed)",
        "Manage users, schedules and settings",
    ],
    "operator": [
        "Run every SQL, SAP and Tidal team action (no team membership needed)",
        "Run EC2 actions on assigned applications only",
        "Use operator pages such as Schedules and Dead Letter Queue",
    ],
    "app_operator": [
        "Run EC2 actions on assigned applications only",
        "Team actions only through team membership",
    ],
    "viewer": [
        "View dashboards and executions (read-only)",
        "Cannot run EC2 actions; team actions only through team membership",
    ],
    "none": [
        "Cannot run EC2 actions",
        "Can still use SQL, SAP or Tidal permissions through team membership",
    ],
}


def team_actions_for(team):
    """[(action_key, capability)] for every configured action of a team."""
    return [(key, cfg["team_capability"][1]) for key, cfg in ACTION_AUTH_CONFIG.items()
            if cfg.get("team_capability") and cfg["team_capability"][0] == team]


def _scope_text(scope):
    if scope == "ALL" or scope is None:
        return "All resources"
    return "Only: " + ", ".join(str(s) for s in scope)


# ── Section evaluators ───────────────────────────────────────────────────

def evaluate_platform_role(role):
    role = role if role in ROLE_LABELS else "none"
    return {
        "role": role,
        "label": ROLE_LABELS[role],
        "status": "none" if role == "none" else "active",
        "cognito_group": ROLE_COGNITO_GROUPS.get(role),
        "ad_group": ROLE_AD_GROUPS.get(role),
        "can_do": ROLE_CAN_DO[role],
        "reason": (
            "Not in any RunStack role group (Admin, Operator, App Operator or Viewer)."
            if role == "none" else None
        ),
    }


def evaluate_ec2(role, apps, app_names, signin_email=None, stored_emails=None):
    """
    EC2 stop/start — authorize_action("ec2_stop_start"):
      Layer 1: role none/unauthorized → denied; viewer → denied.
      Layer 2: admin bypasses; everyone else needs a matching
               runstack-app-access row (validate_instance_access), plus the
               Phase 1 environment guard for start/stop.
    Team membership never contributes to EC2 (see resolve_authorized_app_ids).
    """
    items = []
    stored_emails = stored_emails or {}
    env_note = "Start/stop limited to " + ", ".join(sorted(EC2_ALLOWED_ENVIRONMENTS)) + " environments during Phase 1."

    for app_id in apps:
        name = "All applications" if app_id == "ALL" else app_names.get(app_id)
        item = {"app_id": app_id, "app_name": name}
        stored = stored_emails.get(app_id)
        if role == "admin":
            item.update(status="active", reason="Admin role already covers every application; this assignment isn't needed.")
        elif role in ("none",) or ROLE_RANK.get(role, 0) == 0:
            item.update(status="inactive", reason="No platform role. EC2 actions need the Operator, App Operator or Admin role.")
        elif role == "viewer":
            item.update(status="inactive", reason="Viewer role is read-only. EC2 actions need the Operator, App Operator or Admin role.")
        elif app_id != "ALL" and app_id not in app_names:
            item.update(status="invalid", reason="No servers with this application ID in the instance catalog, so it can't match anything.")
        elif signin_email and stored and stored != signin_email:
            # get_user_apps() is an exact-match DynamoDB key lookup on the
            # email taken from the sign-in token.
            item.update(status="invalid", reason=f"Saved for '{stored}', but the user signs in as '{signin_email}'. The lookup is case-sensitive, so it won't match.")
        else:
            item.update(status="active", reason=env_note)
        items.append(item)

    if role == "admin":
        summary, status = "All applications (Admin role)", "active"
    elif not items:
        summary = "No applications assigned"
        status = "none"
    else:
        status = _combine([i["status"] for i in items])
        n_active = sum(1 for i in items if i["status"] == "active")
        n = len(items)
        if status == "active":
            summary = "All applications" if apps == ["ALL"] else f"{n} application{'s' if n != 1 else ''}"
        elif status == "partial":
            summary = f"{n_active} of {n} usable"
        else:
            summary = f"{'Inactive' if status == 'inactive' else 'Needs fixing'} · {n} assigned"
    blocked = None
    if items and status in ("inactive",) and role in ("none", "viewer"):
        blocked = items[0]["reason"]
    return {"status": status, "summary": summary, "reason": blocked, "apps": items,
            "covers_all": role == "admin" or "ALL" in apps}


def evaluate_team(role, teams, capabilities):
    """
    SQL / SAP / Tidal — authorize_action with a team_capability:
      Layer 1 lets through a team member (any role, even none/viewer) OR a
      non-member whose role isn't none/viewer.
      require_team_capability: admin/operator → allowed (before membership,
      enabled or scope are looked at); otherwise must be a team member AND
      the capability row enabled AND scope ALL or containing resource_id.
    """
    cap_rows = {(c["team"], c["capability"]): c for c in capabilities}
    via_role = ROLE_RANK.get(role, 0) >= ROLE_RANK["operator"]
    items = []

    for team in sorted(teams):
        label = TEAM_LABELS.get(team, team)
        actions = team_actions_for(team)
        known_caps = {cap for _, cap in actions}
        extra_rows = [c for (t, cap), c in cap_rows.items() if t == team and cap not in known_caps]

        if not actions and not extra_rows:
            items.append({"team": team, "team_label": label, "capability": None, "action": None,
                          "action_label": "No permissions configured", "scope": None,
                          "status": "inactive", "reason": "Member of this team, but it has no permissions set up."})
            continue

        for action_key, cap in actions:
            meta = TEAM_ACTIONS.get(action_key, {"label": cap, "wired": True, "resource": None})
            row = cap_rows.get((team, cap))
            item = {"team": team, "team_label": label, "capability": cap, "action": action_key,
                    "action_label": meta["label"], "scope": row.get("scope", "ALL") if row else None}
            if not meta["wired"]:
                item.update(status="not_enforced", reason="Defined, but no RunStack action checks it yet.")
            elif via_role:
                item.update(status="active", reason=f"Allowed by the {ROLE_LABELS[role]} role (team membership and on/off setting aren't checked for this role).")
            elif not row:
                item.update(status="inactive", reason=f"The {label} team has no '{cap}' permission set up, so this is denied.")
            elif not row.get("enabled"):
                item.update(status="inactive", reason=f"Turned off for the whole {label} team.")
            elif row.get("scope", "ALL") != "ALL" and not meta["resource"]:
                item.update(status="invalid", reason="Limited to specific resources, but this action doesn't check a resource, so it is always denied. Set scope to All resources.")
            else:
                item.update(status="active", reason=_scope_text(row.get("scope", "ALL")))
            items.append(item)

        for row in extra_rows:
            items.append({"team": team, "team_label": label, "capability": row["capability"], "action": None,
                          "action_label": row["capability"], "scope": row.get("scope", "ALL"),
                          "status": "not_enforced", "reason": "No RunStack action checks this permission."})

    counted = [i["status"] for i in items if i["status"] != "not_enforced"]
    if via_role:
        status = "active"
        summary = f"All team actions ({ROLE_LABELS[role]} role)"
    elif not items:
        status, summary = "none", "No team membership"
    else:
        status = _combine(counted) if counted else "not_enforced"
        n_active = counted.count("active")
        summary = ", ".join(TEAM_LABELS.get(t, t) for t in sorted(teams))
        if status != "active":
            summary += f" · {n_active} of {len(counted)} usable" if counted else " · not enforced"
    return {"status": status, "summary": summary, "via_role": via_role,
            "memberships": sorted(teams), "items": items}


def _combine(statuses):
    """Roll item/section statuses up: all active → active; some active (or a
    section already partial) → partial; otherwise invalid beats inactive."""
    s = set(statuses)
    if not s:
        return "none"
    if s == {"active"}:
        return "active"
    if "active" in s or "partial" in s:
        return "partial"
    if "invalid" in s:
        return "invalid"
    return "inactive"


def evaluate_user_access(role, apps, teams, capabilities, app_names, signin_email=None, stored_emails=None):
    platform = evaluate_platform_role(role)
    ec2 = evaluate_ec2(platform["role"], apps, app_names, signin_email, stored_emails)
    team = evaluate_team(platform["role"], teams, capabilities)

    section_statuses = [x for x in (ec2["status"], team["status"]) if x not in ("none", "not_enforced")]
    all_items = [i["status"] for i in ec2["apps"]] + [i["status"] for i in team["items"] if i["status"] != "not_enforced"]

    if not section_statuses:
        if platform["role"] == "viewer":
            status, summary = "read_only", "Read-only (Viewer)"
        elif platform["role"] in ("admin", "operator"):
            status, summary = "active", f"Active ({platform['label']})"
        elif platform["role"] == "app_operator":
            status, summary = "inactive", "No applications assigned"
        elif team["status"] == "not_enforced":
            status, summary = "none", "No enforced access"
        else:
            status, summary = "none", "No access"
    else:
        status = _combine(section_statuses)
        n_inactive = all_items.count("inactive")
        n_invalid = all_items.count("invalid")
        summary = {
            "active": "Active",
            "partial": "Partly active",
            "inactive": "Inactive",
            "invalid": "Needs fixing",
        }[status]
        if n_invalid and status != "invalid":
            summary += f" · {n_invalid} needs fixing"

    reasons = []
    if ec2["status"] in ("inactive", "partial", "invalid"):
        reasons += [f"EC2 {i['app_name'] or i['app_id']}: {i['reason']}" for i in ec2["apps"] if i["status"] in ("inactive", "invalid")]
    if team["status"] == "not_enforced":
        reasons.append("Team permissions assigned, but no RunStack action checks them yet.")
    if team["status"] in ("inactive", "partial", "invalid"):
        reasons += [f"{i['team_label']} – {i['action_label']}: {i['reason']}" for i in team["items"] if i["status"] in ("inactive", "invalid")]

    return {"status": status, "summary": summary, "reasons": reasons,
            "platform_role": platform, "ec2": ec2, "team": team}


# ── Data loading for GET /admin/users ────────────────────────────────────

def build_access_overview():
    """
    Everything the Users & Access page needs in one response. Superset of
    the old list_runstack_users() shape — every user still has email,
    role and apps — plus teams, access (the evaluation above), and the
    applications / teams / actions reference data for friendly names.
    """
    import boto3
    from boto3.dynamodb.conditions import Key  # noqa: F401
    from shared import (APP_ACCESS_TABLE, INSTANCE_CATALOG_TABLE, list_cognito_group_members,
                        list_team_capabilities, logger)

    ddb = boto3.resource("dynamodb")

    # App-access rows (keep the exact stored email per app for the
    # case-sensitivity check).
    table = ddb.Table(APP_ACCESS_TABLE)
    resp = table.scan()
    access_items = resp.get("Items", [])
    while "LastEvaluatedKey" in resp:
        resp = table.scan(ExclusiveStartKey=resp["LastEvaluatedKey"])
        access_items.extend(resp.get("Items", []))

    # Application names from the instance catalog.
    table = ddb.Table(INSTANCE_CATALOG_TABLE)
    kwargs = {"ProjectionExpression": "app_id, app_name"}
    resp = table.scan(**kwargs)
    catalog = resp.get("Items", [])
    while "LastEvaluatedKey" in resp:
        resp = table.scan(ExclusiveStartKey=resp["LastEvaluatedKey"], **kwargs)
        catalog.extend(resp.get("Items", []))
    applications = {}
    for row in catalog:
        app_id = row.get("app_id")
        if not app_id:
            continue
        entry = applications.setdefault(app_id, {"app_id": app_id, "app_name": None, "server_count": 0})
        entry["server_count"] += 1
        if row.get("app_name") and not entry["app_name"]:
            entry["app_name"] = row["app_name"]
    app_names = {a: (v["app_name"] or a) for a, v in applications.items()}

    caps = list_team_capabilities()
    capabilities, teams_meta = caps["capabilities"], caps["teams_meta"]
    meta_by_team = {t["team"]: t for t in teams_meta}
    all_teams = sorted({c["team"] for c in capabilities} | set(meta_by_team)
                       | {cfg["team_capability"][0] for cfg in ACTION_AUTH_CONFIG.values() if cfg.get("team_capability")})

    users = {}

    def user(email):
        key = email.lower()
        if key not in users:
            users[key] = {"email": email, "role": "none", "apps": [], "teams": [],
                          "signin_email": None, "stored_emails": {}, "role_groups": []}
        return users[key]

    errors = []
    # Role — same groups and precedence as pre_token.py.
    for group, role in ROLE_GROUPS:
        try:
            members = list_cognito_group_members(group).get("members", [])
        except Exception as e:  # noqa: BLE001
            logger.error(f"access overview: could not list {group}: {e}")
            errors.append(f"Could not read Cognito group {group}")
            continue
        for m in members:
            if not m.get("email"):
                continue
            u = user(m["email"])
            u["role_groups"].append(group)
            if ROLE_RANK.get(role, 0) > ROLE_RANK.get(u["role"], 0):
                u["role"] = role
            _set_signin(u, m)

    # Team membership — same group resolution as is_team_member().
    team_groups = {}
    for team in all_teams:
        group = (meta_by_team.get(team) or {}).get("cognito_group") or f"runstack-team-{team}"
        team_groups[team] = group
        try:
            members = list_cognito_group_members(group).get("members", [])
        except Exception as e:  # noqa: BLE001
            logger.warning(f"access overview: could not list team group {group}: {e}")
            continue
        for m in members:
            if not m.get("email"):
                continue
            u = user(m["email"])
            if team not in u["teams"]:
                u["teams"].append(team)
            _set_signin(u, m)

    for item in access_items:
        email, app_id = item.get("user_email", ""), item.get("app_id", "")
        if not email or not app_id:
            continue
        u = user(email)
        if app_id not in u["apps"]:
            u["apps"].append(app_id)
            u["stored_emails"][app_id] = email

    out_users = []
    for u in sorted(users.values(), key=lambda x: x["email"].lower()):
        access = evaluate_user_access(u["role"], u["apps"], u["teams"], capabilities, app_names,
                                      u["signin_email"], u["stored_emails"])
        out_users.append({"email": u["email"], "role": u["role"], "apps": u["apps"], "teams": sorted(u["teams"]),
                          "signin_email": u["signin_email"], "access": access})

    teams_out = []
    for team in all_teams:
        teams_out.append({
            "team": team,
            "label": TEAM_LABELS.get(team, (meta_by_team.get(team) or {}).get("description") or team),
            "cognito_group": team_groups.get(team),
            "ad_group": TEAM_AD_GROUPS.get(team),
            "member_count": sum(1 for u in users.values() if team in u["teams"]),
            "actions": [{"action": k, "capability": c, **TEAM_ACTIONS.get(k, {"label": c, "wired": True, "resource": None})}
                        for k, c in team_actions_for(team)],
        })

    return {
        "users": out_users,
        "count": len(out_users),
        "applications": sorted(applications.values(), key=lambda a: (a["app_name"] or a["app_id"]).lower()),
        "teams": teams_out,
        "role_labels": ROLE_LABELS,
        "warnings": errors,
    }


def _set_signin(u, member):
    """Email the token will carry: authorize_action strips 'AzureAD_' from
    the Cognito username. Only known for users who have signed in."""
    username = member.get("username") or ""
    if username.startswith("AzureAD_"):
        u["signin_email"] = username[len("AzureAD_"):]
