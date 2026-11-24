import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiClientError } from "../api/client";
import { useAuth } from "../context/AuthContext";

interface FollowUpCustomer {
  id: string;
  name: string;
  followUpDate: string;
  status: string;
}

interface DashboardData {
  customers: { total: number; leads: number; active: number };
  orders: { total: number; draft: number; confirmed: number };
  revenue: { total: number; thisMonth: number };
  followUps: { overdue: FollowUpCustomer[]; dueToday: FollowUpCustomer[] };
  recentCustomers: { id: string; name: string; businessName?: string; status: string; createdAt: string }[];
  recentOrders: { id: string; challanNumber: string; status: string; createdAt: string; customer: { id: string; name: string } }[];
}

function StatCard({ label, value, sub, highlight }: { label: string; value: string | number; sub?: string; highlight?: boolean }) {
  return (
    <div className="card" style={{ textAlign: "center", padding: "24px 20px" }}>
      <div style={{ fontSize: 28, fontWeight: 700, color: highlight ? "var(--success)" : "var(--primary)" }}>{value}</div>
      <div style={{ fontWeight: 600, marginTop: 4 }}>{label}</div>
      {sub && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function fmt(n: number) {
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

export default function Dashboard() {
  const { user } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get("/dashboard")
      .then((res) => setData(res.data))
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load dashboard"));
  }, []);

  if (error) return <div className="error-box">{error}</div>;
  if (!data) return <div>Loading...</div>;

  const totalFollowUpAlerts = data.followUps.overdue.length + data.followUps.dueToday.length;
  const showFollowUps = (user?.role === "ADMIN" || user?.role === "SALES") && totalFollowUpAlerts > 0;
  const showRevenue = user?.role === "ADMIN" || user?.role === "ACCOUNTS";

  return (
    <div>
      <div className="page-header"><h2>Dashboard</h2></div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 16, marginBottom: 20 }}>
        <StatCard label="Total Customers" value={data.customers.total} />
        <StatCard label="Leads" value={data.customers.leads} />
        <StatCard label="Active Customers" value={data.customers.active} />
        <StatCard label="Total Orders" value={data.orders.total} />
        <StatCard label="Draft Orders" value={data.orders.draft} />
        <StatCard label="Confirmed Orders" value={data.orders.confirmed} />
        {showRevenue && (
          <>
            <StatCard label="Total Revenue" value={fmt(data.revenue.total)} highlight />
            <StatCard label="Revenue This Month" value={fmt(data.revenue.thisMonth)} highlight />
          </>
        )}
      </div>

      {/* Follow-up reminders — only Sales/Admin */}
      {showFollowUps && (
        <div className="card" style={{ borderLeft: "4px solid var(--warn)", marginBottom: 20 }}>
          <h3 style={{ marginTop: 0, color: "var(--warn)" }}>
            Follow-up Reminders ({totalFollowUpAlerts})
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            {data.followUps.overdue.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "var(--danger)", marginBottom: 8 }}>
                  Overdue ({data.followUps.overdue.length})
                </div>
                {data.followUps.overdue.map((c) => (
                  <div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 14 }}>
                    <Link to={`/customers/${c.id}`}>{c.name}</Link>
                    <span style={{ color: "var(--danger)", fontSize: 12 }}>
                      {new Date(c.followUpDate).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {data.followUps.dueToday.length > 0 && (
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: "var(--warn)", marginBottom: 8 }}>
                  Due Today ({data.followUps.dueToday.length})
                </div>
                {data.followUps.dueToday.map((c) => (
                  <div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--border)", fontSize: 14 }}>
                    <Link to={`/customers/${c.id}`}>{c.name}</Link>
                    <span style={{ color: "var(--warn)", fontSize: 12 }}>Today</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Recent tables */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Recent Customers</h3>
          <table>
            <thead><tr><th>Name</th><th>Status</th></tr></thead>
            <tbody>
              {data.recentCustomers.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/customers/${c.id}`}>{c.name}{c.businessName ? ` (${c.businessName})` : ""}</Link></td>
                  <td><span className={`badge ${c.status.toLowerCase()}`}>{c.status}</span></td>
                </tr>
              ))}
              {data.recentCustomers.length === 0 && (
                <tr><td colSpan={2} style={{ color: "var(--text-muted)" }}>No customers yet</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3 style={{ marginTop: 0 }}>Recent Orders</h3>
          <table>
            <thead><tr><th>Order #</th><th>Customer</th><th>Status</th></tr></thead>
            <tbody>
              {data.recentOrders.map((o) => (
                <tr key={o.id}>
                  <td><Link to={`/challans/${o.id}`}>{o.challanNumber}</Link></td>
                  <td>{o.customer.name}</td>
                  <td><span className={`badge ${o.status.toLowerCase()}`}>{o.status}</span></td>
                </tr>
              ))}
              {data.recentOrders.length === 0 && (
                <tr><td colSpan={3} style={{ color: "var(--text-muted)" }}>No orders yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
