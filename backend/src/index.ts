import "./env";
import crypto from "crypto";
import type { Server } from "http";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { prisma } from "./config/db";
import { logger } from "./utils/logger";
import { writeSystemEvent } from "./utils/audit";
import { startRetentionSchedule } from "./utils/retention";
import { checkConfigurationChange, startAlertEscalationSchedule } from "./utils/alerting";
import { alertingConfig } from "./config/alerting";
import { flushLogShipment } from "./utils/logShipper";
import { requestLogger } from "./middleware/requestLogger";

import authRoutes from "./routes/auth.routes";
import customerRoutes from "./routes/customer.routes";
import productRoutes from "./routes/product.routes";
import challanRoutes from "./routes/challan.routes";
import userRoutes from "./routes/user.routes";
import roleChangeRoutes from "./routes/rolechange.routes";
import auditLogRoutes from "./routes/auditlog.routes";
import monitoringRoutes from "./routes/monitoring.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

const app = express();

// Security headers
app.use(helmet());

// HTTPS enforcement. Passwords and JWTs must never travel over plain HTTP.
// Enabled automatically in production; set FORCE_HTTPS=true to also require it
// on a staging host. Local development stays on http://localhost.
const enforceHttps = process.env.NODE_ENV === "production" || process.env.FORCE_HTTPS === "true";
if (enforceHttps) {
  // Behind a reverse proxy (Render/Railway/Nginx) the origin is the proxy
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    const forwarded = req.headers["x-forwarded-proto"];
    if (req.secure || forwarded === "https") return next();
    // Safe to redirect GET/HEAD; reject anything else so a password body is
    // never sent over a plaintext connection.
    if (req.method === "GET" || req.method === "HEAD") {
      return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
    }
    return res.status(403).json({ success: false, message: "HTTPS is required for this request." });
  });
}

// CORS. Credentials are enabled because the session lives in HttpOnly cookies,
// which means the allowlist is an exact origin — never a wildcard.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true,
}));

// Body parser
app.use(express.json({ limit: "50kb" }));

// CSRF layer 1: a browser always sends Origin on state-changing requests, so any
// origin we do not recognise is rejected outright. SameSite=strict cookies plus
// the double-submit token in the auth middleware are layers 2 and 3.
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ success: false, message: "Request origin is not allowed" });
  }
  next();
});

// Session responses must never be cached by a proxy or the browser
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Structured access log: one line per request including refused ones, so a 403
// from the authorization layer is still visible in the trail.
app.use(requestLogger);

// Rate limiting is a security control, so every trip is reported as a security
// alert. These stay in the log stream rather than the database: a flood of
// throttled requests must not turn into a flood of database writes.
function limitHandler(name: string, message: string) {
  return (req: express.Request, res: express.Response) => {
    logger.security("RATE_LIMIT_EXCEEDED", `${name} rate limit exceeded`, {
      ip: req.ip,
      method: req.method,
      path: req.originalUrl,
      userEmail: req.user?.email,
    });
    res.status(429).json({ success: false, message });
  };
}

// Rate limit login endpoint: 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: limitHandler("login", "Too many login attempts. Please try again in 15 minutes."),
  standardHeaders: true,
  legacyHeaders: false,
});

// Registration: 5 signups per hour per IP. CAPTCHA is the first line of
// defence; this caps the damage from distributed or scripted abuse.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  handler: limitHandler("registration", "Too many signup attempts. Please try again later."),
  standardHeaders: true,
  legacyHeaders: false,
});

// Password-reset requests: 5 per hour per IP, keeps reset email flooding down
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  handler: limitHandler("password reset", "Too many reset requests. Please try again later."),
  standardHeaders: true,
  legacyHeaders: false,
});

// Token refresh: generous enough for normal use, tight enough to bound abuse
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  handler: limitHandler("token refresh", "Too many session refreshes. Please try again shortly."),
  standardHeaders: true,
  legacyHeaders: false,
});

// Second-factor submissions: 10 per 15 minutes per IP. A challenge also allows
// only a handful of attempts, so guessing is bounded per sign-in as well.
const mfaVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: limitHandler("second factor", "Too many verification attempts. Please try again in 15 minutes."),
  standardHeaders: true,
  legacyHeaders: false,
});

// Recovery links: 5 per hour per IP, keeps the mailbox from being flooded
const mfaRecoveryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  handler: limitHandler("MFA recovery", "Too many recovery requests. Please try again later."),
  standardHeaders: true,
  legacyHeaders: false,
});

