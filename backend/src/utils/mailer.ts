import nodemailer from "nodemailer";
import { logger } from "./logger";

// Build a transporter from environment variables.
// If SMTP_HOST is not set the transporter is null and all send calls are
// no-ops — this keeps the development workflow intact when email is not
// configured yet.
function createTransport() {
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

const transporter = createTransport();

// Gmail (and most providers) reject a From address that differs from the
// authenticated user unless it is a verified alias, so fall back to SMTP_USER.
const FROM = process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "noreply@crm.local";
const APP_URL = process.env.APP_URL ?? "http://localhost:5173";

// ── Send helpers ─────────────────────────────────────────────────────────────

// Single path for every outbound message so a mail outage is a logged service
// failure (task 2.2) rather than a stack trace in whichever request happened to
// trigger it. The error is re-thrown: callers still decide how to react.
async function deliver(to: string, subject: string, html: string) {
  if (!transporter) return false;
  try {
    await transporter.sendMail({ from: FROM, to, subject, html });
    logger.info("EMAIL_SENT", `Sent "${subject}"`, { to });
    return true;
  } catch (err) {
    logger.error("EMAIL_SEND_FAILED", `Could not send "${subject}"`, err, { to });
    throw err;
  }
}

export async function sendVerificationEmail(
  email: string,
  name: string,
  token: string,
  requiresApproval = false
) {
  const link = `${APP_URL}/verify-email?token=${token}`;
  if (!transporter) {
    console.log(`[mailer] SMTP not configured. Verification link for ${email}: ${link}`);
    return;
  }
  const nextStep = requiresApproval
    ? "verify your email. An administrator will then review your account before you can use the CRM."
    : "verify your email and activate your account:";
  await deliver(email, "Verify your CRM account", `
      <p>Hi ${name},</p>
      <p>Your CRM account has been created. Click the link below to ${nextStep}</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link can only be used once.</p>
    `);
}

// Account recovery when the authenticator device is lost. The link only starts
// the flow: the account password is still required to complete it.
export async function sendMfaRecoveryEmail(email: string, name: string, token: string) {
  const link = `${APP_URL}/mfa-recovery?token=${token}`;
  if (!transporter) {
    console.log(`[mailer] SMTP not configured. MFA recovery link for ${email}: ${link}`);
    return;
  }
  await deliver(email, "Recover access to your CRM account", `
      <p>Hi ${name},</p>
      <p>We received a request to remove two-factor authentication because you no longer have access to your authenticator app.</p>
      <p>Click the link below to continue. You will be asked for your password:</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 30 minutes and can be used once. If you did not request this, change your password now and tell an administrator.</p>
    `);
}

// Sent after the second factor is removed, so a silent change never goes
// unnoticed by the account owner.
export async function sendMfaDisabledEmail(email: string, name: string, reason: string) {
  const link = `${APP_URL}/profile`;
  if (!transporter) {
    console.log(`[mailer] SMTP not configured. MFA disabled notice for ${email} (${reason})`);
    return;
  }
  await deliver(email, "Two-factor authentication was turned off", `
      <p>Hi ${name},</p>
      <p>Two-factor authentication on your CRM account was turned off via ${reason}.</p>
      <p>If this was not you, reset your password immediately and contact an administrator.</p>
      <p><a href="${APP_URL}/login">Sign in to the CRM</a> · <a href="${link}">Set up two-factor authentication again</a></p>
    `);
}

// Security alert notification (task 2.5). The alert is already persisted, so a
// mail failure is raised to the caller, recorded on the alert and shown in the
// dashboard — it never suppresses the alert itself.
// Returns false when no SMTP transport is configured: the alerting layer must
// not record a notification as delivered when nothing actually left the
// process. Other mail helpers keep their silent no-op behaviour.
export async function sendSecurityAlertEmail(
  recipients: string[],
  subject: string,
  text: string,
  meta: { alertId: string; team: string; escalation: boolean; runbookUrl: string }
): Promise<boolean> {
  if (!transporter) {
    console.log(`[mailer] SMTP not configured. Security alert to ${recipients.join(", ")}: ${subject}\n${text}`);
    return false;
  }

  const lines = text.split("\n").map((line) => `<p>${line}</p>`).join("");
  await deliver(recipients.join(", "), subject, `
      ${lines}
      <p><strong>Team:</strong> ${meta.team}${meta.escalation ? " (escalated)" : ""}</p>
      <p><a href="${meta.runbookUrl}">Open the security dashboard and acknowledge this alert</a></p>
      <p style="color:#6b7280;font-size:12px">Alert id: ${meta.alertId}. Do not reply to this message.</p>
    `);
  return true;
}

export async function sendPasswordResetEmail(email: string, name: string, token: string) {
  const link = `${APP_URL}/reset-password?token=${token}`;
  if (!transporter) {
    console.log(`[mailer] SMTP not configured. Password reset link for ${email}: ${link}`);
    return;
  }
  await deliver(email, "Reset your CRM password", `
      <p>Hi ${name},</p>
      <p>A password reset was requested for your account. Click the link below to set a new password:</p>
      <p><a href="${link}">${link}</a></p>
      <p>This link expires in 15 minutes. If you did not request this, ignore this email.</p>
    `);
}
