import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import { useAuth } from "../context/AuthContext";

export default function CustomerDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const canEdit = user?.role === "ADMIN" || user?.role === "SALES";

  const [customer, setCustomer] = useState<any>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<any>(null);

  async function load() {
    const res = await api.get(`/customers/${id}`);
    setCustomer(res.data);
    setForm(res.data);
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load"));
  }, [id]);

  async function handleAddNote() {
    if (!note.trim()) return;
    try {
      await api.post(`/customers/${id}/followups`, { note });
      setNote("");
      await load();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to add note");
    }
  }

  async function handleSave() {
    try {
      await api.put(`/customers/${id}`, form);
      setEditing(false);
      await load();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to save");
    }
  }

  if (!customer) return <div>Loading...</div>;

  return (
    <div>
      <div className="page-header">
        <h2><Link to="/customers">Customers</Link> / {customer.name}</h2>
        {canEdit && (
          <button className="btn secondary" onClick={() => setEditing((e) => !e)}>
            {editing ? "Cancel" : "Edit"}
          </button>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        {editing ? (
          <div>
            <div className="form-grid">
              <div className="form-group">
                <label>Name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Mobile</label>
                <input value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
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
                <label>Customer Type</label>
                <select value={form.customerType} onChange={(e) => setForm({ ...form, customerType: e.target.value })}>
                  <option value="RETAIL">Retail</option>
                  <option value="WHOLESALE">Wholesale</option>
                  <option value="DISTRIBUTOR">Distributor</option>
                </select>
              </div>
            </div>
            <button className="btn" onClick={handleSave}>Save</button>
          </div>
        ) : (
          <div className="form-grid">
            <div><strong>Mobile:</strong> {customer.mobile}</div>
            <div><strong>Email:</strong> {customer.email || "-"}</div>
            <div><strong>Business:</strong> {customer.businessName || "-"}</div>
            <div><strong>GST:</strong> {customer.gstNumber || "-"}</div>
            <div><strong>Type:</strong> {customer.customerType}</div>
            <div><strong>Status:</strong> <span className={`badge ${customer.status.toLowerCase()}`}>{customer.status}</span></div>
            <div><strong>Address:</strong> {customer.address || "-"}</div>
            <div><strong>Follow-up:</strong> {customer.followUpDate ? new Date(customer.followUpDate).toLocaleDateString() : "-"}</div>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Follow-up Notes</h3>
        {canEdit && (
          <div className="toolbar">
            <input style={{ flex: 1 }} placeholder="Add a follow-up note..." value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn" onClick={handleAddNote}>Add</button>
          </div>
        )}
        {customer.followUps?.length ? (
          customer.followUps.map((f: any) => (
            <div key={f.id} style={{ borderBottom: "1px solid var(--border)", padding: "8px 0" }}>
              <div>{f.note}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{new Date(f.createdAt).toLocaleString()}</div>
            </div>
          ))
        ) : (
          <div style={{ color: "var(--text-muted)" }}>No follow-up notes yet</div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Sales Orders</h3>
        {customer.challans?.length ? (
          <table>
            <thead><tr><th>Number</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              {customer.challans.map((c: any) => (
                <tr key={c.id}>
                  <td><Link to={`/challans/${c.id}`}>{c.challanNumber}</Link></td>
                  <td><span className={`badge ${c.status.toLowerCase()}`}>{c.status}</span></td>
                  <td>{new Date(c.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ color: "var(--text-muted)" }}>No challans yet</div>
        )}
      </div>
    </div>
  );
}