// Reset submissions: 10 per hour per IP, bounds token guessing
const resetSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  handler: limitHandler("password reset submission", "Too many attempts. Please try again later."),
  standardHeaders: true,
  legacyHeaders: false,
});

// Health check
app.get("/health", (_req, res) => {
  res.json({ success: true, status: "ok", time: new Date().toISOString() });
});

// Routes
app.use("/auth/login", loginLimiter);
app.use("/auth/refresh", refreshLimiter);
app.use("/auth/register", registerLimiter);
app.use("/auth/forgot-password", passwordResetLimiter);
app.use("/auth/reset-password", resetSubmitLimiter);
app.use("/auth/mfa/verify",     mfaVerifyLimiter);
app.use("/auth/mfa/recover",    mfaRecoveryLimiter);
app.use("/auth", authRoutes);
app.use("/customers", customerRoutes);
app.use("/products", productRoutes);
app.use("/challans", challanRoutes);
app.use("/users", userRoutes);
app.use("/role-changes", roleChangeRoutes);
app.use("/audit-logs", auditLogRoutes);
app.use("/monitoring", monitoringRoutes);
app.use("/dashboard", dashboardRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

// ── System event logging (task 2.2) ─────────────────────────────────────────
// Startup, shutdown, configuration and dependency failures are recorded both in
// the audit table (so administrators see them in the UI) and in the structured
// log stream (so infrastructure tooling sees them even if the DB is down).

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

// Non-secret configuration worth recording. Secret values are represented by a
// boolean, never by their contents.
function configSnapshot() {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: PORT,
    corsOrigins: ALLOWED_ORIGINS,
    https: enforceHttps ? "required" : "off",
    cookie: {
      secure: process.env.COOKIE_SECURE ?? "auto",
      sameSite: process.env.COOKIE_SAME_SITE ?? "strict",
    },
    sessions: {
      idleMinutes: process.env.SESSION_IDLE_MINUTES ?? "30",
      ttlHours: process.env.SESSION_TTL_HOURS ?? "12",
    },
    login: {
      maxAttempts: process.env.LOGIN_MAX_ATTEMPTS ?? "5",
      lockoutMinutes: process.env.LOGIN_LOCKOUT_MINUTES ?? "15",
    },
    mfa: {
      issuer: process.env.MFA_ISSUER ?? "Mini ERP CRM",
      challengeMinutes: process.env.MFA_CHALLENGE_MINUTES ?? "5",
      maxAttempts: process.env.MFA_MAX_ATTEMPTS ?? "5",
    },
    smtp: process.env.SMTP_HOST ? "configured" : "console",
    logging: {
      level: process.env.LOG_LEVEL ?? "info",
      toFile: (process.env.LOG_TO_FILE ?? "false").toLowerCase() === "true",
      // Central delivery is reported as on/off; the URL and token stay out of
      // the trail.
      centralShipping: Boolean(process.env.SIEM_URL),
      retention: {
        appLogDays: process.env.APP_LOG_RETENTION_DAYS ?? "30",
        auditLogDays: process.env.AUDIT_LOG_RETENTION_DAYS ?? "365",
        siemDays: process.env.SIEM_RETENTION_DAYS ?? "90",
      },
      // Audit rows are always encrypted and hash-chained; this only reports
      // whether they use a dedicated key rather than the JWT_SECRET fallback.
      dedicatedAuditKey: Boolean(process.env.LOG_ENCRYPTION_KEY),
    },
    alerting: {
      enabled: alertingConfig.enabled,
      // Channels are reported as on/off; webhook URLs and tokens stay out of
      // the trail. Recipient counts show whether each team route is staffed.
      webhook: Boolean(alertingConfig.webhook.url),
      teams: Object.fromEntries(
        Object.entries(alertingConfig.teams).map(([team, config]) => [
          team,
          config.emails.length,
        ])
      ),
      escalationMinutes: alertingConfig.escalation.afterMinutes,
      thresholds: {
        failedLogins: alertingConfig.thresholds.failedLogins,
        authzDenials: alertingConfig.thresholds.authzDenials,
        dataAccess: alertingConfig.thresholds.dataAccess,
      },
    },
    envPresence: {
      databaseUrl: Boolean(process.env.DATABASE_URL),
      jwtSecret: Boolean(process.env.JWT_SECRET),
      mfaEncryptionKey: Boolean(process.env.MFA_ENCRYPTION_KEY),
      logEncryptionKey: Boolean(process.env.LOG_ENCRYPTION_KEY),
      recaptcha: Boolean(process.env.RECAPTCHA_SECRET_KEY),
    },
  };
}

