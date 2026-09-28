import { HOUR } from './config.js';
import type { Store } from './db.js';
import { normalizeMarket as normalizeMarketForReport } from './normalize.js';
import { FACTORIES } from './pons.js';

const importantFields = ['price', 'fdv', 'marketCap', 'providerLiquidityEstimate', 'volume5m', 'buys5m', 'sells5m', 'buyers5m', 'sellers5m', 'lastTradeTime', 'experimentalUniqueBuyers5m', 'curveReserves'];
function median(values: number[]): number | null {
  if (!values.length) return null;
  const a = values.sort((x,y) => x-y); const i = Math.floor(a.length / 2);
  return a.length % 2 ? a[i] : (a[i-1] + a[i]) / 2;
}
function percent(n: number, d: number): number | null { return d ? Math.round(n / d * 10000) / 100 : null; }
export function report(store: Store, now = Date.now()) {
  const tokens = store.all('SELECT * FROM tokens ORDER BY launch_time');
  const snapshots = store.all('SELECT * FROM snapshots ORDER BY recorded_at');
  const errors = store.all('SELECT provider,kind,status,COUNT(*) AS count FROM observations WHERE error IS NOT NULL GROUP BY provider,kind,status');
  const launchesByHour: Record<string, number> = {};
  for (const t of tokens) {
    const hour = new Date(t.launch_time).toISOString().slice(0,13) + ':00Z';
    launchesByHour[hour] = (launchesByHour[hour] ?? 0) + 1;
  }
  const tokenSets = { market: new Set<string>(), liquidity: new Set<string>(), buyers: new Set<string>(), trades: new Set<string>(), tradeRanges: new Set<string>() };
  const firstMarket = new Map<string, number>();
  const marketTimes = new Map<string, number[]>();
  for (const o of store.all("SELECT * FROM observations WHERE kind='market' AND error IS NULL ORDER BY fetched_at")) {
    const resource = o.payload ? JSON.parse(o.payload).resource : null;
    if (!resource) continue;
    const n = normalizeMarketForReport(resource, o.token_address);
    if (n.price === null) continue;
    tokenSets.market.add(o.token_address);
    if (n.providerLiquidityEstimate !== null) tokenSets.liquidity.add(o.token_address);
    if (n.windows.m5.buyers !== null) tokenSets.buyers.add(o.token_address);
    firstMarket.set(o.token_address, Math.min(firstMarket.get(o.token_address) ?? Infinity, o.fetched_at));
    const a = marketTimes.get(o.token_address) ?? []; a.push(o.fetched_at); marketTimes.set(o.token_address, a);
  }
  for (const s of snapshots) {
    const n = JSON.parse(s.normalized);
    if (n.price !== null && s.fetched_at !== null) {
      tokenSets.market.add(s.token_address);
    }
    if (n.providerLiquidityEstimate !== null) tokenSets.liquidity.add(s.token_address);
    if (n.buyers5m !== null || n.experimentalUniqueBuyers5m !== null) tokenSets.buyers.add(s.token_address);
  }
  for (const t of store.all('SELECT DISTINCT token_address FROM trades')) tokenSets.trades.add(t.token_address);
  for (const v of store.all('SELECT token_address FROM venues WHERE trade_complete_from IS NOT NULL')) tokenSets.tradeRanges.add(v.token_address);
  const selected = tokens.filter(t => t.selected);
  const liveTokens = tokens.filter(t => t.discovery_origin === 'live');
  const backfilledTokens = tokens.filter(t => t.discovery_origin === 'backfill');
  const activeTokens = tokens.filter(t => t.launch_time <= now && t.launch_time > now - 3 * HOUR);
  const activeSelected = activeTokens.filter(t => t.selected);
  const activeMarket = activeSelected.filter(t => {
    const times = marketTimes.get(t.token_address) ?? [];
    return times.some(x => x > now - 180_000);
  });
  const cursorSamples = store.all('SELECT lag_blocks FROM live_cursor_samples ORDER BY observed_at');
  const latestLive = liveCursorState(store);
  const coverageFor = (cohort: any[]) => Object.fromEntries(Object.entries(tokenSets).map(([field, set]) => {
    const count = cohort.filter(t => set.has(t.token_address)).length;
    return [field, { tokens: count, percent: percent(count, cohort.length) }];
  }));
  const missingRates = Object.fromEntries(importantFields.map(field => {
    const missing = snapshots.filter(s => { const v = JSON.parse(s.normalized)[field]; return v === null || v === undefined; }).length;
    return [field, { missing, snapshots: snapshots.length, percent: percent(missing, snapshots.length) }];
  }));
  const tracking: Record<string, any> = {};
  for (const [label, threshold] of [['15m', 900_000], ['1h', HOUR], ['6h', 6 * HOUR]] as const) {
    let reached = 0; let continuous = 0; let eligible = 0;
    for (const t of selected) {
      if (now - t.launch_time < threshold) continue;
      eligible++;
      const times = [...new Set(marketTimes.get(t.token_address) ?? [])].sort((a,b) => a-b);
      if (!times.length || times.at(-1)! < t.launch_time + threshold) continue;
      reached++;
      // Coverage is measured with actual non-null price observations, not row count or wall-clock uptime.
      const endIndex = times.findIndex(x => x >= t.launch_time + threshold);
      const relevant = times.slice(0, endIndex + 1);
      const early = relevant[0] <= t.launch_time + 180_000;
      let gapsOkay = true;
      for (let i = 1; i < relevant.length; i++) {
        const previousAge = relevant[i-1] - t.launch_time;
        const tolerance = previousAge < HOUR ? 180_000 : 420_000;
        if (relevant[i] - relevant[i-1] > tolerance) gapsOkay = false;
      }
      if (early && gapsOkay) continuous++;
    }
    tracking[label] = { eligibleSampledTokens: eligible, observedThroughLaunchAge: reached, continuousMarketCoverage: continuous };
  }
  const snapshotGaps = selected.map(t => {
    const times = [...new Set(marketTimes.get(t.token_address) ?? [])].sort((a,b) => a-b);
    return { token: t.token_address, firstMarketAgeMs: times.length ? times[0] - t.launch_time : null,
      lastMarketAgeMs: times.length ? times.at(-1)! - t.launch_time : null,
      maxObservedMarketGapMs: times.length > 1 ? Math.max(...times.slice(1).map((x,i) => x-times[i])) : null };
  });
  const requests = store.all(`SELECT provider,COUNT(*) AS requests,SUM(CASE WHEN status=429 THEN 1 ELSE 0 END) AS rateLimits,SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors FROM observations WHERE kind='http' GROUP BY provider`);
  const rpcCount = store.get('rpcRequests', 0);
  const rpcRow = requests.find(r=>r.provider==='rpc');
  if (rpcRow) rpcRow.requests=rpcCount;
  else requests.push({ provider:'rpc', requests:rpcCount, rateLimits:0, errors:0 });
  const spanHours = Math.max(0, now - store.get('firstStartedAt', now)) / HOUR;
  const latest = store.all(`SELECT s.* FROM snapshots s JOIN (SELECT token_address,MAX(id) AS id FROM snapshots GROUP BY token_address) x ON s.id=x.id`);
  const freshness = { fresh: 0, stale: 0, unknown: 0, incomplete: 0 };
  for (const s of latest) {
    const c = JSON.parse(s.coverage);
    const staleMs = store.get('staleMs', 180000);
    const aged = s.fetched_at === null || now - s.fetched_at > staleMs || c.providerError || (s.source_observation_time !== null && now - s.source_observation_time > staleMs);
    const current = aged || c.freshness === 'stale' ? 'stale' : c.sourceTimeKnown ? 'fresh' : 'unknown';
    freshness[current as 'fresh' | 'stale' | 'unknown']++;
    if (c.missingFields.length || c.uniqueBuyerCompleteness !== 'complete-address-window') freshness.incomplete++;
  }
  return { generatedAt: new Date(now).toISOString(), launches: tokens.length, sampledTokens: selected.length,
    liveLaunches: liveTokens.length, backfilledLaunches: backfilledTokens.length,
    legacyLaunches: tokens.length - liveTokens.length - backfilledTokens.length,
    medianLiveDiscoveryDelayMs: median(liveTokens.map(t => t.discovered_at - t.launch_time)),
    p90LiveDiscoveryDelayMs: percentile(liveTokens.map(t => t.discovered_at - t.launch_time), 0.9),
    liveCursorLagBlocks: latestLive.lag, maximumLiveCursorLagBlocks: cursorSamples.length ? Math.max(...cursorSamples.map(r=>r.lag_blocks)) : null,
    medianLiveCursorLagBlocks: median(cursorSamples.map(r=>r.lag_blocks)),
    activeTokenTrackingCoverage: { eligibleLiveLaunches: activeTokens.filter(t=>t.discovery_origin==='live').length,
      selectedActive: activeSelected.length, selectedWithMarketFetchLast3m: activeMarket.length,
      selectedWithMarketFetchLast3mPercent: percent(activeMarket.length, activeSelected.length) },
    collectorElapsedHours: spanHours, launchesPerCollectorElapsedHour: spanHours ? tokens.length / spanHours : null,
    launchesByUtcHour: launchesByHour, initialLookbackIncluded: true,
    allLaunchCoverage: coverageFor(tokens), sampledCoverage: coverageFor(selected),
    medianDiscoveryDelayMs: median(tokens.map(t => t.discovered_at - t.launch_time)),
    medianFirstMarketDelayMs: median(tokens.filter(t => firstMarket.has(t.token_address)).map(t => firstMarket.get(t.token_address)! - t.launch_time)),
    firstMarketDelayMeasuredAt: 'provider fetch time; source observation time often unavailable',
    tradesStored: store.one('SELECT COUNT(*) AS n FROM trades').n, snapshots: snapshots.length,
    providerRequests: requests, providerErrors: requests.reduce((n,r)=>n+Number(r.errors),0), rateLimitResponses: requests.reduce((n,r)=>n+Number(r.rateLimits),0),
    missingVenueResponses: store.one("SELECT COUNT(*) AS n FROM observations WHERE kind='market' AND error='Provider did not return requested venue'").n,
    rpcAttempts: store.get('rpcRequests', 0), errorGroups: errors,
    tracking, trackingDefinition: 'non-null market price observed through launch age; continuous also requires first observation within 3m and gaps <=3m before 1h, <=7m afterward',
    missingRates, latestSnapshotHealth: freshness, sampledMarketGaps: snapshotGaps,
    limitations: ['Sample is deterministic and capacity-limited, not random.', 'Legacy discovery delays include historical replay and are excluded from live statistics.', 'Initial near-head lookback affects even live discovery delay.', 'No six-hour completion claim until actual observations meet coverage criteria.', 'Post-graduation V4 RPC trades unsupported; market tracking continues.', 'Unique recipients are addresses, not independent humans.'] };
}
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}
export function liveCursorState(store: Store) {
  const head = store.get<number | null>('rpcHead', null);
  const live = FACTORIES.map(f => store.get<{block:number} | null>(`liveDiscovery:${f.address}`, null)?.block ?? null);
  const backfill = FACTORIES.map(f => store.get<{block:number} | null>(`backfillDiscovery:${f.address}`, null)?.block ?? null);
  const cursor = live.every(x=>x!==null) ? Math.min(...live as number[]) : null;
  const backfillCursor = backfill.every(x=>x!==null) ? Math.min(...backfill as number[]) : null;
  return { head, cursor, lag: head === null || cursor === null ? null : Math.max(0,head-cursor), backfillCursor,
    backfillLag: head === null || backfillCursor === null ? null : Math.max(0,head-backfillCursor) };
}
export function status(store: Store, now = Date.now()): string {
  const count = (table: string) => store.one(`SELECT COUNT(*) AS n FROM ${table}`).n;
  const cursors = liveCursorState(store);
  const gecko = store.one(`SELECT COUNT(*) AS n FROM observations WHERE provider='geckoterminal' AND kind='http' AND fetched_at>?`, now - 60_000).n;
  const rpcLimits = store.one(`SELECT COUNT(*) AS n FROM observations WHERE provider='rpc' AND kind='http' AND status=429`).n;
  const geckoLimits = store.one(`SELECT COUNT(*) AS n FROM observations WHERE provider='geckoterminal' AND kind='http' AND status=429`).n;
  const rpcErrors = store.one(`SELECT COUNT(*) AS n FROM observations WHERE provider='rpc' AND kind='http' AND error IS NOT NULL`).n;
  const uptime = Math.floor((now - store.get('runStartedAt', now)) / 1000);
  const recent = store.all('SELECT token_address,symbol,protocol_version FROM tokens ORDER BY discovered_at DESC LIMIT 3');
  const health = { fresh: 0, stale: 0, unknown: 0, incomplete: 0 };
  for (const s of store.all(`SELECT s.* FROM snapshots s JOIN (SELECT token_address,MAX(id) AS id FROM snapshots GROUP BY token_address) x ON s.id=x.id`)) {
    const c = JSON.parse(s.coverage);
    const staleMs = store.get('staleMs', 180000);
    const stale = s.fetched_at === null || now-s.fetched_at > staleMs || c.providerError || (s.source_observation_time !== null && now-s.source_observation_time > staleMs);
    health[stale ? 'stale' : c.sourceTimeKnown ? 'fresh' : 'unknown']++;
    if (c.missingFields.length || c.uniqueBuyerCompleteness !== 'complete-address-window') health.incomplete++;
  }
  const active = store.one('SELECT COUNT(*) AS n FROM tokens WHERE launch_time<=? AND launch_time>?',now,now-3*HOUR).n;
  const warn = cursors.lag !== null && cursors.lag > store.get('maxLiveLagBlocks', 2000);
  return `RPC HEAD ${cursors.head ?? 'unknown'}  LIVE CURSOR ${cursors.cursor ?? 'not initialized'}  LIVE LAG ${cursors.lag ?? 'unknown'} BLOCKS${warn?'  ⚠ ABOVE LIMIT':''}  UPTIME ${uptime}s\n` +
    `BACKFILL CURSOR ${cursors.backfillCursor ?? 'disabled'}  BACKFILL LAG ${cursors.backfillLag ?? 'n/a'} (paused)\n` +
    `TOKENS ${count('tokens')}  ACTIVE <3H ${active}  TRACKED TOKENS ${store.selected(now).length}\n` +
    `TOKENS DISCOVERED LIVE ${store.one("SELECT COUNT(*) AS n FROM tokens WHERE discovery_origin='live'").n}  TOKENS DISCOVERED BACKFILL ${store.one("SELECT COUNT(*) AS n FROM tokens WHERE discovery_origin='backfill'").n}\n` +
    `TRADES ${count('trades')}  SNAPSHOTS ${count('snapshots')}  RPC 429s ${rpcLimits}  RPC errors ${rpcErrors}  GECKO 429s ${geckoLimits}  GECKO requests/min ${gecko}\n` +
    `DATA HEALTH ${jsonText(health)}\nRecent: ${recent.map(t => `${t.symbol ?? t.token_address} (${t.protocol_version})`).join(', ')}`;
}
function jsonText(value: unknown) { return JSON.stringify(value); }
