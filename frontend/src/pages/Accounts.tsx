import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Summary {
  revenueTotal: number;
  revenueThisMonth: number;
  revenueLastMonth: number;
  draftValue: number;
}

interface MonthlyRevenue {
  month: string; // "YYYY-MM"
  revenue: number;
}

interface TopCustomer {
  id: string;
  name: string;
  businessName?: string;
  revenue: number;
}

interface OrderRow {
  id: string;
  challanNumber: string;
  createdAt: string;
  customer: { id: string; name: string; businessName?: string };
  total: number;
  itemCount: number;
}

interface AccountsData {
  summary: Summary;
  monthlyRevenue: MonthlyRevenue[];
  topCustomers: TopCustomer[];
  recentConfirmed: OrderRow[];
  recentDraft: OrderRow[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function monthLabel(ym: string) {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleString("default", { month: "short", year: "2-digit" });
}

function SummaryCard({
  label, value, sub, color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="card" style={{ textAlign: "center", padding: "22px 16px" }}>
      <div style={{ fontSize: 26, fontWeight: 700, color: color ?? "var(--success)" }}>{value}</div>
      <div style={{ fontWeight: 600, marginTop: 4, fontSize: 14 }}>{label}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// Inline bar chart — no library needed
function RevenueChart({ data }: { data: MonthlyRevenue[] }) {
  const max = Math.max(...data.map((d) => d.revenue), 1);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120 }}>
        {data.map((d) => {
          const pct = (d.revenue / max) * 100;
          return (
            <div
              key={d.month}
              style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}
              title={`${monthLabel(d.month)}: ${fmt(d.revenue)}`}
            >
              <div
                style={{
                  width: "100%",
                  height: `${Math.max(pct, 2)}%`,
                  background: d.revenue > 0 ? "var(--primary)" : "var(--border)",
                  borderRadius: "3px 3px 0 0",
                  transition: "height 0.3s",
                }}
              />
            </div>
          );
        })}
      </div>
      {/* X-axis labels */}
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        {data.map((d) => (
          <div key={d.month} style={{ flex: 1, textAlign: "center", fontSize: 10, color: "var(--text-muted)" }}>
            {monthLabel(d.month)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

type Tab = "overview" | "confirmed" | "draft" | "customers";

export default function Accounts() {
  const [data, setData] = useState<AccountsData | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    api.get("/dashboard/accounts")
      .then((res) => setData(res.data))
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load accounts data"));
  }, []);

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <div>Loading...</div>;

  const { summary, monthlyRevenue, topCustomers, recentConfirmed, recentDraft } = data;

  const mom =
    summary.revenueLastMonth > 0
      ? (((summary.revenueThisMonth - summary.revenueLastMonth) / summary.revenueLastMonth) * 100).toFixed(1)
      : null;

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

  return (
    <div>
      <div className="page-header"><h2>Accounts</h2></div>

      {/* Summary cards — always visible */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 16, marginBottom: 24 }}>
        <SummaryCard label="Total Revenue" value={fmt(summary.revenueTotal)} />
        <SummaryCard
          label="This Month"
          value={fmt(summary.revenueThisMonth)}
          sub={mom !== null ? `${Number(mom) >= 0 ? "▲" : "▼"} ${Math.abs(Number(mom))}% vs last month` : undefined}
          color={mom !== null && Number(mom) >= 0 ? "var(--success)" : "var(--danger)"}
        />
        <SummaryCard label="Last Month" value={fmt(summary.revenueLastMonth)} color="var(--primary)" />
        <SummaryCard
          label="Draft / Pending"
          value={fmt(summary.draftValue)}
          sub="Value of unconfirmed orders"
          color="var(--warn)"
        />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border)", marginBottom: 0 }}>
        <button style={tabStyle("overview")} onClick={() => setTab("overview")}>Overview</button>
        <button style={tabStyle("confirmed")} onClick={() => setTab("confirmed")}>
          Confirmed Orders ({recentConfirmed.length})
        </button>
        <button style={tabStyle("draft")} onClick={() => setTab("draft")}>
          Draft Orders ({recentDraft.length})
        </button>
        <button style={tabStyle("customers")} onClick={() => setTab("customers")}>Top Customers</button>
      </div>

      {/* ── Overview tab ───────────────────────────────────────────────────── */}
      {tab === "overview" && (
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 20, marginTop: 0 }}>
          <div className="card" style={{ borderTopLeftRadius: 0 }}>
            <h3 style={{ marginTop: 0 }}>Revenue — Last 12 Months</h3>
            <RevenueChart data={monthlyRevenue} />
            <table style={{ marginTop: 20 }}>
              <thead>
                <tr><th>Month</th><th style={{ textAlign: "right" }}>Revenue</th></tr>
              </thead>
              <tbody>
                {[...monthlyRevenue].reverse().map((d) => (
                  <tr key={d.month}>
                    <td>{monthLabel(d.month)}</td>
                    <td style={{ textAlign: "right", fontWeight: d.revenue > 0 ? 600 : undefined, color: d.revenue > 0 ? "var(--success)" : "var(--text-muted)" }}>
                      {d.revenue > 0 ? fmt(d.revenue) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0 }}>Top Customers</h3>
            {topCustomers.length === 0 ? (
              <div style={{ color: "var(--text-muted)" }}>No revenue data yet</div>
            ) : (
              topCustomers.map((c, i) => (
                <div
                  key={c.id}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 14 }}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span style={{ color: "var(--text-muted)", fontSize: 12, width: 18 }}>#{i + 1}</span>
                    <div>
                      <Link to={`/customers/${c.id}`} style={{ fontWeight: 500 }}>{c.name}</Link>
                      {c.businessName && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{c.businessName}</div>
                      )}
                    </div>
                  </div>
                  <span style={{ fontWeight: 700, color: "var(--success)", fontSize: 13 }}>{fmt(c.revenue)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ── Confirmed Orders tab ───────────────────────────────────────────── */}
      {tab === "confirmed" && (
        <div className="card" style={{ borderTopLeftRadius: 0 }}>
          {recentConfirmed.length === 0 ? (
            <div style={{ color: "var(--text-muted)", padding: "20px 0", textAlign: "center" }}>No confirmed orders yet</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Order #</th>
                  <th>Customer</th>
                  <th>Items</th>
                  <th>Date</th>
                  <th style={{ textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {recentConfirmed.map((o) => (
                  <tr key={o.id}>
                    <td><Link to={`/challans/${o.id}`}>{o.challanNumber}</Link></td>
                    <td>
                      <Link to={`/customers/${o.customer.id}`}>{o.customer.name}</Link>
                      {o.customer.businessName && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{o.customer.businessName}</div>
                      )}
                    </td>
                    <td>{o.itemCount}</td>
                    <td style={{ fontSize: 13 }}>{new Date(o.createdAt).toLocaleDateString()}</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: "var(--success)" }}>{fmt(o.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} style={{ textAlign: "right", fontWeight: 600, paddingTop: 12 }}>Shown total</td>
                  <td style={{ textAlign: "right", fontWeight: 700, color: "var(--success)", paddingTop: 12 }}>
                    {fmt(recentConfirmed.reduce((s, o) => s + o.total, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}

      {/* ── Draft Orders tab ───────────────────────────────────────────────── */}
      {tab === "draft" && (
        <div className="card" style={{ borderTopLeftRadius: 0 }}>
          {recentDraft.length === 0 ? (
            <div style={{ color: "var(--text-muted)", padding: "20px 0", textAlign: "center" }}>No draft orders</div>
          ) : (
            <>
              <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 6, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#92400e" }}>
                These orders have not been confirmed yet. Total pending value: <strong>{fmt(summary.draftValue)}</strong>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Customer</th>
                    <th>Items</th>
                    <th>Created</th>
                    <th style={{ textAlign: "right" }}>Pending Value</th>
                  </tr>
                </thead>
                <tbody>
                  {recentDraft.map((o) => (
                    <tr key={o.id}>
                      <td><Link to={`/challans/${o.id}`}>{o.challanNumber}</Link></td>
                      <td>
                        <Link to={`/customers/${o.customer.id}`}>{o.customer.name}</Link>
                        {o.customer.businessName && (
                          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{o.customer.businessName}</div>
                        )}
                      </td>
                      <td>{o.itemCount}</td>
                      <td style={{ fontSize: 13 }}>{new Date(o.createdAt).toLocaleDateString()}</td>
                      <td style={{ textAlign: "right", fontWeight: 600, color: "var(--warn)" }}>{fmt(o.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} style={{ textAlign: "right", fontWeight: 600, paddingTop: 12 }}>Shown total</td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: "var(--warn)", paddingTop: 12 }}>
                      {fmt(recentDraft.reduce((s, o) => s + o.total, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </>
          )}
        </div>
      )}

      {/* ── Top Customers tab ──────────────────────────────────────────────── */}
      {tab === "customers" && (
        <div className="card" style={{ borderTopLeftRadius: 0 }}>
          {topCustomers.length === 0 ? (
            <div style={{ color: "var(--text-muted)", padding: "20px 0", textAlign: "center" }}>No revenue data yet</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Customer</th>
                  <th style={{ textAlign: "right" }}>Total Revenue</th>
                  <th style={{ textAlign: "right" }}>Share</th>
                </tr>
              </thead>
              <tbody>
                {topCustomers.map((c, i) => (
                  <tr key={c.id}>
                    <td style={{ color: "var(--text-muted)", width: 32 }}>{i + 1}</td>
                    <td>
                      <Link to={`/customers/${c.id}`} style={{ fontWeight: 500 }}>{c.name}</Link>
                      {c.businessName && (
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{c.businessName}</div>
                      )}
                    </td>
                    <td style={{ textAlign: "right", fontWeight: 700, color: "var(--success)" }}>{fmt(c.revenue)}</td>
                    <td style={{ textAlign: "right", fontSize: 13, color: "var(--text-muted)" }}>
                      {summary.revenueTotal > 0
                        ? ((c.revenue / summary.revenueTotal) * 100).toFixed(1) + "%"
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
