import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";

interface StockMovement {
  id: string;
  movementType: "IN" | "OUT";
  quantityChanged: number;
  reason: string;
  createdAt: string;
  product: { id: string; name: string; sku: string };
}

interface Challan {
  id: string;
  challanNumber: string;
  createdAt: string;
  customer: { id: string; name: string };
  items: { id: string; productNameSnapshot: string; productSkuSnapshot: string; quantity: number }[];
}

interface LowStockProduct {
  id: string;
  name: string;
  sku: string;
  currentStock: number;
  minStockAlert: number;
  location?: string;
}

export default function Warehouse() {
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [confirmedChallans, setConfirmedChallans] = useState<Challan[]>([]);
  const [lowStock, setLowStock] = useState<LowStockProduct[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api.get("/products/movements?limit=20"),
      api.get("/challans?status=CONFIRMED&limit=20"),
      api.get("/products?lowStock=true&limit=50"),
    ])
      .then(([movRes, challanRes, lowStockRes]) => {
        setMovements(movRes.data);
        setConfirmedChallans(challanRes.data);
        setLowStock(lowStockRes.data.filter((p: LowStockProduct) => p.currentStock <= p.minStockAlert));
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load warehouse data"));
  }, []);

  return (
    <div>
      <div className="page-header"><h2>Warehouse</h2></div>
      {error && <div className="error-box">{error}</div>}

      {/* Low stock alerts */}
      {lowStock.length > 0 && (
        <div className="card" style={{ borderLeft: "4px solid var(--danger)", marginBottom: 20 }}>
          <h3 style={{ marginTop: 0, color: "var(--danger)" }}>Low Stock Alerts ({lowStock.length})</h3>
          <table>
            <thead>
              <tr><th>Product</th><th>SKU</th><th>Stock</th><th>Min Alert</th><th>Location</th></tr>
            </thead>
            <tbody>
              {lowStock.map((p) => (
                <tr key={p.id}>
                  <td><Link to={`/products/${p.id}`}>{p.name}</Link></td>
                  <td>{p.sku}</td>
                  <td style={{ color: "var(--danger)", fontWeight: 600 }}>{p.currentStock}</td>
                  <td>{p.minStockAlert}</td>
                  <td>{p.location || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* Confirmed orders pending dispatch */}
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Confirmed Orders</h3>
          {confirmedChallans.length === 0 ? (
            <div style={{ color: "var(--text-muted)" }}>No confirmed orders</div>
          ) : (
            <table>
              <thead>
                <tr><th>Order #</th><th>Customer</th><th>Items</th><th>Date</th></tr>
              </thead>
              <tbody>
                {confirmedChallans.map((c) => (
                  <tr key={c.id}>
                    <td><Link to={`/challans/${c.id}`}>{c.challanNumber}</Link></td>
                    <td>{c.customer.name}</td>
                    <td>{c.items.length}</td>
                    <td>{new Date(c.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Recent stock movements */}
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Recent Stock Movements</h3>
          {movements.length === 0 ? (
            <div style={{ color: "var(--text-muted)" }}>No movements recorded</div>
          ) : (
            <table>
              <thead>
                <tr><th>Product</th><th>Type</th><th>Qty</th><th>Reason</th><th>Date</th></tr>
              </thead>
              <tbody>
                {movements.map((m) => (
                  <tr key={m.id}>
                    <td><Link to={`/products/${m.product.id}`}>{m.product.name}</Link></td>
                    <td>
                      <span className={`badge ${m.movementType === "IN" ? "confirmed" : "cancelled"}`}>
                        {m.movementType}
                      </span>
                    </td>
                    <td>{m.quantityChanged}</td>
                    <td style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.reason}</td>
                    <td>{new Date(m.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
