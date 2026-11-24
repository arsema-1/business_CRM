import { NavLink, useNavigate } from "react-router-dom";
import { ReactNode } from "react";
import { useAuth } from "../context/AuthContext";

export default function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    // Revokes the session server-side before we navigate away
    await logout();
    navigate("/login");
  }

  const canSeeProducts =
    user?.role === "ADMIN" || user?.role === "WAREHOUSE" || user?.role === "SALES";

  const canSeeWarehouse = user?.role === "ADMIN" || user?.role === "WAREHOUSE";
  const canSeeAccounts  = user?.role === "ADMIN" || user?.role === "ACCOUNTS";

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>CRM</h1>
        <NavLink to="/dashboard" className={({ isActive }) => (isActive ? "active" : "")}>
          Dashboard
        </NavLink>
        <NavLink to="/customers" className={({ isActive }) => (isActive ? "active" : "")}>
          Customers
        </NavLink>
        <NavLink to="/challans" className={({ isActive }) => (isActive ? "active" : "")}>
          Sales Orders
        </NavLink>
        {canSeeProducts && (
          <NavLink to="/products" className={({ isActive }) => (isActive ? "active" : "")}>
            Products
          </NavLink>
        )}
        {canSeeWarehouse && (
          <NavLink to="/warehouse" className={({ isActive }) => (isActive ? "active" : "")}>
            Warehouse
          </NavLink>
        )}
        {canSeeAccounts && (
          <NavLink to="/accounts" className={({ isActive }) => (isActive ? "active" : "")}>
            Accounts
          </NavLink>
        )}
        {user?.role === "ADMIN" && (
          <>
            <NavLink to="/users" className={({ isActive }) => (isActive ? "active" : "")}>
              User Management
            </NavLink>
            <NavLink to="/audit-logs" className={({ isActive }) => (isActive ? "active" : "")}>
              Audit Logs
            </NavLink>
            <NavLink to="/monitoring" className={({ isActive }) => (isActive ? "active" : "")}>
              Security Monitoring
            </NavLink>
          </>
        )}
        <div className="user-info">
          <div>{user?.name}</div>
          <div>{user?.role}</div>
          <NavLink to="/profile" style={{ fontSize: 12, color: "#9ca3af", display: "block", marginTop: 6 }} className={({ isActive }) => isActive ? "active" : ""}>
            My Profile
          </NavLink>
          <button onClick={handleLogout} style={{ marginTop: 8, padding: "6px 0" }}>
            Log out
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
