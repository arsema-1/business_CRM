import { FormEvent, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api, ApiClientError } from "../api/client";
import { executeRecaptcha } from "../utils/recaptcha";

const DEMO_HINT = import.meta.env.VITE_DEMO_HINT as string | undefined;

export default function Login() {
  const { login, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Second step: the password was accepted, a code is still required. No session
  // exists until the code is verified.
  const [step, setStep] = useState<"password" | "mfa">("password");
  const [code, setCode] = useState("");
  const [usingBackupCode, setUsingBackupCode] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const recaptchaToken = await executeRecaptcha("login");
      const result = await login(email, password, recaptchaToken);
      if (result.mfaRequired) {
        setStep("mfa");
        return;
      }
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.post("/auth/mfa/verify", { code: code.trim() });
      const user = await refreshUser();
      if (!user) throw new ApiClientError(401, "Verification failed. Please sign in again.");
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  if (step === "mfa") {
    return (
      <div className="login-wrap">
        <form className="login-card" onSubmit={handleVerify}>
          <h1>Two-factor verification</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: -6 }}>
            Signed in as <strong>{email}</strong>. Enter the code from your authenticator app to finish signing in.
          </p>
          {error && <div className="error-box">{error}</div>}
          <div className="form-group">
            <label>{usingBackupCode ? "Backup code" : "6-digit code"}</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode={usingBackupCode ? "text" : "numeric"}
              autoComplete="one-time-code"
              autoFocus
              required
              maxLength={usingBackupCode ? 11 : 6}
              placeholder={usingBackupCode ? "XXXXX-XXXXX" : "123456"}
              style={{ letterSpacing: usingBackupCode ? 1 : 4, fontFamily: "monospace" }}
            />
          </div>
          <button className="btn" type="submit" disabled={loading} style={{ width: "100%" }}>
            {loading ? "Verifying..." : "Verify and sign in"}
          </button>

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 13 }}>
            <button
              type="button"
              onClick={() => {
                setUsingBackupCode((v) => !v);
                setCode("");
                setError("");
              }}
              style={{ background: "none", border: "none", padding: 0, color: "var(--primary)", cursor: "pointer", fontSize: 13 }}
            >
              {usingBackupCode ? "Use authenticator code" : "Use a backup code"}
            </button>
            <Link to="/mfa-recovery" style={{ color: "var(--text-muted)" }}>
              Lost your device?
            </Link>
          </div>

          <div style={{ marginTop: 12, textAlign: "center", fontSize: 13 }}>
            <button
              type="button"
              onClick={() => {
                setStep("password");
                setCode("");
                setError("");
              }}
              style={{ background: "none", border: "none", padding: 0, color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}
            >
              ← Start over
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>CRM Login</h1>
        {error && <div className="error-box">{error}</div>}
        <div className="form-group">
          <label>Email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
        </div>
        <div className="form-group">
          <label>Password</label>
          <div style={{ position: "relative" }}>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type={showPassword ? "text" : "password"}
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
        </div>
        <button className="btn" type="submit" disabled={loading} style={{ width: "100%" }}>
          {loading ? "Signing in..." : "Sign in"}
        </button>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 13 }}>
          <Link to="/forgot-password" style={{ color: "var(--text-muted)" }}>Forgot password?</Link>
          <Link to="/login-passkey" style={{ color: "var(--primary)" }}>Sign in with passkey →</Link>
        </div>
        <div style={{ marginTop: 10, textAlign: "center", fontSize: 13 }}>
          New here? <Link to="/register" style={{ color: "var(--primary)" }}>Create an account</Link>
        </div>
        {DEMO_HINT && <p className="hint">{DEMO_HINT}</p>}
      </form>
    </div>
  );
}
