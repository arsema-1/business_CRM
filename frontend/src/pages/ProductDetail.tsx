import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import { useAuth } from "../context/AuthContext";

export default function ProductDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const canEdit = user?.role === "ADMIN" || user?.role === "WAREHOUSE";

  const [product, setProduct] = useState<any>(null);
  const [error, setError] = useState("");
  const [movement, setMovement] = useState({ quantity: "", movementType: "IN", reason: "" });

  async function load() {
    const res = await api.get(`/products/${id}`);
    setProduct(res.data);
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load"));
  }, [id]);

  async function handleMovement() {
    setError("");
    try {
      await api.post(`/products/${id}/stock`, {
        quantity: Number(movement.quantity),
        movementType: movement.movementType,
        reason: movement.reason,
      });
      setMovement({ quantity: "", movementType: "IN", reason: "" });
      await load();
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to record movement");
    }
  }

  if (!product) return <div>Loading...</div>;

  return (
    <div>
      <div className="page-header">
        <h2><Link to="/products">Products</Link> / {product.name}</h2>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="card form-grid">
        <div><strong>SKU:</strong> {product.sku}</div>
        <div><strong>Category:</strong> {product.category || "-"}</div>
        <div><strong>Unit Price:</strong> ₹{Number(product.unitPrice).toFixed(2)}</div>
        <div><strong>Current Stock:</strong> {product.currentStock}</div>
        <div><strong>Min Stock Alert:</strong> {product.minStockAlert}</div>
        <div><strong>Location:</strong> {product.location || "-"}</div>
      </div>

      {canEdit && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Record Stock Movement</h3>
          <div className="form-grid">
            <div className="form-group">
              <label>Type</label>
              <select value={movement.movementType} onChange={(e) => setMovement({ ...movement, movementType: e.target.value })}>
                <option value="IN">IN (stock received)</option>
                <option value="OUT">OUT (stock removed)</option>
              </select>
            </div>
            <div className="form-group">
              <label>Quantity</label>
              <input type="number" value={movement.quantity} onChange={(e) => setMovement({ ...movement, quantity: e.target.value })} />
            </div>
            <div className="form-group" style={{ gridColumn: "1 / -1" }}>
              <label>Reason</label>
              <input value={movement.reason} onChange={(e) => setMovement({ ...movement, reason: e.target.value })} placeholder="e.g. Purchase order received, damaged goods, stock correction" />
            </div>
          </div>
          <button className="btn" onClick={handleMovement}>Record Movement</button>
        </div>
      )}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Stock Movement Log</h3>
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>Qty</th><th>Reason</th></tr></thead>
          <tbody>
            {product.stockMovements?.map((m: any) => (
              <tr key={m.id}>
                <td>{new Date(m.createdAt).toLocaleString()}</td>
                <td><span className={`badge ${m.movementType === "IN" ? "active" : "cancelled"}`}>{m.movementType}</span></td>
                <td>{m.quantityChanged}</td>
                <td>{m.reason}</td>
              </tr>
            ))}
            {(!product.stockMovements || product.stockMovements.length === 0) && (
              <tr><td colSpan={4} style={{ textAlign: "center", color: "#9ca3af" }}>No movements yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
