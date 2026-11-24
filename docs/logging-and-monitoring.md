# Centralized Logging, Retention and Monitoring

This document defines how the ERP/CRM portal collects, ships, retains and monitors
security-relevant logs (control 2.4). It is the policy an operator follows; the
implementation lives in `backend/src/utils/logger.ts`, `logShipper.ts`,
`retention.ts` and `backend/src/controllers/monitoring.controller.ts`.

## 1. What is logged, and where

| Signal | Written to | Contains |
|---|---|---|
| Security audit trail (`AuditLog`) | PostgreSQL, encrypted free-text fields, HMAC hash chain | who (id/email/role), what (action/entity), when, IP, user agent, method/path, severity, success |
| Structured application log | stdout always; daily JSONL files when `LOG_TO_FILE=true`; central collector when `SIEM_URL` is set | every request (method/path/status/duration/actor), rate-limit trips, 5xx, startup/shutdown, config fingerprint, retention sweeps |
| Central collector (SIEM) | External system chosen by the operator | the same structured records, batched over HTTPS |

Every record is one JSON object. Credentials, tokens, cookies, captcha responses
and API keys are redacted by the logger before the record reaches **any** sink,
including the SIEM. Query-string secrets are replaced with `[redacted]`.

The audit table remains the authoritative, tamper-evident record. The log stream
is the high-volume operational view (including events deliberately kept out of
the database so a throttle flood cannot become a write flood).

## 2. Central delivery (SIEM)

Set:

```dotenv
SIEM_URL="https://siem.example.com/ingest/logs"
SIEM_AUTH_HEADER="Bearer <ingest-token>"   # or "Splunk <HEC-token>"
SIEM_SOURCE="mini-erp-crm"
```

The shipper POSTs batches of up to `SIEM_BATCH_SIZE` events every
`SIEM_FLUSH_SECONDS`, or immediately when a batch fills:

```json
{
  "source": "mini-erp-crm",
  "environment": "production",
  "host": "api-1",
  "sentAt": "2026-11-23T12:00:00.000Z",
  "events": [
    { "ts": "2026-11-23T11:59:58.001Z", "level": "info", "event": "HTTP_REQUEST", "method": "GET", "path": "/customers", "status": 200, "durationMs": 12.4 }
  ]
}
```

Any HTTP JSON ingest accepts this shape: Vector (`http` source), Fluent Bit
(`http` input), Logstash (`http` input), a small adapter in front of Splunk HEC,
or a cloud ingest function. For Splunk HEC, use an adapter that maps `events[]`
to one HEC `{"event": ...}` object per line; the `SIEM_AUTH_HEADER` value is sent
verbatim as `Authorization`, so `Splunk <token>` works there.

Delivery is best-effort by design:

- a request never waits for the collector;
- a failed batch is retried with exponential backoff (1s → 30s);
- the queue is capped at `SIEM_MAX_BUFFER`; the oldest records are dropped first
  and counted (`dropped`) so a long outage cannot exhaust memory;
- queue depth, shipped/failed/dropped counters, last delivery time and last error
  are shown on **Security Monitoring → Central log pipeline**;
- shutdown waits up to 2 seconds to drain the queue.

If `SIEM_URL` is empty the API still logs to stdout/file, and the monitoring page
raises "Central log shipping is not configured".

## 3. Retention policy

| Store | Default | Enforcement |
|---|---|---|
| Local application log files (`app-YYYY-MM-DD.log`) | **30 days** (`APP_LOG_RETENTION_DAYS`) | Automatic sweep deletes files older than the window |
| Central collector copy | **90 days** (`SIEM_RETENTION_DAYS`, also set on the collector) | Collector-side retention/index lifecycle |
| Security audit trail | **365 days** (`AUDIT_LOG_RETENTION_DAYS`) | **Never deleted by the application**; archived by an operator |
| Session / MFA challenge rows | existing session/MFA lifetimes | Independent of this policy |

The sweep runs at startup and every `RETENTION_SWEEP_HOURS` (default 24h), and is
available as a one-shot job for cron or a scheduled task:

```bash
cd backend
npm run retention:sweep
```

### Why the audit trail is not auto-deleted

