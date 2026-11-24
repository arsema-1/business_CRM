import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Reset Password</h1>
        {submitted ? (
          <div>
            <div style={{ background: "#d1fae5", border: "1px solid #6ee7b7", color: "#065f46", padding: "12px 14px", borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
              If that email is registered you will receive a reset link shortly.
            </div>
            <Link to="/login" className="btn" style={{ display: "block", textAlign: "center" }}>Back to sign in</Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {error && <div className="error-box">{error}</div>}
            <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 0 }}>
              Enter your email address and we will send you a link to reset your password.
            </p>
            <div className="form-group">
              <label>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <button className="btn" type="submit" disabled={loading} style={{ width: "100%" }}>
              {loading ? "Sending..." : "Send reset link"}
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
