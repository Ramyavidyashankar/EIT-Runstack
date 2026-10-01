# Execution Details — per-server status and running script output

This document covers the **Execution Details** view (UI: `/jobs/:jobId`) and
the backend, workflow, IAM and SSM changes behind it. It applies to ITG and
PROD; the only difference between the two is the central account ID
(ITG `246314649749`, PROD `693426599691`).

---

## 1. In plain English

**What it does.** Clicking an execution on *Automation Executions* opens a
Rundeck-style page: a searchable list of servers on the left, and the
selected server's output on the right, with Output / Steps / Details tabs.
While the run is active the page refreshes status about every 5 seconds and
output about every 10 seconds.

**Where the data comes from.** RunStack already records one job per target
in `runstack-jobs-table`. The new page asks the backend for that job (or its
whole bulk run), and the backend reads the live status from Systems Manager
and the script output from CloudWatch Logs **in the target account and
region**, using the existing `runstack-cross-account-role`.

**Example.** Ramya starts a SQL health check sweep over 40 servers →
RunStack creates 40 jobs, all stamped with the same `execution_group_id` →
she opens any one of them → the page shows all 40 servers, 12 running, 25
succeeded, 3 timed out → she clicks `ITG-SQL-07` and watches its output
arrive every ~30 seconds.

**What "live" means here.** The SSM Agent uploads output to CloudWatch in
batches (typically about every 30 seconds), and scripts that buffer their
own output add more delay. It is near-live, not a keystroke terminal.

---

## 2. What changed

### 2.1 Backend (`src/process_messages`)

| File | Change |
|---|---|
| `execution_details.py` (new) | `GET /jobs/{jobId}/execution` and `GET /jobs/{jobId}/logs` |
| `app.py` | Routes the two paths **before** the bare `{jobId}` branch |
| `shared.py` | `transform_message_data` keeps `initiated_by`, `execution_group_id`, `execution_group_label`; `normalize_runcommand_data` adds `CloudWatchOutputConfig` to same-region Run Command jobs; new `job_initiator()` / `stamp_job_origin()` |
| `notify.py`, `ec2_sync.py` | Record `initiated_by` from the verified token; drop any origin/group fields the caller sent |
| `healthcheck.py` | Batch sweep stamps one `execution_group_id` per sweep (response also returns it — additive) |
| `src/scheduler/app.py` | One `execution_group_id` per scheduled run; `initiated_by = schedule:<rule>` |
| `src/step_function/workflow.asl.json` | Four `RecordDispatch*` states write `ssm_dispatch` right after each SSM dispatch |

### 2.2 New job attributes (additive, `runstack-jobs-table`)

| Attribute | Written by | Purpose |
|---|---|---|
| `ssm_dispatch` | Workflow (`RecordDispatch*`), or the API from Step Functions history for older jobs | `kind`, `command_id` or `automation_execution_id`, `dispatch_account`, `dispatch_region` |
| `execution_tracking` | API | Resolved child execution, command IDs and plugins per target |
| `exec_outcome` | API, once a job is finished | Detailed per-target outcome (e.g. `timed_out` / `DeliveryTimedOut`) so finished jobs need no further SSM calls |
| `initiated_by` | `/notify`, `/notify-sync`, batch health check, scheduler | Shown as "Initiated by"; also lets the person who started a job view it |
| `execution_group_id`, `execution_group_label` | Scheduler, batch health check | Explicit bulk-run grouping (never inferred from names or times) |

New GSI: **`execution-group-index`** (hash `execution_group_id`, range
`created_at`, INCLUDE projection). It is sparse — only grouped jobs appear.

### 2.3 API

Both routes: `GET`, Cognito authorizer, scope `runstack-api/notify`, same
Lambda (covered by the existing wildcard Lambda permission).

`GET /jobs/{jobId}/execution?limit=&cursor=&q=&status=&target=`
returns `execution` (header), `counts` (pending, running, success, failed,
cancelled, timed_out, total, finished, unsuccessful), a page of `targets`,
paging cursors, `hidden_jobs`, `retrieval_errors`, `poll` hints and — with
`target=<key>` — `selected` (target, steps, plugins, details, notes).

