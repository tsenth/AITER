import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { json, type Launch } from './pons.js';

export const schema = `
CREATE TABLE IF NOT EXISTS tokens (
 token_address TEXT PRIMARY KEY, chain INTEGER NOT NULL DEFAULT 4663, deployer_address TEXT NOT NULL,
 factory TEXT NOT NULL, protocol_version TEXT NOT NULL, quote_asset TEXT NOT NULL,
 launch_block INTEGER NOT NULL, launch_time INTEGER NOT NULL, discovered_at INTEGER NOT NULL,
 block_hash TEXT NOT NULL, transaction_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
 name TEXT, symbol TEXT, decimals INTEGER, selected INTEGER NOT NULL DEFAULT 0,
 UNIQUE(chain, transaction_hash, log_index));
CREATE TABLE IF NOT EXISTS venues (
 token_address TEXT PRIMARY KEY REFERENCES tokens(token_address), curve_address TEXT, pool_address TEXT, pool_id TEXT,
 venue_type TEXT NOT NULL, phase TEXT NOT NULL, phase_observed_at INTEGER, phase_block INTEGER,
 trade_cursor INTEGER, trade_cursor_hash TEXT, trade_complete_from INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS observations (
 id INTEGER PRIMARY KEY, token_address TEXT REFERENCES tokens(token_address), provider TEXT NOT NULL, kind TEXT NOT NULL,
 fetched_at INTEGER NOT NULL, source_observation_time INTEGER, last_trade_time INTEGER, block_number INTEGER,
 block_hash TEXT, status INTEGER, error TEXT, payload TEXT, dedupe_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS trades (
 chain INTEGER NOT NULL DEFAULT 4663, transaction_hash TEXT NOT NULL, log_index INTEGER NOT NULL,
 token_address TEXT NOT NULL REFERENCES tokens(token_address), venue_address TEXT NOT NULL,
 block_number INTEGER NOT NULL, block_hash TEXT NOT NULL, timestamp INTEGER NOT NULL, side TEXT NOT NULL,
 token_amount TEXT NOT NULL, quote_amount TEXT NOT NULL, raw_actor TEXT NOT NULL, resolved_recipient TEXT,
 attribution TEXT NOT NULL, PRIMARY KEY(chain, transaction_hash, log_index));
CREATE TABLE IF NOT EXISTS snapshots (
 id INTEGER PRIMARY KEY, token_address TEXT NOT NULL REFERENCES tokens(token_address), recorded_at INTEGER NOT NULL,
 observation_id INTEGER REFERENCES observations(id), fetched_at INTEGER, source_observation_time INTEGER,
 last_trade_time INTEGER, block_number INTEGER, provider TEXT, age_ms INTEGER NOT NULL,
 normalized TEXT NOT NULL, coverage TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS observations_token ON observations(token_address, kind, fetched_at);
CREATE INDEX IF NOT EXISTS trades_token_time ON trades(token_address, timestamp);
CREATE INDEX IF NOT EXISTS snapshots_token_time ON snapshots(token_address, recorded_at);
`;
const migration2 = `
ALTER TABLE tokens ADD COLUMN discovery_origin TEXT NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS tokens_origin_time ON tokens(discovery_origin, launch_time);
CREATE TABLE IF NOT EXISTS live_cursor_samples (
 id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, head INTEGER NOT NULL,
 safe_head INTEGER NOT NULL, live_cursor INTEGER NOT NULL, lag_blocks INTEGER NOT NULL,
 warning INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS live_cursor_samples_time ON live_cursor_samples(observed_at);
PRAGMA user_version = 2;
`;
const migration3 = `
CREATE TABLE IF NOT EXISTS product_events (id INTEGER PRIMARY KEY, event TEXT NOT NULL, token_address TEXT, count INTEGER, occurred_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS product_events_time ON product_events(occurred_at);
PRAGMA user_version = 3;
`;
const migration4 = `
CREATE TABLE IF NOT EXISTS activity_events (
 transaction_hash TEXT NOT NULL, log_index INTEGER NOT NULL, venue_address TEXT NOT NULL,
 block_number INTEGER NOT NULL, block_hash TEXT NOT NULL, side TEXT NOT NULL,
 buyer_address TEXT, PRIMARY KEY(transaction_hash,log_index));
CREATE INDEX IF NOT EXISTS activity_events_venue_block ON activity_events(venue_address,block_number);
CREATE INDEX IF NOT EXISTS activity_events_block ON activity_events(block_number);
PRAGMA user_version = 4;
`;
const migration5 = `
CREATE TABLE IF NOT EXISTS auto_hunt_signals (
 id INTEGER PRIMARY KEY, token_address TEXT NOT NULL REFERENCES tokens(token_address),
 found_at INTEGER NOT NULL, data_timestamp INTEGER NOT NULL, payload TEXT NOT NULL,
 UNIQUE(token_address));
CREATE INDEX IF NOT EXISTS auto_hunt_signals_time ON auto_hunt_signals(found_at);
PRAGMA user_version = 5;
`;
const migration6 = `
CREATE TABLE IF NOT EXISTS find_signals (
 id INTEGER PRIMARY KEY, token_address TEXT NOT NULL REFERENCES tokens(token_address),
 found_at INTEGER NOT NULL, data_timestamp INTEGER NOT NULL, payload TEXT NOT NULL,
 UNIQUE(token_address));
CREATE INDEX IF NOT EXISTS find_signals_time ON find_signals(found_at);
INSERT OR IGNORE INTO find_signals(token_address,found_at,data_timestamp,payload)
 SELECT token_address,found_at,data_timestamp,payload FROM auto_hunt_signals;
PRAGMA user_version = 6;
`;
const migration7 = `
CREATE TABLE IF NOT EXISTS solana_pools (
 pool_address TEXT PRIMARY KEY, mint_address TEXT NOT NULL, quote_mint TEXT NOT NULL,
 quote_symbol TEXT, dex_id TEXT, name TEXT, symbol TEXT, image_url TEXT,
 created_at INTEGER NOT NULL, discovered_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
 price REAL, fdv REAL, market_cap REAL, liquidity REAL, volume_5m REAL,
 buys_5m INTEGER, sells_5m INTEGER, buyers_5m INTEGER, sellers_5m INTEGER,
 price_change_5m REAL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS solana_pools_mint_time ON solana_pools(mint_address,created_at,fetched_at);
CREATE TABLE IF NOT EXISTS solana_find_signals (
 id INTEGER PRIMARY KEY, mint_address TEXT NOT NULL, pool_address TEXT NOT NULL,
 found_at INTEGER NOT NULL, data_timestamp INTEGER NOT NULL, payload TEXT NOT NULL,
 UNIQUE(mint_address));
CREATE INDEX IF NOT EXISTS solana_find_signals_time ON solana_find_signals(found_at);
ALTER TABLE product_events ADD COLUMN chain TEXT;
PRAGMA user_version = 7;
`;
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = Number((this.db.prepare('PRAGMA user_version').get() as any).user_version);
    if (version > 7) throw new Error(`Unsupported database schema ${version}`);
    this.db.exec(schema);
    if (version < 2) this.atomic(() => this.db.exec(migration2));
    if (version < 3) this.atomic(() => this.db.exec(migration3));
    if (version < 4) this.atomic(() => this.db.exec(migration4));
    if (version < 5) this.atomic(() => this.db.exec(migration5));
    if (version < 6) this.atomic(() => this.db.exec(migration6));
    if (version < 7) this.atomic(() => this.db.exec(migration7));
  }
  all(sql: string, ...params: any[]): any[] { return this.db.prepare(sql).all(...params); }
  one(sql: string, ...params: any[]): any { return this.db.prepare(sql).get(...params); }
  run(sql: string, ...params: any[]) { return this.db.prepare(sql).run(...params); }
  get<T>(key: string, fallback: T): T { const r = this.one('SELECT value FROM collection_state WHERE key=?', key); return r ? JSON.parse(r.value) : fallback; }
  set(key: string, value: unknown) { this.run('INSERT INTO collection_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, json(value)); }
  atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  observation(p: { token?: string; provider: string; kind: string; fetchedAt: number; sourceTime?: number | null; lastTradeTime?: number | null; block?: number | null; blockHash?: string | null; status?: number | null; error?: string | null; payload?: unknown; key?: string }) {
    const r = this.run(`INSERT OR IGNORE INTO observations(token_address,provider,kind,fetched_at,source_observation_time,last_trade_time,block_number,block_hash,status,error,payload,dedupe_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.token ?? null, p.provider, p.kind, p.fetchedAt, p.sourceTime ?? null, p.lastTradeTime ?? null, p.block ?? null, p.blockHash ?? null,
      p.status ?? null, p.error ?? null, p.payload === undefined ? null : json(p.payload), p.key ?? null);
    return Number(r.lastInsertRowid);
  }
  launch(l: Launch, origin: 'live' | 'backfill' | 'legacy' = 'legacy') {
    this.run(`INSERT OR IGNORE INTO tokens(token_address,deployer_address,factory,protocol_version,quote_asset,launch_block,launch_time,discovered_at,block_hash,transaction_hash,log_index,discovery_origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      l.tokenAddress, l.deployerAddress, l.factory, l.version, l.quoteAsset, l.launchBlock, l.launchTime, l.discoveredAt, l.blockHash, l.transactionHash, l.logIndex, origin);
    this.run(`INSERT OR IGNORE INTO venues(token_address,curve_address,pool_address,venue_type,phase,phase_observed_at,phase_block,trade_cursor,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      l.tokenAddress, l.curveAddress, l.poolAddress, l.curveAddress ? 'curve' : 'v3', l.curveAddress ? 'not-graduated' : 'pool-at-launch', l.launchTime, l.launchBlock, l.launchBlock - 1, l.discoveredAt);
  }
  trade(t: ReturnType<typeof import('./pons.js').decodeTrade>) {
    this.run(`INSERT OR IGNORE INTO trades(transaction_hash,log_index,token_address,venue_address,block_number,block_hash,timestamp,side,token_amount,quote_amount,raw_actor,resolved_recipient,attribution) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      t.transactionHash, t.logIndex, t.tokenAddress, t.venueAddress, t.block, t.blockHash, t.timestamp, t.side, t.tokenAmount, t.quoteAmount, t.actor, t.recipient, t.attribution);
  }
  selected(now: number, grace = 900_000) {
    return this.all(`SELECT t.*,v.* FROM tokens t JOIN venues v USING(token_address) WHERE selected=1 AND launch_time<=? AND launch_time+21600000+?>=? ORDER BY launch_time, token_address`, now, grace, now);
  }
  close() { this.db.close(); }
}
