import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!token) { setStatus("error"); setMessage("No verification token found."); return; }
    api.get(`/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then((res) => { setStatus("success"); setMessage(res.message); })
      .catch((err) => { setStatus("error"); setMessage(err instanceof ApiClientError ? err.message : "Verification failed"); });
  }, [token]);

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Email Verification</h1>
        {status === "loading" && <div style={{ color: "var(--text-muted)" }}>Verifying…</div>}
        {status === "success" && (
          <>
            <div style={{ background: "#d1fae5", border: "1px solid #6ee7b7", color: "#065f46", padding: "12px 14px", borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
              {message}
            </div>
            <Link to="/login" className="btn" style={{ display: "block", textAlign: "center" }}>Sign in</Link>
          </>
        )}
        {status === "error" && (
          <>
            <div className="error-box">{message}</div>
            <Link to="/login" style={{ fontSize: 13, color: "var(--text-muted)" }}>Back to sign in</Link>
          </>
        )}
      </div>
    </div>
  );
}