The audit table rejects `UPDATE` and `DELETE` at the database level and each row
is HMAC-linked to its predecessor. Deleting the oldest rows breaks the chain and
destroys the evidence a retention policy is meant to preserve. Therefore:

1. When rows pass `AUDIT_LOG_RETENTION_DAYS`, the dashboard reports
   **"Past retention window"** and raises an archival alert.
2. The operator takes an encrypted archive, for example:

   ```bash
   pg_dump "$DATABASE_URL" --data-only --table='"AuditLog"' \
     | gpg --encrypt --recipient security@example.com \
     > "audit-archive-$(date +%F).sql.gpg"
   ```

   Store it in access-controlled, versioned/WORM storage for the period your
   legal/regulatory requirement demands.
3. Keep the archive verifiable: run `npm run audit:verify` before archiving and
   store its output (chain head + entry count) with the archive.
4. Do **not** prune audit rows merely to save space. If law requires deletion or
   minimisation, treat it as a documented break-glass procedure approved by the
   data owner, record the approval, and re-anchor the chain afterwards — never as
   routine maintenance.

Retention windows must be reviewed with legal/regulatory input. Keep audit
retention at least as long as the longest applicable requirement (default one
year); shorten only where data-minimisation rules require it and the evidence has
been archived.

## 4. Monitoring and review

**Security Monitoring** (`/monitoring`, Admin only) is the built-in dashboard. It
shows, for a 7/14/30/90-day window:

- total audit events, failures, failed sign-ins, lockouts, denied requests and
  critical events;
- a per-day bar chart (blue = activity, amber = failures, red = a critical event);
- most frequent actions and accounts with the most failed attempts;
- recent `WARN`/`CRITICAL` entries with decrypted detail (Admin only);
- central-pipeline health and the retention/archival state.

It does not replace the SIEM. Dashboards there should cover:

- failed sign-ins and lockouts per IP/account, compared with the same hour last
  week (credential-stuffing pattern);
- `AUTHZ_DENIED`, `CSRF_REJECTED`, `REFRESH_TOKEN_REUSE`, `RATE_LIMIT_EXCEEDED`
  and `SERVICE_FAILURE` spikes;
- 5xx error rate and response-time percentiles per endpoint;
- absence of logs from the API for more than a few minutes (collector silence is
  itself an alert);
- audit chain verification failures (`npm run audit:verify` in cron, exit code 1).

Suggested escalation thresholds (tune to traffic):

| Condition | Response |
|---|---|
| ≥ 10 failed sign-ins for one account in 15 min | Verify lockout, contact the account owner |
| Lockouts on several accounts from one IP | Block/rate-limit the source at the edge |
| Any `REFRESH_TOKEN_REUSE` | Treat the session as compromised; revoke all sessions |
| `CRITICAL` audit event or 5xx burst | Page the on-call engineer, preserve logs |
| No logs received for 5 min | Check API health and collector credentials |
| Audit chain verification fails | Incident: preserve the database, investigate access |

Review the dashboard and SIEM alerts at least weekly, and record the review.
Every view of the audit trail is itself audited (`AUDIT_LOGS_VIEWED`).

## 5. Access and protection

- The audit trail and monitoring endpoints require an approved `ADMIN` session.
- Audit rows are read-only; there is no API to modify or delete them.
- Local log files are created `0600` in a `0700` directory.
- SIEM credentials come from the environment, are never logged, and the collector
  endpoint is reported only as a hostname.
- Redaction happens before shipping, so the SIEM never receives secrets either.

## 6. Runbooks

**Collector unavailable.** The queue retries with backoff and drops the oldest
records once full. Queue and drop counters turn non-zero on the dashboard. Fix
the endpoint/credential in the environment and restart; records still queued are
sent on startup. Investigate records lost during the outage from the local files
if `LOG_TO_FILE=true`.

**Disk filling with logs.** Set `LOG_TO_FILE=true` only where local retention is
wanted, lower `APP_LOG_RETENTION_DAYS`, and confirm the sweep runs
(`npm run retention:sweep`). Application logs should normally go to stdout and be
retained by the platform/SIEM.

**CSI/forensic request.** Preserve the encrypted audit archive and the SIEM
extract for the window, record chain verification output, and follow the
organisation's incident procedure. Do not alter or delete rows.
