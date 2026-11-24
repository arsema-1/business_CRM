import { useEffect, useState } from "react";
import { api, ApiClientError } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { PASSWORD_MIN_LENGTH, passwordIssues } from "../utils/password";

// ─── Types ───────────────────────────────────────────────────────────────────

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  emailVerifiedAt?: string;
  createdAt: string;
  lastReviewedAt?: string;
  reviewDueAt?: string;
  selfRegistered?: boolean;
  approvedAt?: string;
}

interface RoleChangeRequest {
  id: string;
  fromRole: string;
  toRole: string;
  justification: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  reviewedAt?: string;
  reviewNote?: string;
  targetUser: { id: string; name: string; email: string; role: string };
  requestedBy: { id: string; name: string; email: string };
  reviewedBy?: { id: string; name: string; email: string };
}

interface ReviewStatus {
  overdue: User[];
  dueSoon: User[];
  neverReviewed: User[];
  all: User[];
}

type Tab = "users" | "role-changes" | "review";

const ROLES = ["ADMIN", "SALES", "WAREHOUSE", "ACCOUNTS"] as const;
const EMPTY_FORM = { name: "", email: "", password: "", role: "SALES" };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "APPROVED" ? "confirmed" :
    status === "REJECTED" ? "cancelled" :
    "draft";
  return <span className={`badge ${cls}`}>{status}</span>;
}

