import type { MintState, PriceMark, PumpEvent } from "../domain/types.js";
import { bondingCurveMarketCapUsd } from "./market-cap.js";
import type { Ledger } from "../storage/ledger.js";

export class CandidateStore {
  private readonly states = new Map<string, MintState>();

  constructor(
    private readonly ledger: Ledger,
    private readonly maxStates = 10_000,
  ) {
    for (const state of ledger.listMints(maxStates)) {
      if (["eligible", "risk_pending", "ready"].includes(state.phase)) {
        state.phase = "killed";
        ledger.upsertMint(state);
      }
      this.states.set(state.mint, state);
    }
  }

  apply(event: PumpEvent, price: PriceMark): MintState | null {
    if (event.kind === "create") {
      const existing = this.load(event.mint);
      if (existing) return existing;
      const currentMarketCapUsd = bondingCurveMarketCapUsd({
        solUsd: price.priceUsd,
        tokenTotalSupplyBaseUnits: event.tokenTotalSupplyBaseUnits,
        virtualSolReservesLamports: event.virtualSolReservesLamports,
        virtualTokenReservesBaseUnits: event.virtualTokenReservesBaseUnits,
      });
      const state: MintState = {
        bondingCurve: event.bondingCurve,
        createdAtMs: event.blockTimeMs,
        creationSignature: event.signature,
        creationSlot: event.slot,
        creator: event.creator,
        currentMarketCapUsd,
        highWaterMarketCapUsd: currentMarketCapUsd,
        lastEventSignature: event.signature,
        lastObservedAtMs: event.observedAtMs,
        lastSlot: event.slot,
        mint: event.mint,
        name: event.name,
        phase: "seen",
        previousMarketCapUsd: 0,
        quoteMint: event.quoteMint,
        symbol: event.symbol,
        tokenProgram: event.tokenProgram,
        tokenTotalSupplyBaseUnits: event.tokenTotalSupplyBaseUnits,
        virtualSolReservesLamports: event.virtualSolReservesLamports,
        virtualTokenReservesBaseUnits: event.virtualTokenReservesBaseUnits,
      };
      this.persist(state);
      return state;
    }

    const state = this.load(event.mint);
    if (
      !state ||
      event.slot < state.lastSlot ||
      event.signature === state.lastEventSignature
    )
      return null;
    const currentMarketCapUsd = bondingCurveMarketCapUsd({
      solUsd: price.priceUsd,
      tokenTotalSupplyBaseUnits: state.tokenTotalSupplyBaseUnits,
      virtualSolReservesLamports: event.virtualSolReservesLamports,
      virtualTokenReservesBaseUnits: event.virtualTokenReservesBaseUnits,
    });
    state.previousMarketCapUsd = state.currentMarketCapUsd;
    state.currentMarketCapUsd = currentMarketCapUsd;
    state.highWaterMarketCapUsd = Math.max(
      state.highWaterMarketCapUsd,
      currentMarketCapUsd,
    );
    state.lastEventSignature = event.signature;
    state.lastObservedAtMs = event.observedAtMs;
    state.lastSlot = event.slot;
    state.virtualSolReservesLamports = event.virtualSolReservesLamports;
    state.virtualTokenReservesBaseUnits = event.virtualTokenReservesBaseUnits;
    this.persist(state);
    return state;
  }

  setPhase(mint: string, phase: MintState["phase"]): MintState {
    const state = this.states.get(mint);
    if (!state) throw new Error(`unknown mint ${mint}`);
    state.phase = phase;
    this.persist(state);
    return state;
  }

  get(mint: string): MintState | undefined {
    return this.states.get(mint);
  }

  list(limit = 100): MintState[] {
    return [...this.states.values()]
      .sort((a, b) => b.lastObservedAtMs - a.lastObservedAtMs)
      .slice(0, limit);
  }

  private persist(state: MintState): void {
    this.states.set(state.mint, state);
    this.ledger.upsertMint(state);
    this.trim();
  }

  private load(mint: string): MintState | null {
    const state = this.states.get(mint) ?? this.ledger.getMint(mint);
    if (state) this.states.set(mint, state);
    return state;
  }

  private trim(): void {
    if (this.states.size <= this.maxStates) return;
    const removable = [...this.states.values()]
      .filter(
        (state) =>
          state.phase === "killed" ||
          state.phase === "closed" ||
          (state.phase === "seen" &&
            Date.now() - state.createdAtMs > 2 * 60_000),
      )
      .sort((a, b) => a.lastObservedAtMs - b.lastObservedAtMs);
    for (const state of removable) {
      if (this.states.size <= this.maxStates) break;
      this.states.delete(state.mint);
    }
  }
}
