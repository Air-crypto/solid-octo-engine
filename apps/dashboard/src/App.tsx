import { useCallback, useEffect, useMemo, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import type {
  DeskMode,
  DeskEvent,
  ManualPending,
  PortfolioMark,
  PortfolioPosition,
  PublicConfig,
  Role,
  Snapshot,
} from "./types";

const ROLES: Array<{ role: Role; label: string; description: string }> = [
  {
    role: "scout",
    label: "SCOUT",
    description: "Mint stream and threshold crossings",
  },
  {
    role: "sniper",
    label: "SNIPER",
    description: "Exact-mint intents and execution",
  },
  { role: "risk", label: "RISK", description: "Fail-closed on-chain checks" },
  {
    role: "rug",
    label: "RUG",
    description: "Creator and lifecycle monitoring",
  },
  {
    role: "whale",
    label: "WHALE",
    description: "Holder and wallet concentration",
  },
  {
    role: "exit",
    label: "EXIT",
    description: "Loss stop, scale-out, trail, and time stop",
  },
  {
    role: "finance",
    label: "FINANCE",
    description: "Positions and durable ledger",
  },
  {
    role: "head",
    label: "HEAD OF DESK",
    description: "Controls and exceptions",
  },
];

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [pending, setPending] = useState<ManualPending[]>([]);
  const [events, setEvents] = useState<DeskEvent[]>([]);
  const [armToken, setArmToken] = useState("");
  const [message, setMessage] = useState("Connecting…");
  const [portfolioMode, setPortfolioMode] = useState<DeskMode | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const refresh = useCallback(async () => {
    const [snapshotResponse, configResponse, pendingResponse] =
      await Promise.all([
        fetch("/api/snapshot"),
        fetch("/api/config"),
        fetch("/api/manual/pending"),
      ]);
    const nextSnapshot = (await snapshotResponse.json()) as Snapshot;
    setSnapshot(nextSnapshot);
    setPortfolioMode((current) => current ?? nextSnapshot.mode);
    setConfig((await configResponse.json()) as PublicConfig);
    setPending((await pendingResponse.json()) as ManualPending[]);
    setEvents(nextSnapshot.events);
    setMessage("Live");
  }, []);

  useEffect(() => {
    void refresh().catch((error) =>
      setMessage(error instanceof Error ? error.message : String(error)),
    );
    const stream = new EventSource("/api/events");
    stream.onmessage = ({ data }) => {
      const event = JSON.parse(data) as DeskEvent;
      setEvents((current) => [...current.slice(-149), event]);
      if (
        event.type.startsWith("execution.") ||
        event.type.startsWith("position.") ||
        event.type.startsWith("control.")
      )
        void refresh();
    };
    stream.onerror = () => setMessage("Event stream reconnecting");
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      stream.close();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const latestByRole = useMemo(() => {
    const map = new Map<Role, DeskEvent>();
    for (const event of events) map.set(event.role, event);
    return map;
  }, [events]);

  async function post(path: string, body?: unknown) {
    const response = await fetch(path, {
      body: body ? JSON.stringify(body) : undefined,
      headers: body ? { "content-type": "application/json" } : undefined,
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? `request failed ${response.status}`);
    await refresh();
    return result;
  }

  async function signWithPhantom(item: ManualPending) {
    try {
      const provider = window.phantom?.solana;
      if (!provider?.isPhantom)
        throw new Error("Phantom extension is not available");
      const connection = await provider.connect();
      const address = connection.publicKey.toBase58();
      if (
        !config?.expectedSignerPublicKey ||
        address !== config.expectedSignerPublicKey ||
        address !== item.intent.wallet
      ) {
        throw new Error(
          `Connected address ${short(address)} does not match the configured desk wallet`,
        );
      }
      const transaction = VersionedTransaction.deserialize(
        base64ToBytes(item.execution.transactionBase64),
      );
      const sent = await provider.signAndSendTransaction(transaction);
      const signature = typeof sent === "string" ? sent : sent.signature;
      await post(`/api/manual/${item.execution.intentId}/confirm`, {
        signature,
      });
      setMessage(`Confirmed ${short(signature)}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  if (!snapshot || !config) return <main className="loading">{message}</main>;
  const armed =
    snapshot.armedUntilMs !== null && snapshot.armedUntilMs > Date.now();
  const ready = snapshot.readiness.canArm;
  const recentRpcLimit =
    snapshot.rpc.last429AtMs !== null &&
    Date.now() - snapshot.rpc.last429AtMs < 60_000;
  const selectedMode = portfolioMode ?? snapshot.mode;
  const portfolioSummary = snapshot.portfolio.summaries[selectedMode];
  const portfolioPositions = snapshot.portfolio.positions
    .filter(
      (position) =>
        position.mode === selectedMode &&
        position.wallet === portfolioSummary.wallet &&
        (showClosed || position.status !== "closed"),
    )
    .sort((a, b) => b.entryTimeMs - a.entryTimeMs);

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">SOLID OCTO ENGINE</p>
          <h1>Deterministic mint desk</h1>
        </div>
        <div className="status-strip">
          <Status
            label="MODE"
            value={
              snapshot.mode === "live" && !ready
                ? "LIVE / BLOCKED"
                : snapshot.mode.toUpperCase()
            }
            tone={snapshot.mode === "live" ? "danger" : "safe"}
          />
          <Status
            label="READY"
            value={ready ? "YES" : "NO"}
            tone={ready ? "safe" : "warn"}
          />
          <Status
            label="LEASE"
            value={armed ? "ARMED" : "DISARMED"}
            tone={armed ? "warn" : "muted"}
          />
          <Status
            label="KILL"
            value={snapshot.killSwitch ? "ENGAGED" : "CLEAR"}
            tone={snapshot.killSwitch ? "danger" : "safe"}
          />
          <Status
            label="STREAM"
            value={message}
            tone={message === "Live" ? "safe" : "warn"}
          />
        </div>
      </header>

      <section className="role-grid">
        {ROLES.map(({ role, label, description }) => (
          <RoleCard
            key={role}
            role={role}
            label={label}
            description={description}
            event={latestByRole.get(role)}
          />
        ))}
      </section>

      <section className="split">
        <article className="panel controls">
          <div className="panel-heading">
            <h2>Control plane</h2>
            <span>Local approval only</span>
          </div>
          <input
            type="password"
            autoComplete="off"
            placeholder="Arm token (never a wallet secret)"
            value={armToken}
            onChange={(event) => setArmToken(event.target.value)}
          />
          <div className="button-row">
            <button
              className="primary"
              disabled={!ready}
              onClick={() =>
                void post("/api/control/arm", {
                  leaseMs: 15 * 60_000,
                  token: armToken,
                }).catch(showError(setMessage))
              }
            >
              Arm 15m
            </button>
            <button
              onClick={() =>
                void post("/api/control/disarm").catch(showError(setMessage))
              }
            >
              Disarm
            </button>
            <button
              className="kill"
              onClick={() =>
                void post("/api/control/kill").catch(showError(setMessage))
              }
            >
              Kill
            </button>
            <button
              onClick={() =>
                void post("/api/control/release", { token: armToken }).catch(
                  showError(setMessage),
                )
              }
            >
              Release kill
            </button>
          </div>
          <p className="note">
            Wallet passwords and recovery phrases are never accepted by this
            application.
          </p>
          {!ready && (
            <p className="note">
              Arm blocked: {snapshot.readiness.reasons.join(" · ")}
            </p>
          )}
        </article>

        <article className="panel health">
          <div className="panel-heading">
            <h2>Health</h2>
            <span>Independent gates</span>
          </div>
          {Object.entries(snapshot.health).map(([name, health]) => (
            <div className="health-row" key={name}>
              <span className={`dot ${health.status}`} />
              <strong>{name}</strong>
              <span>{health.detail}</span>
            </div>
          ))}
          <div className="health-row">
            <span className={`dot ${recentRpcLimit ? "degraded" : "ok"}`} />
            <strong>RPC meter</strong>
            <span>
              {snapshot.rpc.total} calls · {snapshot.rpc.queueDepth} queued ·{" "}
              {snapshot.rpc.rateLimited} rate-limited · cap{" "}
              {snapshot.rpc.maxRequestsPerSecond}/s
            </span>
          </div>
        </article>
      </section>

      <section className="panel portfolio">
        <div className="portfolio-heading">
          <div>
            <p className="eyebrow">PORTFOLIO</p>
            <h2>Positions, P&amp;L, and net worth</h2>
          </div>
          <div className="mode-tabs" aria-label="Portfolio mode">
            {(["shadow", "manual", "live"] as DeskMode[]).map((mode) => (
              <button
                className={selectedMode === mode ? "active" : ""}
                key={mode}
                onClick={() => setPortfolioMode(mode)}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        <div className="metric-grid">
          <Metric
            label="Net worth"
            value={dollars(portfolioSummary.netWorthUsd)}
            detail={
              selectedMode === "shadow"
                ? "Paper mode has no custody balance"
                : selectedMode === snapshot.mode
                  ? decimal(portfolioSummary.walletSol, 4) +
                    " SOL wallet + positions"
                  : "Wallet balance is only marked for the running mode"
            }
          />
          <Metric
            label="Total P&L"
            value={signedDollars(portfolioSummary.totalPnlUsd)}
            tone={pnlTone(portfolioSummary.totalPnlUsd)}
            detail={signedPercent(portfolioSummary.totalReturnPct) + " return"}
          />
          <Metric
            label="Realized"
            value={signedDollars(portfolioSummary.realizedPnlUsd)}
            tone={pnlTone(portfolioSummary.realizedPnlUsd)}
            detail={portfolioSummary.closedPositions + " closed"}
          />
          <Metric
            label="Unrealized"
            value={signedDollars(portfolioSummary.unrealizedPnlUsd)}
            tone={pnlTone(portfolioSummary.unrealizedPnlUsd)}
            detail={
              portfolioSummary.openPositions +
              " open · " +
              dollars(portfolioSummary.openPositionValueUsd) +
              " value"
            }
          />
          <Metric
            label="Today"
            value={signedDollars(portfolioSummary.dailyPnlUsd)}
            tone={pnlTone(portfolioSummary.dailyPnlUsd)}
            detail={
              signedDollars(portfolioSummary.sessionPnlUsd) + " this session"
            }
          />
          <Metric
            label="Fees"
            value={dollars(portfolioSummary.feesUsd)}
            detail={dollars(portfolioSummary.capitalDeployedUsd) + " deployed"}
          />
        </div>

        <EquityChart
          history={snapshot.portfolio.history[selectedMode]}
          mode={selectedMode}
        />

        <div className="positions-heading">
          <div>
            <h2>{showClosed ? "All positions" : "Current positions"}</h2>
            <span>
              SOL {dollars(snapshot.portfolio.solUsd)} · marked{" "}
              {snapshot.portfolio.solUsdObservedAtMs
                ? new Date(
                    snapshot.portfolio.solUsdObservedAtMs,
                  ).toLocaleTimeString()
                : "unavailable"}
            </span>
          </div>
          <button onClick={() => setShowClosed((current) => !current)}>
            {showClosed ? "Open only" : "Include closed"}
          </button>
        </div>
        <PositionTable positions={portfolioPositions} />
        <p className="portfolio-note">
          Open token value and unrealized P&amp;L are estimates from the latest
          bonding-curve market cap. Realized P&amp;L, fees, and wallet changes
          use confirmed transaction deltas when available.{" "}
          {portfolioSummary.legacyPositions > 0 && (
            <strong>
              {portfolioSummary.legacyPositions} pre-upgrade position
              {portfolioSummary.legacyPositions === 1 ? " has" : "s have"} no
              reconstructable cost basis and remain excluded.
            </strong>
          )}
        </p>
      </section>

      {snapshot.mode === "manual" && (
        <section className="panel manual">
          <div className="panel-heading">
            <h2>Phantom approvals</h2>
            <span>{pending.length} pending</span>
          </div>
          {pending.length === 0 ? (
            <p className="empty">No transaction awaits a signature.</p>
          ) : (
            pending.map((item) => (
              <div className="approval" key={item.execution.intentId}>
                <div>
                  <strong>
                    {item.intent.side.toUpperCase()} {short(item.intent.mint)}
                  </strong>
                  <span>
                    {item.intent.spendUsdCents
                      ? `$${(item.intent.spendUsdCents / 100).toFixed(2)}`
                      : `${item.intent.tokenAmountBaseUnits} base units`}
                  </span>
                </div>
                <button
                  className="primary"
                  onClick={() => void signWithPhantom(item)}
                >
                  Review in Phantom
                </button>
              </div>
            ))
          )}
        </section>
      )}

      <section className="split wide-left">
        <article className="panel table-panel">
          <div className="panel-heading">
            <h2>Mint tape</h2>
            <span>{snapshot.candidates.length} tracked</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Age</th>
                  <th>Market cap</th>
                  <th>High</th>
                  <th>Phase</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.candidates.slice(0, 20).map((mint) => (
                  <tr key={mint.mint}>
                    <td>
                      <strong>{mint.symbol || "—"}</strong>
                      <small>{short(mint.mint)}</small>
                    </td>
                    <td>{age(mint.createdAtMs)}</td>
                    <td>{money(mint.currentMarketCapUsd)}</td>
                    <td>{money(mint.highWaterMarketCapUsd)}</td>
                    <td>
                      <span className={`pill ${mint.phase}`}>{mint.phase}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
        <article className="panel positions">
          <div className="panel-heading">
            <h2>Book</h2>
            <span>
              {
                snapshot.portfolio.positions.filter(
                  (position) =>
                    position.mode === snapshot.mode &&
                    position.wallet ===
                      snapshot.portfolio.summaries[snapshot.mode].wallet &&
                    position.status !== "closed",
                ).length
              }{" "}
              open
            </span>
          </div>
          {snapshot.portfolio.positions.filter(
            (position) =>
              position.mode === snapshot.mode &&
              position.wallet ===
                snapshot.portfolio.summaries[snapshot.mode].wallet &&
              position.status !== "closed",
          ).length === 0 ? (
            <p className="empty">No open positions.</p>
          ) : (
            snapshot.portfolio.positions
              .filter(
                (position) =>
                  position.mode === snapshot.mode &&
                  position.wallet ===
                    snapshot.portfolio.summaries[snapshot.mode].wallet &&
                  position.status !== "closed",
              )
              .map((position) => (
                <div className="position" key={position.id}>
                  <div>
                    <strong>{short(position.mint)}</strong>
                    <span>
                      {position.mode} · {position.status}
                    </span>
                  </div>
                  <div>
                    <strong>{dollars(position.currentValueUsd)}</strong>
                    <span>
                      {signedDollars(position.unrealizedPnlUsd)} P&amp;L
                    </span>
                  </div>
                </div>
              ))
          )}
        </article>
      </section>

      <section className="panel feed">
        <div className="panel-heading">
          <h2>Audit stream</h2>
          <span>Durable, bounded operational events</span>
        </div>
        {events
          .slice(-30)
          .reverse()
          .map((event) => (
            <div className="feed-row" key={event.id}>
              <time>{new Date(event.atMs).toLocaleTimeString()}</time>
              <span className={`role-tag ${event.role}`}>{event.role}</span>
              <strong>{event.type}</strong>
              <code>{compact(event.data)}</code>
            </div>
          ))}
      </section>
    </main>
  );
}

function Metric({
  detail,
  label,
  tone = "neutral",
  value,
}: {
  detail: string;
  label: string;
  tone?: string;
  value: string;
}) {
  return (
    <div className={"metric " + tone}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function EquityChart({
  history,
  mode,
}: {
  history: PortfolioMark[];
  mode: DeskMode;
}) {
  const points = history.slice(-120);
  if (points.length < 2)
    return (
      <div className="chart-empty">
        <strong>Performance history starts now</strong>
        <span>
          The engine stores a mark every 30 seconds. Two marks are needed to
          draw the chart.
        </span>
      </div>
    );
  const pnlValues = points.map((point) => point.totalPnlUsd);
  const worthValues = points
    .map((point) => point.netWorthUsd)
    .filter((value): value is number => value !== null);
  const pnlRange = paddedRange(pnlValues);
  const worthRange = paddedRange(worthValues);
  const pnlLine = chartPoints(points, (point) => point.totalPnlUsd, pnlRange);
  const worthLine = chartPoints(
    points,
    (point) => point.netWorthUsd,
    worthRange,
  );
  const first = new Date(points[0].atMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const last = new Date(points.at(-1)!.atMs).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className="chart">
      <div className="chart-legend">
        <div>
          <span className="legend-line pnl" />
          P&amp;L {signedDollars(points.at(-1)!.totalPnlUsd)}
        </div>
        <div className={worthValues.length === 0 ? "muted" : ""}>
          <span className="legend-line worth" />
          Net worth{" "}
          {worthValues.length === 0
            ? "unavailable"
            : dollars(points.at(-1)!.netWorthUsd)}
        </div>
        <span>{mode} · last 60 minutes</span>
      </div>
      <svg
        aria-label="Portfolio performance history"
        role="img"
        viewBox="0 0 900 230"
      >
        <line className="chart-grid" x1="54" x2="846" y1="30" y2="30" />
        <line className="chart-grid" x1="54" x2="846" y1="110" y2="110" />
        <line className="chart-grid" x1="54" x2="846" y1="190" y2="190" />
        {worthLine && <polyline className="worth-line" points={worthLine} />}
        <polyline className="pnl-line" points={pnlLine ?? ""} />
        <text x="12" y="34">
          {signedDollars(pnlRange.max)}
        </text>
        <text x="12" y="194">
          {signedDollars(pnlRange.min)}
        </text>
        {worthValues.length > 0 && (
          <>
            <text className="worth-axis" textAnchor="end" x="890" y="34">
              {dollars(worthRange.max)}
            </text>
            <text className="worth-axis" textAnchor="end" x="890" y="194">
              {dollars(worthRange.min)}
            </text>
          </>
        )}
        <text x="54" y="220">
          {first}
        </text>
        <text textAnchor="end" x="846" y="220">
          {last}
        </text>
      </svg>
    </div>
  );
}

function PositionTable({ positions }: { positions: PortfolioPosition[] }) {
  if (positions.length === 0)
    return <p className="empty">No positions in this view.</p>;
  return (
    <div className="table-wrap positions-table">
      <table>
        <thead>
          <tr>
            <th>Mint</th>
            <th>Status</th>
            <th>Entry</th>
            <th>Current value</th>
            <th>Unrealized</th>
            <th>Realized</th>
            <th>Return</th>
            <th>Fees</th>
            <th>Age</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr key={position.id}>
              <td>
                <strong>{short(position.mint)}</strong>
                <small>{position.mode}</small>
              </td>
              <td>
                <span className={"pill " + position.status}>
                  {position.status}
                </span>
                {position.legacy && <small>legacy</small>}
              </td>
              <td>
                {dollars(position.entryValueUsd)}
                <small>{money(position.entryMarketCapUsd)} MC</small>
              </td>
              <td>
                {dollars(position.currentValueUsd)}
                <small>{money(position.currentMarketCapUsd)} MC</small>
              </td>
              <td className={pnlTone(position.unrealizedPnlUsd)}>
                {signedDollars(position.unrealizedPnlUsd)}
              </td>
              <td className={pnlTone(position.realizedPnlUsd)}>
                {signedDollars(position.realizedPnlUsd)}
              </td>
              <td className={pnlTone(position.returnPct)}>
                {signedPercent(position.returnPct)}
              </td>
              <td>{dollars(position.feesUsd)}</td>
              <td>{age(position.entryTimeMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoleCard({
  role,
  label,
  description,
  event,
}: {
  role: Role;
  label: string;
  description: string;
  event?: DeskEvent;
}) {
  return (
    <article className={`role-card ${role}`}>
      <div className="role-head">
        <span>{label}</span>
        <span className="pulse" />
      </div>
      <p>{description}</p>
      <div className="latest">
        <strong>{event?.type ?? "waiting"}</strong>
        <span>{event ? new Date(event.atMs).toLocaleTimeString() : "—"}</span>
      </div>
    </article>
  );
}

function Status({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className={`status ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function chartPoints(
  points: PortfolioMark[],
  valueFor: (point: PortfolioMark) => number | null,
  range: { min: number; max: number },
) {
  const plotted = points
    .map((point, index) => {
      const value = valueFor(point);
      if (value === null) return null;
      const x = 54 + (index / Math.max(1, points.length - 1)) * 792;
      const y = 190 - ((value - range.min) / (range.max - range.min)) * 160;
      return x.toFixed(2) + "," + y.toFixed(2);
    })
    .filter((value): value is string => value !== null);
  return plotted.length < 2 ? null : plotted.join(" ");
}

function paddedRange(values: number[]) {
  if (values.length === 0) return { max: 1, min: -1 };
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = Math.max(rawMax - rawMin, Math.abs(rawMax) * 0.05, 0.01);
  return { max: rawMax + span * 0.12, min: rawMin - span * 0.12 };
}

function short(value: string) {
  return value.length > 13 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
function money(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}
function dollars(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: Math.abs(value) < 100 ? 2 : 0,
    style: "currency",
  }).format(value);
}
function signedDollars(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.005) return "$0.00";
  return (value > 0 ? "+" : "−") + dollars(Math.abs(value));
}
function signedPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) < 0.005) return "0.00%";
  return (value > 0 ? "+" : "−") + Math.abs(value).toFixed(2) + "%";
}
function decimal(value: number | null, digits: number) {
  return value === null || !Number.isFinite(value)
    ? "—"
    : value.toFixed(digits);
}
function pnlTone(value: number | null) {
  if (value === null || Math.abs(value) < 0.005) return "neutral";
  return value > 0 ? "positive" : "negative";
}
function age(createdAtMs: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}
function compact(value: unknown) {
  const text = JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}
function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function showError(setter: (value: string) => void) {
  return (error: unknown) =>
    setter(error instanceof Error ? error.message : String(error));
}
