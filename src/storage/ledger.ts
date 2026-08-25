import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DeskEvent,
  ExecutionResult,
  MintState,
  OrderIntent,
  Position,
  RiskReport,
} from "../domain/types.js";

export class Ledger {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    );
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  appendEvent(event: DeskEvent): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO desk_events(id, at_ms, role, type, data_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        event.id,
        event.atMs,
        event.role,
        event.type,
        JSON.stringify(event.data),
      );
  }

  recentEvents(limit = 100): DeskEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM desk_events ORDER BY at_ms DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((row) => ({
      atMs: Number(row.at_ms),
      data: JSON.parse(String(row.data_json)),
      id: String(row.id),
      role: String(row.role) as DeskEvent["role"],
      type: String(row.type),
    }));
  }

  upsertMint(state: MintState): void {
    this.db
      .prepare(
        `
      INSERT INTO mints(mint, phase, state_json, updated_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(mint) DO UPDATE SET phase=excluded.phase, state_json=excluded.state_json, updated_at_ms=excluded.updated_at_ms
    `,
      )
      .run(
        state.mint,
        state.phase,
        JSON.stringify(state),
        state.lastObservedAtMs,
      );
  }

  getMint(mint: string): MintState | null {
    const row = this.db
      .prepare("SELECT state_json FROM mints WHERE mint = ?")
      .get(mint) as { state_json?: string } | undefined;
    return row?.state_json ? (JSON.parse(row.state_json) as MintState) : null;
  }

  listMints(limit = 100): MintState[] {
    const rows = this.db
      .prepare(
        "SELECT state_json FROM mints ORDER BY updated_at_ms DESC LIMIT ?",
      )
      .all(limit) as Array<{ state_json: string }>;
    return rows.map((row) => JSON.parse(row.state_json) as MintState);
  }

  saveRisk(report: RiskReport): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO risk_reports(raw_hash, mint, checked_at_ms, passed, report_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        report.rawHash,
        report.mint,
        report.checkedAtMs,
        report.passed ? 1 : 0,
        JSON.stringify(report),
      );
  }

  createIntent(intent: OrderIntent): boolean {
    const result = this.db
      .prepare(
        `
      INSERT OR IGNORE INTO order_intents(id, mint, side, created_at_ms, expires_at_ms, status, intent_json)
      VALUES (?, ?, ?, ?, ?, 'created', ?)
    `,
      )
      .run(
        intent.id,
        intent.mint,
        intent.side,
        intent.createdAtMs,
        intent.expiresAtMs,
        JSON.stringify(intent),
      );
    return Number(result.changes) === 1;
  }

  updateIntentStatus(id: string, status: string): void {
    this.db
      .prepare("UPDATE order_intents SET status = ? WHERE id = ?")
      .run(status, id);
  }

  getIntent(id: string): OrderIntent | null {
    const row = this.db
      .prepare("SELECT intent_json FROM order_intents WHERE id = ?")
      .get(id) as { intent_json?: string } | undefined;
    return row?.intent_json
      ? (JSON.parse(row.intent_json) as OrderIntent)
      : null;
  }

  hasBuyIntent(mint: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS found FROM order_intents WHERE mint = ? AND side = 'buy' LIMIT 1",
      )
      .get(mint) as { found?: number } | undefined;
    return row?.found === 1;
  }

  saveExecution(result: ExecutionResult): void {
    this.db
      .prepare(
        `
      INSERT INTO executions(intent_id, status, signature, result_json, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(intent_id) DO UPDATE SET status=excluded.status, signature=excluded.signature, result_json=excluded.result_json, updated_at_ms=excluded.updated_at_ms
    `,
      )
      .run(
        result.intentId,
        result.status,
        result.signature ?? null,
        JSON.stringify(result),
        result.confirmedAtMs ?? Date.now(),
      );
  }

  getExecution(intentId: string): ExecutionResult | null {
    const row = this.db
      .prepare("SELECT result_json FROM executions WHERE intent_id = ?")
      .get(intentId) as { result_json?: string } | undefined;
    return row?.result_json
      ? (JSON.parse(row.result_json) as ExecutionResult)
      : null;
  }

  pendingManualExecutions(nowMs = Date.now()): Array<{
    execution: ExecutionResult;
    intent: OrderIntent;
  }> {
    const rows = this.db
      .prepare(
        `
      SELECT i.intent_json, e.result_json
      FROM executions e JOIN order_intents i ON i.id = e.intent_id
      WHERE e.status = 'awaiting_manual_signature' AND i.expires_at_ms > ?
      ORDER BY e.updated_at_ms DESC
    `,
      )
      .all(nowMs) as Array<{ intent_json: string; result_json: string }>;
    return rows.map((row) => ({
      execution: JSON.parse(row.result_json) as ExecutionResult,
      intent: JSON.parse(row.intent_json) as OrderIntent,
    }));
  }

  upsertPosition(position: Position): void {
    this.db
      .prepare(
        `
      INSERT INTO positions(id, mint, status, position_json, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, position_json=excluded.position_json, updated_at_ms=excluded.updated_at_ms
    `,
      )
      .run(
        position.id,
        position.mint,
        position.status,
        JSON.stringify(position),
        Date.now(),
      );
  }

  listPositions(openOnly = false): Position[] {
    const rows = this.db
      .prepare(
        openOnly
          ? "SELECT position_json FROM positions WHERE status != 'closed' ORDER BY updated_at_ms DESC"
          : "SELECT position_json FROM positions ORDER BY updated_at_ms DESC",
      )
      .all() as Array<{ position_json: string }>;
    return rows.map((row) => JSON.parse(row.position_json) as Position);
  }

  dailySpendUsdCents(sinceMs: number): number {
    const rows = this.db
      .prepare(
        "SELECT intent_json FROM order_intents WHERE side = 'buy' AND created_at_ms >= ? AND status IN ('submitted','confirmed','paper_filled')",
      )
      .all(sinceMs) as Array<{ intent_json: string }>;
    return rows.reduce(
      (sum, row) =>
        sum + (JSON.parse(row.intent_json) as OrderIntent).spendUsdCents!,
      0,
    );
  }

  setControl(key: string, value: unknown): void {
    this.db
      .prepare(
        `
      INSERT INTO control_state(key, value_json, updated_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at_ms=excluded.updated_at_ms
    `,
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  getControl<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value_json FROM control_state WHERE key = ?")
      .get(key) as { value_json?: string } | undefined;
    return row?.value_json ? (JSON.parse(row.value_json) as T) : fallback;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS desk_events(
        id TEXT PRIMARY KEY,
        at_ms INTEGER NOT NULL,
        role TEXT NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS desk_events_time_idx ON desk_events(at_ms);

      CREATE TABLE IF NOT EXISTS mints(
        mint TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS risk_reports(
        raw_hash TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        checked_at_ms INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        report_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS order_intents(
        id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        side TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        intent_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_buy_per_mint_idx ON order_intents(mint) WHERE side = 'buy';

      CREATE TABLE IF NOT EXISTS executions(
        intent_id TEXT PRIMARY KEY REFERENCES order_intents(id),
        status TEXT NOT NULL,
        signature TEXT,
        result_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS positions(
        id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        status TEXT NOT NULL,
        position_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS control_state(
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  }
}
