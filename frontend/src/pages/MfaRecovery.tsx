import { FormEvent, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiClientError } from "../api/client";

// Account recovery when the authenticator device is lost. Two steps: request a
// link to the verified email address, then confirm with the account password
// (which is what stops a compromised mailbox from becoming a compromised CRM).
export default function MfaRecovery() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState("");

  async function handleRequest(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.post("/auth/mfa/recover/request", { email });
      setDone("If that account has two-factor authentication enabled, a recovery link is on its way.");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.post("/auth/mfa/recover/confirm", { token, password });
      setDone("Two-factor authentication has been turned off. Sign in with your password and set it up again.");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Account recovery</h1>
        {done ? (
          <div>
            <div style={{ background: "#d1fae5", border: "1px solid #6ee7b7", color: "#065f46", padding: "12px 14px", borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
              {done}
            </div>
            <Link to="/login" className="btn" style={{ display: "block", textAlign: "center" }}>Back to sign in</Link>
          </div>
        ) : token ? (
          <form onSubmit={handleConfirm}>
            {error && <div className="error-box">{error}</div>}
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 0 }}>
              Confirm your password to remove two-factor authentication. All devices will be signed out, and you can
              set up a new authenticator afterwards.
            </p>
            <div className="form-group">
              <label>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            <button className="btn" type="submit" disabled={loading} style={{ width: "100%" }}>
              {loading ? "Removing..." : "Remove two-factor authentication"}
            </button>
            <div style={{ marginTop: 12, textAlign: "center", fontSize: 13 }}>
              <Link to="/login" style={{ color: "var(--text-muted)" }}>Back to sign in</Link>
            </div>
          </form>
        ) : (
          <form onSubmit={handleRequest}>
            {error && <div className="error-box">{error}</div>}
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 0 }}>
              Lost access to your authenticator app and your backup codes? Enter your email address and we will send a
              link that lets you remove the second factor.
            </p>
            <div className="form-group">
              <label>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <button className="btn" type="submit" disabled={loading} style={{ width: "100%" }}>
              {loading ? "Sending..." : "Send recovery link"}
            </button>
            <div style={{ marginTop: 12, textAlign: "center", fontSize: 13 }}>
              <Link to="/login" style={{ color: "var(--text-muted)" }}>Back to sign in</Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
