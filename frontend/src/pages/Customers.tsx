import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import { useAuth } from "../context/AuthContext";

interface Customer {
  id: string;
  name: string;
  mobile: string;
  businessName?: string;
  customerType: string;
  status: string;
  followUpDate?: string;
}

const EMPTY_FORM = {
  name: "",
  mobile: "",
  email: "",
  businessName: "",
  gstNumber: "",
  customerType: "RETAIL",
  address: "",
  status: "LEAD",
  followUpDate: "",
  notes: "",
};

export default function Customers() {
  const { user } = useAuth();
  const canEdit = user?.role === "ADMIN" || user?.role === "SALES";

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // inline edit state: maps customer id -> { status, followUpDate }
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<{ status: string; followUpDate: string }>({ status: "", followUpDate: "" });
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load() {
    const params = new URLSearchParams({ page: String(page), limit: "20" });
    if (search) params.set("search", search);
    if (status) params.set("status", status);
    const res = await api.get(`/customers?${params.toString()}`);
    setCustomers(res.data);
    setTotalPages(res.pagination.totalPages || 1);
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load customers"));
  }, [page, search, status]);

  async function handleSubmit() {
    setError("");
    setLoading(true);
    try {
      await api.post("/customers", form);
      setForm(EMPTY_FORM);
      setShowForm(false);
      setPage(1);
      await load();
    } catch (e) {
      setError(e instanceof ApiClientError ? (e.details as string[])?.join(", ") || e.message : "Failed to save");
    } finally {
      setLoading(false);
    }
  }

  function startEdit(c: Customer) {
    setEditingId(c.id);
    setEditRow({
      status: c.status,
      followUpDate: c.followUpDate ? c.followUpDate.slice(0, 10) : "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function saveEdit(c: Customer) {
    setSavingId(c.id);
    try {
      await api.put(`/customers/${c.id}`, {
        name: c.name,
        mobile: c.mobile,
        status: editRow.status,
        followUpDate: editRow.followUpDate || null,
      });
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to update");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Customers</h2>
        {canEdit && (
          <button className="btn" onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "+ Add Customer"}
          </button>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}

      {showForm && (
        <div className="card">
          <div className="form-grid">
            <div className="form-group">
              <label>Name *</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Mobile *</label>
              <input value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Business Name</label>
              <input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} />
            </div>
            <div className="form-group">
              <label>GST Number</label>
              <input value={form.gstNumber} onChange={(e) => setForm({ ...form, gstNumber: e.target.value })} />
            </div>
            <div className="form-group">
              <label>Customer Type</label>
              <select value={form.customerType} onChange={(e) => setForm({ ...form, customerType: e.target.value })}>
                <option value="RETAIL">Retail</option>
                <option value="WHOLESALE">Wholesale</option>
                <option value="DISTRIBUTOR">Distributor</option>
              </select>
            </div>
            <div className="form-group">
              <label>Status</label>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="LEAD">Lead</option>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select>
            </div>
            <div className="form-group">
              <label>Follow-up Date</label>
              <input type="date" value={form.followUpDate} onChange={(e) => setForm({ ...form, followUpDate: e.target.value })} />
            </div>
            <div className="form-group" style={{ gridColumn: "1 / -1" }}>
              <label>Address</label>
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div className="form-group" style={{ gridColumn: "1 / -1" }}>
              <label>Notes</label>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <button className="btn" onClick={handleSubmit} disabled={loading}>
            {loading ? "Saving..." : "Save Customer"}
          </button>
        </div>
      )}

      <div className="card">
        <div className="toolbar">
          <input
            placeholder="Search name, mobile, email..."
            value={search}
            onChange={(e) => { setPage(1); setSearch(e.target.value); }}
          />
          <select
            value={status}
            onChange={(e) => { setPage(1); setStatus(e.target.value); }}
          >
            <option value="">All statuses</option>
            <option value="LEAD">Lead</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </div>

        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Mobile</th>
              <th>Business</th>
              <th>Type</th>
              <th>Status</th>
              <th>Follow-up</th>
              {canEdit && <th></th>}
            </tr>
          </thead>
          <tbody>
            {customers.map((c) =>
              editingId === c.id ? (
                <tr key={c.id} style={{ background: "#f8faff" }}>
                  <td><Link to={`/customers/${c.id}`}>{c.name}</Link></td>
                  <td>{c.mobile}</td>
                  <td>{c.businessName || "-"}</td>
                  <td>{c.customerType}</td>
                  <td>
                    <select
                      value={editRow.status}
                      onChange={(e) => setEditRow({ ...editRow, status: e.target.value })}
                      style={{ padding: "4px 6px", borderRadius: 4, border: "1px solid var(--border)", fontSize: 13 }}
                    >
                      <option value="LEAD">Lead</option>
                      <option value="ACTIVE">Active</option>
                      <option value="INACTIVE">Inactive</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="date"
                      value={editRow.followUpDate}
                      onChange={(e) => setEditRow({ ...editRow, followUpDate: e.target.value })}
                      style={{ padding: "4px 6px", borderRadius: 4, border: "1px solid var(--border)", fontSize: 13 }}
                    />
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        className="btn"
                        style={{ padding: "4px 10px", fontSize: 12 }}
                        disabled={savingId === c.id}
                        onClick={() => saveEdit(c)}
                      >
                        {savingId === c.id ? "..." : "Save"}
                      </button>
                      <button
                        className="btn secondary"
                        style={{ padding: "4px 10px", fontSize: 12 }}
                        onClick={cancelEdit}
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={c.id}>
                  <td><Link to={`/customers/${c.id}`}>{c.name}</Link></td>
                  <td>{c.mobile}</td>
                  <td>{c.businessName || "-"}</td>
                  <td>{c.customerType}</td>
                  <td><span className={`badge ${c.status.toLowerCase()}`}>{c.status}</span></td>
                  <td>{c.followUpDate ? new Date(c.followUpDate).toLocaleDateString() : "-"}</td>
                  {canEdit && (
                    <td>
                      <button
                        className="btn secondary"
                        style={{ padding: "4px 10px", fontSize: 12 }}
                        onClick={() => startEdit(c)}
                      >
                        Edit
                      </button>
                    </td>
                  )}
                </tr>
              )
            )}
            {customers.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 7 : 6} style={{ textAlign: "center", color: "#9ca3af" }}>
                  No customers found
                </td>
              </tr>
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