`GET /jobs/{jobId}/logs?target=<key>&cursor=&direction=forward|backward`
returns `status` (`ok`, `waiting`, `not_configured`, `no_logs`,
`no_output`, `unavailable`), `events` (`ts`, `stream`, `plugin`, `message`),
`next_cursor` (new output), `older_cursor` (older output), `more`.
`429` + `Retry-After` when AWS throttles.

### 2.4 UI (`runstack-ui-latest`)

`pages/ExecutionDetails.jsx`, `components/execution/*`,
`hooks/usePolling.js`, `utils/executionLogs.js` (+ tests),
`api/client.js` (`fetchExecution`, `fetchExecutionLogs`), `App.jsx` route,
`Jobs.jsx` row click. The old `?job=` side panel still opens for existing
links.

---

## 3. Security model

- **Nothing that decides where RunStack reads comes from the browser.** The
  browser sends a job ID and a target key (`<job_id>~<instance_id>`). The
  backend checks both against the jobs table; account, region, execution
  IDs, command IDs, log group and log stream names are all derived from
  the job record and SSM's own responses. A dispatch location that does not
  match the job is refused. Log cursors are only honoured for streams the
  backend derived itself.
- **Access is checked before any AWS read.** A caller may view a job if
  they are: admin; the person who started it (`initiated_by`); allowed by
  the team capability that governs the document (SQL health check →
  `gdba-sql/sql-db-healthcheck`, DR documents → `gdba-sql/sql-dr-failover`;
  admin/operator bypass exactly as for running them); or granted the
  target instance through `runstack-app-access` → `runstack-instance-catalog`.
  In a bulk run, servers the caller can't see are left out and counted as
  "hidden". Not visible and not found return the same 404.
- **Viewing does not stamp `runstack-app-access.last_used_at`** — that
  marks real actions only.
- **Decision to confirm:** operators are *not* given a blanket bypass for
  non-team documents (same as `validate_instance_access`, where only admin
  bypasses). An operator needs an app-access grant (or `ALL`) to view
  EC2/generic runs here.

---

## 4. IAM

### 4.1 Central account — `runstack-process-messages` role (in `template.yaml`)

```yaml
- Sid: RunStackExecutionDetailsSsmRead          # Automation parents in the central account
  Action: [ssm:GetAutomationExecution, ssm:DescribeAutomationExecutions,
           ssm:DescribeAutomationStepExecutions, ssm:ListCommandInvocations]
  Resource: '*'
- Sid: RunStackExecutionDetailsWorkflowHistory  # fallback for jobs dispatched before the workflow change
  Action: states:GetExecutionHistory
  Resource: arn:aws:states:${Region}:${AccountId}:execution:${pSolutionName}-workflow:*
- Sid: RunStackExecutionDetailsOwnAccountLogs
  Action: [logs:DescribeLogStreams, logs:GetLogEvents]
  Resource: arn:aws:logs:*:${AccountId}:log-group:/aws/ssm/runstack(:*)
```

`sts:AssumeRole` on `*/runstack-cross-account-role` already exists
(`RunStackCrossAccountAssess`). The workflow role already has
`dynamodb:UpdateItem` on the jobs table — no change.

### 4.2 Every target account — `runstack-cross-account-role` (CloudOps)

Add to the role's policy (`create-role.sh` updated):

```json
{
  "Sid": "RunStackExecutionDetailsLogsRead",
  "Effect": "Allow",
  "Action": ["logs:DescribeLogStreams", "logs:GetLogEvents"],
  "Resource": [
    "arn:aws:logs:*:<TARGET_ACCOUNT>:log-group:/aws/ssm/runstack",
    "arn:aws:logs:*:<TARGET_ACCOUNT>:log-group:/aws/ssm/runstack:*"
  ]
}
```

The existing `ssm:Get*`, `ssm:List*`, `ssm:Describe*` already cover the
status reads.

**Trust policy check.** `create-role.sh` makes the role trust only
`runstack-workflow-role`, but `process_messages` (health checks, DR, and now
Execution Details) assumes it **directly**. That works today in the
accounts you use, so the deployed trust is broader than the script. Confirm
the trust includes the `runstack-process-messages` Lambda role in every
target account that should show live status; where it doesn't, the page
still works and shows "status from RunStack's record (permission)".

### 4.3 Managed nodes (instance profile) — needed for running output

The SSM Agent writes the output, so the **instance profile** of every server
needs CloudWatch Logs write access to the group (AmazonSSMManagedInstanceCore
alone does not include it):

