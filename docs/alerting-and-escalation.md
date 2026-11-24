# Security Alerting and Escalation (task 2.5)

This document defines what triggers an alert, who is responsible for it, and
what happens when nobody responds. The implementation lives in
`backend/src/utils/alerting.ts` (rules, routing, escalation),
`backend/src/config/alerting.ts` (thresholds and routes) and
`frontend/src/pages/Monitoring.tsx` (open alerts and acknowledgement).

## 1. What raises an alert

Alerts are derived from the append-only `AuditLog`, so every alert has an
immutable source event. Detection never trusts the client and never reads
request bodies.

| Alert type | Trigger | Severity | Team |
|---|---|---|---|
| `FAILED_LOGIN_BURST` | ≥ `ALERT_FAILED_LOGIN_THRESHOLD` failed sign-ins **or lockouts** for one account inside `ALERT_FAILED_LOGIN_WINDOW_MINUTES` | HIGH | Security |
| `ACCOUNT_LOCKOUT` | `LOGIN_MAX_ATTEMPTS` reached and the account is locked | HIGH | Security |
| `SESSION_TOKEN_REPLAY` | An already-rotated refresh token is replayed (session revoked) | CRITICAL | Security |
| `AUTHORIZATION_DENIAL_BURST` | ≥ `ALERT_AUTHZ_DENIAL_THRESHOLD` `AUTHZ_DENIED` events for one actor inside the window | HIGH | Security |
| `CSRF_REJECTION_BURST` | ≥ `ALERT_CSRF_THRESHOLD` `CSRF_REJECTED` events for one actor inside the window | MEDIUM | Security |
| `PRIVILEGE_ESCALATION` | `ROLE_CHANGE_APPROVED`, or `USER_UPDATED` that changes a role. Promotion to `ADMIN` is CRITICAL, any other role change is HIGH | HIGH / CRITICAL | Security |
| `SENSITIVE_ACCOUNT_CHANGE` | Admin `MFA_RESET_BY_ADMIN` or admin `PASSWORD_RESET` (break-glass account changes) | HIGH | Security |
| `UNUSUAL_DATA_ACCESS` | ≥ `ALERT_DATA_ACCESS_THRESHOLD` `AUDIT_LOGS_VIEWED` events by one administrator inside the window | MEDIUM | Data owners |
| `CONFIGURATION_CHANGED` | The startup configuration fingerprint differs from the previous `CONFIG_LOADED` entry | HIGH | IT operations |
| `SERVICE_FAILURE` | A CRITICAL system event (uncaught exception, listen failure, database unavailable at startup) | CRITICAL | IT operations |

Notes:

- The failed-sign-in counter includes the lockout event itself, so the fifth
  attempt is visible even though it is recorded as `ACCOUNT_LOCKED`.
- Configuration changes are detected by comparing the fingerprint stored in the
  previous `CONFIG_LOADED` audit row with the current one. Secret values are
  never part of the fingerprint.
- "Unusual data access" can only cover reads the application already audits
  (the audit trail is the only sensitive read that is recorded). Extend the rule
  set in `evaluateAuditEvent` as more read paths are audited.
- IP addresses are encrypted at rest, so burst rules count by actor account,
  not source address. Distributed attacks spread across many unknown accounts
  are still visible individually and in the SIEM stream.

## 2. Routing

Every alert is persisted first in `SecurityAlert`, then delivered to the team
that owns it:

| Team | Configuration | Owns |
|---|---|---|
| Security | `ALERT_SECURITY_EMAILS` | Sign-in abuse, token replay, privilege escalation, break-glass changes, denial/CSRF bursts |
| IT operations | `ALERT_OPERATIONS_EMAILS` | Configuration changes and infrastructure-facing alerts |
| Data owners | `ALERT_DATA_EMAILS` | Unusual access to sensitive data |

Delivery channels:

1. **Webhook** — `ALERT_WEBHOOK_URL` receives one JSON document per alert
   (compatible with a Slack/Teams relay, a PagerDuty events adapter, or an
   internal on-call bridge). `ALERT_WEBHOOK_AUTH_HEADER` is sent verbatim as
   `Authorization`.
2. **Email** — sent through the existing SMTP settings (`SMTP_*`). Teams can be
   empty; configure at least one channel per team that has responsibilities.

The notification contains the alert id, severity, title, detail, occurrence
count, owning team, escalation flag and the `ALERT_RUNBOOK_URL` (defaults to the
Security Monitoring page).

If no route is configured the alert is still stored. The dashboard shows
`no recipients or webhook configured`, and the alert remains open.

