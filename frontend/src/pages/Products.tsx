import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import { useAuth } from "../context/AuthContext";

const EMPTY_FORM = { name: "", sku: "", category: "", unitPrice: "", currentStock: "0", minStockAlert: "0", location: "" };

export default function Products() {
  const { user } = useAuth();
  const canEdit = user?.role === "ADMIN" || user?.role === "WAREHOUSE";

  const [products, setProducts] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [lowStock, setLowStock] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState("");

  async function load() {
    const params = new URLSearchParams({ limit: "50" });
    if (search) params.set("search", search);
    if (lowStock) params.set("lowStock", "true");
    const res = await api.get(`/products?${params.toString()}`);
    setProducts(res.data);
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load"));
  }, [search, lowStock]);

  async function handleSubmit() {
    setError("");
    try {
      await api.post("/products", {
        ...form,
        unitPrice: Number(form.unitPrice),
        currentStock: Number(form.currentStock),
        minStockAlert: Number(form.minStockAlert),
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (e) {
      setError(e instanceof ApiClientError ? (e.details as string[])?.join(", ") || e.message : "Failed to save");
    }
  }

  return (
    <div>
      <div className="page-header">
        <h2>Products &amp; Inventory</h2>
        {canEdit && (
          <button className="btn" onClick={() => setShowForm((s) => !s)}>
            {showForm ? "Cancel" : "+ Add Product"}
          </button>
        )}
      </div>

      {error && <div className="error-box">{error}</div>}

      {showForm && (
        <div className="card">
          <div className="form-grid">
            <div className="form-group"><label>Name *</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="form-group"><label>SKU *</label><input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} /></div>
            <div className="form-group"><label>Category</label><input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></div>
            <div className="form-group"><label>Unit Price *</label><input type="number" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} /></div>
            <div className="form-group"><label>Opening Stock</label><input type="number" value={form.currentStock} onChange={(e) => setForm({ ...form, currentStock: e.target.value })} /></div>
            <div className="form-group"><label>Min Stock Alert</label><input type="number" value={form.minStockAlert} onChange={(e) => setForm({ ...form, minStockAlert: e.target.value })} /></div>
            <div className="form-group"><label>Warehouse Location</label><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} /></div>
          </div>
          <button className="btn" onClick={handleSubmit}>Save Product</button>
        </div>
      )}

      <div className="card">
        <div className="toolbar">
          <input placeholder="Search name, SKU, category..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={lowStock} onChange={(e) => setLowStock(e.target.checked)} />
            Low stock only
          </label>
        </div>
        <table>
          <thead><tr><th>Name</th><th>SKU</th><th>Category</th><th>Price</th><th>Stock</th><th>Min Alert</th><th>Location</th></tr></thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id}>
                <td><Link to={`/products/${p.id}`}>{p.name}</Link></td>
                <td>{p.sku}</td>
                <td>{p.category || "-"}</td>
                <td>₹{Number(p.unitPrice).toFixed(2)}</td>
                <td style={{ color: p.currentStock <= p.minStockAlert ? "var(--danger)" : undefined, fontWeight: p.currentStock <= p.minStockAlert ? 600 : undefined }}>
                  {p.currentStock}
                </td>
                <td>{p.minStockAlert}</td>
                <td>{p.location || "-"}</td>
              </tr>
            ))}
            {products.length === 0 && <tr><td colSpan={7} style={{ textAlign: "center", color: "#9ca3af" }}>No products found</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
