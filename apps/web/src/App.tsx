import { useCallback, useEffect, useState } from "react";

type CapabilityState = "available" | "degraded" | "unavailable" | "unknown";

interface StatusPayload {
  schemaVersion: 1;
  product: {
    name: string;
    version: string;
    channel: "alpha";
    readOnly: true;
  };
  runtime: {
    platform: string;
    nodeVersion: string;
    codexVersion?: string;
  };
  compatibility: {
    state: "compatible" | "limited" | "unknown";
    summary: string;
  };
  capabilities: Array<{
    id: string;
    label: string;
    state: CapabilityState;
    detail?: string;
  }>;
  warnings: string[];
  generatedAt: string;
}

interface SnapshotsPayload {
  schemaVersion: 1;
  total: number;
  items: Array<{
    id: string;
    createdAt: string;
    fileCount?: number;
    byteCount?: number;
  }>;
  generatedAt: string;
}

interface DashboardData {
  status: StatusPayload;
  snapshots: SnapshotsPayload;
}

function ShieldMark(): React.JSX.Element {
  return (
    <svg aria-hidden="true" className="brand-mark" viewBox="0 0 48 48">
      <path d="M24 3 42 10v13c0 11.4-7.4 18.3-18 22C13.4 41.3 6 34.4 6 23V10L24 3Z" />
      <path d="m16.5 24.5 5 5 10-11" />
    </svg>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) {
    return "—";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Local API returned ${response.status}.`);
  }
  return (await response.json()) as T;
}

function StateBadge({ state }: { state: string }): React.JSX.Element {
  return <span className={`state-badge state-${state}`}>{state}</span>;
}

function Skeleton(): React.JSX.Element {
  return (
    <div aria-label="Loading dashboard" className="skeleton-grid" role="status">
      <div className="skeleton skeleton-wide" />
      <div className="skeleton" />
      <div className="skeleton" />
    </div>
  );
}

export function App(): React.JSX.Element {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshSequence, setRefreshSequence] = useState(0);

  const refresh = useCallback(() => setRefreshSequence((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      getJson<StatusPayload>(`/api/v1/status?refresh=${refreshSequence}`, controller.signal),
      getJson<SnapshotsPayload>(`/api/v1/snapshots?refresh=${refreshSequence}`, controller.signal),
    ])
      .then(([status, snapshots]) => setData({ status, snapshots }))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "The local API could not be reached.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [refreshSequence]);

  const state = data?.status.compatibility.state ?? "unknown";

  return (
    <div className="app-shell">
      <header className="topbar">
        <a aria-label="Codex Mantle home" className="brand" href="/">
          <ShieldMark />
          <span>Codex Mantle</span>
        </a>
        <div className="header-actions">
          <span className="alpha-badge">ALPHA</span>
          <span className="readonly-badge">
            <span aria-hidden="true">●</span> Read-only
          </span>
          <button className="refresh-button" disabled={loading} onClick={refresh} type="button">
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <main>
        <section className="hero">
          <div>
            <p className="eyebrow">LOCAL CONTROL PLANE</p>
            <h1>
              Your Codex setup,
              <br />
              visible and reversible.
            </h1>
            <p className="hero-copy">
              Inspect compatibility, capabilities, and recovery snapshots without sending local
              configuration to a remote service.
            </p>
          </div>
          <aside className="alpha-note">
            <span className="note-kicker">Preview boundary</span>
            <strong>This dashboard cannot change your configuration.</strong>
            <p>
              Alpha exposes evidence first. Apply and restore stay in the explicit CLI workflow.
            </p>
          </aside>
        </section>

        {error !== null && (
          <section aria-live="polite" className="error-panel">
            <div>
              <strong>Local service unavailable</strong>
              <p>{error}</p>
            </div>
            <button onClick={refresh} type="button">
              Try again
            </button>
          </section>
        )}

        {loading && data === null ? (
          <Skeleton />
        ) : data !== null ? (
          <>
            <section aria-label="System summary" className="summary-grid">
              <article className="summary-card primary-card">
                <div className="card-heading">
                  <span>Compatibility</span>
                  <StateBadge state={state} />
                </div>
                <p className="metric">
                  {state === "compatible" ? "Ready" : state === "limited" ? "Limited" : "Unknown"}
                </p>
                <p className="muted">{data.status.compatibility.summary}</p>
              </article>
              <article className="summary-card">
                <div className="card-heading">
                  <span>Codex</span>
                  <span className="signal-dot" />
                </div>
                <p className="metric mono">{data.status.runtime.codexVersion ?? "Not detected"}</p>
                <p className="muted">
                  Node {data.status.runtime.nodeVersion} · {data.status.runtime.platform}
                </p>
              </article>
              <article className="summary-card">
                <div className="card-heading">
                  <span>Recovery points</span>
                  <span className="signal-dot amber" />
                </div>
                <p className="metric">{data.snapshots.total}</p>
                <p className="muted">Verified local snapshot metadata</p>
              </article>
            </section>

            {data.status.warnings.length > 0 && (
              <section className="warning-strip">
                <strong>Attention</strong>
                <ul>
                  {data.status.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </section>
            )}

            <section className="content-grid">
              <article className="panel">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">CAPABILITY MAP</p>
                    <h2>What Mantle can verify</h2>
                  </div>
                  <span>{data.status.capabilities.length} signals</span>
                </div>
                {data.status.capabilities.length === 0 ? (
                  <div className="empty-state">
                    <strong>No capability report yet</strong>
                    <p>Run the compatibility probe, then refresh this page.</p>
                  </div>
                ) : (
                  <div className="capability-list">
                    {data.status.capabilities.map((capability) => (
                      <div className="capability-row" key={capability.id}>
                        <span className={`status-orb orb-${capability.state}`} />
                        <div>
                          <strong>{capability.label}</strong>
                          <p>{capability.detail ?? capability.id}</p>
                        </div>
                        <StateBadge state={capability.state} />
                      </div>
                    ))}
                  </div>
                )}
              </article>

              <article className="panel safety-panel">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">SAFETY MODEL</p>
                    <h2>Four hard edges</h2>
                  </div>
                </div>
                <ol className="safety-list">
                  <li>
                    <span>01</span>
                    <div>
                      <strong>Loopback only</strong>
                      <p>No LAN or public listener.</p>
                    </div>
                  </li>
                  <li>
                    <span>02</span>
                    <div>
                      <strong>Evidence before mutation</strong>
                      <p>Plan and snapshot precede apply.</p>
                    </div>
                  </li>
                  <li>
                    <span>03</span>
                    <div>
                      <strong>Drift aware</strong>
                      <p>Stale file hashes stop a write.</p>
                    </div>
                  </li>
                  <li>
                    <span>04</span>
                    <div>
                      <strong>No plugin execution</strong>
                      <p>Alpha validates manifests as data.</p>
                    </div>
                  </li>
                </ol>
              </article>
            </section>

            <section className="panel snapshots-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">RECOVERY LEDGER</p>
                  <h2>Recent snapshots</h2>
                </div>
                <span>Metadata only</span>
              </div>
              {data.snapshots.items.length === 0 ? (
                <div className="empty-state">
                  <strong>No snapshots found</strong>
                  <p>Your first guarded apply will create one before changing any file.</p>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Snapshot</th>
                        <th>Created</th>
                        <th>Files</th>
                        <th>Size</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.snapshots.items.map((snapshot) => (
                        <tr key={snapshot.id}>
                          <td className="mono">{snapshot.id}</td>
                          <td>{formatDate(snapshot.createdAt)}</td>
                          <td>{snapshot.fileCount ?? "—"}</td>
                          <td>{formatBytes(snapshot.byteCount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        ) : null}
      </main>

      <footer>
        <span>Codex Mantle {data?.status.product.version ?? "alpha"}</span>
        <span>Generated {data ? formatDate(data.status.generatedAt) : "locally"}</span>
      </footer>
    </div>
  );
}
