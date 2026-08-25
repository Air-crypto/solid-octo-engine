# Bot setup

Create focused Bots and paste the corresponding Markdown file as the Bot's role description. Add the full contents of `COMMON_BOUNDARIES.md` before the role prompt.

Recommended actual Bots:

1. HEAD OF DESK
2. SEARCH
3. SHILL
4. FINANCE

SCOUT, SNIPER, RISK, WHALE, RUG, and EXIT are deterministic engine components. Their prompts are supplied for explanation/monitoring Bots only; do not put them between the engine and execution.

Grant Bots only the read-only desk tools they require. Keep the arm token, signer configuration, wallet session, keypair, password, and recovery phrase outside the shared Bot computer.
