# Operations

## 1. Install and verify

```bash
npm ci
npm run format:check
npm run check
npm run build
npm run replay -- fixtures/vsexy-replay.json
npm run replay -- fixtures/queezing-remints.json
```

The VSEXY fixture must create one paper position from the 13-second `$3.24k` crossing. Replaying its duplicate event must not create another intent. The QUEEZING fixture must retain two separate mint addresses despite the identical name.

## 2. Shadow mode

Copy `.env.example` to a service-owned environment file. Keep `DESK_MODE=shadow`. Configure authenticated private RPC HTTP and WebSocket URLs from the same provider or providers with compatible commitment behavior.

Start the service and inspect:

- `/api/health` — event stream, price, risk, execution, control state;
- `/api/snapshot` — candidates, positions, mode-scoped portfolio summaries and history, and audit events;
- the dashboard at `http://127.0.0.1:8787`;
- SQLite and logs after sleep/wake, WebSocket interruption, rate limiting, and restart.

KILL must be released by the human before a forward shadow run can create paper entries. With KILL engaged, eligible candidates are terminally recorded as `candidate.kill_switch_blocked` before Risk and create no intent, fill, position, or P&L. Releasing KILL does not arm live execution.

Do not run the service on a laptop expected to sleep. Use systemd/container restart policy and an external heartbeat if continuous observation matters.

Run exactly one process. `EADDRINUSE` means another engine or old dashboard already owns port 8787; it is not a reason to change ports and accidentally run two desks. Resolve the owning PID and working directory, stop only the known old service, and then let one service manager restart it. Never run `npm start` manually while the launchd/systemd unit is loaded.

## 3. Manual Phantom mode

Set:

```text
DESK_MODE=manual
EXPECTED_SIGNER_PUBLIC_KEY=<exact public address shown by Phantom>
```

Build the dashboard, run the local service, unlock Phantom yourself, and use Connect Phantom. The dashboard refuses an address mismatch. Every eligible intent still passes risk and transaction inspection before a popup is possible. After Phantom submits it, the backend verifies the confirmed on-chain transaction before opening the position.

Only unexpired intents appear in the approval queue. If the short entry TTL closes before review, the candidate is a miss; do not rebuild or extend the old intent.

Manual mode will not solve a sub-second execution requirement: popup review and a human click are intentionally in the loop. It is for end-to-end correctness checks with tiny amounts.

## 4. Dedicated live wallet

Generate a new keypair file outside the repository:

```bash
mkdir -p "$HOME/.config/solid-octo-engine"
npm run wallet:create -- "$HOME/.config/solid-octo-engine/execution-wallet.json"
```

Copy the printed public address into `EXPECTED_SIGNER_PUBLIC_KEY`. Transfer only bounded test SOL from Phantom to that public address. Store the file offline or accept that it has no mnemonic recovery route.

Generate an arm token locally with a password manager or operating-system cryptographic tool. Do not paste it into chat. Configure:

```text
DESK_MODE=live
SOLANA_EXECUTION_KEYPAIR_PATH=/absolute/path/execution-wallet.json
EXPECTED_SIGNER_PUBLIC_KEY=<dedicated execution public key>
DESK_ARM_TOKEN=<random value at least 24 characters>
```

Startup fails if the keypair file is group/world-readable, its derived address differs, or any live setting is missing.

## 5. Arming and kill switch

The dashboard arm action requires the token and requests a lease no longer than `armLeaseMaxMs`. The default maximum is 15 minutes, and the engine further caps it at the remaining freshness of the last passing risk report. The token is checked with a timing-safe comparison and is not stored in the database.

- `Disarm` prevents new live buys after the current synchronous action finishes.
- `KILL` immediately engages the persisted kill switch and runs the exit path for open positions belonging to the current mode and wallet.
- KILL blocks every new buy in shadow, manual, and live; it never blocks a sell.
- Releasing the kill switch requires the arm token; it does not automatically arm buys.
- Sells do not require an arm lease.

Live always starts disarmed. While disarmed, eligible exact mints may run Risk so the readiness gate can become current, but that candidate is terminally killed after Risk and is never remade. Only a later candidate can buy after the human arms the desk. Test all four controls before live funding.

### Incident behavior

- A buy simulation rejection such as Pump `6002 TooMuchSolRequired` is a miss before broadcast. That exact mint is terminal, live is disarmed, and the process stays healthy; do not restart or remake it.
- A sell simulation rejection such as Pump `6003 TooLittleSolReceived` may retry with at most three fresh 10-second intents. Slippage remains fixed. After the bounded attempts, the position remains open and monitoring retries after a two-second cooldown.
- A send/confirmation error where broadcast may have occurred is never retried automatically. The position remains `closing`, KILL remains engaged, and the operator must reconcile the signature plus wallet token/SOL balances before deciding any next action.
- A first hold-risk timeout/provider error disarms live and retries after two seconds. A second consecutive uncertain check kills. Confirmed authority, program, curve, holder, or insider danger kills immediately.
- Do not pull, rebuild, or restart over an `open` or `closing` live position unless the running process is unavailable and recovery is unavoidable. First disarm, engage KILL when safe, and reconcile the ledger against chain state.

## 6. Promotion criteria

Require a time-bounded forward shadow report, not a successful synthetic replay. At minimum record:

- event timestamp, observation timestamp, risk latency, intent timestamp, and total event-to-intent latency;
- every eligibility rejection and risk unknown;
- duplicate-intent count (must be zero);
- price source availability/spread and RPC heartbeat gaps;
- expected versus actual output and realized slippage in manual tests;
- restart/catch-up behavior;
- KILL entry blocking, KILL exit, full `-5%` loss-stop, full `+20%` take-profit, legacy-partial trailing-stop, and time-stop outcomes;
- bounded pre-broadcast exit retry and no-retry-after-ambiguous-broadcast behavior.

Keep the live daily cap and wallet balance small. Policy version 3 has independent limits: `maxDailyShadowSpendUsdCents` defaults to `$1,000,000` of paper spend, while `maxDailySpendUsdCents` stays `$50` for manual/live. Never copy the shadow value into the live field. A passing gate only bounds mechanism risk; it does not validate alpha.

## 7. Backup and reconciliation

Stop the service before copying the SQLite database, or copy the database together with its `-wal` and `-shm` files. Reconcile ledger positions to RPC token balances and transaction signatures. Never use the dashboard alone as proof of a fill.

After a test window, disarm, close/reconcile positions, and sweep unused SOL back to a safer wallet on a trusted device.

Operational events are capped by `DESK_EVENT_MAX_ROWS` and `DESK_EVENT_RETENTION_HOURS`. After upgrading an old high-volume database, stop the service, make a consistent backup, and optionally run `sqlite3 data/desk.db 'VACUUM;'` once to return already-allocated pages to disk. Do not run `VACUUM` against a live writer. Rotate launchd stdout/stderr separately; SQLite retention does not rotate text logs.
