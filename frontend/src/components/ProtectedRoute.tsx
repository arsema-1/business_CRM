import { Navigate, useNavigate } from "react-router-dom";
import { ReactNode } from "react";
import { useAuth } from "../context/AuthContext";

function PendingApproval() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>Awaiting approval</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 0 }}>
          Thanks for verifying <strong>{user?.email}</strong>. Your account has been created, but an
          administrator must approve it before you can access the CRM.
        </p>
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
          If you have already been approved, sign out and sign in again to pick up the change.
        </p>
        <button className="btn secondary" onClick={handleLogout} style={{ width: "100%" }}>
          Sign out
        </button>
      </div>
    </div>
  );
}

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  // Wait for the session check, otherwise a page reload would land here with no
  // user yet and wrongly redirect to /login.
  if (loading) return <div className="page-loading">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.pendingApproval) return <PendingApproval />;
  return <>{children}</>;
}
