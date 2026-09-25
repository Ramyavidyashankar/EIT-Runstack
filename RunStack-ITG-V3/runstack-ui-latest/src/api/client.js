// ─── Add to src/api/client.js, in the "Admin: Users & Roles" section or its
// own "Instances" section — right next to the other exported API functions.

/** GET /app-instances — instances scoped to the current user's role/app
 *  access (admins/operators currently get every instance in the catalog;
 *  a future app-scoped role would get only their assigned apps' instances).
 *  Optional appId narrows server-side to a single app; TriggerJob.jsx fetches
 *  once with no filter and slices the result client-side per selected app,
 *  so this param mainly exists for future/other callers. */
export async function fetchAppInstances(appId) {
  const params = appId ? `?app_id=${encodeURIComponent(appId)}` : '';
  return apiFetch(`/app-instances${params}`);
}

const API_BASE = process.env.REACT_APP_API_BASE_URL || '';

let _tokenProvider = null;

/** Called once by AuthProvider on mount. Registers a function that returns
 *  a Promise<string> resolving to a valid (non-expired, refreshed-if-needed)
 *  access token for the current user. */
export function setAccessTokenProvider(fn) {
  _tokenProvider = fn;
}

/** Thrown when the API rejects a request as unauthenticated/expired —
 *  callers (or a top-level handler) should treat this as "must log in
 *  again", not retry with the same token. */
export class AuthRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

async function getAccessToken() {
  if (!_tokenProvider) {
    throw new AuthRequiredError('Not signed in — no access token provider registered.');
  }
  try {
    return await _tokenProvider();
  } catch (e) {
    throw new AuthRequiredError(e.message || 'Could not obtain a valid access token.');
  }
}

async function apiFetch(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });

  if (res.status === 401) {
    const text = await res.text();
    throw new AuthRequiredError(`Session expired or invalid (401): ${text}`);
  }

  if (!res.ok) {
    const text = await res.text();
    // Message format unchanged for existing callers. `status` and parsed
    // `body` are attached so pages can react to structured errors (e.g.
    // DR /plan's failed readiness checks, /execute's STATE_CHANGED 409).
    const err = new Error(`API error ${res.status}: ${text}`);
    err.status = res.status;
    try { err.body = JSON.parse(text); } catch { err.body = null; }
    throw err;
  }

  return res.json();
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

/** GET /jobs/recent?limit=N&status=FILTER&last_key=... */
export async function fetchRecentJobs({ limit = 20, status, lastKey } = {}) {
  const params = new URLSearchParams({ limit });
  if (status) params.set('status', status);
  if (lastKey) params.set('last_key', lastKey);   // backend uses last_key (underscore)
  return apiFetch(`/jobs/recent?${params}`);
}

/** GET /jobs/latest */
export async function fetchLatestJob() {
  return apiFetch('/jobs/latest');
}

/** GET /jobs/query — dataset-wide filter, counts, sort and paging for the
 *  Automation Executions page (see jobs.handle_jobs_query). Unlike
 *  /jobs/recent, totals and status counts cover the whole jobs table. */
export async function queryJobs(params = {}) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  return apiFetch(`/jobs/query?${qs.toString()}`);
}

/** GET /jobs/{jobId} */
export async function fetchJob(jobId) {
  return apiFetch(`/jobs/${jobId}`);
}



export async function fetchSSMDocuments({ type = 'Command', owner = 'Self' } = {}) {
  const params = new URLSearchParams({ type, owner });
  return apiFetch(`/ssm/documents?${params}`);
}

export async function fetchSchedules({ prefix = '', scope, source } = {}) {
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix);
  if (scope) params.set('scope', scope);        // runstack | other | all (default all)
  if (source) params.set('source', source);     // 'scheduler' → EventBridge Scheduler (read-only)
  const qs = params.toString();
  return apiFetch(`/eventbridge/schedules${qs ? `?${qs}` : ''}`);
}

