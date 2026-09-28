import { encodeFunctionData, decodeFunctionResult, toEventSelector, type Abi, type Hex } from 'viem';
import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from './db.js';
import type { Config } from './config.js';
import { json, type RpcLog } from './pons.js';

export class Deferred extends Error {}
export class ChainMismatch extends Error {}
export class Rpc {
  private nextRequest = 0;
  private id = 0;
  constructor(readonly store: Store, readonly cfg: Config) {}
  async request<T>(method: string, params: unknown[]): Promise<T> {
    if (Date.now() < this.store.get('rpcNext', 0)) throw new Deferred('RPC cooldown');
    // Shared spacing and cooldown across discovery, trades and state jobs.
    const scheduled = Math.max(Date.now(), this.nextRequest, this.store.get('rpcNext', 0));
    this.nextRequest = scheduled + this.cfg.rpcSpacingMs;
    await delay(Math.max(0, scheduled - Date.now()));
    // A preceding in-flight call may have learned a new cooldown after this call was queued.
    if (Date.now() < this.store.get('rpcNext', 0)) throw new Deferred('RPC cooldown');
    const at = Date.now();
    this.store.set('rpcRequests', this.store.get('rpcRequests', 0) + 1);
    try {
      const r = await fetch(this.cfg.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'FIND-Lab/0.1' },
        body: json({ jsonrpc: '2.0', id: ++this.id, method, params }), signal: AbortSignal.timeout(15_000) });
      if (!r.ok) {
        if (r.status === 429) {
          const streak = this.store.get('rpcRateLimitStreak', 0) + 1;
          this.store.set('rpcRateLimitStreak', streak);
          const retry = r.headers.get('retry-after');
          const retryMs = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry)*1000 : Date.parse(retry)-Date.now()) : 0;
          this.store.set('rpcNext', Date.now()+Math.max(Math.min(300_000,30_000*2**Math.min(streak,4)),Number.isFinite(retryMs)?retryMs:0));
        }
        this.store.observation({ provider: 'rpc', kind: 'http', fetchedAt: at, status: r.status, error: `RPC HTTP ${r.status}: ${method}` });
        throw new RecordedError(`RPC HTTP ${r.status}: ${method}`);
      }
      const d: any = await r.json();
      if (d.error || d.result === undefined || d.result === null) {
        const limited = d.error?.code === 429 || /rate.limit|too many requests/i.test(d.error?.message ?? '');
        if (limited) {
          const streak = this.store.get('rpcRateLimitStreak', 0) + 1;
          this.store.set('rpcRateLimitStreak', streak);
          this.store.set('rpcNext', Date.now()+Math.min(300_000,30_000*2**Math.min(streak,4)));
        }
        this.store.observation({ provider: 'rpc', kind: 'http', fetchedAt: at, status: limited ? 429 : r.status,
          error: `RPC ${method} returned JSON-RPC error ${d.error?.code ?? 'missing-result'}`, payload: { method, error: d.error ?? null } });
        throw new RecordedError(`RPC ${method} server error`);
      }
      this.store.set('rpcRateLimitStreak', 0);
      return d.result;
    } catch (e) {
      if (!(e instanceof RecordedError)) this.store.observation({ provider: 'rpc', kind: 'http', fetchedAt: at, error: `RPC ${method} failed (${(e as Error).name})` });
      // Do not print fetch URLs: configured URLs may contain API keys.
      throw new Error(`RPC ${method} failed; inspect observations for error category`);
    }
  }
  async head() { return Number(BigInt(await this.request<Hex>('eth_blockNumber', []))); }
  async block(n: number) {
    const b = await this.request<any>('eth_getBlockByNumber', ['0x' + n.toString(16), false]);
    if (Number(BigInt(b.number)) !== n || !b.hash || !b.timestamp) throw new Error('Malformed RPC block');
    return { number: n, hash: b.hash as string, time: Number(BigInt(b.timestamp)) * 1000 };
  }
  async logs(address: string, event: Abi[number][], from: number, to: number) {
    return this.request<RpcLog[]>('eth_getLogs', [{ address, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      topics: [event.length === 1 ? toEventSelector(event[0] as any) : event.map(e => toEventSelector(e as any))] }]);
  }
  async read(address: string, abi: Abi, functionName: string, args: unknown[], block: number): Promise<any> {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await this.request<Hex>('eth_call', [{ to: address, data }, '0x' + block.toString(16)]);
    return decodeFunctionResult({ abi, functionName, data: result });
  }
  async assertCursor(block: number, hash: string | null) {
    if (hash && (await this.block(block)).hash.toLowerCase() !== hash.toLowerCase()) {
      throw new ChainMismatch(`Canonical block changed at ${block}. Collector stopped; restore/reconcile the affected dataset before resuming.`);
    }
  }
}
class RecordedError extends Error {}
export class Gecko {
  constructor(readonly store: Store, readonly cfg: Config) {}
  available(now = Date.now()): boolean {
    const attempts = this.store.get<number[]>('geckoAttempts', []).filter(t => t > now - 60_000);
    return attempts.length < this.cfg.geckoRpm && now >= this.store.get('geckoNext', 0);
  }
  async request(path: string): Promise<{ payload: any; fetchedAt: number; cacheAge: number | null }> {
    const now = Date.now();
    this.store.atomic(() => {
      if (!this.available(now)) throw new Deferred('Gecko request budget/cooldown');
      this.store.set('geckoAttempts', [...this.store.get<number[]>('geckoAttempts', []).filter(t => t > now - 60_000), now]);
      this.store.set('geckoNext', now + 13_000);
    });
    let status: number | undefined;
    try {
      const r = await fetch(this.cfg.geckoBase + path, { headers: { Accept: 'application/json;version=20230203', 'User-Agent': 'FIND-Lab/0.1' }, signal: AbortSignal.timeout(15_000) });
      status = r.status;
      if (!r.ok) {
        const streak = this.store.get('geckoFailures', 0) + 1;
        const retry = r.headers.get('retry-after');
        const retryMs = retry ? (/^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
        this.store.set('geckoFailures', streak);
        this.store.set('geckoNext', now + Math.max(60_000, Number.isFinite(retryMs) ? retryMs : 0, Math.min(900_000, 30_000 * 2 ** Math.min(streak, 5))));
        throw new Error(`Gecko HTTP ${r.status}`);
      }
      const payload = await r.json();
      if (!payload || typeof (payload as any).data !== 'object') throw new Error('Gecko malformed data');
      this.store.set('geckoFailures', 0);
      this.store.observation({ provider: 'geckoterminal', kind: 'http', fetchedAt: now, status, payload });
      const age = r.headers.get('age');
      return { payload, fetchedAt: now, cacheAge: age === null ? null : Number(age) * 1000 };
    } catch (e) {
      this.store.observation({ provider: 'geckoterminal', kind: 'http', fetchedAt: now, status, error: (e as Error).message });
      // Timeout/network failures also back off, while remaining visible in per-token observations.
      this.store.set('geckoNext', Math.max(this.store.get('geckoNext', 0), now + 60_000));
      throw e;
    }
  }
}
