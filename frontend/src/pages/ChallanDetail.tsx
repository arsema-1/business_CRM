import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import { useAuth } from "../context/AuthContext";

export default function ChallanDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const canAct = user?.role === "ADMIN" || user?.role === "SALES";

  const [challan, setChallan] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    const res = await api.get(`/challans/${id}`);
    setChallan(res.data);
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load"));
  }, [id]);

  async function handleConfirm() {
    setError("");
    setLoading(true);
    try {
      await api.put(`/challans/${id}/confirm`);
      await load();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to confirm");
    } finally {
      setLoading(false);
    }
  }

  async function handleCancel() {
    setError("");
    setLoading(true);
    try {
      await api.put(`/challans/${id}/cancel`);
      await load();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to cancel");
    } finally {
      setLoading(false);
    }
  }

  if (!challan) return <div>Loading...</div>;

  const total = challan.items.reduce((sum: number, i: any) => sum + Number(i.unitPriceSnapshot) * i.quantity, 0);

  return (
    <div>
      <div className="page-header">
        <h2><Link to="/challans">Sales Orders</Link> / {challan.challanNumber}</h2>
        {canAct && challan.status === "DRAFT" && (
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn danger" onClick={handleCancel} disabled={loading}>Cancel</button>
            <button className="btn" onClick={handleConfirm} disabled={loading}>Confirm Order</button>
          </div>
        )}
        {canAct && challan.status === "CONFIRMED" && (
          <button className="btn danger" onClick={handleCancel} disabled={loading}>Cancel &amp; Revert</button>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="card form-grid">
        <div><strong>Customer:</strong> <Link to={`/customers/${challan.customer.id}`}>{challan.customer.name}</Link></div>
        <div><strong>Status:</strong> <span className={`badge ${challan.status.toLowerCase()}`}>{challan.status}</span></div>
        <div><strong>Total Quantity:</strong> {challan.totalQuantity}</div>
        <div><strong>Created:</strong> {new Date(challan.createdAt).toLocaleString()}</div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Line Items</h3>
        <table>
          <thead><tr><th>Product</th><th>SKU</th><th>Qty</th><th>Unit Price</th><th>Line Total</th></tr></thead>
          <tbody>
            {challan.items.map((item: any) => (
              <tr key={item.id}>
                <td>{item.productNameSnapshot}</td>
                <td>{item.productSkuSnapshot}</td>
                <td>{item.quantity}</td>
                <td>₹{Number(item.unitPriceSnapshot).toFixed(2)}</td>
                <td>₹{(Number(item.unitPriceSnapshot) * item.quantity).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={4} style={{ textAlign: "right", fontWeight: 600 }}>Total</td><td style={{ fontWeight: 600 }}>₹{total.toFixed(2)}</td></tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
