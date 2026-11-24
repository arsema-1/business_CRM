import { Router } from "express";
import {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  me,
  updateProfile,
  verifyEmail,
  forgotPassword,
  resetPassword,
  webAuthnRegisterOptions,
  webAuthnRegisterVerify,
  webAuthnLoginOptions,
  webAuthnLoginVerify,
  webAuthnRemoveCredential,
} from "../controllers/auth.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { authenticate } from "../middleware/auth";
import {
  confirmMfaRecovery,
  disableMfa,
  enableMfa,
  mfaStatus,
  regenerateBackupCodes,
  requestMfaRecovery,
  setupMfa,
  verifyMfaLogin,
} from "../controllers/mfa.controller";

const router = Router();

// Public
router.post("/register",      asyncHandler(register));
router.post("/login",          asyncHandler(login));
// Refresh/logout authenticate with the HttpOnly refresh cookie instead of an
// access token, so they must not sit behind `authenticate`.
router.post("/refresh",        asyncHandler(refresh));
router.post("/logout",         asyncHandler(logout));
router.get("/verify-email",    asyncHandler(verifyEmail));
router.post("/forgot-password", asyncHandler(forgotPassword));
router.post("/reset-password",  asyncHandler(resetPassword));

// Multi-factor authentication — public halves of the flows
// `/mfa/verify` finishes a sign-in (password already accepted, ticket in an
// HttpOnly cookie); the recovery pair is used when the device is lost.
router.post("/mfa/verify",          asyncHandler(verifyMfaLogin));
router.post("/mfa/recover/request", asyncHandler(requestMfaRecovery));
router.post("/mfa/recover/confirm", asyncHandler(confirmMfaRecovery));

// WebAuthn — public (unauthenticated login flow)
router.post("/webauthn/login-options", asyncHandler(webAuthnLoginOptions));
router.post("/webauthn/login-verify",  asyncHandler(webAuthnLoginVerify));

// Authenticated
router.get("/me",             authenticate, asyncHandler(me));
router.put("/profile",        authenticate, asyncHandler(updateProfile));
router.post("/logout-all",    authenticate, asyncHandler(logoutAll));

// Multi-factor authentication — enrollment and management (signed in)
router.get("/mfa/status",                authenticate, asyncHandler(mfaStatus));
router.post("/mfa/setup",                authenticate, asyncHandler(setupMfa));
router.post("/mfa/enable",               authenticate, asyncHandler(enableMfa));
router.post("/mfa/disable",              authenticate, asyncHandler(disableMfa));
router.post("/mfa/backup-codes",         authenticate, asyncHandler(regenerateBackupCodes));

// WebAuthn — authenticated (register a new passkey)
router.get("/webauthn/register-options",          authenticate, asyncHandler(webAuthnRegisterOptions));
router.post("/webauthn/register-verify",          authenticate, asyncHandler(webAuthnRegisterVerify));
router.delete("/webauthn/:credentialId",          authenticate, asyncHandler(webAuthnRemoveCredential));

export default router;