const config = configSnapshot();
// A short fingerprint of the whole configuration: two restarts with different
// settings always produce a different value, so a configuration change is
// visible in the trail even though the values themselves stay out of it.
const configFingerprint = crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12);

let server: Server | undefined;
let shuttingDown = false;

async function start() {
  // The fingerprint is also stored as the row's entityId so the next start can
  // tell whether the configuration changed and raise an alert (task 2.5).
  await writeSystemEvent(
    "CONFIG_LOADED",
    `Configuration loaded for ${config.nodeEnv} (fingerprint ${configFingerprint})`,
    "INFO",
    { ...config, configFingerprint },
    { entity: "Config", entityId: configFingerprint }
  );

  try {
    await prisma.$connect();
    logger.info("DATABASE_CONNECTED", "Database connection established");

    // Log/audit retention (task 2.4): prune expired local log files and report
    // whether the immutable audit trail is due for archival. Scheduled daily;
    // the CLI equivalent is `npm run retention:sweep`.
    startRetentionSchedule();

    // Alerting (task 2.5): compare this start's configuration fingerprint with
    // the previous one, then start the escalation sweep for unacknowledged
    // HIGH/CRITICAL alerts.
    const previousFingerprint = await checkConfigurationChange(configFingerprint);
    if (previousFingerprint) {
      logger.warn("CONFIGURATION_CHANGED", "Configuration fingerprint changed since the last start", {
        previousFingerprint,
        configFingerprint,
      });
    }
    startAlertEscalationSchedule();
  } catch (err) {
    logger.error("DATABASE_UNAVAILABLE", "Could not reach the database at startup", err);
    await writeSystemEvent(
      "SERVICE_FAILURE",
      `Database connection failed at startup: ${(err as Error)?.message ?? "unknown error"}`,
      "CRITICAL"
    );
    process.exitCode = 1;
    return;
  }

  server = app.listen(PORT, () => {
    console.log(`🚀 CRM API running on http://localhost:${PORT}`);
    void writeSystemEvent(
      "SYSTEM_STARTUP",
      `API started on port ${PORT} in ${config.nodeEnv} (pid ${process.pid}, node ${process.version}, config ${configFingerprint})`
    );
  });

  // A failed listen (port in use, permission denied) is a service failure, not
  // a silent crash.
  server.on("error", (err) => {
    logger.error("LISTEN_FAILED", `Server could not bind to port ${PORT}`, err);
    void writeSystemEvent("SERVICE_FAILURE", `Server could not bind to port ${PORT}: ${err.message}`, "CRITICAL");
  });
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  const uptimeSeconds = Math.round(process.uptime());
  logger.info("SYSTEM_SHUTDOWN", `Received ${signal}; shutting down gracefully`, { uptimeSeconds });
  await writeSystemEvent("SYSTEM_SHUTDOWN", `Received ${signal}; graceful shutdown after ${uptimeSeconds}s uptime`);

  const finish = async () => {
    // Give queued log records one short chance to reach the central collector
    // before the process disappears.
    const unsent = await flushLogShipment(2000).catch(() => 0);
    if (unsent > 0) {
      logger.warn("LOG_SHIP_PENDING", "Shutdown with unsent log records", { unsent });
    }
    await prisma.$disconnect().catch(() => undefined);
    process.exit(0);
  };

  // Never hang forever waiting for keep-alive connections.
  const forceExit = setTimeout(() => {
    logger.error("SHUTDOWN_TIMEOUT", "Forced exit after 10s while draining connections");
    process.exit(1);
  }, 10000);
  forceExit.unref();

  if (server) server.close(() => void finish());
  else void finish();
}

// Unexpected failures are security/operational alerts: log them, persist them,
// and let the process die so the supervisor restarts a clean instance.
process.on("uncaughtException", (err) => {
  logger.error("UNCAUGHT_EXCEPTION", "Uncaught exception; shutting down", err);
  void writeSystemEvent("SERVICE_FAILURE", `Uncaught exception: ${err.message}`, "CRITICAL").finally(() =>
    process.exit(1)
  );
});

process.on("unhandledRejection", (reason) => {
  logger.error("UNHANDLED_REJECTION", "Unhandled promise rejection", reason);
  void writeSystemEvent(
    "SERVICE_FAILURE",
    `Unhandled promise rejection: ${String((reason as Error)?.message ?? reason).slice(0, 300)}`,
    "WARN"
  );
});

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

void start();
