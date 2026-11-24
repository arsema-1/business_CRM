import { useEffect, useState } from "react";
import { api, ApiClientError } from "../api/client";

interface AuditLog {
  id: string;
  userEmail?: string;
  userRole?: string;
  action: string;
  entity?: string;
  detail?: string;
  ipAddress?: string;
  method?: string;
  path?: string;
  severity?: string;
  success?: boolean;
  createdAt: string;
}

const ACTION_COLORS: Record<string, string> = {
  LOGIN_SUCCESS: "active",
  LOGIN_FAILED: "cancelled",
  LOGIN_BLOCKED_LOCKED: "cancelled",
  ACCOUNT_LOCKED: "cancelled",
  AUTHZ_DENIED: "cancelled",
  CSRF_REJECTED: "cancelled",
  SESSION_REJECTED: "cancelled",
  CUSTOMER_CREATED: "lead",
  CUSTOMER_UPDATED: "draft",
  FOLLOWUP_ADDED: "draft",
  USER_CREATED: "lead",
  USER_UPDATED: "draft",
  PASSWORD_RESET: "lead",
  ROLE_CHANGE_REQUESTED: "draft",
  ROLE_CHANGE_APPROVED: "confirmed",
  ROLE_CHANGE_REJECTED: "cancelled",
  ROLE_REVIEW_CYCLE: "active",
  SYSTEM_STARTUP: "active",
  SYSTEM_SHUTDOWN: "draft",
  SERVICE_FAILURE: "cancelled",
  AUDIT_LOGS_VIEWED: "lead",
};

const SEVERITY_STYLE: Record<string, { background: string; color: string }> = {
  INFO: { background: "#eef2ff", color: "#3730a3" },
  WARN: { background: "#fef3c7", color: "#92400e" },
  CRITICAL: { background: "#fee2e2", color: "#991b1b" },
};

const ACTIONS = [
  { value: "LOGIN_SUCCESS", label: "Login Success" },
  { value: "LOGIN_FAILED", label: "Login Failed" },
  { value: "LOGIN_MFA_REQUIRED", label: "Login — second factor required" },
  { value: "LOGOUT", label: "Logout" },
  { value: "AUTHZ_DENIED", label: "Authorization denied" },
  { value: "CSRF_REJECTED", label: "CSRF rejected" },
  { value: "SESSION_REJECTED", label: "Session rejected" },
  { value: "ACCOUNT_LOCKED", label: "Account locked" },
  { value: "REFRESH_TOKEN_REUSE", label: "Refresh token reuse" },
  { value: "MFA_ENABLED", label: "MFA enabled" },
  { value: "MFA_DISABLED", label: "MFA disabled" },
  { value: "MFA_RESET_BY_ADMIN", label: "MFA reset by admin" },
  { value: "CUSTOMER_CREATED", label: "Customer created" },
  { value: "CUSTOMER_UPDATED", label: "Customer updated" },
  { value: "FOLLOWUP_ADDED", label: "Follow-up added" },
  { value: "PRODUCT_CREATED", label: "Product created" },
  { value: "PRODUCT_UPDATED", label: "Product updated" },
  { value: "STOCK_MOVED", label: "Stock movement" },
  { value: "CHALLAN_CREATED", label: "Challan created" },
  { value: "CHALLAN_CONFIRMED", label: "Challan confirmed" },
  { value: "CHALLAN_CANCELLED", label: "Challan cancelled" },
  { value: "USER_CREATED", label: "User created" },
  { value: "USER_UPDATED", label: "User updated" },
  { value: "PASSWORD_RESET", label: "Password reset" },
  { value: "ROLE_CHANGE_REQUESTED", label: "Role change requested" },
  { value: "ROLE_CHANGE_APPROVED", label: "Role change approved" },
  { value: "ROLE_CHANGE_REJECTED", label: "Role change rejected" },
  { value: "ROLE_REVIEW_CYCLE", label: "Role review cycle" },
  { value: "AUDIT_LOGS_VIEWED", label: "Audit trail viewed" },
  { value: "SYSTEM_STARTUP", label: "System startup" },
  { value: "SYSTEM_SHUTDOWN", label: "System shutdown" },
  { value: "CONFIG_LOADED", label: "Configuration loaded" },
  { value: "SERVICE_FAILURE", label: "Service failure" },
];

export default function AuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [actionFilter, setActionFilter] = useState("");
  const [emailFilter, setEmailFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const params = new URLSearchParams({ page: String(page), limit: "50" });
    if (actionFilter) params.set("action", actionFilter);
    if (emailFilter) params.set("userEmail", emailFilter);
    if (severityFilter) params.set("severity", severityFilter);
    const res = await api.get(`/audit-logs?${params.toString()}`);
    setLogs(res.data);
    setTotalPages(res.pagination.totalPages || 1);
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load logs"));
  }, [page, actionFilter, emailFilter, severityFilter]);

  return (
    <div>
      <div className="page-header"><h2>Security Audit Logs</h2></div>
      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <div className="toolbar">
          <input
            placeholder="Filter by email..."
            value={emailFilter}
            onChange={(e) => { setPage(1); setEmailFilter(e.target.value); }}
            style={{ width: 200 }}
          />
          <select value={severityFilter} onChange={(e) => { setPage(1); setSeverityFilter(e.target.value); }}>
            <option value="">All severities</option>
            <option value="INFO">Info</option>
            <option value="WARN">Warning</option>
            <option value="CRITICAL">Critical</option>
          </select>
          <select value={actionFilter} onChange={(e) => { setPage(1); setActionFilter(e.target.value); }}>
            <option value="">All actions</option>
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </div>

        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>User</th>
              <th>Action</th>
              <th>Severity</th>
              <th>Detail</th>
              <th>Request</th>
              <th>IP Address</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => {
              const sev = (log.severity || "INFO").toUpperCase();
              const style = SEVERITY_STYLE[sev] || SEVERITY_STYLE.INFO;
              const isSystem = log.userEmail === "system";
              return (
                <tr key={log.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(log.createdAt).toLocaleString()}</td>
                  <td>
                    {isSystem ? (
                      <em style={{ color: "var(--text-muted)" }}>system</em>
                    ) : (
                      <>
                        {log.userEmail || "-"}
                        {log.userRole && (
                          <span style={{ color: "var(--text-muted)", fontSize: 12 }}> ({log.userRole})</span>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${ACTION_COLORS[log.action] || "draft"}`}>
                      {log.action.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td>
                    <span style={{ ...style, padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                      {sev}
                    </span>
                  </td>
                  <td>{log.detail || "-"}</td>
                  <td style={{ whiteSpace: "nowrap", color: "var(--text-muted)", fontSize: 12 }}>
                    {log.method && log.path ? `${log.method} ${log.path}` : "-"}
                  </td>
                  <td>{log.ipAddress || "-"}</td>
                </tr>
              );
            })}
            {logs.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--text-muted)" }}>No logs found</td></tr>
            )}
          </tbody>
        </table>

        <div className="toolbar" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span>Page {page} of {totalPages}</span>
          <button className="btn secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}