export async function createSchedule(body) {
  return apiFetch('/eventbridge/schedules', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateSchedule(name, body) {
  return apiFetch(`/eventbridge/schedules/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteSchedule(name) {
  return apiFetch(`/eventbridge/schedules/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

export async function fetchSSMDocumentContent(name) {
  return apiFetch(`/ssm/documents/${encodeURIComponent(name)}`);
}

// ─── Trigger ─────────────────────────────────────────────────────────────────

/**
 * POST /notify
 * payload: { id, region, account_id, resource_id, automation_type, automation_data }
 */
export async function triggerJob(payload) {
  return apiFetch('/notify', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ─── Uploads (S3) ────────────────────────────────────────────────────────────

/** POST /uploads/presign — returns { upload_url, key, bucket, expires_in } */
export async function getUploadUrl(filename, contentType) {
  return apiFetch('/uploads/presign', {
    method: 'POST',
    body: JSON.stringify({ filename, content_type: contentType }),
  });
}

/** PUT the file bytes directly to S3 using the presigned URL (no auth header, no API base). */
export async function uploadFileToS3(uploadUrl, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`S3 upload failed: ${xhr.status} ${xhr.statusText}`));
    };
    xhr.onerror = () => reject(new Error('S3 upload failed: network error'));
    xhr.send(file);
  });
}

/** GET /uploads — list uploaded files with presigned download links */
export async function fetchUploads({ prefix } = {}) {
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix);
  const query = params.toString() ? `?${params}` : '';
  return apiFetch(`/uploads${query}`);
}

/** DELETE /uploads/{key} */
export async function deleteUpload(key) {
  return apiFetch(`/uploads/${encodeURIComponent(key).replace(/%2F/g, '/')}`, {
    method: 'DELETE',
  });
}

// ─── Admin: Users & Roles ──────────────────────────────────────────────────────

/** GET /admin/users — list users with their current RunStack role */
export async function fetchUsers() {
  return apiFetch('/admin/users');
}

/** POST /admin/users/{email}/role — update a user's role and/or app access.
 *  Both are independently optional. Pass ONLY what should actually change —
 *  omit `role` on an apps-only edit (don't resend whatever role happens to
 *  be displayed), and omit `apps` on a role-only edit. */
