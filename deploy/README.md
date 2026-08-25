# Deployment notes

The container defaults to shadow mode. Do not publish port 8787 to an untrusted network. Mount `/app/data` persistently.

For systemd, install the built repository at `/opt/solid-octo-engine`, create an unprivileged `solid-octo` user, store the SQLite database under `/var/lib/solid-octo-engine`, and place non-secret configuration plus secret references in root-owned `/etc/solid-octo-engine.env` with mode `0600`.

`ProtectHome=true` means a live keypair must not be stored in a home directory. Place its `0600` file in a root-managed path readable only by `solid-octo`, and set that absolute path in the environment file. Keep `DESK_HOST=127.0.0.1`; use an authenticated TLS reverse proxy or SSH tunnel for remote viewing.

The unit restarts process failures, but it is not an availability guarantee. Add an external check against `/api/health`, test WebSocket recovery, monitor disk space, and alert on `killSwitch=true`, `eventStream=down`, stale price health, or an open position with no recent events.

## macOS launchd

Use Node 24 (`.nvmrc`) and build before restarting. Copy `com.solid-octo-engine.plist.example` to `~/Library/LaunchAgents/com.solid-octo-engine.plist`, replace `__NODE_24_BIN__` with the absolute Node 24 binary and `__REPO_DIR__` with the absolute repository path, then validate it with `plutil -lint`. The app loads the repository's mode-`0600` `.env`; never embed RPC keys, arm tokens, or keypair bytes in the plist.

Before bootstrap, use `lsof -nP -iTCP:8787 -sTCP:LISTEN` and inspect the reported process working directory. Stop only a known old Solid Octo instance. Boot out an already-loaded `com.solid-octo-engine` job before bootstrapping its replacement, then manage restarts only with `launchctl`; do not also run `npm start` in a terminal. This prevents the duplicate-launch `EADDRINUSE` crash loop seen in the incident logs.

The example writes stdout/stderr under `data/`, which Git ignores. Configure macOS `newsyslog` or another local rotation policy; launchd does not rotate these files for you.
