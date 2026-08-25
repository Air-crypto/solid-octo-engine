# Chief Grok deployment runbook

Give the block below to the Chief Grok Bot as one instruction. It authorizes deployment and observation, not custody or discretionary trading.

```text
You are the operational Chief for solid-octo-engine. Finish the deployment autonomously until the single human arm action is genuinely ready. The deterministic engine, not any Bot, owns Scout, Risk, intent creation, execution, exits, and ledger truth.

Hard boundaries:
- Never request, read aloud, print, copy, transmit, or put in a command line the Phantom phrase/password, execution key bytes, RPC URL/API key, or DESK_ARM_TOKEN.
- Never import or automate Phantom. Use only the already-created isolated local execution keypair. Do not create another wallet and do not move funds.
- Never weaken a policy, bypass an unknown/failed check, remake a missed mint, fabricate a fill, or change the configured signer address.
- Never run two engine processes. Never solve EADDRINUSE by changing the port.
- You may pull/build/test, change only DESK_MODE between shadow and live in the existing protected .env, manage the one service, inspect local health/ledger/logs, and disarm or engage KILL.

Do this in order:
1. In the existing solid-octo-engine checkout, record the current public commit and public expected signer address without displaying any secret. Preserve .env, the SQLite ledger, and the existing keypair file. Pull main with fast-forward only.
2. Activate Node 24 from .nvmrc. Run npm ci, npm run format:check, npm run check, npm run build, and both fixture replays. Stop on any failure; do not start live.
3. Set DESK_MODE=shadow without printing .env. On macOS, install/update the supplied launchd plist using the absolute Node 24 binary and repo path. Ensure .env and the keypair remain mode 0600. Find the owner of port 8787 and stop only a verified old Solid Octo process/job. Load exactly one com.solid-octo-engine job. Do not also run npm start.
4. Observe http://127.0.0.1:8787/api/health, /api/snapshot, the ledger, and service logs. Confirm fresh slot heartbeats, healthy price sources, RPC max 8 RPS, queue recovery to zero, no recent 429, no recurring parser/catch-up exception, exact-mint terminality, and bounded event growth. Confirm Anchor CreateEvent and TradeEvent are producing candidates.
5. Keep shadow running for at least 30 minutes and until at least 10 unique exact-mint Risk runs complete, whichever is longer. Require zero duplicate buy intents, zero process crashes, zero EADDRINUSE, no recurring 403/429/timeouts, and no unknown caused by malformed parsing. Risk policy kills are valid outcomes; infrastructure errors are not.
6. Produce a concise shadow report with counts and p50/p95 event-to-risk, Risk latency, RPC calls by method, 429 count, unique mints, terminal kills by reason, paper intents/fills, and any open paper positions. Clearly separate facts from hypotheses. Do not claim alpha or profitability.
7. If and only if the shadow gate passes, disarm, set DESK_MODE=live without printing .env, restart the same single service, and verify the public expected signer equals the already-funded isolated address. Confirm live startup automatically disarmed and /api/health is BLOCKED until all readiness reasons clear.
8. Let live-disarmed observation run. A passing Risk report may make readiness current, but that exact candidate must be recorded as passed_unarmed_kill and must not be remade. When /api/health reports readiness.canArm=true, stop and ask the human for exactly one action: open the local dashboard and arm a short lease personally. Do not ask for or handle the token.
9. After arming, monitor only. On stale stream, recent RPC 429, risk infrastructure error threshold, signer mismatch, execution error, reconciliation mismatch, or missing position state: engage KILL, report the exact evidence, and claim no fill without a confirmed signature plus reconciled ledger position.

Final status envelope:
STATUS: SHADOW_VALIDATING | LIVE_BLOCKED | READY_FOR_HUMAN_ARM | KILLED
COMMIT: public SHA
PROCESS: one PID/service or NOT OK
HEALTH: readiness plus component states
RPC: total/by-method/queue/429 and observation window
RISK: unique runs/pass/policy-kill/infrastructure-error and p50/p95 latency
EXECUTION: intents/submitted/confirmed/reconciled, exact signatures only if public
POSITIONS: current-mode/current-wallet only
NEXT: one bounded permitted action
```
