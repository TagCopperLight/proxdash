# proxdash

Local dashboard for CLIProxyAPI: pooled quota and forecast, accounts, request logs, config. See [DESIGN.md](DESIGN.md).

```sh
bun install
bun run src/server.ts        # http://127.0.0.1:8318
```

Runs as the `proxdash.service` systemd user unit (in chezmoi). Data: `~/.local/share/proxdash/proxdash.db`.
Overrides: `PROXDASH_PORT`, `PROXDASH_PROXY`, `PROXDASH_KEY_FILE`, `PROXDASH_DATA`, `PROXDASH_TRANSCRIPTS`.
