import { FormEvent, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { startAuthentication } from "@simplewebauthn/browser";
import { api, ApiClientError } from "../api/client";
import { useAuth } from "../context/AuthContext";

export default function LoginPasskey() {
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Passkey sign-in bypasses login() (no password), but the server still sets
  // the same HttpOnly session cookies, so we just re-read the session.
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      // Step 1 — get options from server
      const optRes = await api.post("/auth/webauthn/login-options", { email });

      // Step 2 — trigger browser biometric prompt
      const authResponse = await startAuthentication({ optionsJSON: optRes.options });

      // Step 3 — verify on server; the session cookie comes back with it
      await api.post("/auth/webauthn/login-verify", { email, response: authResponse });

      await refreshUser();
      navigate("/dashboard", { replace: true });
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Passkey authentication was cancelled or timed out.");
      } else {
        setError("Passkey authentication failed");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Sign in with Passkey</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 0 }}>
          Use Face ID, Touch ID, Windows Hello, or a hardware security key.
        </p>
        {error && <div className="error-box">{error}</div>}
        <div className="form-group">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <button className="btn" type="submit" disabled={loading} style={{ width: "100%" }}>
          {loading ? "Waiting for authenticator…" : "Continue with passkey"}
        </button>
        <div style={{ marginTop: 12, textAlign: "center", fontSize: 13 }}>
          <Link to="/login" style={{ color: "var(--text-muted)" }}>Use password instead</Link>
        </div>
      </form>
    </div>
  );
}
