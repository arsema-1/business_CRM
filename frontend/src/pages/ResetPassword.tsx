import { FormEvent, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import {
  PASSWORD_GUIDANCE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordIssues,
} from "../utils/password";

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const navigate = useNavigate();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError("Passwords do not match");
    const issues = passwordIssues(password);
    if (issues.length > 0) return setError(`Password: ${issues[0]}.`);
    setError("");
    setLoading(true);
    try {
      await api.post("/auth/reset-password", { token, password });
      navigate("/login", { state: { message: "Password updated. You can now sign in." } });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Reset failed");
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>Reset Password</h1>
          <div className="error-box">Invalid or missing reset link.</div>
          <Link to="/forgot-password" className="btn" style={{ display: "block", textAlign: "center", marginTop: 12 }}>Request a new link</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Set New Password</h1>
        {error && <div className="error-box">{error}</div>}
        <div className="form-group">
          <label>New password</label>
          <div style={{ position: "relative" }}>
            <input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              autoComplete="new-password"
              required
              style={{ width: "100%", paddingRight: "2.5rem" }}
            />
            <button type="button" onClick={() => setShowPassword((s) => !s)}
              style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--text-muted)", fontSize: 13 }}>
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        <div className="form-group">
          <label>Confirm password</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            maxLength={PASSWORD_MAX_LENGTH}
            autoComplete="new-password"
            required
          />
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 0 }}>{PASSWORD_GUIDANCE}</p>
        <button className="btn" type="submit" disabled={loading} style={{ width: "100%" }}>
          {loading ? "Updating..." : "Update password"}
        </button>
      </form>
    </div>
  );
}
