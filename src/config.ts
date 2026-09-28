import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

function integer(name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return n;
}
function address(name: string): `0x${string}` | null {
  const value=process.env[name];
  if(!value) return null;
  if(!/^0x[0-9a-f]{40}$/i.test(value)) throw new Error(`${name} must be an EVM address`);
  return value.toLowerCase() as `0x${string}`;
}
export function config() {
  const rpcUrl = process.env.RPC_URL ?? 'https://rpc.mainnet.chain.robinhood.com';
  if (!/^https?:\/\//.test(rpcUrl)) throw new Error('RPC_URL must use HTTP(S)');
  const deploymentMode = process.env.AITER_DEPLOYMENT_MODE ?? 'full';
  if (!['full', 'free'].includes(deploymentMode)) throw new Error('AITER_DEPLOYMENT_MODE must be full or free');
  const dbPath = deploymentMode === 'free'
    ? `${tmpdir()}/aiter-free-${process.pid}.sqlite`
    : process.env.DB_PATH ?? 'data/find.sqlite';
  return {
    deploymentMode: deploymentMode as 'full' | 'free',
    rpcUrl, dbPath: resolve(dbPath),
    discoveryMs: integer('DISCOVERY_MS', 15_000, 15_000),
    tradeMs: integer('TRADE_MS', 60_000, 30_000),
    sampleSize: integer('SAMPLE_SIZE', 3, 1, 100),
    lookback: integer('INITIAL_LOOKBACK_BLOCKS', 300, 0),
    maxLiveLagBlocks: integer('MAX_LIVE_LAG_BLOCKS', 2000, 100),
    liveOverlapBlocks: integer('LIVE_OVERLAP_BLOCKS', 20, 0, 1000),
    sampleSlotMs: integer('SAMPLE_SLOT_MS', 600_000, 60_000),
    chunk: integer('LOG_CHUNK_BLOCKS', 1000, 1, 5000),
    confirmations: integer('CONFIRMATION_BLOCKS', 20, 1),
    geckoRpm: integer('GECKO_REQUESTS_PER_MINUTE', 5, 1, 5),
    staleMs: integer('STALE_AFTER_MS', 180_000, 60_000),
    rpcSpacingMs: integer('RPC_SPACING_MS', 1000, 500),
    rpcEnrichment: process.env.RPC_ENRICHMENT === 'true',
    autoHuntEnabled: deploymentMode === 'free' ? false : process.env.AUTO_HUNT_ENABLED === 'true',
    autoHuntBeta: process.env.AUTO_HUNT_BETA === 'true',
    aiterTokenAddress: address('AITER_TOKEN_ADDRESS'),
    aiterLockAddress: address('AITER_LOCK_ADDRESS'),
    autoHuntMinLocked: process.env.AUTO_HUNT_MIN_LOCKED ?? '0',
    geckoBase: 'https://api.geckoterminal.com/api/v2',
  };
}
export type Config = ReturnType<typeof config>;
export const HOUR = 3_600_000;
export const TARGET_AGES = [120_000, 300_000, 600_000, 900_000, 1_800_000, HOUR];
export function nextAge(age: number): number | null {
  const target = TARGET_AGES.find(t => t > age);
  if (target !== undefined) return target;
  if (age >= 6 * HOUR) return null;
  return Math.min(6 * HOUR, (Math.floor(age / 300_000) + 1) * 300_000);
}
