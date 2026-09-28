import { setTimeout as delay } from 'node:timers/promises';
import { toEventSelector } from 'viem';
import { Store } from './db.js';
import { HOUR, nextAge, type Config } from './config.js';
import { Rpc, Gecko, Deferred, ChainMismatch } from './providers.js';
import { FACTORIES, v2Launch, v1Launch, curveBuy, curveSell, v3Swap, stateAbi, reserveAbi, metadataAbi, poolId, decodeLaunch, decodeTrade, json } from './pons.js';
import { normalizeMarket, coverage } from './normalize.js';
import { status } from './report.js';
import { rankAutoHunt } from './ranking.js';

export class Collector {
  readonly rpc: Rpc;
  readonly gecko: Gecko;
  stopped = false;
  private blocks = new Map<number, { number: number; hash: string; time: number }>();
  private statePosition = 0;
  private marketPosition = 0;
  private checkedCursors = new Map<string, number>();
  constructor(readonly store: Store, readonly cfg: Config) { this.rpc = new Rpc(store, cfg); this.gecko = new Gecko(store, cfg); }
  async block(n: number) {
    let b = this.blocks.get(n);
    if (!b) { b = await this.rpc.block(n); this.blocks.set(n, b); }
    if (this.blocks.size > 5000) this.blocks.delete(this.blocks.keys().next().value!);
    return b;
  }
  async discover() {
    const head = await this.rpc.head();
    const safe = head - this.cfg.confirmations;
    this.store.set('rpcHead', head); this.store.set('safeHead', safe);
    this.initializeLive(safe);
    const lagBefore = this.liveLag(head);
    if (lagBefore > this.cfg.maxLiveLagBlocks) {
      console.warn(`LIVE DISCOVERY WARNING: lag ${lagBefore} blocks exceeds ${this.cfg.maxLiveLagBlocks}; recovering recent coverage.`);
      this.store.set('liveLagWarning', { at: Date.now(), lagBlocks: lagBefore });
    }
    for (const f of FACTORIES) {
      const key = `liveDiscovery:${f.address}`;
      let cursor = this.store.get<{ block: number; hash: string | null }>(key, { block: Math.max(0, safe - this.cfg.lookback), hash: null });
      if (safe - cursor.block > this.cfg.maxLiveLagBlocks) {
        const replacement = Math.max(0, safe - this.cfg.lookback);
        this.store.atomic(() => {
          this.store.observation({ provider: 'collector', kind: 'discovery_gap', fetchedAt: Date.now(),
            error: `Live cursor lag ${safe-cursor.block} blocks; skipped older range to restore live coverage`,
            payload: { factory: f.address, fromBlock: cursor.block + 1, toBlock: replacement, reason: 'live-lag-safety-reset' } });
          this.store.set(key, { block: replacement, hash: null });
        });
        cursor = { block: replacement, hash: null };
        this.checkedCursors.delete(key);
      }
      if (Date.now() - (this.checkedCursors.get(key) ?? 0) >= 60_000) {
        await this.rpc.assertCursor(cursor.block,cursor.hash);
        this.checkedCursors.set(key,Date.now());
      }
      // One bounded range per factory per pass. The next 15-second pass resumes it.
      if (cursor.block < safe && !this.stopped) {
        const end = Math.min(safe, cursor.block + this.cfg.chunk);
        const from = Math.max(0, cursor.block + 1 - this.cfg.liveOverlapBlocks);
        const logs = await this.rpc.logs(f.address, [f.version === 'pons-v2' ? v2Launch : v1Launch], from, end);
        const launches: { launch: ReturnType<typeof decodeLaunch>; log: import('./pons.js').RpcLog }[] = [];
        for (const log of logs) {
          const b = await this.block(Number(BigInt(log.blockNumber)));
          if (b.hash.toLowerCase() !== log.blockHash.toLowerCase()) throw new ChainMismatch('Launch log block hash mismatch');
          launches.push({ launch: decodeLaunch(log, f.version, b.time, Date.now()), log });
        }
        const endBlock = await this.block(end);
        this.store.atomic(() => {
          for (const { launch, log } of launches) {
            this.store.launch(launch, 'live');
            this.store.observation({ token: launch.tokenAddress, provider: 'rpc', kind: 'launch', fetchedAt: launch.discoveredAt,
              sourceTime: launch.launchTime, block: launch.launchBlock, blockHash: launch.blockHash, payload: log,
              key: `4663:${launch.transactionHash}:${launch.logIndex}` });
          }
          this.store.set(key, { block: end, hash: endBlock.hash });
        });
      }
    }
    this.enroll();
    this.store.set('lastDiscoverySuccess', Date.now());
    const lagAfter = this.liveLag(head);
    this.store.run('INSERT INTO live_cursor_samples(observed_at,head,safe_head,live_cursor,lag_blocks,warning) VALUES (?,?,?,?,?,?)',
      Date.now(), head, safe, head - lagAfter, lagAfter, lagAfter > this.cfg.maxLiveLagBlocks ? 1 : 0);
  }
  initializeLive(safe: number, startup = false) {
    this.store.atomic(() => {
      for (const f of FACTORIES) {
        const old = this.store.get<{ block: number; hash: string | null } | null>(`discovery:${f.address}`, null);
        if (old && this.store.get(`backfillDiscovery:${f.address}`, null) === null) this.store.set(`backfillDiscovery:${f.address}`, old);
        const key = `liveDiscovery:${f.address}`;
        if (this.store.get(key, null) === null) {
          const start = Math.max(0, safe - this.cfg.lookback);
          this.store.set(key, { block: start, hash: null });
          if (old && old.block < start) this.store.observation({ provider: 'collector', kind: 'discovery_gap', fetchedAt: Date.now(),
            error: 'Legacy backlog isolated from live discovery', payload: { factory: f.address, fromBlock: old.block + 1, toBlock: start,
              reason: 'v1-cursor-migration', backfillCursor: old.block } });
        }
        else if (startup) {
          const current=this.store.get<{block:number;hash:string|null}>(key,{block:0,hash:null});
          const start=Math.max(0,safe-this.cfg.lookback);
          if (current.block < start) {
            this.store.observation({provider:'collector',kind:'discovery_gap',fetchedAt:Date.now(),
              error:'Startup live cursor reset to recent lookback',payload:{factory:f.address,fromBlock:current.block+1,toBlock:start,reason:'startup-live-first'}});
            this.store.set(key,{block:start,hash:null});
            this.checkedCursors.delete(key);
          }
        }
      }
    });
  }
  liveLag(head: number): number {
    const cursors = FACTORIES.map(f => this.store.get<{ block: number } | null>(`liveDiscovery:${f.address}`, null)?.block ?? 0);
    return Math.max(0, head - Math.min(...cursors));
  }
  enroll(now = Date.now()) {
    // Admit a few newest unsampled launches on every discovery pass. Existing samples
    // remain available for outcome tracking; they never occupy all fresh slots.
    const candidates = this.store.all(`SELECT token_address,launch_time FROM tokens WHERE selected=0 AND discovery_origin='live' AND launch_time>=? AND launch_time<=? ORDER BY launch_time DESC,token_address LIMIT ?`,
      now - Math.min(3 * HOUR, this.cfg.sampleSlotMs), now, this.cfg.sampleSize);
    this.store.atomic(() => {
      for (const t of candidates) {
        this.store.run('UPDATE tokens SET selected=1 WHERE token_address=?', t.token_address);
        this.store.set(`snapshotDue:${t.token_address}`, now);
      }
    });
  }
  async activity() {
    const now = Date.now();
    const safe = this.store.get<number>('safeHead', 0);
    const head = this.store.get<number>('rpcHead', 0);
    if (!safe || now-this.store.get('lastDiscoverySuccess',0)>90_000 || this.liveLag(head)>this.cfg.maxLiveLagBlocks) return;
    // A 3-minute starting boundary leaves ample room for RPC delays before
    // the next refresh. Counts are labelled "recent", never exact 5m.
    let boundary = this.store.get<{block:number;time:number;at:number}|null>('activityBoundary',null);
    if (!boundary || now-boundary.at>=60_000 || safe<boundary.block) {
      const cutoff=now-180_000;
      let low=Math.max(0,safe-6000),high=safe;
      while(low<high) {
        const mid=Math.floor((low+high)/2);
        if((await this.block(mid)).time<cutoff) low=mid+1;
        else high=mid;
      }
      const b=await this.block(low);
      boundary={block:low,time:b.time,at:Date.now()};
      this.store.set('activityBoundary',boundary);
    }
    let cursor=this.store.get<number|null>('activityCursor',null);
    if(cursor===null || cursor<boundary.block-1 || cursor>safe) cursor=boundary.block-1;
    if(cursor>=safe) return;
    const end=Math.min(safe,cursor+4000);
    const logs=await this.rpc.request<import('./pons.js').RpcLog[]>('eth_getLogs',[{
      fromBlock:'0x'+(cursor+1).toString(16),toBlock:'0x'+end.toString(16),
      topics:[[toEventSelector(curveBuy),toEventSelector(curveSell)]],
    }]);
    const buyTopic=toEventSelector(curveBuy).toLowerCase();
    const endBlock=await this.block(end);
    this.store.atomic(()=>{
      for(const log of logs) {
        if(log.removed || !log.blockHash || !log.transactionHash) continue;
        const buy=log.topics[0]?.toLowerCase()===buyTopic;
        const buyer=buy && /^0x[0-9a-f]{64}$/i.test(log.topics[2]??'') ? '0x'+log.topics[2].slice(-40).toLowerCase() : null;
        this.store.run(`INSERT OR IGNORE INTO activity_events(transaction_hash,log_index,venue_address,block_number,block_hash,side,buyer_address)
          VALUES (?,?,?,?,?,?,?)`,log.transactionHash,Number(BigInt(log.logIndex)),log.address.toLowerCase(),
          Number(BigInt(log.blockNumber)),log.blockHash,buy?'buy':'sell',buyer);
      }
      this.store.run('DELETE FROM activity_events WHERE block_number<?',boundary.block);
      this.store.set('activityCursor',end);
      this.store.set('activitySafeTime',endBlock.time);
      this.store.set('lastActivitySuccess',Date.now());
    });
    // Metadata is cheap only after actual activity narrows the launch universe.
    const names=this.store.all(`SELECT t.token_address,COUNT(*) n FROM tokens t JOIN venues v USING(token_address)
      JOIN activity_events e ON e.venue_address=v.curve_address
      WHERE t.discovery_origin='live' AND t.launch_time>? AND t.name IS NULL AND e.block_number>=?
      GROUP BY t.token_address HAVING n>=3 ORDER BY n DESC LIMIT 2`,now-3*HOUR,boundary.block);
    for(const t of names) {
      try {
        const [name,symbol]=await Promise.all([
          this.rpc.read(t.token_address,metadataAbi,'name',[],end),
          this.rpc.read(t.token_address,metadataAbi,'symbol',[],end),
        ]);
        if(typeof name==='string' && typeof symbol==='string')
          this.store.run('UPDATE tokens SET name=?,symbol=? WHERE token_address=?',name.slice(0,100),symbol.slice(0,30),t.token_address);
      } catch { /* A token may omit standard metadata; its address remains available. */ }
    }
  }
  async trades() {
    const safe = this.store.get('safeHead', 0);
    if (!safe) return;
    if (this.liveLag(this.store.get('rpcHead', safe)) > this.cfg.maxLiveLagBlocks) return;
    for (const t of this.store.selected(Date.now()).filter(t=>t.discovery_origin==='live' && Date.now()-t.launch_time<3*HOUR).sort((a,b)=>b.launch_time-a.launch_time).slice(0,10)) {
      if (this.stopped) return;
      // Curve histories remain backfillable after graduation; V4 swaps are explicitly unsupported.
      const address = t.curve_address ?? t.pool_address;
      if (!address) continue;
      const kind = t.curve_address ? 'curve' : 'v3';
      const row = this.store.one('SELECT trade_cursor,trade_cursor_hash FROM venues WHERE token_address=?', t.token_address);
      let cursor = row.trade_cursor;
      await this.rpc.assertCursor(cursor, row.trade_cursor_hash);
      for (let i = 0; i < 1 && cursor < safe && !this.stopped; i++) {
        const end = Math.min(safe, cursor + this.cfg.chunk);
        const logs = await this.rpc.logs(address, kind === 'curve' ? [curveBuy, curveSell] : [v3Swap], cursor + 1, end);
        const grouped = new Map<number, typeof logs>();
        for (const log of logs) {
          const n = Number(BigInt(log.blockNumber));
          const a = grouped.get(n) ?? []; a.push(log); grouped.set(n,a);
        }
        const commit = (b: { number: number; hash: string; time: number }, entries: typeof logs) => {
          const decoded = entries.map(log => {
            if (b.hash.toLowerCase() !== log.blockHash.toLowerCase()) throw new ChainMismatch('Trade log block hash mismatch');
            return { log, trade: decodeTrade(log,t.token_address,t.quote_asset,kind,b.time) };
          });
          this.store.atomic(() => {
            for (const { trade, log } of decoded) {
              this.store.trade(trade);
              this.store.observation({ token: t.token_address, provider: 'rpc', kind: 'trade', fetchedAt: Date.now(), sourceTime: trade.timestamp,
                block: trade.block, blockHash: trade.blockHash, payload: log, key: `4663:${trade.transactionHash}:${trade.logIndex}` });
            }
            this.store.run('UPDATE venues SET trade_cursor=?,trade_cursor_hash=?,trade_complete_from=COALESCE(trade_complete_from,?),updated_at=? WHERE token_address=?',
              b.number,b.hash,t.launch_block,Date.now(),t.token_address);
            this.store.set(`tradeCursorTime:${t.token_address}`,b.time);
          });
        };
        const ordered = [...grouped.entries()].sort((a,b)=>a[0]-b[0]);
        // Bound per-token work so a busy curve cannot monopolize all other sampled histories.
        for (const [n, entries] of ordered.slice(0,4)) {
          if (this.stopped) return;
          commit(await this.block(n),entries);
        }
        if (ordered.length > 4) break;
        if (this.stopped) return;
        commit(await this.rpc.block(end),[]);
        cursor = end;
      }
    }
    this.store.set('lastTradePass', Date.now());
  }
  async state() {
    const safe = this.store.get('safeHead', 0);
    if (!safe) return;
    if (this.liveLag(this.store.get('rpcHead', safe)) > this.cfg.maxLiveLagBlocks) return;
    const selected = this.store.selected(Date.now()).filter(t => t.discovery_origin==='live' && t.protocol_version === 'pons-v2' && Date.now()-t.launch_time<3*HOUR);
    if (!selected.length) return;
    // One token per second avoids a burst of state reads; rotates independently of quality.
    const t = selected[this.statePosition++ % selected.length];
    const last = this.store.get(`stateAttempt:${t.token_address}`, 0);
    if (Date.now() - last < (Date.now() - t.launch_time < HOUR ? 60_000 : 300_000)) return;
    this.store.set(`stateAttempt:${t.token_address}`, Date.now());
    try {
      const block = await this.block(safe);
      const launch = await this.rpc.read(t.factory, stateAbi, 'getLaunchedToken', [t.token_address], safe);
      if (!launch.exists || launch.token.toLowerCase() !== t.token_address || launch.curve.toLowerCase() !== t.curve_address) {
        throw new ChainMismatch('Pons state contradicts persisted launch identity');
      }
      const phase = ['not-graduated', 'swept', 'pool-created', 'rescued'][launch.phase] ?? 'unknown';
      let reserves: any = null;
      if (launch.phase === 0) {
        const [pricingQuote, tokenReserve] = await this.rpc.read(t.curve_address, reserveAbi, 'getReserves', [], safe);
        const realQuote = await this.rpc.read(t.curve_address, reserveAbi, 'realQuoteReserve', [], safe);
        reserves = { pricingQuoteReserve: pricingQuote.toString(), realQuoteReserve: realQuote.toString(), tokenReserve: tokenReserve.toString(),
          virtualQuoteReserve: (pricingQuote - realQuote).toString(), units: 'raw-token-base-units',
          virtualReserveDefinition: 'pricingQuoteReserve-minus-realQuoteReserve' };
      }
      this.store.atomic(() => {
        this.store.run('UPDATE venues SET phase=?,venue_type=?,pool_id=?,phase_observed_at=?,phase_block=?,updated_at=? WHERE token_address=?',
          phase, launch.phase === 2 ? 'v4' : 'curve', launch.phase === 2 ? poolId(t.token_address, t.quote_asset, launch.poolFee, launch.tickSpacing) : null,
          block.time, safe, Date.now(), t.token_address);
        this.store.observation({ token: t.token_address, provider: 'rpc', kind: 'state', fetchedAt: Date.now(), sourceTime: block.time,
          block: safe, blockHash: block.hash, payload: { launch, phase, reserves, hook: launch.phase === 2 ? 'configured-pons-v2-hook' : null } });
      });
    } catch (e) {
      if (e instanceof ChainMismatch) throw e;
      if (e instanceof Deferred) return;
      this.store.observation({ token: t.token_address, provider: 'rpc', kind: 'state', fetchedAt: Date.now(), error: (e as Error).message });
    }
  }
  async market() {
    if (!this.gecko.available()) return;
    const now = Date.now();
    // Reserve one in four free-tier requests for profile/social metadata after
    // real onchain activity has narrowed the launch universe.
    if (++this.marketPosition % 4 === 0) { await this.tokenInfo(now); return; }
    const priorSuccess = new Map<string,boolean>();
    const hasMarket = (token:string) => {
      if (!priorSuccess.has(token)) priorSuccess.set(token,Boolean(this.store.one(
        "SELECT 1 FROM observations WHERE token_address=? AND kind='market' AND error IS NULL LIMIT 1",token)));
      return priorSuccess.get(token)!;
    };
    const due = this.store.selected(now).filter(t => t.discovery_origin === 'live').filter(t => {
      const last = this.store.get(`marketAttempt:${t.token_address}`, 0);
      const finalNeeded = now >= t.launch_time + 6 * HOUR && this.store.get(`snapshotDue:${t.token_address}`, null) !== null;
      return now - last >= (now - t.launch_time < this.cfg.sampleSlotMs || finalNeeded ? 60_000 : hasMarket(t.token_address) ? 120_000 : 600_000);
    });
    if (!due.length) return;
    // One in three batches refreshes already-indexed pools. This prevents a steady
    // launch stream from starving the only pools that can produce usable cards.
    const preferKnown=this.marketPosition % 3 === 0;
    const priority=(t:any) => {
      const fresh=t.launch_time >= now-this.cfg.sampleSlotMs;
      const known=hasMarket(t.token_address);
      return preferKnown ? known&&!fresh?0:fresh?1:2 : fresh?0:known?1:2;
    };
    due.sort((a,b) => priority(a)-priority(b) ||
      this.store.get(`marketAttempt:${a.token_address}`, 0) - this.store.get(`marketAttempt:${b.token_address}`, 0));
    const batch = due.slice(0, 5);
    const addresses = batch.map(t => t.phase === 'pool-created' ? t.pool_id : t.curve_address ?? t.pool_address).filter(Boolean);
    if (!addresses.length) return;
    const path = '/networks/robinhood/pools/multi/' + addresses.join(',') + '?include=base_token,quote_token';
    try {
      const result = await this.gecko.request(path);
      this.store.atomic(() => {
        for (const t of batch) {
          const requested = t.phase === 'pool-created' ? t.pool_id : t.curve_address ?? t.pool_address;
          const resource = result.payload.data.find((p: any) => p.attributes?.address?.toLowerCase() === requested?.toLowerCase());
          const error = resource ? null : 'Provider did not return requested venue';
          this.store.observation({ token: t.token_address, provider: 'geckoterminal', kind: 'market', fetchedAt: result.fetchedAt,
            sourceTime: resource ? normalizeMarket(resource, t.token_address).sourceObservationTime : null,
            lastTradeTime: resource ? normalizeMarket(resource, t.token_address).lastTradeTime : null,
            status: 200, error, payload: { resource: resource ?? null, httpCacheAgeMs: result.cacheAge } });
          this.store.set(`marketAttempt:${t.token_address}`, result.fetchedAt);
          const included = result.payload.included?.find((p: any) => p.attributes?.address?.toLowerCase() === t.token_address);
          if (included) this.store.run('UPDATE tokens SET name=?,symbol=?,decimals=? WHERE token_address=?', included.attributes.name ?? null, included.attributes.symbol ?? null, included.attributes.decimals ?? null, t.token_address);
        }
      });
    } catch (e) {
      if (e instanceof Deferred) return;
      for (const t of batch) {
        this.store.observation({ token: t.token_address, provider: 'geckoterminal', kind: 'market', fetchedAt: Date.now(), error: (e as Error).message });
        this.store.set(`marketAttempt:${t.token_address}`, Date.now());
      }
    }
  }
  async tokenInfo(now = Date.now()) {
    const row=this.store.one(`SELECT t.token_address FROM tokens t JOIN venues v USING(token_address)
      JOIN activity_events e ON e.venue_address=v.curve_address
      WHERE t.discovery_origin='live' AND t.launch_time BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.token_address=t.token_address
        AND o.kind='token_info' AND o.fetched_at>?)
      GROUP BY t.token_address ORDER BY COUNT(*) DESC,t.launch_time DESC LIMIT 1`,
      now-3*HOUR,now,now-15*60_000);
    if(!row) return;
    try {
      const result=await this.gecko.request(`/networks/robinhood/tokens/${row.token_address}/info`);
      const resource=result.payload.data;
      if(!resource?.attributes) throw new Error('Provider did not return token info');
      this.store.atomic(()=>{
        this.store.observation({token:row.token_address,provider:'geckoterminal',kind:'token_info',
          fetchedAt:result.fetchedAt,status:200,payload:resource});
        const a=resource.attributes;
        if(typeof a.name==='string' || typeof a.symbol==='string') this.store.run(
          'UPDATE tokens SET name=COALESCE(?,name),symbol=COALESCE(?,symbol),decimals=COALESCE(?,decimals) WHERE token_address=?',
          typeof a.name==='string'?a.name.slice(0,100):null,typeof a.symbol==='string'?a.symbol.slice(0,30):null,
          Number.isInteger(a.decimals)?a.decimals:null,row.token_address);
      });
    } catch(e) {
      if(e instanceof Deferred) return;
      this.store.observation({token:row.token_address,provider:'geckoterminal',kind:'token_info',
        fetchedAt:Date.now(),error:(e as Error).message});
    }
  }
  autoHunt() {
    if(!this.cfg.autoHuntEnabled) return;
    const now=Date.now();
    const signals=rankAutoHunt(this.store,this.cfg,now);
    this.store.atomic(()=>{
      for(const signal of signals) this.store.run(
        'INSERT OR IGNORE INTO auto_hunt_signals(token_address,found_at,data_timestamp,payload) VALUES (?,?,?,?)',
        signal.tokenAddress,now,Date.parse(signal.dataTimestamp),json(signal));
      this.store.run('DELETE FROM auto_hunt_signals WHERE found_at<?',now-24*HOUR);
      this.store.set('lastAutoHuntPass',now);
      this.store.set('lastAutoHuntFound',signals.length);
    });
  }
  snapshots(now = Date.now()) {
    for (const t of this.store.selected(now)) {
      const due = this.store.get<number | null>(`snapshotDue:${t.token_address}`, now);
      if (due === null || now < due) continue;
      const obs = this.store.one(`SELECT * FROM observations WHERE token_address=? AND kind='market' ORDER BY id DESC LIMIT 1`, t.token_address);
      // Wait for a real boundary-or-later fetch for the last scheduled snapshot; never label an old fetch as 6H.
      if (now >= t.launch_time + 6 * HOUR && (obs?.fetched_at ?? 0) < t.launch_time + 6 * HOUR && now < t.launch_time + 6 * HOUR + 900_000) continue;
      const state = this.store.one(`SELECT * FROM observations WHERE token_address=? AND kind='state' ORDER BY id DESC LIMIT 1`, t.token_address);
      const resource = obs?.payload ? JSON.parse(obs.payload).resource : null;
      const m = normalizeMarket(resource, t.token_address);
      const rawState = state?.payload ? JSON.parse(state.payload) : null;
      const age = now - t.launch_time;
      const trade = this.store.one('SELECT MAX(timestamp) AS last FROM trades WHERE token_address=?', t.token_address);
      const cursorBlock = t.trade_cursor_hash ? this.blocks.get(t.trade_cursor) : undefined;
      const cursorTime = cursorBlock?.time ?? this.store.get<number | null>(`tradeCursorTime:${t.token_address}`, null);
      const historyComplete = t.trade_complete_from === t.launch_block && cursorTime !== null;
      const knownRecipients = t.protocol_version === 'pons-v2';
      const windowEnd = Math.min(now, cursorTime ?? now);
      const unique = this.store.one(`SELECT COUNT(DISTINCT resolved_recipient) AS n FROM trades WHERE token_address=? AND side='buy' AND attribution='curve-recipient-address' AND timestamp>=? AND timestamp<=?`, t.token_address, windowEnd - 300_000, windowEnd).n;
      const values = { price: m.price, fdv: m.fdv, marketCap: m.marketCap, providerLiquidityEstimate: m.providerLiquidityEstimate,
        volume5m: m.windows.m5.volume, buys5m: m.windows.m5.buys, sells5m: m.windows.m5.sells, buyers5m: m.windows.m5.buyers,
        sellers5m: m.windows.m5.sellers, lastTradeTime: m.lastTradeTime ?? trade.last ?? null };
      const marketCoverage = coverage(now, obs?.fetched_at ?? null, obs?.source_observation_time ?? null, obs?.error ?? null, this.cfg.staleMs, values);
      const stateCoverage = coverage(now, state?.fetched_at ?? null, state?.source_observation_time ?? null, state?.error ?? null, this.cfg.staleMs, { reserves: rawState?.reserves ?? null });
      const c = { ...marketCoverage, state: stateCoverage, observationAgeMs: age, samplePolicy: 'newest-unsampled-live-launches-per-discovery-pass',
        lastTradeTimeSource: m.lastTradeTime !== null ? 'geckoterminal' : trade.last !== null ? 'rpc-last-observed-trade' : null,
        providerBuyerAttribution: 'provider-reported; wallet attribution semantics unverified',
        tradeHistoryComplete: historyComplete, tradeCursor: t.trade_cursor, tradeCursorTime: cursorTime,
        tradeHistoryLagMs: cursorTime === null ? null : now - cursorTime,
        tradeAttribution: knownRecipients && t.phase === 'not-graduated' ? 'curve-recipient-addresses-only' : 'incomplete-or-unsupported',
        uniqueBuyerWindowMs: 300_000, uniqueBuyerWindowEnd: cursorTime,
        uniqueBuyerCompleteness: historyComplete && knownRecipients && t.phase === 'not-graduated' && state?.error === null && now - state.fetched_at <= this.cfg.staleMs ? 'complete-address-window' : 'partial',
        scheduledFor: due, scheduleDelayMs: now - due,
      };
      this.store.atomic(() => {
        this.store.run(`INSERT INTO snapshots(token_address,recorded_at,observation_id,fetched_at,source_observation_time,last_trade_time,block_number,provider,age_ms,normalized,coverage) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          t.token_address, now, obs?.id ?? null, obs?.fetched_at ?? null, obs?.source_observation_time ?? null, values.lastTradeTime,
          state?.block_number ?? null, obs?.provider ?? null, age,
          json({ ...values, windows: m.windows, venueType: t.venue_type, phase: t.phase, curveReserves: rawState?.reserves ?? null,
            experimentalUniqueBuyers5m: knownRecipients && t.trade_complete_from !== null ? unique : null }), json(c));
        const next = nextAge(age);
        this.store.set(`snapshotDue:${t.token_address}`, next === null ? null : t.launch_time + next);
      });
    }
  }
  async run(seconds?: number) {
    const chain = Number(BigInt(await this.rpc.request<string>('eth_chainId', [])));
    if (chain !== 4663) throw new ChainMismatch(`Expected Robinhood mainnet 4663, got ${chain}`);
    const started = Date.now();
    this.store.set('staleMs', this.cfg.staleMs);
    this.store.set('maxLiveLagBlocks', this.cfg.maxLiveLagBlocks);
    this.store.set('firstStartedAt', this.store.get('firstStartedAt', started)); this.store.set('runStartedAt', started);
    // Establish a live cursor before any enrichment loops start.
    const startupHead = await this.rpc.head();
    this.store.set('rpcHead', startupHead);
    this.initializeLive(startupHead - this.cfg.confirmations, true);
    console.log(`Startup RPC HEAD ${startupHead}; LIVE CURSOR ${startupHead-this.liveLag(startupHead)}; LIVE LAG ${this.liveLag(startupHead)} blocks.`);
    console.log('AITER COLLECTOR: Ctrl+C stops safely.');
    let fatal: Error | null = null;
    const loop = async (name: string, interval: number, fn: () => Promise<void> | void) => {
      while (!this.stopped) {
        const begin = Date.now();
        try { await fn(); } catch (e) {
          if (!(e instanceof Deferred)) {
            console.error(`${name}: ${(e as Error).message}`);
            this.store.observation({ provider: 'collector', kind: name, fetchedAt: Date.now(), error: (e as Error).message });
            if (e instanceof ChainMismatch) { fatal = e; this.stopped = true; }
          }
        }
        const until = begin + interval;
        while (!this.stopped && Date.now() < until) await delay(Math.min(500, until - Date.now()));
      }
    };
    const stop = () => { this.stopped = true; };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const timer = seconds === undefined ? undefined : setTimeout(stop, seconds * 1000);
    try {
      const jobs = [
        loop('discovery', this.cfg.discoveryMs, () => this.discover()),
        loop('activity', 15_000, () => this.activity()),
        loop('auto-hunt', 30_000, () => this.autoHunt()),
        loop('market', 1000, () => this.market()),
        loop('snapshots', 5000, () => this.snapshots()),
        loop('status', 30_000, () => { this.store.set('lastHeartbeat', Date.now()); console.log(status(this.store)); }),
      ];
      if (this.cfg.rpcEnrichment) jobs.push(loop('trades', this.cfg.tradeMs, () => this.trades()),loop('state', 10_000, () => this.state()));
      await Promise.all(jobs);
      if (fatal) throw fatal;
    } finally {
      if (timer) clearTimeout(timer);
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      this.store.set('lastStoppedAt', Date.now());
      console.log('Collector stopped; committed cursors retained.');
    }
  }
}
