# AITER MVP

AITER is a live Solana token discovery prototype. Press FIND ME SOMETHING, review a small set of fresh cards, PASS or save to a browser-local BAG, then open the pool on GeckoTerminal. It does not execute trades or predict returns.

## Run locally

Requires Node.js 24+ and npm.

```sh
npm ci
cp .env.example .env
npm test
npm run build
npm run web
```

Open `http://localhost:3000`. The web command runs the collector, API and website in one process.

## Solana data path

The active chain defaults to `solana`. AITER requests the documented GeckoTerminal endpoint below with API version `20230203`:

```text
GET https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page={page}&include=base_token,quote_token,dex
```

The collector reads three pages once per minute by default, stores only temporary current pool state in free mode, accepts SOL and USDC quote pools, and removes stale rows. Ranking deduplicates by mint and chooses the strongest current pool. Missing optional values remain null.

`SOLANA_DISCOVERY_MS` cannot be set below 60 seconds. `SOLANA_NEW_POOL_PAGES` accepts 1 through 5. These defaults stay below the public API's approximate rate limit and avoid per-token enrichment calls.

The legacy Robinhood Lab collector remains available with `AITER_CHAIN=robinhood`. Its tables and local research database are not read by the Solana ranking path.

## Render Free

Create a Render Web Service from this repository.

```text
Build command: npm ci && npm run build
Start command: npm run web
Health check path: /api/health
Persistent disk: none
```

Set:

```text
AITER_CHAIN=solana
AITER_DEPLOYMENT_MODE=free
HOST=0.0.0.0
NODE_VERSION=24
```

Render supplies `PORT`. Do not set `DB_PATH` and do not attach a disk. Free mode creates a unique temporary SQLite database for each process. After a sleep or restart it fetches current Solana pools again. `/api/health` moves through `STARTING`, `SCANNING`, `READY` and `DEGRADED`.

BAG remains in browser localStorage and survives server restarts. Old BAG records are preserved, while new records include `chain`, `mintAddress` and `poolAddress`.

## Data integrity

Only pools created within three hours and refreshed within the configured freshness limit can enter `/api/find`. The normal filter prefers at least $10K size, $5K liquidity and meaningful five-minute activity. The fallback still requires real fresh activity and rejects confirmed tiny size or thin liquidity. No fixed result count is promised.

AUTO HUNT is disabled for Solana. No API key, paid provider, wallet connection or persistent disk is required for the public MVP.