## 3. Escalation procedure

```
Event → rule fires → SecurityAlert (OPEN) → notify owning team
                              │
                acknowledged within ALERT_ESCALATION_MINUTES?
                     │ yes                      │ no
                     ▼                          ▼
              mark acknowledged          notify ALERT_ESCALATION_EMAILS
              (audited; sweep stops)     once, flag escalatedAt, keep OPEN
```

1. **Tier 1 — owning team.** The team named in the alert receives the webhook
   and/or email immediately. The alert appears in **Security Monitoring →
   Open security alerts**.
2. **Tier 2 — escalation contacts.** If a HIGH or CRITICAL alert is still
   unacknowledged after `ALERT_ESCALATION_MINUTES` (default 15), the sweep
   re-delivers it once to `ALERT_ESCALATION_EMAILS` (security team when unset).
   The sweep runs every `ALERT_ESCALATION_SWEEP_SECONDS` (default 60).
3. **Tier 3 — incident handling.** An escalation contact who confirms a real
   incident follows the runbook below, records findings in the incident log,
   and may force sign-out of affected sessions (admin reset) or disable the
   account.

Acknowledgement is an Admin action
(`POST /monitoring/alerts/:id/acknowledge`). It records who acknowledged the
alert and when, and is itself written to the audit trail
(`SECURITY_ALERT_ACKNOWLEDGED`). Acknowledgement means "someone is handling
this", not "the incident is resolved"; the alert stays in the list for the
record.

## 4. Runbooks

### Failed sign-ins / lockout (`FAILED_LOGIN_BURST`, `ACCOUNT_LOCKOUT`)
1. Open the audit trail filtered by `LOGIN_FAILED` / `ACCOUNT_LOCKED` and the
   account.
2. Contact the account owner out-of-band. If they do not recognise the
   attempts, reset the password (which clears the lock) and review active
   sessions; consider enabling MFA.
3. If the same unknown account is sprayed repeatedly, block the source at the
   edge and keep the SIEM record.

### Refresh-token replay (`SESSION_TOKEN_REPLAY`)
1. Confirm the session was revoked (the alert detail says so).
2. Review `LOGIN_SUCCESS`, `REFRESH_TOKEN_REUSE` and business changes for the
   account in the preceding 24 hours.
3. Reset the password and enable MFA; force sign-out on all devices.

### Privilege escalation (`PRIVILEGE_ESCALATION`)
1. Compare the change with an approved `RoleChangeRequest`; the requester and
   approver must be different administrators.
2. If the change is not backed by an approved request, revert the role and
   disable the involved administrator account.
3. Record the outcome in the audit trail or incident log and rotate credentials
   if the account may be compromised.

### Sensitive account change (`SENSITIVE_ACCOUNT_CHANGE`)
1. Verify the request came from the account owner.
2. Review the account's sessions and recent business activity.
3. If unrequested, disable the account, revoke sessions, and reset MFA again
   only after identity verification.

### Unusual data access (`UNUSUAL_DATA_ACCESS`)
1. Confirm the administrator is running an approved investigation.
2. If not, disable the account and preserve the audit trail / SIEM copy.
3. Review what was read and whether it left the organisation.

### Configuration change (`CONFIGURATION_CHANGED`)
1. Open the latest `CONFIG_LOADED` audit entry and compare the fingerprint with
   the change record/ticket.
2. Check alert thresholds and routing were not weakened (`ALERTING_ENABLED`,
   recipient lists, SIEM URL).
3. Revert and redeploy if the change is unauthorised; rotation of any exposed
   secret is mandatory.

## 5. Tuning and limitations

- Defaults are deliberately conservative for a small deployment. Lower
  `ALERT_FAILED_LOGIN_THRESHOLD` to 3 for internet-facing admin accounts, or
  raise it where shared IPs cause noise.
- `ALERT_COOLDOWN_MINUTES` (default 30) folds repeats of the same condition into
  one **open** alert and increments `occurrences`; the team is not paged again
  for every retry. Once an alert is acknowledged, a further occurrence raises a
  new alert and pages the owning team again.
- Email delivery is only as reliable as SMTP. The webhook is the preferred
  on-call path; both fail independently and failures are stored in
  `notificationError` and shown on the dashboard.
- Alerts are not append-only (they need acknowledgement state), but the source
  events are. Deleting an alert row does not hide the underlying audited action.
- There is no automatic SLA clock or paging-provider acknowledgement sync; the
  escalation is time-based on the application side.
