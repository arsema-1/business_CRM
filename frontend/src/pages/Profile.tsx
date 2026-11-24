import { useEffect, useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import { api, ApiClientError } from "../api/client";
import { useAuth } from "../context/AuthContext";
import {
  PASSWORD_GUIDANCE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordIssues,
} from "../utils/password";

interface Credential {
  id: string;
  deviceName?: string;
  createdAt: string;
}

interface ProfileUser {
  id: string;
  name: string;
  email: string;
  role: string;
  emailVerifiedAt?: string;
  webAuthnCredentials: Credential[];
}

interface MfaStatus {
  enabled: boolean;
  enabledAt?: string | null;
  backupCodesRemaining: number;
}

type Tab = "profile" | "two-factor" | "passkeys";

export default function Profile() {
  const { user: authUser } = useAuth();
  void authUser; // consumed via loadProfile; suppresses unused-var warning
  const [tab, setTab] = useState<Tab>("profile");
  const [profile, setProfile] = useState<ProfileUser | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Profile form state
  const [name, setName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);

  // Passkey state
  const [deviceName, setDeviceName] = useState("");
  const [registeringPasskey, setRegisteringPasskey] = useState(false);

  // Two-factor (TOTP) state
  const [mfa, setMfa] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [mfaBusy, setMfaBusy] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [regenCode, setRegenCode] = useState("");

  async function loadProfile() {
    const res = await api.get("/auth/me");
    setProfile(res.user);
    setName(res.user.name);
  }

  async function loadMfa() {
    try {
      setMfa(await api.get("/auth/mfa/status"));
    } catch {
      // Leave the previous status in place; the tab shows a retry hint
    }
  }

  useEffect(() => {
    loadProfile().catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load profile"));
    loadMfa();
  }, []);

  async function handleSaveProfile() {
    setError(""); setSuccess(""); setSaving(true);
    try {
      if (newPassword && newPassword !== confirmPassword) {
        setError("New passwords do not match"); return;
      }
      if (newPassword) {
        const issues = passwordIssues(newPassword, { email: profile?.email, name });
        if (issues.length > 0) { setError(`Password: ${issues[0]}.`); return; }
      }
      const body: Record<string, string> = {};
      if (name.trim() && name !== profile?.name) body.name = name.trim();
      if (newPassword) { body.currentPassword = currentPassword; body.newPassword = newPassword; }
      if (Object.keys(body).length === 0) { setError("Nothing to update"); return; }
      await api.put("/auth/profile", body);
      setSuccess("Profile updated.");
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      await loadProfile();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to update profile");
    } finally { setSaving(false); }
  }

  async function handleRegisterPasskey() {
    setError(""); setSuccess(""); setRegisteringPasskey(true);
    try {
      const optRes = await api.get("/auth/webauthn/register-options");
      const regResponse = await startRegistration({ optionsJSON: optRes.options });
      await api.post("/auth/webauthn/register-verify", { response: regResponse, deviceName: deviceName.trim() || undefined });
      setSuccess("Passkey registered successfully.");
      setDeviceName("");
      await loadProfile();
    } catch (e) {
      if (e instanceof Error && e.name === "NotAllowedError") {
        setError("Passkey registration was cancelled.");
      } else {
        setError(e instanceof ApiClientError ? e.message : "Passkey registration failed");
      }
    } finally { setRegisteringPasskey(false); }
  }

  async function handleRemovePasskey(credId: string) {
    if (!window.confirm("Remove this passkey?")) return;
    setError(""); setSuccess("");
    try {
      await api.delete(`/auth/webauthn/${credId}`);
      setSuccess("Passkey removed.");
      await loadProfile();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to remove passkey");
    }
  }

  // ── Two-factor handlers ────────────────────────────────────────────────────

  async function handleStartSetup() {
    setError(""); setSuccess(""); setBackupCodes(null); setMfaBusy(true);
    try {
      const res = await api.post("/auth/mfa/setup");
      setSetup({ secret: res.secret, otpauthUri: res.otpauthUri });
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not start two-factor setup");
    } finally { setMfaBusy(false); }
  }

  async function handleEnableMfa() {
    setError(""); setSuccess(""); setMfaBusy(true);
    try {
      const res = await api.post("/auth/mfa/enable", { code: enrollCode.trim() });
      setBackupCodes(res.backupCodes);
      setSetup(null);
      setEnrollCode("");
      setSuccess("Two-factor authentication is on. Save your backup codes now — they are shown only once.");
      await loadMfa();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not enable two-factor authentication");
    } finally { setMfaBusy(false); }
  }

  async function handleDisableMfa() {
    if (!window.confirm("Turn off two-factor authentication? Your account will only need a password to sign in.")) return;
    setError(""); setSuccess(""); setMfaBusy(true);
    try {
      await api.post("/auth/mfa/disable", { password: disablePassword, code: disableCode.trim() });
      setDisablePassword(""); setDisableCode(""); setBackupCodes(null);
      setSuccess("Two-factor authentication is off.");
      await loadMfa();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not disable two-factor authentication");
    } finally { setMfaBusy(false); }
  }

  async function handleRegenerateCodes() {
    setError(""); setSuccess(""); setMfaBusy(true);
    try {
      const res = await api.post("/auth/mfa/backup-codes", { code: regenCode.trim() });
      setBackupCodes(res.backupCodes);
      setRegenCode("");
      setSuccess("New backup codes generated. The old ones no longer work.");
      await loadMfa();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not regenerate backup codes");
    } finally { setMfaBusy(false); }
  }

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: "8px 18px",
    borderRadius: "6px 6px 0 0",
    border: "1px solid var(--border)",
    borderBottom: tab === t ? "1px solid var(--surface)" : undefined,
    background: tab === t ? "var(--surface)" : "#f3f4f6",
    cursor: "pointer",
    fontWeight: tab === t ? 600 : 400,
    fontSize: 14,
    marginBottom: -1,
    position: "relative",
  });

  if (!profile) return <div>Loading…</div>;

  return (
    <div>
      <div className="page-header"><h2>My Profile</h2></div>

      {error && <div className="error-box">{error}</div>}
      {success && (
        <div style={{ background: "#d1fae5", border: "1px solid #6ee7b7", color: "#065f46", padding: "10px 14px", borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
          {success}
        </div>
      )}

      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 0 }}>
        <button style={tabStyle("profile")} onClick={() => setTab("profile")}>Profile</button>
        <button style={tabStyle("two-factor")} onClick={() => setTab("two-factor")}>
          Two-factor{mfa?.enabled ? " ✓" : ""}
        </button>
        <button style={tabStyle("passkeys")} onClick={() => setTab("passkeys")}>
          Passkeys ({profile.webAuthnCredentials.length})
        </button>
      </div>

      {tab === "profile" && (
        <div className="card" style={{ borderTopLeftRadius: 0, maxWidth: 560 }}>
          <div style={{ marginBottom: 20, padding: "12px 14px", background: "#f8faff", borderRadius: 6, border: "1px solid var(--border)", fontSize: 13 }}>
            <div><strong>Email:</strong> {profile.email}</div>
            <div style={{ marginTop: 4 }}><strong>Role:</strong> {profile.role}</div>
            <div style={{ marginTop: 4, color: profile.emailVerifiedAt ? "var(--success)" : "var(--danger)" }}>
              {profile.emailVerifiedAt ? "✓ Email verified" : "⚠ Email not verified"}
            </div>
          </div>

          <div className="form-group">
            <label>Display name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "16px 0" }} />
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: "var(--text-muted)" }}>Change password</div>

          <div className="form-group">
            <label>Current password</label>
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="form-group">
            <label>New password (min {PASSWORD_MIN_LENGTH} chars)</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              autoComplete="new-password"
            />
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{PASSWORD_GUIDANCE}</div>
          </div>
          <div className="form-group">
            <label>Confirm new password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              maxLength={PASSWORD_MAX_LENGTH}
              autoComplete="new-password"
            />
          </div>

          <button className="btn" onClick={handleSaveProfile} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}

      {tab === "two-factor" && (
        <div className="card" style={{ borderTopLeftRadius: 0, maxWidth: 560 }}>
          <p style={{ marginTop: 0, fontSize: 14, color: "var(--text-muted)" }}>
            Two-factor authentication adds a second step to sign-in: your password plus a 6-digit code from an
            authenticator app such as Google Authenticator, Microsoft Authenticator, 1Password or Aegis. If you ever
            lose the device, the one-time backup codes below get you back in.
          </p>

          {backupCodes && (
            <div style={{ border: "1px solid #fcd34d", background: "#fffbeb", borderRadius: 6, padding: "12px 14px", marginBottom: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>Your backup codes</div>
              <div style={{ fontSize: 13, color: "#92400e", marginBottom: 10 }}>
                Each code works once. Store them somewhere safe and offline — they are shown only this one time.
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontFamily: "monospace", fontSize: 14 }}>
                {backupCodes.map((c) => <span key={c}>{c}</span>)}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button
                  className="btn"
                  style={{ padding: "4px 10px", fontSize: 12 }}
                  onClick={() => navigator.clipboard?.writeText(backupCodes.join("\n"))}
                >
                  Copy all
                </button>
                <button
                  className="btn"
                  style={{ padding: "4px 10px", fontSize: 12, background: "#6b7280" }}
                  onClick={() => setBackupCodes(null)}
                >
                  I have saved them
                </button>
              </div>
            </div>
          )}

          {!mfa && <div style={{ color: "var(--text-muted)", fontSize: 14 }}>Loading status…</div>}

          {mfa && !mfa.enabled && !setup && (
            <button className="btn" onClick={handleStartSetup} disabled={mfaBusy}>
              {mfaBusy ? "Starting…" : "Set up authenticator app"}
            </button>
          )}

          {mfa && !mfa.enabled && setup && (
            <div>
              <ol style={{ paddingLeft: 20, fontSize: 14, lineHeight: 1.7, marginTop: 0 }}>
                <li>Open your authenticator app and add an account.</li>
                <li>Enter this setup key (time-based, 6 digits, 30 seconds):</li>
              </ol>
              <div
                style={{
                  fontFamily: "monospace", fontSize: 15, letterSpacing: 1, padding: "10px 12px",
                  background: "#f3f4f6", border: "1px solid var(--border)", borderRadius: 6,
                  wordBreak: "break-all", marginBottom: 8,
                }}
              >
                {setup.secret.match(/.{1,4}/g)?.join(" ") ?? setup.secret}
              </div>
              <div style={{ display: "flex", gap: 12, fontSize: 13, marginBottom: 16 }}>
                <button
                  style={{ background: "none", border: "none", padding: 0, color: "var(--primary)", cursor: "pointer", fontSize: 13 }}
                  onClick={() => navigator.clipboard?.writeText(setup.secret)}
                >
                  Copy setup key
                </button>
                <a href={setup.otpauthUri} style={{ color: "var(--primary)" }}>Open in authenticator app</a>
              </div>
              <div className="form-group">
                <label>Enter the 6-digit code it shows</label>
                <input
                  value={enrollCode}
                  onChange={(e) => setEnrollCode(e.target.value)}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  style={{ letterSpacing: 4, fontFamily: "monospace" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" onClick={handleEnableMfa} disabled={mfaBusy || enrollCode.trim().length < 6}>
                  {mfaBusy ? "Verifying…" : "Verify and turn on"}
                </button>
                <button
                  className="btn"
                  style={{ background: "#6b7280" }}
                  onClick={() => { setSetup(null); setEnrollCode(""); }}
                  disabled={mfaBusy}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {mfa?.enabled && (
            <div>
              <div style={{ marginBottom: 18, padding: "12px 14px", background: "#f8faff", borderRadius: 6, border: "1px solid var(--border)", fontSize: 13 }}>
                <div style={{ color: "var(--success)", fontWeight: 600 }}>✓ Two-factor authentication is on</div>
                {mfa.enabledAt && (
                  <div style={{ marginTop: 4, color: "var(--text-muted)" }}>
                    Enabled {new Date(mfa.enabledAt).toLocaleDateString()}
                  </div>
                )}
                <div style={{ marginTop: 4 }}>
                  Unused backup codes: <strong>{mfa.backupCodesRemaining}</strong>
                  {mfa.backupCodesRemaining <= 2 && (
                    <span style={{ color: "#92400e" }}> — generate a new set soon</span>
                  )}
                </div>
              </div>

              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--text-muted)" }}>Regenerate backup codes</div>
              <div className="form-group">
                <input
                  value={regenCode}
                  onChange={(e) => setRegenCode(e.target.value)}
                  placeholder="Authenticator code or a backup code"
                  autoComplete="one-time-code"
                />
              </div>
              <button className="btn" onClick={handleRegenerateCodes} disabled={mfaBusy || !regenCode.trim()}>
                {mfaBusy ? "Working…" : "Generate new backup codes"}
              </button>

              <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "22px 0 16px" }} />

              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--danger)" }}>Turn off two-factor authentication</div>
              <div className="form-group">
                <label>Password</label>
                <input
                  type="password"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="form-group">
                <label>Authenticator code or backup code</label>
                <input
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value)}
                  autoComplete="one-time-code"
                />
              </div>
              <button
                className="btn danger"
                onClick={handleDisableMfa}
                disabled={mfaBusy || !disablePassword || !disableCode.trim()}
              >
                {mfaBusy ? "Working…" : "Turn off two-factor"}
              </button>
            </div>
          )}
        </div>
      )}

      {tab === "passkeys" && (
        <div className="card" style={{ borderTopLeftRadius: 0, maxWidth: 560 }}>
          <p style={{ marginTop: 0, fontSize: 14, color: "var(--text-muted)" }}>
            Passkeys let you sign in with Face ID, Touch ID, Windows Hello, or a hardware key — no password needed.
          </p>

          <div style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Register a new passkey</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                placeholder="Device name (optional)"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                style={{ padding: "8px 10px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 14, flex: 1 }}
              />
              <button className="btn" onClick={handleRegisterPasskey} disabled={registeringPasskey}>
                {registeringPasskey ? "Waiting…" : "Register passkey"}
              </button>
            </div>
          </div>

          {profile.webAuthnCredentials.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 14 }}>No passkeys registered yet.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Device</th><th>Registered</th><th></th></tr>
              </thead>
              <tbody>
                {profile.webAuthnCredentials.map((c) => (
                  <tr key={c.id}>
                    <td>{c.deviceName || <span style={{ color: "var(--text-muted)" }}>Unnamed device</span>}</td>
                    <td style={{ fontSize: 13 }}>{new Date(c.createdAt).toLocaleDateString()}</td>
                    <td>
                      <button className="btn danger" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => handleRemovePasskey(c.id)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
