# Mini ERP + CRM Operations Portal

A small ERP/CRM system for a wholesale/distribution company, covering customers, products/inventory,
and sales challans, built for internal Sales, Warehouse, Accounts, and Admin users.

## Tech Stack

- **Backend:** Node.js, TypeScript, Express, Prisma ORM, PostgreSQL, JWT auth, bcrypt
- **Frontend:** React + TypeScript (Vite), React Router, plain fetch-based API client
- **Deployment target:** Render/Railway/Fly.io (backend), Vercel/Netlify (frontend), Neon/Supabase/Render Postgres (DB)

## Architecture (short explanation)

- The backend is a standard layered Express app: `routes -> controllers -> Prisma (DB)`, with
  shared `authenticate`/`authorize` middleware for session verification and role checks, and a single
  central `errorHandler` so every endpoint returns a consistent JSON error shape.
- Auth is a short-lived JWT plus a server-side `Session` row. On login the server signs
  `{ id, email, role, name, sid }` into a 15-minute access token and stores it in an **HttpOnly**
  cookie; a random refresh token (also HttpOnly, scoped to `/auth`) lives in the same session row.
  Nothing secret is ever exposed to JavaScript or `localStorage`. Because every request checks the
  session row, logout, password changes and admin actions revoke access immediately rather than when
  the token happens to expire. API clients may still send `Authorization: Bearer <accessToken>`.
- Role-based access is enforced per-route (e.g. only `ADMIN`/`SALES` can create customers or
  challans; only `ADMIN`/`WAREHOUSE` can edit the product catalog or record stock movements). All
  authenticated roles can *view* customers, products, and challans.
- **Stock integrity** is the core business rule: `currentStock` on a `Product` is never edited
  directly by a client-supplied value after creation. It only changes through:
  1. `POST /products/:id/stock` (manual IN/OUT entries), or
  2. Confirming a sales challan (`PUT /challans/:id/confirm`), or
  3. Cancelling a previously confirmed challan (stock is restored).
  Every change is wrapped in a Prisma `$transaction` and re-validates stock availability
  server-side before writing, so stock can never go negative even under concurrent requests, and
  every change is logged as a `StockMovement` row (product, qty, IN/OUT, reason, user, timestamp).
- **Sales challans** snapshot product name/SKU/unit price into `ChallanItem` at creation time (not
  just a `productId` reference), so historical challans stay accurate even if a product is later
  renamed or repriced. Challan numbers are auto-generated (`CH-<year>-<sequence>`).
- The frontend is a plain Vite + React SPA (no server-side rendering needed for an internal admin
  tool) with a small `AuthContext`, a shared `api` fetch wrapper that sends cookies and silently
  refreshes an expired access token once, and one
  page per module (Customers, Products, Challans) plus detail pages.

## Project Structure

```
mini-erp-crm/
├── backend/                 # Express + TypeScript API
│   ├── prisma/schema.prisma # DB schema (Users, Customers, FollowUps, Products, StockMovements, Challans, ChallanItems)
│   ├── src/
│   │   ├── controllers/     # Business logic per module
│   │   ├── routes/          # Route definitions + role restrictions
│   │   ├── middleware/      # auth (session + CSRF) + errorHandler
│   │   ├── utils/session.ts  # cookie sessions, refresh rotation, revocation
│   │   ├── config/db.ts     # Prisma client singleton
│   │   ├── seed.ts          # Creates 1 login per role + demo data
│   │   └── index.ts         # App entry point
│   └── .env.example
├── frontend/                 # React + TypeScript (Vite) SPA
│   ├── src/
│   │   ├── api/client.ts     # fetch wrapper: cookies, CSRF header, silent refresh
│   │   ├── context/AuthContext.tsx
│   │   ├── components/       # Layout, ProtectedRoute
│   │   └── pages/             # Login, Customers, CustomerDetail, Products, ProductDetail, Challans, ChallanCreate, ChallanDetail
│   └── .env.example
└── postman_collection.json   # Import into Postman to test every endpoint
```

