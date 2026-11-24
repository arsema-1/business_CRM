import { useEffect, useState } from "react";
import { api, ApiClientError } from "../api/client";

interface DailyPoint {
  day: string;
  total: number;
  failures: number;
  critical: number;
  loginFailures: number;
  loginBlocked: number;
  lockouts: number;
  authzDenials: number;
  csrfRejections: number;
  tokenReuse: number;
}

interface SecurityAlert {
  id: string;
  alertType: string;
  severity: string;
  team: string;
  title: string;
  detail: string;
  occurrences: number;
  notifiedAt: string | null;
  escalatedAt: string | null;
  acknowledgedAt?: string | null;
  createdAt: string;
}

interface SecurityTrends {
  window: { days: number; from: string; to: string };
  summary: {
    totalEvents: number;
    failures: number;
    critical: number;
    failedLogins: number;
    blockedLogins: number;
    lockouts: number;
    authzDenials: number;
    csrfRejections: number;
    tokenReuse: number;
  };
  severity: Record<string, number>;
  daily: DailyPoint[];
  topActions: { action: string; count: number }[];
  topActors: { userEmail: string | null; failures: number }[];
  recentCritical: {
    id: string;
    userEmail: string | null;
    userRole: string | null;
    action: string;
    entity: string | null;
    detail: string | null;
    severity: string;
    success: boolean;
    createdAt: string;
  }[];
  alerts: string[];
  alerting: {
    routing: {
      enabled: boolean;
      webhookConfigured: boolean;
      escalationAfterMinutes: number;
      runbookUrl: string;
      teams: { team: string; label: string; recipients: number }[];
    };
    openTotal: number;
    openBySeverity: Record<string, number>;
    recent: SecurityAlert[];
  };
  pipeline: {
    shipping: {
      enabled: boolean;
      endpointHost: string | null;
      source: string;
      queued: number;
      shipped: number;
      failedBatches: number;
      dropped: number;
      retryDelayMs: number;
      lastShippedAt: string | null;
      lastError: string | null;
    };
    retention: {
      appLogDays: number;
      auditLogDays: number;
      siemDays: number;
      sweepHours: number;
    };
    auditRetention: {
      policyDays: number;
      totalEntries: number;
      entriesBeyondRetention: number;
      oldestEntryAt: string | null;
      archiveDue: boolean;
      note: string;
    };
  };
}

const SEVERITY_STYLE: Record<string, { background: string; color: string }> = {
  INFO: { background: "#eef2ff", color: "#3730a3" },
  WARN: { background: "#fef3c7", color: "#92400e" },
  CRITICAL: { background: "#fee2e2", color: "#991b1b" },
};

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="card" style={{ marginBottom: 0, padding: 16 }}>
      <div style={{ fontSize: 12, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.03em" }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6, color: tone || "var(--text)" }}>{value}</div>
    </div>
  );
}

