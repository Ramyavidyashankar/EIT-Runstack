# RunStack SAP Agent Reference — Run Email

Use this when a `sap_stop` or `sap_start` run has finished (status SUCCEEDED, FAILED or CANCELLED). Send **one combined email per run** covering every SAP component of the SID. Fill it only from the run's data (`GET /jobs/{jobId}` / `run_status`): never estimate or invent values. Use "Not available" for anything missing.

## How to send

- Outlook connector, **Shared Mailbox Service-to-Service** integration, action `SendUserEmail`.
- Set `runstack-notifications@dxc.com` as the **target user / mailbox / user ID parameter** (whatever that parameter is called). Never send from the signed-in user's own mailbox or a personal connection.
- To: `ramyav@dxc.com; kiran.sharma@dxc.com`
- CC: the signed-in user.
- Body type: HTML.
- Send once per run. If the user types "status" again after the email was sent, do not send it again.
- If sending fails, show the real error in chat; never claim the email was sent.

## Subject

| Run result | Banner colour | Subject |
|---|---|---|
| Stop SUCCEEDED | `#1C7C54` | `[RunStack] SAP Stop Completed — <SID> (<n> components stopped)` |
| Start SUCCEEDED | `#1C7C54` | `[RunStack] SAP Start Completed — <SID> (<n> components started)` |
| FAILED | `#B42318` | `[RunStack] ACTION REQUIRED: SAP <Stop/Start> Failed — <SID> — <failed component>` |
| CANCELLED | `#B26B00` | `[RunStack] SAP <Stop/Start> Cancelled — <SID>` |

## Banner text

- SUCCEEDED: `SAP <STOP/START> COMPLETED` and below it `<SID> · All <n> components <stopped/started> and verified`
- FAILED: `SAP <STOP/START> FAILED` and below it `<SID> · Failed at <component>: <step message>`
- CANCELLED: `SAP <STOP/START> CANCELLED` and below it `<SID> · <x> of <n> components completed before cancel`

## Summary sentence (one line under the banner)

- Stop SUCCEEDED: "All SAP components of <SID> were stopped in order and each was verified before the next. EC2 servers are still running."
- Start SUCCEEDED: "All EC2 servers were confirmed running, then all SAP components of <SID> were started in order and each was verified before the next."
- FAILED: "The run stopped at <component>. Later components were not run, and nothing was rolled back. Please check with the SAP Basis team."
- CANCELLED: "The run was cancelled by <user>. The step in progress finished; later steps were not run. Nothing was rolled back."

## Run details table (rows in this order, all required)

| Label | Value |
|---|---|
| SAP System (SID) | `sid` |
| Action | SAP Stop / SAP Start |
| Result | SUCCEEDED / FAILED / CANCELLED |
| Initiated by | `initiated_by` |
| Started | `started_at`, in the user's time zone (e.g. 13-Oct-2026 18:35:43 IST) |
| Finished | `finished_at`, same format |
| Elapsed | finished minus started, mm:ss, never estimated |
| Components | e.g. "4 of 4 stopped" / "2 of 4 started" |
| Failed step | component and its message, or "None" |
| RunStack run ID | `job_id` (sap-run-…) |

## Components table (one row per SAP component, in run order)

Columns: **Order | Component | Server | Result | Verified state / detail | Finished**

- Result: ✅ Succeeded, ❌ Failed, ➖ Skipped (use the text, not only the icon).
- Verified state / detail: the step's `message` (e.g. "STOPPED — D00: 0/2 processes GREEN (confirmed by the stop script)", "STOPPED — DB STOPPED, Listener STOPPED, OEM blackout STARTED").
- Finished: the step's `finished_at` in the user's time zone, or "—" for skipped steps.
- Leave out the `EC2 check` rows unless one of them failed (then include it, as order 0).

## HTML template

Outlook ignores inherited fonts: put `font-family:Segoe UI,Arial,sans-serif` on **every** table, td, span and a. Keep this structure; repeat row elements as needed.