export async function setUserRole(email, { role, apps } = {}) {
  const body = {};
  if (role !== undefined) body.role = role;
  if (apps !== undefined) body.apps = apps;
  return apiFetch(`/admin/users/${encodeURIComponent(email)}/role`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ─── Team Capabilities ──────────────────────────────────────────────────────
// Live as of the ITG-v7 admin routes: runstack-team-capabilities is PK team /
// SK capability. Each row is { enabled: bool, scope: "ALL" | string[] }.
// Team membership itself is NOT stored per-user here — it's whichever
// Cognito group is on the team's reserved "_meta" row (capability: "_meta",
// cognito_group, description), checked by is_team_member() server-side.

/** GET /admin/team-capabilities → { capabilities: [...], teams_meta: [...], count } */
export async function fetchTeamCapabilities() {
  return apiFetch('/admin/team-capabilities');
}

/** POST /admin/team-capabilities — create/update one (team, capability) row.
 *  enabled/scope are independently optional — an omitted field keeps its
 *  existing value server-side (same contract as setUserRole). scope is
 *  "ALL" or an array of resource IDs (AG names, instance IDs, etc.). */
export async function setTeamCapability(team, capability, { enabled, scope } = {}) {
  const body = { team, capability };
  if (enabled !== undefined) body.enabled = enabled;
  if (scope !== undefined) body.scope = scope;
  return apiFetch('/admin/team-capabilities', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** DELETE /admin/team-capabilities — remove one (team, capability) row.
 *  Refuses capability === "_meta" server-side; use setTeamMeta with nulls
 *  if you need to clear team config instead. */
export async function deleteTeamCapability(team, capability) {
  return apiFetch('/admin/team-capabilities', {
    method: 'DELETE',
    body: JSON.stringify({ team, capability }),
  });
}

/** POST /admin/team-capabilities with capability: "_meta" — create/update a
 *  team's Cognito group mapping. Defaults cognito_group server-side to
 *  "runstack-team-{team}" on first create if omitted. */
export async function setTeamMeta(team, { cognitoGroup, description } = {}) {
  const body = { team, capability: '_meta' };
  if (cognitoGroup !== undefined) body.cognito_group = cognitoGroup;
  if (description !== undefined) body.description = description;
  return apiFetch('/admin/team-capabilities', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** GET /admin/cognito-groups → { groups: [{group_name, description}], count }.
 *  Real ListGroups call against the actual user pool — not a guess. */
export async function fetchCognitoGroups() {
  return apiFetch('/admin/cognito-groups');
}

/** GET /admin/cognito-groups/{group}/members → { group_name, members: [{username, email, enabled}], count }.
 *  Real ListUsersInGroup call — who is actually in a given group. */
export async function fetchCognitoGroupMembers(groupName) {
  return apiFetch(`/admin/cognito-groups/${encodeURIComponent(groupName)}/members`);
}

// ─── DR Failover (AlwaysOn AG) ────────────────────────────────────────────────
// All SSM-backed operations here are async — API Gateway's 29s limit is
// shorter than the Step Function's own 30s initial wait, so nothing that
// touches SSM can return a synchronous answer. Every one of these either
// returns instantly (list/servers/config/plan/status) or hands back a
// job_id to poll (roles trigger, execute).

/** GET /dynatrace/ags — list AG names discovered via Dynatrace */
export async function fetchDrAgNames() {
  return apiFetch('/dynatrace/ags');
}

/** GET /dynatrace/ags/{AGName}/servers — hosts + Dynatrace AG health for one AG */
export async function fetchDrAgServers(agName) {
  return apiFetch(`/dynatrace/ags/${encodeURIComponent(agName)}/servers`);
}

/** GET /dynatrace/ags/{AGName}/roles — TRIGGERS an async role/health-check
 *  job against one reachable replica. Returns { job_id, resolved_via_host,
 *  instance_id, status: "PENDING" } immediately — poll pollDrRolesJob for
 *  the actual Primary/Secondary/DR + per-DB sync result. */
export async function triggerDrAgRoles(agName) {
  return apiFetch(`/dynatrace/ags/${encodeURIComponent(agName)}/roles`);
}

/** GET /dynatrace/ags/{AGName}/roles/{jobId} — poll + parse the role-check
 *  job triggered above. Returns { status: "PENDING" } while running, or
 *  { status: "COMPLETED", roles, db_sync } once done (or throws on
 *  FAILED/not-found — see apiFetch's error handling). */
export async function pollDrRolesJob(agName, jobId) {
  return apiFetch(`/dynatrace/ags/${encodeURIComponent(agName)}/roles/${encodeURIComponent(jobId)}`);
}

/** GET /dr-failover/{AGName}/config — global DR thresholds (same for every
 *  AG — not per-AG instance identity anymore, that's derived live). */
export async function fetchDrConfig(agName) {
  return apiFetch(`/dr-failover/${encodeURIComponent(agName)}/config`);
}

/** POST /dr-failover/{AGName}/plan — runs pre-validation checks against an
 *  ALREADY-COMPLETED role-check job (pass the job_id from pollDrRolesJob
 *  once its status is COMPLETED). This call itself is fast/synchronous —
 *  it only reads DynamoDB, it doesn't touch SSM. No direction param —
 *  there's only one action ("fail over to the DR replica"), determined
 *  from whichever host the role-check job found to be PRIMARY.
 *  Returns { run_id, primary_host, dr_replica_host, all_pass, checks,
 *  confirmation_token, token_ttl_seconds }. confirmation_token is null if
 *  any check failed — /execute cannot be called without it, by design. */
export async function planDrFailover(agName, roleCheckJobId, targetReplica) {
  const body = { role_check_job_id: roleCheckJobId };
  if (targetReplica) body.target_replica = targetReplica;
  return apiFetch(`/dr-failover/${encodeURIComponent(agName)}/plan`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** POST /dr-failover/{AGName}/execute — consumes the one-time token from
 *  planDrFailover and CREATES the failover job (does not wait for it).
 *  Returns { run_id, failover_job_id, status: "EXECUTING" } immediately —
 *  poll fetchDrRunStatus with run_id to track it through to completion.
 *  Requires the person to have typed the literal string "YES" — this
 *  mirrors the original PowerShell script's interactive confirmation
 *  prompt, moved into the API contract so it still happens even though
 *  this is no longer a terminal. */
export async function executeDrFailover(agName, confirmationToken, freshRoleCheckJobId) {
  const body = { confirmation_token: confirmationToken, confirm: 'YES' };
  // Optional: a role-check job run immediately before execution. The
  // backend re-evaluates readiness against it and returns 409
  // (code STATE_CHANGED, with `differences`) if primary/target/readiness
  // moved since review — the UI always sends it.
  if (freshRoleCheckJobId) body.fresh_role_check_job_id = freshRoleCheckJobId;
  return apiFetch(`/dr-failover/${encodeURIComponent(agName)}/execute`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** GET /dr-failover/{AGName}/status/{RunId} — poll a plan/execute run
 *  record. Each call ADVANCES the run's state machine one step if the
 *  underlying job has completed (EXECUTING -> CONFIRMING ->
 *  SUCCESS/NEEDS_MANUAL_CHECK), so just keep polling this until `status`
 *  is one of: SUCCESS, NEEDS_MANUAL_CHECK, EXECUTE_FAILED, PLAN_FAILED. */
export async function fetchDrRunStatus(agName, runId) {
  return apiFetch(`/dr-failover/${encodeURIComponent(agName)}/status/${encodeURIComponent(runId)}`);
}

// ─── Saved DR switchover plans (drafts only) ─────────────────────────────────
// Saving a plan records intent (target, proposed time, change reference).
// Nothing executes it automatically — there is no scheduler behind
// proposed_time. Performing the switchover always goes through the live
// check → readiness → final check → execute flow above.

/** GET /dr-failover/{AGName}/plans → { plans: [...] } (DRAFT only by default) */
export async function fetchDrPlans(agName, { includeClosed = false } = {}) {
  const qs = includeClosed ? '?include_closed=true' : '';
  return apiFetch(`/dr-failover/${encodeURIComponent(agName)}/plans${qs}`);
}

/** POST /dr-failover/{AGName}/plans — { intended_target, proposed_time (ISO), change_reference, notes } */
export async function createDrPlan(agName, plan) {
  return apiFetch(`/dr-failover/${encodeURIComponent(agName)}/plans`, {
    method: 'POST',
    body: JSON.stringify(plan),
  });
}

/** POST /dr-failover/{AGName}/plans/{PlanId} — partial update, or
 *  { status: 'CANCELLED' } / { status: 'EXECUTED', executed_run_id } */
export async function updateDrPlan(agName, planId, changes) {
  return apiFetch(`/dr-failover/${encodeURIComponent(agName)}/plans/${encodeURIComponent(planId)}`, {
    method: 'POST',
    body: JSON.stringify(changes),
  });
}

// ─── Config check ────────────────────────────────────────────────────────────
export function isConfigured() {
  return Boolean(
    API_BASE &&
    process.env.REACT_APP_COGNITO_HOSTED_UI_DOMAIN &&
    process.env.REACT_APP_COGNITO_USER_CLIENT_ID
  );
}