export default function Monitoring() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<SecurityTrends | null>(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);

  useEffect(() => {
    setError("");
    api
      .get(`/monitoring/security-trends?days=${days}`)
      .then((res) => setData(res.data))
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "Failed to load security trends"));
  }, [days, reloadKey]);

  async function acknowledge(id: string) {
    setAcknowledging(id);
    try {
      await api.post(`/monitoring/alerts/${id}/acknowledge`, {});
      setReloadKey((key) => key + 1);
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : "Could not acknowledge the alert");
    } finally {
      setAcknowledging(null);
    }
  }

  const maxDaily = data ? Math.max(...data.daily.map((d) => d.total), 1) : 1;
  const shipping = data?.pipeline.shipping;
  const retention = data?.pipeline.retention;
  const auditRetention = data?.pipeline.auditRetention;

  return (
    <div>
      <div className="page-header">
        <h2>Security Monitoring</h2>
        <div className="toolbar" style={{ margin: 0 }}>
          <label style={{ fontSize: 13, color: "var(--text-muted)" }}>Window</label>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {!data && !error && <div className="card">Loading security trends…</div>}

      {data && (
        <>
          {data.alerts.length > 0 && (
            <div className="card" style={{ borderLeft: "4px solid var(--warn)", marginBottom: 20 }}>
              <h3 style={{ marginTop: 0, color: "var(--warn)", fontSize: 15 }}>
                Attention ({data.alerts.length})
              </h3>
              <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7 }}>
                {data.alerts.map((alert) => (
                  <li key={alert}>{alert}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="card">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>
              Open security alerts ({data.alerting.openTotal})
            </h3>
            <table>
              <thead>
                <tr>
                  <th>Raised</th>
                  <th>Severity</th>
                  <th>Alert</th>
                  <th>Routed to</th>
                  <th style={{ textAlign: "right" }}>Seen</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.alerting.recent.map((alert) => {
                  const sev = (alert.severity || "MEDIUM").toUpperCase();
                  const style = SEVERITY_STYLE[sev] || SEVERITY_STYLE.WARN;
                  return (
                    <tr key={alert.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{new Date(alert.createdAt).toLocaleString()}</td>
                      <td>
                        <span style={{ ...style, padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                          {sev}
                        </span>
                      </td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{alert.title}</div>
                        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{alert.detail}</div>
                        {alert.escalatedAt && (
                          <div style={{ fontSize: 12, color: "var(--danger)" }}>
                            Escalated {new Date(alert.escalatedAt).toLocaleString()}
                            {alert.notifiedAt ? "" : " · primary delivery failed"}
                          </div>
                        )}
                      </td>
                      <td>{alert.team}</td>
                      <td style={{ textAlign: "right" }}>{alert.occurrences}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          onClick={() => acknowledge(alert.id)}
                          disabled={acknowledging === alert.id}
                          style={{ padding: "4px 10px", fontSize: 12 }}
                        >
                          {acknowledging === alert.id ? "…" : "Acknowledge"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {data.alerting.recent.length === 0 && (
                  <tr><td colSpan={6} style={{ color: "var(--text-muted)" }}>No open alerts</td></tr>
                )}
              </tbody>
            </table>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, lineHeight: 1.6 }}>
              Routing: {data.alerting.routing.teams.map((team) =>
                `${team.label} ${team.recipients > 0 ? `(${team.recipients})` : "(no email)"}`
              ).join(" · ")}
              {" · "}webhook {data.alerting.routing.webhookConfigured ? "configured" : "not configured"}
              {" · "}unacknowledged HIGH/CRITICAL alerts escalate after{" "}
              {data.alerting.routing.escalationAfterMinutes} minute(s).
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: 16,
              marginBottom: 20,
            }}
          >
            <Stat label="Audit events" value={data.summary.totalEvents} />
            <Stat label="Failures" value={data.summary.failures} tone="var(--danger)" />
            <Stat label="Failed sign-ins" value={data.summary.failedLogins} tone="var(--warn)" />
            <Stat label="Lockouts" value={data.summary.lockouts} tone="var(--warn)" />
            <Stat label="Denied requests" value={data.summary.authzDenials} />
            <Stat label="Critical events" value={data.summary.critical} tone="var(--danger)" />
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>Security events per day</h3>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 160, paddingTop: 8 }}>
              {data.daily.map((d) => {
                const height = Math.max((d.total / maxDaily) * 140, d.total > 0 ? 4 : 1);
                return (
                  <div
                    key={d.day}
                    title={
                      `${d.day}: ${d.total} event(s), ${d.failures} failure(s), ` +
                      `${d.critical} critical, ${d.loginFailures} failed sign-in(s)`
                    }
                    style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%" }}
                  >
                    <div
                      style={{
                        height,
                        background: d.critical > 0 ? "#b91c1c" : d.failures > 0 ? "#f59e0b" : "#93c5fd",
                        borderRadius: "3px 3px 0 0",
                        transition: "height 0.2s",
                      }}
                    />
                    {days <= 14 && (
                      <div style={{ fontSize: 10, color: "var(--text-muted)", textAlign: "center", marginTop: 4 }}>
                        {d.day.slice(5)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
              Blue = successful activity, amber = failures, red = at least one critical event.
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div className="card">
              <h3 style={{ marginTop: 0, fontSize: 15 }}>Most frequent actions</h3>
              <table>
                <thead>
                  <tr><th>Action</th><th style={{ textAlign: "right" }}>Count</th></tr>
                </thead>
                <tbody>
                  {data.topActions.map((a) => (
                    <tr key={a.action}>
                      <td>{a.action.replace(/_/g, " ")}</td>
                      <td style={{ textAlign: "right" }}>{a.count}</td>
                    </tr>
                  ))}
                  {data.topActions.length === 0 && (
                    <tr><td colSpan={2} style={{ color: "var(--text-muted)" }}>No activity in this window</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="card">
              <h3 style={{ marginTop: 0, fontSize: 15 }}>Actors with failed attempts</h3>
              <table>
                <thead>
                  <tr><th>Account</th><th style={{ textAlign: "right" }}>Failures</th></tr>
                </thead>
                <tbody>
                  {data.topActors.map((a) => (
                    <tr key={a.userEmail ?? "unknown"}>
                      <td>{a.userEmail || "unknown"}</td>
                      <td style={{ textAlign: "right" }}>{a.failures}</td>
                    </tr>
                  ))}
                  {data.topActors.length === 0 && (
                    <tr><td colSpan={2} style={{ color: "var(--text-muted)" }}>No failed attempts</td></tr>
                  )}
                </tbody>
              </table>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
                Severity mix: {Object.entries(data.severity).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}
              </div>
            </div>
          </div>

          <div className="card">
            <h3 style={{ marginTop: 0, fontSize: 15 }}>Recent warnings and critical events</h3>
            <table>
              <thead>
                <tr><th>Time</th><th>Account</th><th>Action</th><th>Severity</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {data.recentCritical.map((row) => {
                  const sev = (row.severity || "INFO").toUpperCase();
                  const style = SEVERITY_STYLE[sev] || SEVERITY_STYLE.INFO;
                  return (
                    <tr key={row.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{new Date(row.createdAt).toLocaleString()}</td>
                      <td>
                        {row.userEmail || "-"}
                        {row.userRole && (
                          <span style={{ color: "var(--text-muted)", fontSize: 12 }}> ({row.userRole})</span>
                        )}
                      </td>
                      <td><span className="badge draft">{row.action.replace(/_/g, " ")}</span></td>
                      <td>
                        <span style={{ ...style, padding: "2px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
                          {sev}
                        </span>
                      </td>
                      <td>{row.detail || "-"}</td>
                    </tr>
                  );
                })}
                {data.recentCritical.length === 0 && (
                  <tr><td colSpan={5} style={{ color: "var(--text-muted)" }}>Nothing flagged in this window</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div className="card">
              <h3 style={{ marginTop: 0, fontSize: 15 }}>Central log pipeline</h3>
              <table>
                <tbody>
                  <tr><td>Shipping to SIEM</td><td>{shipping?.enabled ? `enabled (${shipping.endpointHost})` : "disabled"}</td></tr>
                  <tr><td>Source</td><td>{shipping?.source}</td></tr>
                  <tr><td>Queued / shipped</td><td>{shipping?.queued} / {shipping?.shipped}</td></tr>
                  <tr><td>Failed batches</td><td style={{ color: shipping?.failedBatches ? "var(--danger)" : undefined }}>{shipping?.failedBatches}</td></tr>
                  <tr><td>Dropped records</td><td style={{ color: shipping?.dropped ? "var(--danger)" : undefined }}>{shipping?.dropped}</td></tr>
                  <tr><td>Last delivery</td><td>{shipping?.lastShippedAt ? new Date(shipping.lastShippedAt).toLocaleString() : "—"}</td></tr>
                </tbody>
              </table>
              {shipping?.lastError && (
                <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 8 }}>Last error: {shipping.lastError}</div>
              )}
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
                Records are batched and retried with backoff; requests never wait for the collector. Rate-limit
                alerts and 5xx bursts live in the SIEM stream, not this table.
              </div>
            </div>

            <div className="card">
              <h3 style={{ marginTop: 0, fontSize: 15 }}>Retention policy</h3>
              <table>
                <tbody>
                  <tr><td>Application log files</td><td>{retention?.appLogDays} days (auto-pruned)</td></tr>
                  <tr><td>Central collector copy</td><td>{retention?.siemDays} days (SIEM-configured)</td></tr>
                  <tr><td>Audit trail</td><td>{retention?.auditLogDays} days (immutable)</td></tr>
                  <tr><td>Sweep interval</td><td>every {retention?.sweepHours}h</td></tr>
                  <tr><td>Audit entries retained</td><td>{auditRetention?.totalEntries}</td></tr>
                  <tr>
                    <td>Past retention window</td>
                    <td style={{ color: auditRetention?.archiveDue ? "var(--warn)" : undefined }}>
                      {auditRetention?.entriesBeyondRetention}
                    </td>
                  </tr>
                </tbody>
              </table>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10, lineHeight: 1.6 }}>
                {auditRetention?.note} The audit table is append-only, so retention is enforced by encrypted
                archival — never by deleting chain links.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