```json
{
  "Effect": "Allow",
  "Action": ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams", "logs:DescribeLogGroups"],
  "Resource": "arn:aws:logs:*:<TARGET_ACCOUNT>:log-group:/aws/ssm/runstack:*"
}
```

Add `logs:CreateLogGroup` too **only** if you don't pre-create the group.
Recommended: pre-create `/aws/ssm/runstack` in each target account and
region (us-east-1 and us-west-2) with a retention period, e.g.
`aws logs create-log-group --log-group-name /aws/ssm/runstack --region us-west-2`
then `aws logs put-retention-policy --log-group-name /aws/ssm/runstack --retention-in-days 30`.
Nodes without network access to CloudWatch Logs (no internet/NAT and no
`logs` VPC endpoint) cannot upload output.

If a node can't write logs, **the command still runs and succeeds**; only
the live output is missing, and the page says so.

---

## 5. SSM logging configuration

| Execution path | Running output | What's needed |
|---|---|---|
| Run Command, us-east-1 | Yes, once enabled | **Off by default** (`SSM_CLOUDWATCH_OUTPUT_ENABLED=false`), so scheduled and production commands are sent exactly as before. When set to `true` (after the logs IAM is in place), `normalize_runcommand_data` adds `CloudWatchOutputConfig` (group `SSM_OUTPUT_LOG_GROUP`, default `/aws/ssm/runstack`) unless the caller set one. |
| Run Command, us-west-2 (via `RunStack-Generic-RunCommand-Wrapper`) | Only after the wrapper change | The wrapper document is **not in the repo**. Its `aws:runCommand` step must pass `CloudWatchOutputConfig` (below). Until then: status and steps work; output shows the SSM final preview only. |
| Automation with `aws:runCommand` steps | Only after the document change | Each `aws:runCommand` step needs `CloudWatchOutputConfig` (below). |
| Automation steps that aren't commands (`aws:changeInstanceState`, `aws:executeAwsApi`, …) | No — nothing runs on the server | Steps tab shows status, timing, failure message and outputs (sensitive keys masked). |
| EC2 status check (`EC2-Action`) | No | Calls the EC2 API directly; shown as such. |

Add to every `aws:runCommand` step (wrapper and Automation documents), in
**each region the document exists in** (documents are regional):

```yaml
- name: runCommand
  action: aws:runCommand
  inputs:
    DocumentName: '{{ TargetDocumentName }}'
    InstanceIds: ['{{ InstanceId }}']
    Parameters: '{{ CommandParameters }}'
    CloudWatchOutputConfig:
      CloudWatchOutputEnabled: true
      CloudWatchLogGroupName: /aws/ssm/runstack
```

Stream naming (for troubleshooting):
`/aws/ssm/runstack` → `<CommandId>/<InstanceId>/<step-or-plugin>/stdout|stderr`.
The backend lists streams by the `<CommandId>/<InstanceId>/` prefix, so
plugin names never need to be guessed. A missing `stderr` (or `stdout`)
stream is normal.

`GetCommandInvocation.StandardOutputContent` is **not** used for running
output (it is truncated at 24,000 characters and only reliable at the end).
When CloudWatch output is off, the page shows SSM's final preview (first
2,500 characters per step) after the command finishes, labelled as such.

---

## 5a. Deploying with no IAM changes

Everything below works with permissions RunStack already has:

| Works now | Why no IAM change is needed |
|---|---|
| Per-server status, counts, Steps, Details (same- and cross-region) | Reads go through `runstack-cross-account-role` (already `ssm:Get*/List*/Describe*`) in every account, including the central one; the Lambda's own role is only a fallback in its own account |
| Why a job failed before SSM started | The workflow's `RecordRunCommandDispatchError` / `RecordAutomationDispatchError` states save `dispatch_error` on the job (workflow role already has `dynamodb:UpdateItem`). The whole Catch output is stored as one JSON string (`States.JsonToString($.error)`), never `$.error.Cause` directly: a missing field there would be an uncatchable `States.Runtime` error and stop the execution before the job is marked FAILED. |
| Complete output after a command finishes (up to 24,000 characters per step) | `ssm:GetCommandInvocation` via the same role; shown as "Final output (not live)" whenever CloudWatch output is off, empty or unreadable |
| Initiated by, bulk-run grouping | DynamoDB only (the Lambda already has CRUD on `runstack-*` tables and their indexes) |

