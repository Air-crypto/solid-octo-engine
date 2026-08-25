import { useCallback, useEffect, useMemo, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import type {
  DeskEvent,
  ManualPending,
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
    description: "Scale-out, trail, and time stop",
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

  const refresh = useCallback(async () => {
    const [snapshotResponse, configResponse, pendingResponse] =
      await Promise.all([
        fetch("/api/snapshot"),
        fetch("/api/config"),
        fetch("/api/manual/pending"),
      ]);
    const nextSnapshot = (await snapshotResponse.json()) as Snapshot;
    setSnapshot(nextSnapshot);
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
            <span>{snapshot.positions.length} positions</span>
          </div>
          {snapshot.positions.length === 0 ? (
            <p className="empty">No positions yet.</p>
          ) : (
            snapshot.positions.map((position) => (
              <div className="position" key={position.id}>
                <div>
                  <strong>{short(position.mint)}</strong>
                  <span>
                    {position.mode} · {position.status}
                  </span>
                </div>
                <div>
                  <strong>{money(position.entryMarketCapUsd)}</strong>
                  <span>entry MC</span>
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

function short(value: string) {
  return value.length > 13 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}
function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
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
