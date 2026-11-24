import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiClientError } from "../api/client";

interface Line { productId: string; quantity: string }

export default function ChallanCreate() {
  const navigate = useNavigate();
  const [customers, setCustomers] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [lines, setLines] = useState<Line[]>([{ productId: "", quantity: "1" }]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function load() {
      const [cRes, pRes] = await Promise.all([api.get("/customers?limit=100"), api.get("/products?limit=100")]);
      setCustomers(cRes.data);
      setProducts(pRes.data);
    }
    load().catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load form data"));
  }, []);

  function updateLine(index: number, field: keyof Line, value: string) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, [field]: value } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, { productId: "", quantity: "1" }]);
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(confirmImmediately: boolean) {
    setError("");
    if (!customerId) return setError("Please select a customer");
    const validLines = lines.filter((l) => l.productId && Number(l.quantity) > 0);
    if (validLines.length === 0) return setError("Add at least one product line with a quantity");

    setLoading(true);
    try {
      const res = await api.post("/challans", {
        customerId,
        items: validLines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })),
      });
      if (confirmImmediately) {
        await api.put(`/challans/${res.data.id}/confirm`);
      }
      navigate(`/challans/${res.data.id}`);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Failed to create challan");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header"><h2>New Sales Order</h2></div>
      {error && <div className="error-box">{error}</div>}

      <div className="card">
        <div className="form-group">
          <label>Customer *</label>
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">Select a customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name} {c.businessName ? `(${c.businessName})` : ""}</option>
            ))}
          </select>
        </div>

        <label style={{ fontSize: 13, color: "var(--text-muted)", fontWeight: 500 }}>Products</label>
        {lines.map((line, i) => {
          const product = products.find((p) => p.id === line.productId);
          return (
            <div className="item-row" key={i}>
              <select value={line.productId} onChange={(e) => updateLine(i, "productId", e.target.value)}>
                <option value="">Select product</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.sku}) - stock: {p.currentStock}</option>
                ))}
              </select>
              <input type="number" min={1} placeholder="Qty" value={line.quantity} onChange={(e) => updateLine(i, "quantity", e.target.value)} />
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {product ? `₹${(Number(product.unitPrice) * Number(line.quantity || 0)).toFixed(2)}` : ""}
              </div>
              <button className="btn secondary" onClick={() => removeLine(i)} disabled={lines.length === 1}>Remove</button>
            </div>
          );
        })}
        <button className="btn secondary" onClick={addLine} style={{ marginBottom: 16 }}>+ Add Product</button>

        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn secondary" onClick={() => handleSubmit(false)} disabled={loading}>
            Save as Draft
          </button>
          <button className="btn" onClick={() => handleSubmit(true)} disabled={loading}>
            Save &amp; Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
