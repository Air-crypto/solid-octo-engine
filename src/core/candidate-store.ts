import type { MintState, PriceMark, PumpEvent } from "../domain/types.js";
import { bondingCurveMarketCapUsd } from "./market-cap.js";
import type { Ledger } from "../storage/ledger.js";

export class CandidateStore {
  private readonly states = new Map<string, MintState>();

  constructor(private readonly ledger: Ledger) {
    for (const state of ledger.listMints(10_000))
      this.states.set(state.mint, state);
  }

  apply(event: PumpEvent, price: PriceMark): MintState | null {
    if (event.kind === "create") {
      const existing = this.states.get(event.mint);
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

    const state = this.states.get(event.mint);
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
  }
}