function RoleBadge({ role }: { role: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    ADMIN:     { bg: "#ede9fe", color: "#5b21b6" },
    SALES:     { bg: "#dbeafe", color: "#1e40af" },
    WAREHOUSE: { bg: "#fef3c7", color: "#92400e" },
    ACCOUNTS:  { bg: "#d1fae5", color: "#065f46" },
  };
  const s = colors[role] || { bg: "#f3f4f6", color: "#374151" };
  return (
    <span style={{ ...s, display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
      {role}
    </span>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const [tab, setTab] = useState<Tab>("users");

  // Users tab state
  const [users, setUsers] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});

  // Role changes tab state
  const [requests, setRequests] = useState<RoleChangeRequest[]>([]);
  const [rcFilter, setRcFilter] = useState<string>("PENDING");
  const [showRcForm, setShowRcForm] = useState(false);
  const [rcForm, setRcForm] = useState({ targetUserId: "", toRole: "SALES", justification: "" });
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});

  // Review tab state
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);

  // Shared
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  // ── Data loaders ──────────────────────────────────────────────────────────

  async function loadUsers() {
    const res = await api.get("/users");
    setUsers(res.data);
  }

  async function loadRequests() {
    const params = new URLSearchParams();
    if (rcFilter) params.set("status", rcFilter);
    const res = await api.get(`/role-changes?${params}`);
    setRequests(res.data);
  }

  async function loadReviewStatus() {
    const res = await api.get("/role-changes/review-status");
    setReviewStatus(res.data);
  }

  useEffect(() => {
    loadUsers().catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load users"));
  }, []);

  useEffect(() => {
    if (tab === "role-changes") {
      loadRequests().catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load requests"));
    } else if (tab === "review") {
      loadReviewStatus().catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load review status"));
    }
  }, [tab, rcFilter]);

  // ── Users tab handlers ────────────────────────────────────────────────────

  async function handleCreate() {
    const issues = passwordIssues(form.password, { email: form.email, name: form.name });
    if (issues.length > 0) return setError(`Password: ${issues[0]}.`);
    setError(""); setSuccess(""); setLoading(true);
    try {
      await api.post("/users", form);
      setForm(EMPTY_FORM);
      setShowForm(false);
      setSuccess("User created.");
      await loadUsers();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to create user");
    } finally { setLoading(false); }
  }

  async function toggleActive(u: User) {
    setError(""); setSuccess("");
    try {
      await api.put(`/users/${u.id}`, { isActive: !u.isActive });
      setSuccess(`User ${u.isActive ? "deactivated" : "activated"}.`);
      await loadUsers();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to update user");
    }
  }

  async function handleApproveUser(u: User) {
    setError(""); setSuccess("");
    try {
      await api.put(`/users/${u.id}/approve`, {});
      setSuccess(`Approved ${u.email}. They can use the CRM after signing in again.`);
      await loadUsers();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to approve user");
    }
  }

  async function handleResetPassword(userId: string) {
    const pw = resetPasswords[userId];
    const target = users.find((u) => u.id === userId);
    const issues = passwordIssues(pw || "", target ? { email: target.email, name: target.name } : {});
    if (issues.length > 0) return setError(`Password: ${issues[0]}.`);
    setError(""); setSuccess("");
    try {
      await api.put(`/users/${userId}/reset-password`, { password: pw });
      setResetPasswords((p) => ({ ...p, [userId]: "" }));
      setSuccess("Password updated.");
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to reset password");
    }
  }

  // ── Role change tab handlers ──────────────────────────────────────────────

  async function handleRequestRoleChange() {
    setError(""); setSuccess(""); setLoading(true);
    try {
      await api.post("/role-changes", rcForm);
      setRcForm({ targetUserId: "", toRole: "SALES", justification: "" });
      setShowRcForm(false);
      setSuccess("Role change request submitted.");
      await loadRequests();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to submit request");
    } finally { setLoading(false); }
  }

  async function handleApprove(id: string) {
    setError(""); setSuccess("");
    try {
      await api.put(`/role-changes/${id}/approve`, { reviewNote: reviewNotes[id] || "" });
      setSuccess("Request approved. Role has been updated.");
      setReviewNotes((n) => ({ ...n, [id]: "" }));
      await loadRequests();
      await loadUsers();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to approve");
    }
  }

  async function handleReject(id: string) {
    setError(""); setSuccess("");
    try {
      await api.put(`/role-changes/${id}/reject`, { reviewNote: reviewNotes[id] || "" });
      setSuccess("Request rejected.");
      setReviewNotes((n) => ({ ...n, [id]: "" }));
      await loadRequests();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to reject");
    }
  }

  // ── Review cycle handler ──────────────────────────────────────────────────

  async function handleTriggerReview() {
    if (!window.confirm("Mark all active users as reviewed now and set next review due in 90 days?")) return;
    setReviewLoading(true); setError(""); setSuccess("");
    try {
      const res = await api.post("/role-changes/review-cycle", {});
      setSuccess(res.message);
      await loadReviewStatus();
      await loadUsers();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to trigger review");
    } finally { setReviewLoading(false); }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: "8px 18px",
    borderRadius: "6px 6px 0 0",
    border: "1px solid var(--border)",
    borderBottom: tab === t ? "1px solid var(--surface)" : undefined,
    background: tab === t ? "var(--surface)" : "#f3f4f6",
    cursor: "pointer",
    fontWeight: tab === t ? 600 : 400,
    fontSize: 14,
    marginBottom: -1,
    position: "relative",
  });

  const pendingCount = requests.filter((r) => r.status === "PENDING").length;

  return (
    <div>
      <div className="page-header">
        <h2>User Management</h2>
      </div>

      {error && <div className="error-box">{error}</div>}
      {success && (
        <div style={{ background: "#d1fae5", border: "1px solid #6ee7b7", color: "#065f46", padding: "10px 14px", borderRadius: 6, marginBottom: 16, fontSize: 14 }}>
          {success}
        </div>
      )}

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, marginBottom: 0, borderBottom: "1px solid var(--border)" }}>
        <button style={tabStyle("users")} onClick={() => setTab("users")}>Users</button>
        <button style={tabStyle("role-changes")} onClick={() => { setTab("role-changes"); }}>
          Role Changes {pendingCount > 0 && tab !== "role-changes" && (
            <span style={{ background: "var(--danger)", color: "#fff", borderRadius: 999, padding: "1px 7px", fontSize: 11, marginLeft: 6 }}>
              {pendingCount}
            </span>
          )}
        </button>
        <button style={tabStyle("review")} onClick={() => setTab("review")}>Access Review</button>
      </div>

      {/* ── Users tab ──────────────────────────────────────────────────────── */}
      {tab === "users" && (
        <div className="card" style={{ borderTopLeftRadius: 0 }}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
            <button className="btn" onClick={() => setShowForm((s) => !s)}>
              {showForm ? "Cancel" : "+ Add User"}
            </button>
          </div>

          {showForm && (
            <div style={{ background: "#f8faff", border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBottom: 20 }}>
              <div className="form-grid">
                <div className="form-group">
                  <label>Name *</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Email *</label>
                  <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Password * (min {PASSWORD_MIN_LENGTH} chars)</label>
                  <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                </div>
                <div className="form-group">
                  <label>Role</label>
                  <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
              </div>
              <button className="btn" onClick={handleCreate} disabled={loading}>
                {loading ? "Creating..." : "Create User"}
              </button>
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last Reviewed</th>
                <th>Reset Password</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const reviewOverdue = u.reviewDueAt && new Date(u.reviewDueAt) < new Date();
                return (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td><RoleBadge role={u.role} /></td>
                    <td>
                      <span className={`badge ${u.isActive ? "active" : "inactive"}`}>
                        {u.isActive ? "Active" : "Inactive"}
                      </span>
                      {u.selfRegistered && !u.approvedAt && (
                        <div style={{ marginTop: 4 }}>
                          <span style={{ background: "#fef3c7", color: "#92400e", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
                            Pending approval
                          </span>
                        </div>
                      )}
                    </td>
                    <td>
                      {u.lastReviewedAt ? (
                        <span style={{ color: reviewOverdue ? "var(--danger)" : undefined, fontSize: 13 }}>
                          {new Date(u.lastReviewedAt).toLocaleDateString()}
                          {reviewOverdue && " ⚠"}
                        </span>
                      ) : (
                        <span style={{ color: "var(--danger)", fontSize: 13 }}>Never ⚠</span>
                      )}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <input
                          type="password"
                          placeholder="New password"
                          style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 13, width: 130 }}
                          value={resetPasswords[u.id] || ""}
                          onChange={(e) => setResetPasswords((p) => ({ ...p, [u.id]: e.target.value }))}
                        />
                        <button className="btn secondary" style={{ padding: "6px 10px", fontSize: 12 }} onClick={() => handleResetPassword(u.id)}>Reset</button>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        {u.selfRegistered && !u.approvedAt && (
                          <button
                            className="btn"
                            style={{ padding: "6px 10px", fontSize: 12 }}
                            disabled={!u.emailVerifiedAt}
                            title={u.emailVerifiedAt ? undefined : "Waiting for the user to verify their email"}
                            onClick={() => handleApproveUser(u)}
                          >
                            Approve
                          </button>
                        )}
                        <button
                          className={`btn ${u.isActive ? "danger" : "secondary"}`}
                          style={{ padding: "6px 10px", fontSize: 12 }}
                          disabled={u.id === currentUser?.id && u.isActive}
                          title={u.id === currentUser?.id ? "Cannot deactivate your own account" : undefined}
                          onClick={() => toggleActive(u)}
                        >
                          {u.isActive ? "Deactivate" : "Activate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: "center", color: "var(--text-muted)" }}>No users found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Role Changes tab ───────────────────────────────────────────────── */}
      {tab === "role-changes" && (
        <div className="card" style={{ borderTopLeftRadius: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>Filter:</span>
              {["PENDING", "APPROVED", "REJECTED", ""].map((s) => (
                <button
                  key={s || "all"}
                  className={`btn ${rcFilter === s ? "" : "secondary"}`}
                  style={{ padding: "4px 12px", fontSize: 12 }}
                  onClick={() => setRcFilter(s)}
                >
                  {s || "All"}
                </button>
              ))}
            </div>
            <button className="btn" onClick={() => setShowRcForm((v) => !v)}>
              {showRcForm ? "Cancel" : "+ New Request"}
            </button>
          </div>

          {showRcForm && (
            <div style={{ background: "#f8faff", border: "1px solid var(--border)", borderRadius: 8, padding: 16, marginBottom: 20 }}>
              <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-muted)" }}>
                Submit a role change request. A <strong>different</strong> Admin must approve it — you cannot approve your own requests.
              </p>
              <div className="form-grid">
                <div className="form-group">
                  <label>Target User *</label>
                  <select
                    value={rcForm.targetUserId}
                    onChange={(e) => setRcForm({ ...rcForm, targetUserId: e.target.value })}
                  >
                    <option value="">— select a user —</option>
                    {users
                      .filter((u) => u.id !== currentUser?.id && u.isActive)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name} ({u.email}) — currently {u.role}
                        </option>
                      ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>New Role *</label>
                  <select
                    value={rcForm.toRole}
                    onChange={(e) => setRcForm({ ...rcForm, toRole: e.target.value })}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div className="form-group" style={{ gridColumn: "1 / -1" }}>
                  <label>Justification * <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(business reason for the change)</span></label>
                  <textarea
                    rows={3}
                    value={rcForm.justification}
                    onChange={(e) => setRcForm({ ...rcForm, justification: e.target.value })}
                    placeholder="e.g. Promoted to warehouse manager role as of 2024-Q4"
                  />
                </div>
              </div>
              <button className="btn" onClick={handleRequestRoleChange} disabled={loading}>
                {loading ? "Submitting..." : "Submit Request"}
              </button>
            </div>
          )}

          {requests.length === 0 ? (
            <div style={{ color: "var(--text-muted)", padding: "20px 0", textAlign: "center" }}>
              No role change requests found
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Change</th>
                  <th>Requested By</th>
                  <th>Justification</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => {
                  const isMine = r.requestedBy.id === currentUser?.id;
                  const isPending = r.status === "PENDING";
                  return (
                    <tr key={r.id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{r.targetUser.name}</div>
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.targetUser.email}</div>
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <RoleBadge role={r.fromRole} />
                          <span style={{ color: "var(--text-muted)" }}>→</span>
                          <RoleBadge role={r.toRole} />
                        </div>
                      </td>
                      <td style={{ fontSize: 13 }}>{r.requestedBy.name}</td>
                      <td style={{ fontSize: 13, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.justification}>
                        {r.justification}
                      </td>
                      <td>
                        <StatusBadge status={r.status} />
                        {r.reviewedBy && (
                          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                            by {r.reviewedBy.name}
                          </div>
                        )}
                        {r.reviewNote && (
                          <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic", marginTop: 2 }}>
                            "{r.reviewNote}"
                          </div>
                        )}
                      </td>
                      <td style={{ fontSize: 13, whiteSpace: "nowrap" }}>
                        {new Date(r.createdAt).toLocaleDateString()}
                      </td>
                      <td>
                        {isPending && !isMine && (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <input
                              type="text"
                              placeholder="Note (optional)"
                              style={{ padding: "4px 6px", borderRadius: 4, border: "1px solid var(--border)", fontSize: 12, width: 150 }}
                              value={reviewNotes[r.id] || ""}
                              onChange={(e) => setReviewNotes((n) => ({ ...n, [r.id]: e.target.value }))}
                            />
                            <div style={{ display: "flex", gap: 4 }}>
                              <button
                                className="btn"
                                style={{ padding: "4px 10px", fontSize: 12 }}
                                onClick={() => handleApprove(r.id)}
                              >
                                Approve
                              </button>
                              <button
                                className="btn danger"
                                style={{ padding: "4px 10px", fontSize: 12 }}
                                onClick={() => handleReject(r.id)}
                              >
                                Reject
                              </button>
                            </div>
                          </div>
                        )}
                        {isPending && isMine && (
                          <span style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                            Awaiting another Admin
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Access Review tab ──────────────────────────────────────────────── */}
      {tab === "review" && (
        <div className="card" style={{ borderTopLeftRadius: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
            <div>
              <h3 style={{ margin: "0 0 4px" }}>Quarterly Access Review</h3>
              <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
                Review all active user roles and confirm access is still appropriate. Run this every 90 days.
              </p>
            </div>
            <button className="btn" onClick={handleTriggerReview} disabled={reviewLoading}>
              {reviewLoading ? "Processing..." : "✓ Complete Review Cycle"}
            </button>
          </div>

          {reviewStatus && (
            <>
              {/* Alert rows */}
              {(reviewStatus.overdue.length > 0 || reviewStatus.neverReviewed.length > 0) && (
                <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 16, marginBottom: 20 }}>
                  <div style={{ fontWeight: 600, color: "var(--danger)", marginBottom: 10 }}>
                    Action required — {reviewStatus.overdue.length + reviewStatus.neverReviewed.length} users need review
                  </div>
                  {reviewStatus.neverReviewed.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Never reviewed ({reviewStatus.neverReviewed.length})</div>
                      {reviewStatus.neverReviewed.map((u) => (
                        <div key={u.id} style={{ fontSize: 13, padding: "3px 0", display: "flex", gap: 10 }}>
                          <span>{u.name}</span>
                          <span style={{ color: "var(--text-muted)" }}>{u.email}</span>
                          <RoleBadge role={u.role} />
                        </div>
                      ))}
                    </div>
                  )}
                  {reviewStatus.overdue.length > 0 && (
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Review overdue ({reviewStatus.overdue.length})</div>
                      {reviewStatus.overdue.map((u) => (
                        <div key={u.id} style={{ fontSize: 13, padding: "3px 0", display: "flex", gap: 10 }}>
                          <span>{u.name}</span>
                          <span style={{ color: "var(--text-muted)" }}>{u.email}</span>
                          <RoleBadge role={u.role} />
                          <span style={{ color: "var(--danger)", fontSize: 12 }}>
                            Due {new Date(u.reviewDueAt!).toLocaleDateString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {reviewStatus.dueSoon.length > 0 && (
                <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 8, padding: 16, marginBottom: 20 }}>
                  <div style={{ fontWeight: 600, color: "var(--warn)", marginBottom: 8 }}>
                    Coming up — {reviewStatus.dueSoon.length} users due for review within 14 days
                  </div>
                  {reviewStatus.dueSoon.map((u) => (
                    <div key={u.id} style={{ fontSize: 13, padding: "3px 0", display: "flex", gap: 10 }}>
                      <span>{u.name}</span>
                      <span style={{ color: "var(--text-muted)" }}>{u.email}</span>
                      <RoleBadge role={u.role} />
                      <span style={{ color: "var(--warn)", fontSize: 12 }}>
                        Due {new Date(u.reviewDueAt!).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Full user table */}
              <h4 style={{ margin: "0 0 12px" }}>All Active Users</h4>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Last Reviewed</th>
                    <th>Next Review Due</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewStatus.all.map((u) => {
                    const overdue = u.reviewDueAt && new Date(u.reviewDueAt) < new Date();
                    return (
                      <tr key={u.id}>
                        <td>{u.name}</td>
                        <td>{u.email}</td>
                        <td><RoleBadge role={u.role} /></td>
                        <td style={{ fontSize: 13 }}>
                          {u.lastReviewedAt ? new Date(u.lastReviewedAt).toLocaleDateString() : (
                            <span style={{ color: "var(--danger)" }}>Never</span>
                          )}
                        </td>
                        <td style={{ fontSize: 13, color: overdue ? "var(--danger)" : undefined, fontWeight: overdue ? 600 : undefined }}>
                          {u.reviewDueAt ? new Date(u.reviewDueAt).toLocaleDateString() : (
                            <span style={{ color: "var(--text-muted)" }}>Not scheduled</span>
                          )}
                          {overdue && " ⚠"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