## Local Setup

### Prerequisites
- Node.js 18+
- A PostgreSQL database (local install, or a free hosted one — see Deployment section)

### 1. Backend

```bash
cd backend
cp .env.example .env
# Edit .env and set DATABASE_URL to your Postgres connection string, and set a real JWT_SECRET

npm install
npx prisma migrate dev --name init   # creates tables
npm run seed                          # creates 1 user per role + demo customer/products
npm run dev                           # starts API on http://localhost:4000
```

### 2. Frontend

In a second terminal:

```bash
cd frontend
cp .env.example .env
# VITE_API_URL should point at your backend, e.g. http://localhost:4000

npm install
npm run dev     # starts UI on http://localhost:5173
```

### 3. Log in

Open http://localhost:5173/login. Seeded credentials (password is the same for all):

| Role      | Email                 | Password       |
|-----------|------------------------|----------------|
| Admin     | admin@demo.com         | Password@123   |
| Sales     | sales@demo.com         | Password@123   |
| Warehouse | warehouse@demo.com     | Password@123   |
| Accounts  | accounts@demo.com      | Password@123   |

(Change `SEED_PASSWORD` in `backend/.env` before seeding if you want a different password.)

## Environment Variables

**Backend (`backend/.env`)**
| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Long random string used to sign access tokens (changing it signs everyone out) |
| `ACCESS_TOKEN_MINUTES` | Access-token lifetime in minutes (default 15) |
| `SESSION_IDLE_MINUTES` | Sign out after this much inactivity (default 30) |
| `SESSION_TTL_HOURS` | Absolute session lifetime, regardless of activity (default 12) |
| `COOKIE_SECURE` | Defaults to `true` in production; set `false` only for plain-HTTP dev |
| `COOKIE_SAME_SITE` | `strict` (default), `lax`, or `none` (forces Secure) for cross-site SPAs |
| `COOKIE_DOMAIN` | Optional parent domain (e.g. `.example.com`) so the SPA can read the CSRF cookie |
| `PORT` | Port the API listens on (default 4000) |
| `CORS_ORIGIN` | Comma-separated list of allowed frontend origins |
| `SEED_PASSWORD` | Password assigned to all seeded demo users |
| `DEFAULT_SIGNUP_ROLE` | Role for self-registered accounts: `SALES`, `WAREHOUSE` or `ACCOUNTS` (default `SALES`) |
| `LOGIN_MAX_ATTEMPTS` | Failed sign-ins before a temporary lockout (default 5) |
| `LOGIN_LOCKOUT_MINUTES` | Lockout duration in minutes (default 15) |
| `FORCE_HTTPS` | Set `true` to enforce HTTPS outside production (production always enforces it) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | Outgoing mail server (blank = links printed to the console) |
| `SMTP_USER` / `SMTP_PASS` | SMTP login — for Gmail use an App Password, not the account password |
| `SMTP_FROM` | From address; defaults to `SMTP_USER` (Gmail requires them to match) |
| `MFA_ISSUER` | Name shown beside the account in the authenticator app (default `Mini ERP CRM`) |
| `MFA_ENCRYPTION_KEY` | AES-256-GCM key that encrypts stored TOTP secrets; falls back to `JWT_SECRET` |
| `LOG_ENCRYPTION_KEY` | Key for audit-row encryption and the hash chain; falls back to `JWT_SECRET` (keep it stable or old rows become unreadable) |
| `MFA_CHALLENGE_MINUTES` | Lifetime of the "code still required" step after a correct password (default 5) |
| `MFA_MAX_ATTEMPTS` | Wrong codes allowed per sign-in before the challenge is burned (default 5) |
| `MFA_BACKUP_CODES` | How many one-time backup codes are issued on enrollment (default 10) |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` or `security` (default `info`) |
| `LOG_TO_FILE` | Also write daily `app-YYYY-MM-DD.log` files (default `false`) |
| `LOG_DIR` | Directory for local log files (default `backend/logs`) |
| `SIEM_URL` | Central collector/SIEM HTTP ingest endpoint; empty disables shipping |
| `SIEM_AUTH_HEADER` | Raw `Authorization` value for the collector (e.g. `Bearer …`) |
| `SIEM_SOURCE` | Source name attached to shipped records (default `mini-erp-crm`) |
| `SIEM_BATCH_SIZE` / `SIEM_FLUSH_SECONDS` | Batch size and flush interval (50 / 5s) |
| `SIEM_MAX_BUFFER` / `SIEM_TIMEOUT_MS` | Queue cap and request timeout (1000 / 5000ms) |
| `APP_LOG_RETENTION_DAYS` | Days before local log files are deleted (default 30) |
| `AUDIT_LOG_RETENTION_DAYS` | Audit retention window, archived not deleted (default 365) |
| `SIEM_RETENTION_DAYS` | Intended collector-side retention (default 90) |
| `RETENTION_SWEEP_HOURS` | How often the retention sweep runs (default 24) |
| `ALERTING_ENABLED` | Turn security alert detection and delivery on/off (default `true`) |
| `ALERT_WEBHOOK_URL` / `ALERT_WEBHOOK_AUTH_HEADER` | Generic JSON alert webhook (Slack/Teams relay, PagerDuty adapter) and raw `Authorization` value |
| `ALERT_WEBHOOK_TIMEOUT_MS` | Webhook request timeout (default 5000) |
| `ALERT_SECURITY_EMAILS` | Comma-separated security team recipients |
| `ALERT_OPERATIONS_EMAILS` | Comma-separated IT-operations recipients (configuration changes) |
| `ALERT_DATA_EMAILS` | Comma-separated data-owner recipients (unusual data access) |
| `ALERT_ESCALATION_EMAILS` | Second-tier contacts for unacknowledged HIGH/CRITICAL alerts (defaults to the security team) |
| `ALERT_ESCALATION_MINUTES` / `ALERT_ESCALATION_SWEEP_SECONDS` | Escalation delay and sweep interval (15 min / 60 s) |
| `ALERT_RUNBOOK_URL` | Runbook link included in every alert notification (defaults to the monitoring page) |
| `ALERT_FAILED_LOGIN_THRESHOLD` / `ALERT_FAILED_LOGIN_WINDOW_MINUTES` | Failed-sign-in burst rule (5 / 15 min) |
| `ALERT_AUTHZ_DENIAL_THRESHOLD` / `..._WINDOW_MINUTES` | Authorization-denial burst rule (10 / 10 min) |
| `ALERT_CSRF_THRESHOLD` / `ALERT_CSRF_WINDOW_MINUTES` | CSRF-refusal burst rule (10 / 10 min) |
| `ALERT_DATA_ACCESS_THRESHOLD` / `..._WINDOW_MINUTES` | Sensitive-read burst rule (20 / 10 min) |
| `ALERT_COOLDOWN_MINUTES` | Fold repeats of the same condition into one alert (default 30) |

**Frontend (`frontend/.env`)**
| Variable | Description |
|---|---|
| `VITE_API_URL` | Base URL of the backend API |

Neither `.env` file is committed — only the `.env.example` templates are, per the `.gitignore`.

## Deploying (free-tier friendly)

This does **not** require AWS or any paid service; the assignment treats AWS as an optional bonus.

1. **Database:** Create a free Postgres instance on [Neon](https://neon.tech), [Supabase](https://supabase.com), or Render Postgres. Copy the connection string into `DATABASE_URL`.
2. **Backend:** Deploy the `backend/` folder to [Render](https://render.com) (or Railway/Fly.io) as a Web Service:
   - Build command: `npm install && npx prisma generate && npm run build`
   - Start command: `npx prisma migrate deploy && npm start`
   - Add the same environment variables as above in the host's dashboard.
   - After first deploy, run the seed script once (Render's shell, or a one-off job): `npm run seed`.
3. **Frontend:** Deploy the `frontend/` folder to [Vercel](https://vercel.com) or [Netlify](https://netlify.com):
   - Build command: `npm run build`
   - Output directory: `dist`
   - Set `VITE_API_URL` to your deployed backend's URL.
   - Update the backend's `CORS_ORIGIN` to include the deployed frontend URL.

### Optional: AWS deployment (bonus)
- Backend: EC2 (with PM2 + Nginx reverse proxy) or Elastic Beanstalk; RDS for PostgreSQL.
- Frontend: S3 + CloudFront static hosting.
- Use AWS Systems Manager Parameter Store or Secrets Manager for environment variables instead of a plain `.env` file.

## Security Controls

- **Password policy (all paths: signup, reset, self-service change, admin-created accounts):**
  12–72 characters, at least three of lowercase/uppercase/number/symbol, no character repeated 4+ times,
  rejected if it contains the user's name or email, checked against a built-in common-password list and
  against **Have I Been Pwned** using k-anonymity (only the first 5 chars of the SHA-1 hash leave the server).
  If the breach service is unreachable the local policy still applies and the lookup fails open.
- **Hashing:** bcrypt with a per-password salt and cost factor 12. No plaintext password is ever stored,
  logged, placed in a URL, or returned by an API.
- **Account lockout:** 5 failed password attempts lock the account for 15 minutes (`LOGIN_MAX_ATTEMPTS`,
  `LOGIN_LOCKOUT_MINUTES`). While locked, even the correct password is refused (HTTP 423). A completed
  password reset — or an admin password reset — clears the lock immediately; the lock also expires on its own.
- **Transport:** in production (or with `FORCE_HTTPS=true`) plain-HTTP `GET`/`HEAD` requests are 308-redirected
  to HTTPS and all other methods are rejected with 403, so credentials are never posted over cleartext.
  Helmet sets HSTS on HTTPS responses.
- **Session management (task 1.4):** the access token is a 15-minute JWT in an HttpOnly, SameSite
  cookie, so it is unreadable from JavaScript. Refresh tokens are opaque random strings stored only as
  SHA-256 hashes in the `Session` table, scoped to the `/auth` cookie path, and **rotated on every
  refresh**; replaying an already-rotated token revokes the session and is written to the audit log.
- **Timeouts:** a session ends after 30 minutes of inactivity (the idle deadline slides forward on
  authenticated traffic) and in all cases after 12 hours, even if active.
- **Revocation:** logout deletes the server-side session, so a copied token stops working at once.
  `POST /auth/logout-all` kills every device; password change/reset and admin deactivation/reset also
  revoke sessions.
- **CSRF and fixation:** every cookie-authenticated non-`GET` request must echo `X-CSRF-Token`
  (double submit against a per-session hash), SameSite=strict blocks cross-site cookie sends, and any
  request whose `Origin` is not in `CORS_ORIGIN` is rejected with 403. Sign-in always mints a brand-new
  session id and clears any previous cookies, so a pre-set session cannot be inherited.
- **Rate limits:** login 10/15min per IP, token refresh 60/15min, registration 5/hour, password-reset
  requests 5/hour and reset submissions 10/hour.
- **Identity verification:** passwords are only changed after proving the current password, resets require a
  single-use emailed token valid for 15 minutes, and new accounts must verify their email before sign-in.
- **Multi-factor authentication (task 1.5):** the password is only the first factor. With MFA enabled,
  `POST /auth/login` creates **no session** — just a 5-minute, single-use challenge (`erp_mfa` HttpOnly
  cookie plus a `MfaChallenge` row) — and the session is only minted by `POST /auth/mfa/verify` after a
  valid code. Codes are TOTP (RFC 6238, SHA-1/6 digits/30 s, one step of drift), generated in-house on
  `node:crypto` so no new dependency was added. Enrollment is two-phase: a pending secret is stored until
  a live code proves the authenticator works, then it is promoted. TOTP secrets are **AES-256-GCM
  encrypted at rest**, so a database leak alone cannot mint codes. A wrong code increments a per-challenge
  counter; at 5 the challenge is burned and the user must sign in again.
- **Backup codes:** 10 single-use codes (`XXXXX-XXXXX`, 50 bits each) are issued on enrollment, shown
  once, and stored only as HMAC-SHA256 hashes. They count as the second factor at sign-in, can be
  regenerated (authenticator or backup code required), and are deleted when MFA is turned off.
- **Account recovery:** losing the device is handled by the emailed recovery link
  (`POST /auth/mfa/recover/request` → `confirm`), which requires a hashed, single-use, 30-minute token
  **and** the account password — so a compromised mailbox alone cannot take over the account. A completed
  recovery turns MFA off, deletes backup codes, revokes every session and emails the account owner; an
  administrator can also reset MFA from user management as a break-glass path. Both are audited.
- **Turning MFA off is itself two-factor:** `POST /auth/mfa/disable` requires the password plus a live
  authenticator or backup code, so a stolen session cannot weaken the account.
- **User activity audit trail (task 2.1):** every security-relevant action is appended to the `AuditLog`
  table with the actor's id, email and role, a timestamp, IP address, user agent, HTTP method/path,
  severity and success flag. Covered: sign-in success and failure (password, passkey, TOTP and backup
  code), lockouts, refresh-token replay, CSRF and authorization denials, account and role administration,
  and every customer, product, stock and challan change. Audit rows carry no foreign keys, so deleting a
  user never erases what they did; reading the trail is Admin-only and is itself audited.
- **System event log (task 2.2):** startup, graceful shutdown, loaded configuration (with a change
  fingerprint, never secret values), database/listen failures, unhandled exceptions and 5xx responses are
  recorded as `system` rows in the same audit table and mirrored to the structured JSON log stream
  (`LOG_TO_FILE`). Rate-limit trips and CSRF refusals are emitted there as security alerts. Both are
  browsable and filterable by an administrator at **Audit Logs** in the UI.
- **Encrypted audit storage:** free-text audit fields (the detail, IP address and user agent) are
  encrypted at rest with AES-256-GCM under a key derived from `LOG_ENCRYPTION_KEY`, so a database leak or
  a stolen backup reveals who did what but not the surrounding details. Indexed fields (actor email,
  role, action, entity, severity, time) stay readable so the admin filters keep working, and the API
  decrypts a row only for an authorised administrator. File logs never contain credentials and are
  created `0600` inside a `0700` directory.
- **Tamper-evident trail:** every row stores a monotonic sequence number and an HMAC-SHA256 over its own
  fields plus the previous row's hash. Appends take a Postgres advisory lock, so concurrent requests
  cannot fork the chain, and a database trigger rejects `UPDATE` and `DELETE` on the table outright.
  `npm run audit:verify` (or `GET /audit-logs/verify`) recomputes the chain and names the first entry
  that was changed, removed or reordered.
- **Restricted log access:** the trail is readable only by an approved administrator — there is no write,
  edit or delete endpoint — and every read is itself recorded as `AUDIT_LOGS_VIEWED`. Anything else gets
  401 (no session) or 403 (wrong role). Entries written before the chain existed are reported as a
  pre-chain prefix rather than counted as verified.
- **Centralized logging and monitoring (task 2.4):** all structured logs (every request, rate-limit trips,
  5xx, startup/shutdown, retention sweeps) can be shipped as JSON batches over HTTPS to a central
  collector/SIEM by setting `SIEM_URL`; delivery is asynchronous, batched, retried with backoff, bounded,
  and its queue/error counters are shown in the UI. Credentials are redacted before any sink. Retention is
  enforced by a scheduled sweep: local `app-YYYY-MM-DD.log` files are deleted after `APP_LOG_RETENTION_DAYS`
  (default 30), the collector keeps its copy for `SIEM_RETENTION_DAYS` (default 90), and the append-only audit
  trail is retained for `AUDIT_LOG_RETENTION_DAYS` (default 365) and **never deleted in place** — past that
  window it is archived encrypted and the dashboard flags it. An Admin-only **Security Monitoring** page
  (`/monitoring`, `/monitoring/security-trends`) charts failed sign-ins, lockouts, denied/CSRF/token-reuse
  events and critical alerts over 7–90 days, plus log-pipeline and retention health. See
  [`docs/logging-and-monitoring.md`](docs/logging-and-monitoring.md) for the policy, SIEM payload, archival
  procedure and alert thresholds.
- **Security alerting and escalation (task 2.5):** critical events and anomalies raise a persisted
  `SecurityAlert` — failed-sign-in bursts and lockouts, refresh-token replay, authorization and CSRF
  denial bursts, privilege escalation (including promotion to `ADMIN`), break-glass MFA/password resets,
  unusual audit-trail access, and configuration-fingerprint changes. Each alert is routed to the team
  that owns it (Security, IT operations or Data owners) by webhook and/or email, and appears on the
  Admin-only **Security Monitoring** page. Repeats within `ALERT_COOLDOWN_MINUTES` increment the existing
  alert instead of paging again. HIGH/CRITICAL alerts that stay unacknowledged for
  `ALERT_ESCALATION_MINUTES` are re-delivered to `ALERT_ESCALATION_EMAILS`; acknowledgement is recorded
  and audited. See [`docs/alerting-and-escalation.md`](docs/alerting-and-escalation.md) for the rule
  catalog, routing table, escalation path and per-alert runbooks.

(The seeded demo password `Password@123` is a development fixture created directly by `seed.ts`; the policy
above rejects it for any password a user sets.)

## API Overview

All endpoints except `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`,
`/auth/verify-email`, `/auth/forgot-password`, `/auth/reset-password`, the `/auth/webauthn/login-*`
pair, the `/auth/mfa/verify` and `/auth/mfa/recover/*` steps and `/health` require a session: either the HttpOnly cookie set by the frontend flow, or
`Authorization: Bearer <accessToken>` for scripts and Postman. Cookie-authenticated requests with a
non-`GET` method must also send `X-CSRF-Token` (the frontend reads it from the `erp_csrf` cookie).

| Method | Path | Roles | Description |
|---|---|---|---|
| POST | /auth/register | Public | Self-service signup (name, email, password + reCAPTCHA). Account stays inactive until the emailed link is opened, then waits for admin approval |
| POST | /auth/login | Public | Issues a session and sets the access/refresh/CSRF cookies (also returns the access token + user) |
| POST | /auth/refresh | Public (refresh cookie) | Rotates the refresh token and issues a new access token |
| POST | /auth/logout | Public (refresh cookie) | Revokes the current session and clears cookies |
| POST | /auth/logout-all | Any | Revokes every session for the signed-in user |
| GET | /auth/verify-email?token= | Public | Activates a pending account; token is single-use |
| GET | /auth/me | Any | Current user info |
| PUT | /auth/profile | Any | Update own name/password (password change requires current password) |
| POST | /auth/mfa/verify | Public (challenge cookie) | Second login step: TOTP or backup code → creates the session |
| GET | /auth/mfa/status | Any | Whether MFA is on, since when, and unused backup codes left |
| POST | /auth/mfa/setup | Any | Start enrollment: returns the setup key + `otpauth://` URI (not yet active) |
| POST | /auth/mfa/enable | Any | Confirm with a live code; returns the one-time backup codes |
| POST | /auth/mfa/disable | Any | Turn MFA off — requires password **and** a valid code |
| POST | /auth/mfa/backup-codes | Any | Issue a fresh set of backup codes (requires a code) |
| POST | /auth/mfa/recover/request | Public | Email a single-use MFA recovery link (30 min) |
| POST | /auth/mfa/recover/confirm | Public | Complete recovery with token + password; revokes all sessions |
| POST | /users/:id/mfa/reset | Admin | Break-glass: clear another user's MFA, revokes their sessions |
| PUT | /users/:id/approve | Admin | Approve a verified self-registered account so it can access business data |
| GET | /customers | Any | List/search/filter customers (paginated) |
| GET | /customers/:id | Any | Customer detail incl. follow-ups + challans |
| POST | /customers | Admin, Sales | Create customer |
| PUT | /customers/:id | Admin, Sales | Update customer |
| POST | /customers/:id/followups | Admin, Sales | Add follow-up note |
| GET | /products | Any | List/search products, `?lowStock=true` filter |
| GET | /products/:id | Any | Product detail incl. stock movement log |
| POST | /products | Admin, Warehouse | Create product |
| PUT | /products/:id | Admin, Warehouse | Update product (not stock directly) |
| POST | /products/:id/stock | Admin, Warehouse | Record IN/OUT stock movement |
| GET | /challans | Any | List/filter challans |
| GET | /challans/:id | Any | Challan detail incl. line items |
| GET | /monitoring/security-trends?days=7 | Admin | Security trend aggregates, open alerts, routing and log pipeline/retention health |
| GET | /monitoring/alerts?status=open\|acknowledged\|all | Admin | List routed security alerts (open by default) with severity/team filters |
| POST | /monitoring/alerts/:id/acknowledge | Admin | Mark an alert as being handled; stops escalation and is audited |
| POST | /challans | Admin, Sales | Create challan (status: DRAFT) |
| PUT | /challans/:id/confirm | Admin, Sales | Confirm challan — deducts stock, rejects if insufficient |
| PUT | /challans/:id/cancel | Admin, Sales | Cancel challan — restocks if it had been confirmed |

Import `postman_collection.json` into Postman to try all of these; it uses `{{baseUrl}}` and
`{{token}}` variables — run **Login (Admin)**, copy the returned token into the `token` collection
variable, then run the rest.

## Assumptions Made

- Only one user exists per role (via seed) since the assignment didn't require a full user-management UI; `ADMIN` could be extended to manage users via `/auth` if needed.
- "Invoice" generation (PDF export) was scoped as a bonus item and left as a documented limitation below, since the core required flow was the sales challan, not invoicing.
- Stock movement `reason` is a free-text field rather than an enum, since the real-world reasons (damage, correction, purchase order, return) vary by business and a free-text audit trail was judged more useful than a rigid enum for this case study's scope.
- GST number and email are optional on the customer record, since not every lead/customer will have them yet.
- A challan can only be confirmed from `DRAFT`; a `CONFIRMED` challan can still be cancelled (which restocks), but there's no separate "edit line items" flow after creation — cancel and recreate covers that case within the assignment's timeframe.

## Known Limitations / Incomplete Parts

- No password-reset or user-registration UI (users are seeded directly); only `ADMIN` accounts could reasonably manage users via an admin panel, which wasn't built out.
- No PDF invoice export or S3 image upload (both listed as bonus items in the spec).
- No Docker setup or GitHub Actions pipeline included (bonus items).
- No automated test suite (unit/integration tests) — given the 48-hour window, manual verification via the Postman collection and the UI was prioritized instead.
- Central log delivery is capped and best-effort: a prolonged SIEM outage drops the oldest queued records (counters are exposed). Audit rows are never deleted automatically, so audit archival is an operator procedure rather than an automated job.
- Alert delivery is best-effort per channel (email and webhook fail independently) and failures are recorded on the alert rather than retried indefinitely. Escalation is time-based inside the application; there is no two-way sync with a paging provider's acknowledgement state. Burst rules count by account because IP addresses are encrypted at rest.
- Accounts role currently has view-only access everywhere; a real system would likely give Accounts write access to an invoicing/payments module, which is out of scope for this case study.
