import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DeskMode,
  DeskEvent,
  ExecutionResult,
  MintState,
  OrderIntent,
  PortfolioMark,
  Position,
  RiskReport,
} from "../domain/types.js";

export class Ledger {
  private readonly db: DatabaseSync;
  private writesSincePrune = 0;

  constructor(
    path: string,
    private readonly retentionMs = 24 * 60 * 60 * 1_000,
    private readonly maxEvents = 50_000,
  ) {
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
    this.writesSincePrune += 1;
    if (this.writesSincePrune >= 500) {
      this.pruneOperationalData(event.atMs);
      this.writesSincePrune = 0;
    }
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

  latestRiskReport(): RiskReport | null {
    const row = this.db
      .prepare(
        "SELECT report_json FROM risk_reports ORDER BY checked_at_ms DESC LIMIT 1",
      )
      .get() as { report_json?: string } | undefined;
    return row?.report_json
      ? (JSON.parse(row.report_json) as RiskReport)
      : null;
  }

  latestPassingRiskReport(): RiskReport | null {
    const row = this.db
      .prepare(
        "SELECT report_json FROM risk_reports WHERE passed = 1 ORDER BY checked_at_ms DESC LIMIT 1",
      )
      .get() as { report_json?: string } | undefined;
    return row?.report_json
      ? (JSON.parse(row.report_json) as RiskReport)
      : null;
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

  savePortfolioMark(mark: PortfolioMark): void {
    this.db
      .prepare(
        `INSERT INTO portfolio_marks(mode, wallet, at_ms, mark_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(mode, wallet, at_ms)
         DO UPDATE SET mark_json=excluded.mark_json`,
      )
      .run(mark.mode, mark.wallet, mark.atMs, JSON.stringify(mark));
  }

  listPortfolioMarks(
    mode: DeskMode,
    wallet: string,
    limit = 240,
  ): PortfolioMark[] {
    const rows = this.db
      .prepare(
        `SELECT mark_json FROM portfolio_marks
         WHERE mode = ? AND wallet = ?
         ORDER BY at_ms DESC LIMIT ?`,
      )
      .all(mode, wallet, limit) as Array<{ mark_json: string }>;
    return rows
      .reverse()
      .map((row) => JSON.parse(row.mark_json) as PortfolioMark);
  }

  dailySpendUsdCents(sinceMs: number, mode: DeskMode, wallet: string): number {
    const rows = this.db
      .prepare(
        `SELECT i.intent_json
         FROM order_intents i
         JOIN executions e ON e.intent_id = i.id
         WHERE i.side = 'buy'
           AND i.created_at_ms >= ?
           AND i.status IN ('submitted','confirmed','paper_filled')
           AND json_extract(i.intent_json, '$.wallet') = ?
           AND json_extract(e.result_json, '$.mode') = ?`,
      )
      .all(sinceMs, wallet, mode) as Array<{ intent_json: string }>;
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

  pruneOperationalData(nowMs = Date.now()): void {
    const cutoffMs = nowMs - this.retentionMs;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM desk_events WHERE at_ms < ?").run(cutoffMs);
      this.db
        .prepare(
          `DELETE FROM desk_events WHERE id IN (
            SELECT id FROM desk_events ORDER BY at_ms DESC LIMIT -1 OFFSET ?
          )`,
        )
        .run(this.maxEvents);
      this.db
        .prepare(
          `DELETE FROM mints
           WHERE updated_at_ms < ? AND phase IN ('seen', 'killed', 'closed')`,
        )
        .run(cutoffMs);
      this.db
        .prepare("DELETE FROM portfolio_marks WHERE at_ms < ?")
        .run(cutoffMs);
      this.db
        .prepare(
          `DELETE FROM risk_reports
           WHERE checked_at_ms < ?
             AND raw_hash NOT IN (
               SELECT json_extract(intent_json, '$.riskSnapshotHash')
               FROM order_intents
             )`,
        )
        .run(cutoffMs);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

      CREATE TABLE IF NOT EXISTS portfolio_marks(
        mode TEXT NOT NULL,
        wallet TEXT NOT NULL,
        at_ms INTEGER NOT NULL,
        mark_json TEXT NOT NULL,
        PRIMARY KEY(mode, wallet, at_ms)
      );
      CREATE INDEX IF NOT EXISTS portfolio_marks_time_idx ON portfolio_marks(at_ms);

      CREATE TABLE IF NOT EXISTS control_state(
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  }
}
