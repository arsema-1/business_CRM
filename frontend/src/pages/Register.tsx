import { FormEvent, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import { executeRecaptcha } from "../utils/recaptcha";
import {
  PASSWORD_GUIDANCE,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordIssues,
  passwordStrength,
} from "../utils/password";

export default function Register() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const strength = useMemo(() => passwordStrength(password), [password]);
  const issues = useMemo(
    () => passwordIssues(password, { email, name }),
    [password, email, name]
  );

  const strengthLabel = ["", "Weak", "Fair", "Good", "Strong", "Very strong"][strength];
  const strengthColor = ["#e5e7eb", "#dc2626", "#f59e0b", "#eab308", "#16a34a", "#047857"][strength];

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (issues.length > 0) return setError(`Password: ${issues[0]}.`);
    if (password !== confirm) return setError("Passwords do not match.");

    setError("");
    setLoading(true);
    try {
      const recaptchaToken = await executeRecaptcha("register");
      await api.post("/auth/register", { name, email, password, recaptchaToken });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not create your account. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>Check your inbox</h1>
          <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 0 }}>
            We sent a verification link to <strong>{email}</strong>. Open it to verify your address.
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
            One more step after that: an administrator reviews new accounts before they can access
            the CRM. You will be able to sign in and see your approval status in the meantime.
          </p>
          <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
            The link is single-use. If it does not arrive within a few minutes, check your spam folder.
          </p>
          <Link to="/login" className="btn" style={{ display: "block", textAlign: "center" }}>
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Create your account</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 0 }}>
          We only ask for what is needed to sign you in.
        </p>
        {error && <div className="error-box">{error}</div>}

        <div className="form-group">
          <label>Full name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            maxLength={100}
            required
          />
        </div>

        <div className="form-group">
          <label>Work email</label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            maxLength={255}
            required
          />
        </div>

        <div className="form-group">
          <label>Password</label>
          <div style={{ position: "relative" }}>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              required
              style={{ width: "100%", paddingRight: "2.5rem" }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--text-muted)", fontSize: 13 }}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
          {password && (
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <div style={{ flex: 1, height: 4, background: "#e5e7eb", borderRadius: 999 }}>
                <div style={{ width: `${(strength / 5) * 100}%`, height: 4, background: strengthColor, borderRadius: 999, transition: "width .2s" }} />
              </div>
              <span style={{ color: strengthColor, minWidth: 64 }}>{strengthLabel}</span>
            </div>
          )}
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            {password && issues.length > 0 ? issues[0] : PASSWORD_GUIDANCE}
          </div>
        </div>

        <div className="form-group">
          <label>Confirm password</label>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            maxLength={PASSWORD_MAX_LENGTH}
            required
          />
        </div>

        <button className="btn" type="submit" disabled={loading} style={{ width: "100%" }}>
          {loading ? "Creating account..." : "Create account"}
        </button>

        <div style={{ marginTop: 12, textAlign: "center", fontSize: 13 }}>
          Already have an account?{" "}
          <Link to="/login" style={{ color: "var(--primary)" }}>Sign in</Link>
        </div>
      </form>
    </div>
  );
}