```html
<!--[if mso]><style>table,td,div,span,a{font-family:Segoe UI,Arial,sans-serif!important}</style><![endif]-->
<table width="720" cellpadding="0" cellspacing="0" style="font-family:Segoe UI,Arial,sans-serif;border:1px solid #DDE1E6">
<tr><td style="font-family:Segoe UI,Arial,sans-serif;background:#0F3557;color:#ffffff;padding:16px 24px;font-size:17px;font-weight:600">EIT RunStack | SAP Operation Notification</td></tr>
<tr><td style="font-family:Segoe UI,Arial,sans-serif;background:{BANNER_COLOUR};color:#ffffff;padding:12px 24px;font-size:15px;font-weight:700">{BANNER_TITLE}<br><span style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;font-weight:400">{BANNER_SUBTITLE}</span></td></tr>
<tr><td style="font-family:Segoe UI,Arial,sans-serif;padding:16px 24px;font-size:14px;color:#1F2933">{SUMMARY_SENTENCE}</td></tr>

<tr><td style="font-family:Segoe UI,Arial,sans-serif;padding:0 24px 4px;font-size:14px;font-weight:600;color:#0F3557">Run details</td></tr>
<tr><td style="font-family:Segoe UI,Arial,sans-serif;padding:0 24px 16px">
<table width="100%" cellpadding="6" cellspacing="0" style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;border:1px solid #DDE1E6">
<!-- one row per run detail -->
<tr><td style="font-family:Segoe UI,Arial,sans-serif;color:#616E7C;width:200px;border-bottom:1px solid #EEF1F4">{Label}</td><td style="font-family:Segoe UI,Arial,sans-serif;border-bottom:1px solid #EEF1F4">{Value}</td></tr>
</table></td></tr>

<tr><td style="font-family:Segoe UI,Arial,sans-serif;padding:0 24px 4px;font-size:14px;font-weight:600;color:#0F3557">Components</td></tr>
<tr><td style="font-family:Segoe UI,Arial,sans-serif;padding:0 24px 16px">
<table width="100%" cellpadding="6" cellspacing="0" style="font-family:Segoe UI,Arial,sans-serif;font-size:13px;border:1px solid #DDE1E6">
<tr style="background:#F5F7FA">
<td style="font-family:Segoe UI,Arial,sans-serif;font-weight:600;border-bottom:1px solid #DDE1E6">Order</td>
<td style="font-family:Segoe UI,Arial,sans-serif;font-weight:600;border-bottom:1px solid #DDE1E6">Component</td>
<td style="font-family:Segoe UI,Arial,sans-serif;font-weight:600;border-bottom:1px solid #DDE1E6">Server</td>
<td style="font-family:Segoe UI,Arial,sans-serif;font-weight:600;border-bottom:1px solid #DDE1E6">Result</td>
<td style="font-family:Segoe UI,Arial,sans-serif;font-weight:600;border-bottom:1px solid #DDE1E6">Verified state / detail</td>
<td style="font-family:Segoe UI,Arial,sans-serif;font-weight:600;border-bottom:1px solid #DDE1E6">Finished</td>
</tr>
<!-- one row per component; Result colour: #1C7C54 succeeded, #B42318 failed, #616E7C skipped -->
<tr>
<td style="font-family:Segoe UI,Arial,sans-serif;border-bottom:1px solid #EEF1F4">{Order}</td>
<td style="font-family:Segoe UI,Arial,sans-serif;border-bottom:1px solid #EEF1F4">{Component}</td>
<td style="font-family:Segoe UI,Arial,sans-serif;border-bottom:1px solid #EEF1F4">{Server}</td>
<td style="font-family:Segoe UI,Arial,sans-serif;border-bottom:1px solid #EEF1F4;color:{RESULT_COLOUR};font-weight:600">{Result}</td>
<td style="font-family:Segoe UI,Arial,sans-serif;border-bottom:1px solid #EEF1F4">{Detail}</td>
<td style="font-family:Segoe UI,Arial,sans-serif;border-bottom:1px solid #EEF1F4">{Finished}</td>
</tr>
</table></td></tr>

<tr><td style="font-family:Segoe UI,Arial,sans-serif;padding:12px 24px;font-size:12px;color:#616E7C">Automated notification from EIT RunStack. Questions: eit-ai-ops-runstack@dxc.com</td></tr>
</table>
```

## Example (stop succeeded)

Subject: `[RunStack] SAP Stop Completed — G1D (4 components stopped)`

Run details: G1D · SAP Stop · SUCCEEDED · ramyav@dxc.com · Started 13-Oct-2026 18:35:43 IST · Finished 13-Oct-2026 18:41:04 IST · Elapsed 05:21 · 4 of 4 stopped · Failed step: None · sap-run-…

| Order | Component | Server | Result | Verified state / detail | Finished |
|---|---|---|---|---|---|
| 1 | AAS | c40t300264 | Succeeded | STOPPED — D00: 0/2 processes GREEN (confirmed by the stop script) | 18:36:31 IST |
| 2 | PAS | c40t300263 | Succeeded | STOPPED — D00: 0/2 processes GREEN (confirmed by the stop script) | 18:38:37 IST |
| 3 | ASCS | c40t300265 | Succeeded | STOPPED — ASCS01: 0/3 processes GREEN (confirmed by the stop script) | 18:39:24 IST |
| 4 | DB | c40t300262 | Succeeded | STOPPED — DB STOPPED, Listener STOPPED, OEM blackout STARTED (confirmed by the stop script) | 18:41:04 IST |
