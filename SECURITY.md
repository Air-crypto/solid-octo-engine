# Security model

## Never provide these to this repository or its Bots

- Phantom recovery phrase
- Phantom password
- personal wallet private key
- browser profile or extension storage
- raw keypair contents
- arm token in chat, prompts, screenshots, or logs

The project intentionally has no Phantom-login automation. A browser-extension password protects a local session; a recovery phrase controls the wallet permanently. Automating either through an agent, browser script, MCP server, or shared cloud computer turns a narrow trade tool into a general wallet-compromise path.

## Supported signer boundaries

Manual mode uses the injected Phantom provider in a user-controlled local browser. The user unlocks Phantom, sees the transaction popup, and approves or rejects it. The engine verifies the configured public address, transaction payer, exact mint, and every invoked program before presenting it. After submission, the engine fetches the confirmed transaction and verifies the same wallet, mint, signature, program allowlist, and success before opening a position.

Live mode uses a separate generated keypair file with mode `0600`. Startup derives its address and refuses to run if it differs from `EXPECTED_SIGNER_PUBLIC_KEY`. Buy execution additionally requires an unexpired arm lease and a released kill switch. The keypair is not available to Bots or the dashboard.

Use an execution wallet with:

- no connection to a primary holdings wallet beyond a small funding transfer;
- only the SOL amount needed for the bounded test plus fees;
- no NFTs, authority roles, token approvals, or unrelated assets;
- an offline copy of the keypair file, or an explicit acceptance that loss of the file loses the funds.

## Transaction guard

Unsigned Pump-builder transactions are rejected unless:

- the fee payer is the configured wallet;
- the intended mint appears in resolved account keys;
- every top-level and resolved instruction uses an allowlisted Pump, Pump AMM, Pump fee, System, Compute Budget, SPL Token, Token-2022, or Associated Token program;
- live simulation succeeds before signing and sending.

The builder timeout is 1.5 seconds and the intent expires after 2.5 seconds by default. Do not extend these merely to obtain more fills; an old transaction is a different trade.

## Network boundary

The default server binds to `127.0.0.1` and disables cross-origin browser access. Keep it local. If remote access is necessary, place it behind authenticated TLS with network-level access control. Do not expose `/api/control/*` or the manual transaction queue directly to the internet.

Public RPCs and public APIs can lie by omission, lag, rate-limit, or fail. Required unknown state fails closed. Use separate authenticated HTTP and WebSocket RPC endpoints and monitor their health externally.

## Operational response

If a wallet secret may have been exposed, do not “change the Phantom password” and continue. On a trusted device, create a new wallet, transfer remaining assets, revoke approvals/authorities where applicable, and retire the exposed wallet. A changed extension password does not invalidate a leaked recovery phrase.

If execution behaves unexpectedly:

1. Engage the kill switch.
2. Disarm buys.
3. Confirm positions and balances directly from Solana RPC and a trusted wallet UI.
4. Preserve the SQLite database and logs.
5. Remove funding from the execution wallet after positions are reconciled.

Report vulnerabilities without including wallet secrets, real signed transactions, or private RPC credentials.
