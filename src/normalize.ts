export function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean' || typeof value === 'object') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
export function timestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const n = Date.parse(value); return Number.isFinite(n) && n > 0 ? n : null;
}
export function normalizeMarket(resource: any, token: string) {
  const a = resource?.attributes ?? {};
  const base = resource?.relationships?.base_token?.data?.id?.split('_').slice(1).join('_').toLowerCase();
  const quote = resource?.relationships?.quote_token?.data?.id?.split('_').slice(1).join('_').toLowerCase();
  if (resource && base !== token.toLowerCase() && quote !== token.toLowerCase()) throw new Error('Market resource does not identify requested token');
  const isBase = base === token.toLowerCase();
  const windows: Record<string, any> = {};
  for (const w of ['m5', 'm15', 'm30', 'h1', 'h6', 'h24']) {
    const t = a.transactions?.[w];
    // Provider side refers to the base token. Invert for a requested quote token.
    windows[w] = {
      volume: numeric(a.volume_usd?.[w]), buys: numeric(isBase ? t?.buys : t?.sells), sells: numeric(isBase ? t?.sells : t?.buys),
      buyers: numeric(isBase ? t?.buyers : t?.sellers), sellers: numeric(isBase ? t?.sellers : t?.buyers),
    };
  }
  return {
    price: numeric(isBase ? a.base_token_price_usd : a.quote_token_price_usd),
    // FDV/market cap belong to the base token; never assign them to a quote token.
    fdv: isBase ? numeric(a.fdv_usd) : null, marketCap: isBase ? numeric(a.market_cap_usd) : null,
    providerLiquidityEstimate: numeric(a.reserve_in_usd), windows,
    sourceObservationTime: timestamp(a.data_timestamp ?? a.updated_at), lastTradeTime: timestamp(a.last_trade_at),
  };
}
export function coverage(now: number, fetchedAt: number | null, sourceTime: number | null, error: string | null, staleMs: number, values: Record<string, unknown>) {
  const sourceAge = sourceTime === null ? null : now - sourceTime;
  const fetchAge = fetchedAt === null ? null : now - fetchedAt;
  const invalidTime = sourceAge !== null && sourceAge < -30_000;
  const freshness = error || fetchedAt === null || (fetchAge !== null && fetchAge > staleMs) || invalidTime || (sourceAge !== null && sourceAge > staleMs)
    ? 'stale' : sourceTime === null ? 'unknown' : 'fresh';
  return { freshness, fetchedAgeMs: fetchAge, sourceObservationAgeMs: sourceAge, sourceTimeKnown: sourceTime !== null,
    missingFields: Object.entries(values).filter(([,v]) => v === null || v === undefined).map(([k]) => k), providerError: error,
    invalidSourceTimestamp: invalidTime };
}
