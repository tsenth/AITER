# AITER MVP

AITER is a live Robinhood Chain token discovery prototype. Press FIND ME SOMETHING, review a small set of fresh cards, PASS or save to a browser-local BAG, then open a token on GeckoTerminal. It does not execute trades or predict returns.

## Run locally

Requires Node.js 24+ and npm. From this directory:

```sh
npm ci
cp .env.example .env
npm test
npm run build
npm run web
```

Open `http://localhost:3000`. The web command runs the live collector and API in one process. It preserves `data/find.sqlite` and upgrades its schema in place; make a backup before public deployment. `npm start` runs the collector without the web interface. `npm run status` and `npm run report` inspect the database.

Do not run two collector processes against the same database. If an old collector is running, stop it first. A stale `.lock` from a dead process is removed automatically. The old historical cursor is preserved as paused backfill metadata; the new live cursor starts close to the RPC head.

## Configuration

`.env.example` lists every option. `RPC_URL` defaults to the public Robinhood Chain RPC; `DB_PATH` defaults to `data/find.sqlite`; `PORT` defaults to `3000`; `HOST` defaults to loopback for local use. The other defaults are tuned for a small free-tier live sample. No API key is required. The public RPC and GeckoTerminal may rate-limit; the UI then returns fewer or zero cards rather than old observations.

`RPC_ENRICHMENT=false` is intentional for the MVP: optional trade and contract-state RPC reads would compete with live launch discovery. GeckoTerminal supplies the card activity metrics. Set it to `true` only when you have enough RPC capacity and need the deeper Lab observations.

The main ranking thresholds and weights are in `src/ranking.ts`. Only live-origin tokens aged at most three hours with a market observation newer than `STALE_AFTER_MS` and complete price, size, liquidity and 5-minute activity fields can appear. No fixed result count is promised. BAG is localStorage on that browser. Product events are aggregate action rows in `product_events` with no IP or wallet data.

## Deploy today

For a $0 temporary public test from this Mac, run `brew install cloudflared` and keep the Mac awake. In one terminal run `npm run web`; in another run `cloudflared tunnel --url http://localhost:3000`. Cloudflare prints a temporary HTTPS `trycloudflare.com` URL. This is a test tunnel, not durable hosting: the URL changes after restart and availability depends on the Mac and the collector staying on. Keep the local database backup and stop any other collector process first.

## AUTO HUNT beta and $AITER gate

`AUTO_HUNT_ENABLED=true` starts the deterministic background agent. It saves only strict, fresh signals and never invents missing market values. `AUTO_HUNT_BETA=true` exposes those signals as an open beta.

After `$AITER` and its lock contract are deployed, set `AITER_TOKEN_ADDRESS`, `AITER_LOCK_ADDRESS`, and `AUTO_HUNT_MIN_LOCKED` (raw token units), then set `AUTO_HUNT_BETA=false`. The web flow asks the wallet to sign a short-lived challenge and the server reads `lockedBalanceOf(address)` from the configured lock contract before issuing a 24-hour session. Contract deployment and token issuance are intentionally separate from the app and require audited contract code, final token parameters, and the owner's wallet.

Use an always-on Node.js 24 host with a persistent volume mounted for the SQLite database. Put this directory on the host, run `npm ci && npm run build`, set `DB_PATH` to a path on the persistent volume, `PORT` to the host-provided port and `HOST=0.0.0.0`, then run `npm run web` behind HTTPS (for example, a host's built-in reverse proxy). Deploy a copy of the existing SQLite database if historical preservation matters; otherwise a new database starts live from the current head. Do not use an ephemeral filesystem for a public collector. Run exactly one web/collector instance per database. A free-tier host that sleeps will miss launches while asleep; for reliable public testing use an always-on instance or run it on your own always-on machine with an HTTPS tunnel/reverse proxy.

The process starts the web listener before the first RPC call, so `/api/health` reports `degraded` until discovery succeeds. Monitor `/api/health` for cursor lag and provider status. `GET /api/find` supplies the cards. `POST /api/events` accepts the six allowlisted product events.

## Deliberately postponed

Deep holder and contract risk analysis, wallet clustering, Auto Hunt, $AITER utility, wallets, trading, multichain, public outcome track record and BAG performance. The MVP's rule score is internal and is a discovery heuristic only.
