# Phase 1A implementation validation

Collector implementation and short live testing completed on 2026-09-16. **Six-hour validation is pending.** No collector process was left running.

- Build and 22 focused tests passed.
- Final dataset: 54 launches, 5 selected tokens, 11 trades, 10 snapshots; two snapshots contain non-null prices.
- Same SQLite database was reopened and collection resumed from persisted factory/trade cursors. Cursors advanced, existing rows remained, and duplicate trade/event keys were zero.
- Three batched GeckoTerminal requests, zero GeckoTerminal errors/429s.
- 143 actual RPC attempts; two rate-limit responses, recorded with cooldown.
- Sample market and provider-liquidity coverage: 40%; buyer-data coverage: 80% (provider counts or experimental recipient counts). Event-bearing tokens: 20%; tokens with some contiguous RPC trade-range collection: 60%. These measure data presence, not current freshness or complete 6H coverage.
- Median launch-to-discovery delay: 74.7 seconds. Median launch-to-first-market-fetch delay: 186.1 seconds. Initial lookback and RPC cooldown materially affect both; 15s discovery latency was not established.
- 15m/1h/6h completed coverage counts remain zero; this test was too short.

An earlier 20-token pilot hit repeated public-RPC rate limits and exposed excessive work before chunk commits. The final version defaults to five tokens, shares RPC cooldown, commits trade work per block and bounds per-token work. Failed pilot observations are retained separately in the workspace scratch dataset; they are not included in COLLECTOR_VALIDATION.json.

## Limits that remain

The public RPC still rate-limited during the final smoke test. A six-hour run must measure cursor lag and coverage before this dataset is used to evaluate FIND hypotheses; a free alternate RPC or longer spacing may be necessary. Market freshness often remains unknown because GeckoTerminal does not provide a source timestamp. Missing prices/market caps remain null. V4 post-graduation RPC trades are unsupported and flagged incomplete, while market tracking continues. Automated reorg repair and holder enrichment are not implemented.

Run instructions and coverage definitions are in README.md; the machine-readable report is COLLECTOR_VALIDATION.json. Your actual six-hour run starts with the default clean data/find.sqlite database.
