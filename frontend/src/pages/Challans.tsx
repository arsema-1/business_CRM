import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import { useAuth } from "../context/AuthContext";

interface Challan {
  id: string;
  challanNumber: string;
  status: string;
  totalQuantity: number;
  createdAt: string;
  customer: { id: string; name: string };
}

export default function Challans() {
  const { user } = useAuth();
  const canCreate = user?.role === "ADMIN" || user?.role === "SALES";

  const [challans, setChallans] = useState<Challan[]>([]);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState("");

  async function load() {
    const params = new URLSearchParams({ page: String(page), limit: "20" });
    if (status) params.set("status", status);
    if (search) params.set("search", search);
    const res = await api.get(`/challans?${params.toString()}`);
    setChallans(res.data);
    setTotalPages(res.pagination?.totalPages || 1);
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load"));
  }, [status, search, page]);

  return (
    <div>
      <div className="page-header">
        <h2>Sales Orders</h2>
        {canCreate && <Link className="btn" to="/challans/new">+ New Order</Link>}
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <div className="toolbar">
          <input
            placeholder="Search order # or customer..."
            value={search}
            onChange={(e) => { setPage(1); setSearch(e.target.value); }}
            style={{ flex: 1 }}
          />
          <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
        </div>
        <table>
          <thead>
            <tr>
              <th>Challan #</th>
              <th>Customer</th>
              <th>Total Qty</th>
              <th>Status</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {challans.map((c) => (
              <tr key={c.id}>
                <td><Link to={`/challans/${c.id}`}>{c.challanNumber}</Link></td>
                <td>{c.customer?.name}</td>
                <td>{c.totalQuantity}</td>
                <td><span className={`badge ${c.status.toLowerCase()}`}>{c.status}</span></td>
                <td>{new Date(c.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
            {challans.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", color: "#9ca3af" }}>No orders found</td>
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