Needs IAM later (the page says so rather than failing):
- **Live output while running** — `logs:DescribeLogStreams`/`logs:GetLogEvents` on the target role, and CloudWatch Logs write on the servers' instance profiles.
- **SSM IDs / failure reasons for jobs that ran before the workflow update** — `WORKFLOW_ARN` plus `states:GetExecutionHistory`. Leave `WORKFLOW_ARN` **unset** until that permission exists; with it set but not permitted, older jobs show a permission warning.

## 6. Deployment (manual / console, ITG first)

1. **Target accounts (CloudOps):** add the logs-read statement (4.2) to
   `runstack-cross-account-role`; confirm its trust (4.2); add the instance
   profile permissions (4.3); pre-create `/aws/ssm/runstack` in us-east-1
   and us-west-2 with retention.
2. **Jobs table:** create GSI `execution-group-index` (hash
   `execution_group_id` S, range `created_at` S, projection INCLUDE:
   status, resource_id, server_name, account_id, region, updated_at,
   automation_type, exec_outcome, initiated_by, notification_id, app_id,
   environment). Wait for it to become ACTIVE. Until it exists, the page
   shows the single job and says the index is missing.
3. **process_messages:** deploy the code; add the IAM statements (4.1); set
   env vars: `WORKFLOW_ARN` (state machine ARN), `EXECUTION_GROUP_INDEX=execution-group-index`,
   `RUNSTACK_EXECUTION_REGIONS=us-east-1,us-west-2`,
   `RUNSTACK_CENTRAL_ACCOUNT_ID=<ITG 246314649749 | PROD 693426599691>`,
   `SSM_OUTPUT_LOG_GROUP=/aws/ssm/runstack`, `SSM_CLOUDWATCH_OUTPUT_ENABLED=false` (set `true` only after the logs IAM is in place)
   (set `false` to deploy the view without turning output on).
4. **Scheduler Lambda:** deploy `src/scheduler/app.py`.
5. **Step Functions:** update the definition from
   `src/step_function/workflow.asl.json` for that environment (ITG and PROD
   files differ only in the central account ID).
6. **API Gateway:** add `/jobs/{jobId}/execution` and `/jobs/{jobId}/logs`
   (GET with the Cognito authorizer and `runstack-api/notify` scope, plus
   OPTIONS for CORS, as in `template.yaml`), then **Deploy API** to the
   stage — new routes aren't live until the stage is redeployed.
7. **SSM documents:** add `CloudWatchOutputConfig` to the Run Command
   wrapper and any Automation `aws:runCommand` steps (section 5).
8. **UI:** build and deploy `runstack-ui-latest` as usual.

Rollback: steps 3–8 are independent. Reverting the UI hides the page; the
new attributes and GSI are additive and harmless if unused; the workflow's
`RecordDispatch*` states can be removed without affecting execution.

---

## 7. Behaviour details

- **Progress** counts every finished target (success, failed, cancelled,
  timed out) — "finished" and "successful" are shown separately.
- **Retrieval vs execution failure.** If RunStack can't read SSM (permission,
  throttling), the target keeps RunStack's own status and is flagged with a
  warning — it never turns red because of a read error. The same applies to
  logs (`status: unavailable`).
- **Polling.** Status ~5 s and output ~10 s while visible and active; no
  overlapping requests; exponential back-off on errors (longer for
  throttling); requests cancelled on navigation; paused in hidden tabs and
  refreshed on return. After a server finishes, output polling continues
  for 90 s to catch the final batch, then stops (Refresh still works).
  "Pause updates" never pauses the automation.
- **Scale.** Finished jobs are served from `exec_outcome`; live SSM reads
  are capped per request (`EXEC_MAX_LIVE_PER_REQUEST`, default 25, active
  jobs first); servers are paged (100) and virtualised in the list; the
  console keeps at most 5,000 lines per server and 5 servers' buffers.
  "Download" fetches the full log when nothing was trimmed.

---

## 8. Found while implementing (implementation vs documentation)

- `execution_id` on a job is the **Step Functions** execution name (= job
  ID), not an SSM ID — the old detail panel's hint "SSM execution / command
  ID in the target account" is wrong.
