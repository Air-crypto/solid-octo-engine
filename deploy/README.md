# Deployment notes

The container defaults to shadow mode. Do not publish port 8787 to an untrusted network. Mount `/app/data` persistently.

For systemd, install the built repository at `/opt/solid-octo-engine`, create an unprivileged `solid-octo` user, store the SQLite database under `/var/lib/solid-octo-engine`, and place non-secret configuration plus secret references in root-owned `/etc/solid-octo-engine.env` with mode `0600`.

`ProtectHome=true` means a live keypair must not be stored in a home directory. Place its `0600` file in a root-managed path readable only by `solid-octo`, and set that absolute path in the environment file. Keep `DESK_HOST=127.0.0.1`; use an authenticated TLS reverse proxy or SSH tunnel for remote viewing.

The unit restarts process failures, but it is not an availability guarantee. Add an external check against `/api/health`, test WebSocket recovery, monitor disk space, and alert on `killSwitch=true`, `eventStream=down`, stale price health, or an open position with no recent events.
