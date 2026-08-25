# Dependency security status

Run:

```bash
npm audit --omit=dev
```

At the initial implementation date, the directly exploitable `@fastify/static` path-traversal advisories were removed by upgrading to `10.1.3` or newer.

The remaining npm audit graph is inherited from the current official Pump/Anchor/Solana JavaScript stack. It includes advisories routed through `@solana/web3.js`, `@solana/spl-token`, `jayson`, `uuid`, and `bigint-buffer`. npm's suggested “fix” is to force-downgrade the Pump SDKs and SPL Token package to old incompatible versions; that is not an acceptable automatic remediation for transaction software.

Risk treatment:

- Pin dependency resolution through `package-lock.json` and use `npm ci`.
- Keep the HTTP server local and never serve directory listings.
- Accept only locally configured endpoints and fixed external API URLs.
- Validate all builder-produced transactions before signing.
- Maintain a minimally funded isolated signer and short arm lease.
- Treat any new critical advisory as a build failure; review high/moderate advisories against the actually invoked code path.
- Re-run tests, replay, transaction-guard tests, and a manual tiny-value transaction before accepting SDK updates.

This file is a disposition record, not a claim that dependencies are safe. Refresh it whenever the lockfile changes.