- Run Command jobs can list several `InstanceIds`, but the workflow only
  monitors `resource_id`; the job's status reflects that one instance. The
  new page shows every instance's own status.
- `GET /jobs/{jobId}` (existing, used by AQS agents) returns script output
  **without an authorization check**. Not changed here; worth gating.
- `/jobs/query` and the `list-month-created-index` GSI exist in the running
  system but not in `template.yaml` (manual deployment drift).
- The scheduler always uses its own region for scheduled jobs, so
  us-west-2 servers in a schedule CSV run with region us-east-1.
- The workflow's retry counter starts at 1 and retries while `< 1`, so SSM
  dispatch is never retried.
- `create-role.sh` trust vs direct assumption by `process_messages` (4.2).

---

## 9. Tests

Backend: `cd RunStack-ITG-V3 && python -m pytest tests -q` (moto + fakes;
no AWS access needed). UI: `CI=true npx react-scripts test --watchAll=false`.

| Scenario | Covered by |
|---|---|
| Single server, running, incremental output, load older | `test_single_server_running_with_incremental_logs`, `test_load_older_output_uses_backward_cursor` |
| Bulk run: explicit group, counts, paging, search, filter, partial | `test_bulk_group_counts_and_paging`, `test_group_finished_with_failures_is_partial` |
| Cross-account + cross-region (TargetLocations wrapper) | `test_cross_region_run_command_wrapper` |
| Automation steps with/without console output | `test_automation_steps_distinguish_running_output` |
| Failure, timeouts (execution/delivery), cancelled, undeliverable | `test_detailed_outcomes` |
| Delayed logs / missing stream / no logs | `test_waiting_for_output_and_no_logs_after_finish`, `test_cloudwatch_not_enabled_shows_final_preview_only` |
| Read errors are not failures; throttling → 429 | `test_permission_error_keeps_runstack_status`, `test_throttled_logs_return_429` |
| Unauthorized, app access, initiator, team capability, hidden group members | `test_unauthorized_user_gets_404_and_no_aws_calls`, `test_app_access_user_and_initiator_can_view`, `test_team_capability_allows_viewing_team_documents`, `test_group_hides_members_user_cannot_see` |
| Browser can't redirect reads (target, instance, cursor, tampered dispatch) | `test_browser_cannot_redirect_reads` |
| Pre-change jobs (Step Functions history) | `test_dispatch_from_step_functions_history_is_persisted` |
| Creation-side changes | `test_cloudwatch_output_added_only_for_same_region_commands`, `test_notify_cannot_spoof_initiator_or_group`, `test_router_sends_new_paths_to_execution_details` |

Manual ITG checks after deployment:

1. Run `AWS-RunShellScript` on one us-east-1 server with
   `for i in $(seq 1 12); do echo line $i; sleep 10; done` → output appears in
   ~30 s batches; Pause stops refreshing but the script finishes.
2. Same on a us-west-2 server (after the wrapper change) → Details shows the
   child execution in the target account/region.
3. Batch health check → one page with all servers; counts add up.
4. `sleep 600` with the document's `executionTimeout` parameter set to 60 → "Timed out · ExecutionTimedOut".
5. Stop the SSM Agent on a test node → "Timed out · DeliveryTimedOut".
6. Remove the logs statement from one target role → status still shown,
   output says "temporarily unavailable (permission)".
7. As a user without app access to the server → "Execution not found".

---

## 10. Automation name filter (Automation Executions)

A second filter, **Automation name**, lists the names jobs were submitted
with (`automation_name`, or `automation_data.automation_name` for older
scheduled jobs) with all-time counts. The existing **Automation** filter
(by SSM document) is unchanged.

How it works: `job_stats` writes a normalised `automation_name_key` on each
job and counts it under a `FACET` / `name#<name>` counter; `/jobs/query`
accepts `name=` and filters on `automation_name_key`.

Deploy: `src/job_stats/app.py` (job_stats Lambda), `src/process_messages/jobs.py`
and `jobs_list.py` (process_messages Lambda), the UI, then run once:

```bash
aws lambda invoke --function-name <job-stats function> \
  --payload '{"action": "backfill_names"}' --cli-binary-format raw-in-base64-out out.json && cat out.json
```

It is idempotent; if it returns `"done": false`, invoke again with the
returned `start_key`. Requires `list-month-created-index` to project
`automation_name_key` (it does if its projection is ALL).
