import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, toEventSelector, type Hex } from 'viem';
import { Store, schema } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import { decodeLaunch, decodeTrade, v2Launch, v1Launch, curveBuy, curveSell, v3Swap, type RpcLog, type Launch } from '../src/pons.js';
import { numeric, timestamp, normalizeMarket, coverage } from '../src/normalize.js';
import { config, nextAge, HOUR } from '../src/config.js';
import { Collector } from '../src/collector.js';
import { Gecko, Rpc, Deferred, ChainMismatch } from '../src/providers.js';
import { report, status } from '../src/report.js';

const token = '0x0000000000000000000000000000000000000011';
const actor = '0x0000000000000000000000000000000000000022';
const recipient = '0x0000000000000000000000000000000000000033';
const quote = '0x0000000000000000000000000000000000000044';
const curve = '0x0000000000000000000000000000000000000055';
const hash = ('0x' + 'ab'.repeat(32)) as Hex;
const addressTopic = (s: string) => ('0x'+s.slice(2).padStart(64,'0')) as Hex;
function log(event: any, topics: string[], data: Hex): RpcLog {
  return { address: curve, topics: [toEventSelector(event), ...topics.map(addressTopic)], data, blockNumber: '0x64', blockHash: hash, transactionHash: hash, logIndex: '0x1' };
}
const launchLog = () => log(v2Launch, [token,curve,actor], encodeAbiParameters([{type:'address'}, {type:'uint256'}, {type:'uint256'}], [quote, 0n, 42n]));
const launch = (time=1000): Launch => decodeLaunch(launchLog(),'pons-v2',time,time+100);
const resource = () => ({ attributes: { base_token_price_usd: '0.01', fdv_usd: '100000', market_cap_usd: null, reserve_in_usd: '15000', transactions: {m5:{buys:0,sells:2,buyers:0,sellers:2}}, volume_usd:{m5:'0'} }, relationships:{base_token:{data:{id:'robinhood_'+token}},quote_token:{data:{id:'robinhood_'+quote}}} });

test('V2 launch decodes identity and optional venue without pair assumptions', () => {
  const l = launch(); assert.equal(l.tokenAddress,token); assert.equal(l.deployerAddress,actor); assert.equal(l.curveAddress,curve); assert.equal(l.poolAddress,null); assert.equal(l.quoteAsset,quote);
  assert.equal(l.launchBlock,100); assert.equal(l.launchTime,1000); assert.equal(l.discoveredAt,1100);
});
test('V1 launch decodes pool-at-launch signature', () => {
  const l = log(v1Launch,[token,actor,curve],encodeAbiParameters([{type:'address'},{type:'address'},...Array.from({length:6},()=>({type:'uint256'} as const))],[quote,recipient,1n,0n,2n,3n,4n,5n]));
  const d = decodeLaunch(l,'pons-v1',1000,1100); assert.equal(d.poolAddress,recipient); assert.equal(d.curveAddress,null);
});
test('curve buy preserves routed actor and token recipient independently', () => {
  const l = log(curveBuy,[actor,recipient],encodeAbiParameters(Array.from({length:4},()=>({type:'uint256'})),[100n,200n,1n,2n]));
  const d = decodeTrade(l,token,quote,'curve',1000); assert.equal(d.actor,actor); assert.equal(d.recipient,recipient); assert.equal(d.side,'buy'); assert.equal(d.attribution,'curve-recipient-address'); assert.equal(d.tokenAmount,'200');
});
test('curve sell does not mistake quote recipient for a token buyer', () => {
  const l = log(curveSell,[actor,recipient],encodeAbiParameters(Array.from({length:4},()=>({type:'uint256'})),[200n,100n,1n,2n]));
  const d = decodeTrade(l,token,quote,'curve',1000); assert.equal(d.side,'sell'); assert.equal(d.attribution,'curve-quote-recipient');
});
test('V3 amount direction and uncertain recipient attribution', () => {
  const l = log(v3Swap,[actor,recipient],encodeAbiParameters([{type:'int256'},{type:'int256'},{type:'uint160'},{type:'uint128'},{type:'int24'}],[-200n,100n,1n,1n,0]));
  const d = decodeTrade(l,token,quote,'v3',1000); assert.equal(d.side,'buy'); assert.equal(d.attribution,'v3-recipient-may-be-router');
});
test('removed or malformed logs are rejected', () => {
  assert.throws(()=>decodeLaunch({...launchLog(),removed:true},'pons-v2',1,2));
  assert.throws(()=>decodeLaunch({...launchLog(),data:'0x'},'pons-v2',1,2));
});
test('normalization distinguishes actual zeros from missing and invalid values', () => {
  for (const x of [null,undefined,'',false,{},'n/a',Infinity]) assert.equal(numeric(x),null);
  assert.equal(numeric('0'),0);
  const m = normalizeMarket(resource(),token); assert.equal(m.price,.01); assert.equal(m.marketCap,null); assert.equal(m.windows.m5.buys,0); assert.equal(m.windows.m15.volume,null); assert.equal(m.sourceObservationTime,null);
  const missing = normalizeMarket(null,token); assert.equal(missing.price,null); assert.equal(missing.providerLiquidityEstimate,null); assert.equal(missing.windows.m5.buyers,null);
});
test('quote-side normalization reverses side and avoids assigning base FDV', () => {
  const r = resource(); (r.attributes as any).quote_token_price_usd = '1';
  const m = normalizeMarket(r,quote); assert.equal(m.price,1); assert.equal(m.fdv,null); assert.equal(m.windows.m5.buys,2);
});
test('timestamp and scheduling preserve age and boundaries', () => {
  assert.equal(timestamp(0),null); assert.equal(timestamp('bad'),null); assert.equal(timestamp('2026-09-16T19:00:00Z'),Date.parse('2026-09-16T19:00:00Z'));
  assert.equal(nextAge(0),120000); assert.equal(nextAge(120000),300000); assert.equal(nextAge(HOUR),HOUR+300000); assert.equal(nextAge(6*HOUR),null);
});
test('freshness does not equate a fetch with a current source observation', () => {
  assert.equal(coverage(1000,1000,null,null,60000,{x:null}).freshness,'unknown');
  assert.equal(coverage(100000,100000,1,null,60000,{}).freshness,'stale');
  assert.equal(coverage(1000,1000,1000,'failure',60000,{}).freshness,'stale');
  assert.equal(coverage(1000,1000,1000,null,60000,{}).freshness,'fresh');
  assert.deepEqual(coverage(1000,1000,null,null,60000,{x:null,y:0}).missingFields,['x']);
});
test('database deduplication and cursor survive close/reopen', () => {
  const dir=mkdtempSync(join(tmpdir(),'find-test-')); const path=join(dir,'db.sqlite');
  try {
    let s=new Store(path); const l=launch();
    s.atomic(()=>{s.launch(l);s.launch(l);s.set('cursor',{block:100,hash});});
    const d=decodeTrade(log(curveBuy,[actor,recipient],encodeAbiParameters(Array.from({length:4},()=>({type:'uint256'})),[1n,2n,0n,0n])),token,quote,'curve',1000);
    s.trade(d);s.trade(d); assert.equal(s.one('SELECT COUNT(*) n FROM tokens').n,1); assert.equal(s.one('SELECT COUNT(*) n FROM trades').n,1);
    s.close();s=new Store(path);assert.deepEqual(s.get('cursor',null),{block:100,hash});assert.equal(s.one('SELECT COUNT(*) n FROM trades').n,1);s.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('atomic rollback does not advance cursor or retain partial launches', () => {
  const s=new Store(':memory:');s.set('cursor',99);
  assert.throws(()=>s.atomic(()=>{s.launch(launch());s.set('cursor',100);throw new Error('crash');}));
  assert.equal(s.get('cursor',0),99);assert.equal(s.one('SELECT COUNT(*) n FROM tokens').n,0);s.close();
});
test('durable Gecko budget includes five attempts and minimum spacing', async () => {
  const s=new Store(':memory:');const g=new Gecko(s,config());const now=Date.now();
  s.set('geckoAttempts',Array.from({length:5},(_,i)=>now-i*13000));s.set('geckoNext',now-1);
  assert.equal(g.available(now),false);await assert.rejects(()=>g.request('/unused'),Deferred);
  s.set('geckoAttempts',[now]);s.set('geckoNext',now+13000);assert.equal(g.available(now+12000),false);assert.equal(g.available(now+13000),true);s.close();
});
test('snapshot failure is null, explicit, and persists schedule metadata', () => {
  const s=new Store(':memory:');const c=new Collector(s,config());const now=Date.now();const l=launch(now-120000);s.launch(l);s.run('UPDATE tokens SET selected=1');
  s.set('snapshotDue:'+token,now);s.observation({token,provider:'geckoterminal',kind:'market',fetchedAt:now,error:'HTTP 429'});c.snapshots(now);
  const row=s.one('SELECT * FROM snapshots');const n=JSON.parse(row.normalized);const cov=JSON.parse(row.coverage);
  assert.equal(n.price,null);assert.equal(n.buys5m,null);assert.equal(n.experimentalUniqueBuyers5m,null);assert.equal(cov.freshness,'stale');assert.equal(cov.providerError,'HTTP 429');assert.equal(row.age_ms,120000);s.close();
});
test('unique buyers count recipients at the durable trade-window end', () => {
  const s=new Store(':memory:');const cfg=config();const c=new Collector(s,cfg);const now=Date.now();s.launch(launch(now-120000));s.run('UPDATE tokens SET selected=1');
  const trade=decodeTrade(log(curveBuy,[actor,recipient],encodeAbiParameters(Array.from({length:4},()=>({type:'uint256'})),[1n,2n,0n,0n])),token,quote,'curve',now-10000);s.trade(trade);
  s.run('UPDATE venues SET trade_complete_from=100,trade_cursor=101');s.set('tradeCursorTime:'+token,now-5000);
  s.observation({token,provider:'rpc',kind:'state',fetchedAt:now,sourceTime:now-5000,payload:{reserves:{realQuoteReserve:'1'}}});s.set('snapshotDue:'+token,now);c.snapshots(now);
  const row=s.one('SELECT * FROM snapshots');assert.equal(JSON.parse(row.normalized).experimentalUniqueBuyers5m,1);assert.equal(JSON.parse(row.coverage).uniqueBuyerWindowEnd,now-5000);s.close();
});
test('report does not claim six-hour tracking from null snapshots or uptime', () => {
  const s=new Store(':memory:');const now=Date.now();s.launch(launch(now-7*HOUR));s.run('UPDATE tokens SET selected=1');s.set('firstStartedAt',now-7*HOUR);
  const r=report(s,now);assert.equal(r.launches,1);assert.equal(r.tracking['6h'].continuousMarketCoverage,0);assert.equal(r.allLaunchCoverage.market.percent,0);assert.equal(r.medianFirstMarketDelayMs,null);s.close();
});
test('discovery commits logs and resumes cursor without duplicates', async () => {
  const s=new Store(':memory:');const c=new Collector(s,{...config(),lookback:1,confirmations:1});
  (c.rpc as any).head=async()=>102;(c.rpc as any).assertCursor=async()=>{};
  (c.rpc as any).block=async(n:number)=>({number:n,time:1000,hash});
  (c.rpc as any).logs=async(address:string)=>address.includes('7ed598')?[{...launchLog(),address,blockNumber:'0x65'}]:[];
  await c.discover();await c.discover();assert.equal(s.one('SELECT COUNT(*) n FROM tokens').n,1);
  assert.equal(s.get<any>('liveDiscovery:0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',null).block,101);s.close();
});
test('canonical cursor mismatch fails visibly', async () => {
  const s=new Store(':memory:');const c=new Collector(s,config());(c.rpc as any).block=async()=>({hash:'other'});
  await assert.rejects(()=>c.rpc.assertCursor(100,hash),ChainMismatch);s.close();
});
test('trade timestamp failure retains earlier committed blocks and resumes', async () => {
  const s=new Store(':memory:');const c=new Collector(s,config());const now=Date.now();s.launch(launch(now-100000),'live');s.run('UPDATE tokens SET selected=1');s.set('safeHead',102);
  const data=encodeAbiParameters(Array.from({length:4},()=>({type:'uint256'})),[1n,2n,0n,0n]);
  const entries=[101,102].map((n,i)=>({...log(curveBuy,[actor,recipient],data),blockNumber:('0x'+n.toString(16)) as Hex,logIndex:('0x'+(i+1).toString(16)) as Hex}));
  (c.rpc as any).assertCursor=async()=>{};(c.rpc as any).logs=async(_a:string,_e:any,from:number)=>entries.filter(l=>Number(BigInt(l.blockNumber))>=from);
  (c.rpc as any).block=async(n:number)=>{if(n===102)throw new Error('timeout');return {number:n,time:now,hash};};
  await assert.rejects(()=>c.trades());assert.equal(s.one('SELECT COUNT(*) n FROM trades').n,1);assert.equal(s.one('SELECT trade_cursor FROM venues').trade_cursor,101);
  (c.rpc as any).block=async(n:number)=>({number:n,time:now,hash});await c.trades();assert.equal(s.one('SELECT COUNT(*) n FROM trades').n,2);assert.equal(s.one('SELECT trade_cursor FROM venues').trade_cursor,102);s.close();
});
test('Gecko 429 persists cooldown and counts the actual failed request', async () => {
  const s=new Store(':memory:');const g=new Gecko(s,config());const previous=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response('{}',{status:429,headers:{'Retry-After':'120'}});
    const before=Date.now();await assert.rejects(()=>g.request('/test'));assert.ok(s.get('geckoNext',0)>=before+120000);assert.equal(g.available(),false);
    assert.equal(s.one("SELECT COUNT(*) n FROM observations WHERE kind='http' AND status=429").n,1);
  } finally {globalThis.fetch=previous;s.close();}
});
test('report cadence coverage uses market observations, not sparse snapshot schedule', () => {
  const s=new Store(':memory:');const now=Date.now();const start=now-900000;s.launch(launch(start));s.run('UPDATE tokens SET selected=1');
  for(let i=1;i<=15;i++)s.observation({token,provider:'geckoterminal',kind:'market',fetchedAt:start+i*60000,payload:{resource:resource()}});
  const r=report(s,now);assert.equal(r.tracking['15m'].continuousMarketCoverage,1);assert.equal(r.tracking['6h'].continuousMarketCoverage,0);s.close();
});
test('report RPC request count includes successful attempts', () => {
  const s=new Store(':memory:');s.set('rpcRequests',5);assert.equal(report(s).providerRequests.find(r=>r.provider==='rpc').requests,5);s.close();
});
test('schema v1 migrates in place without changing observations or legacy origin', () => {
  const dir=mkdtempSync(join(tmpdir(),'find-migration-'));const path=join(dir,'data.sqlite');
  try {
    const old=new DatabaseSync(path);old.exec(schema+'PRAGMA user_version=1');
    old.prepare(`INSERT INTO tokens(token_address,deployer_address,factory,protocol_version,quote_asset,launch_block,launch_time,discovered_at,block_hash,transaction_hash,log_index) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(token,actor,curve,'pons-v2',quote,100,1000,1100,hash,hash,1);
    old.prepare('INSERT INTO observations(token_address,provider,kind,fetched_at,payload) VALUES (?,?,?,?,?)').run(token,'rpc','launch',1100,'{"x":1}');old.close();
    const s=new Store(path);assert.equal(s.one('PRAGMA user_version').user_version,7);assert.equal(s.one('SELECT discovery_origin FROM tokens').discovery_origin,'legacy');
    assert.equal(s.one('SELECT payload FROM observations').payload,'{"x":1}');s.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('millions-behind legacy cursor becomes paused backfill and live starts near head', async () => {
  const s=new Store(':memory:');const cfg={...config(),lookback:100,confirmations:20};const c=new Collector(s,cfg);const head=69137136;const ranges:number[]=[];
  for(const f of ['0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e','0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb','0x0c37a24f5d23a486fa692d1500881d698b1f77a4'])s.set('discovery:'+f,{block:65457784,hash});
  (c.rpc as any).head=async()=>head;(c.rpc as any).assertCursor=async()=>{};(c.rpc as any).block=async(n:number)=>({number:n,time:Date.now(),hash});
  (c.rpc as any).logs=async(_a:string,_e:any,from:number)=>{ranges.push(from);return [];};
  await c.discover();assert.equal(ranges.length,3);assert.ok(ranges.every(x=>x>head-200));
  assert.equal(s.get<any>('backfillDiscovery:0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',null).block,65457784);
  assert.ok(c.liveLag(head)<=20);assert.equal(s.one("SELECT COUNT(*) n FROM observations WHERE kind='discovery_gap'").n,3);s.close();
});
test('no cursor starts near head and recent cursor resumes with overlap', async () => {
  const s=new Store(':memory:');const cfg={...config(),lookback:100,liveOverlapBlocks:10,confirmations:20};const c=new Collector(s,cfg);let head=1000;const starts:number[]=[];
  (c.rpc as any).head=async()=>head;(c.rpc as any).assertCursor=async()=>{};(c.rpc as any).block=async(n:number)=>({number:n,time:Date.now(),hash});
  (c.rpc as any).logs=async(_a:string,_e:any,from:number)=>{starts.push(from);return [];};
  await c.discover();assert.equal(starts[0],871);assert.equal(c.liveLag(head),20);
  head=1010;await c.discover();assert.equal(starts[3],971);assert.equal(c.liveLag(head),20);
  assert.equal(s.one("SELECT COUNT(*) n FROM observations WHERE kind='discovery_gap'").n,0);s.close();
});
test('live cursor beyond safety lag warns, skips old range and resumes recent coverage', async () => {
  const s=new Store(':memory:');const cfg={...config(),lookback:100,maxLiveLagBlocks:200,confirmations:20};const c=new Collector(s,cfg);const head=10000;
  c.initializeLive(9900);for(const f of ['0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e','0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb','0x0c37a24f5d23a486fa692d1500881d698b1f77a4'])s.set('liveDiscovery:'+f,{block:100,hash});
  (c.rpc as any).head=async()=>head;(c.rpc as any).assertCursor=async()=>{};(c.rpc as any).block=async(n:number)=>({number:n,time:Date.now(),hash});(c.rpc as any).logs=async()=>[];
  await c.discover();assert.ok(c.liveLag(head)<=20);assert.match(status(s),/LIVE LAG 20 BLOCKS/);
  assert.equal(s.one("SELECT COUNT(*) n FROM observations WHERE kind='discovery_gap'").n,3);
  assert.equal(s.one('SELECT warning FROM live_cursor_samples ORDER BY id DESC LIMIT 1').warning,0);s.close();
});
test('startup moves a stale live cursor into a small recent lookback',()=>{
  const s=new Store(':memory:');const cfg={...config(),lookback:300};const c=new Collector(s,cfg);
  c.initializeLive(10_000);for(const f of ['0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e','0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb','0x0c37a24f5d23a486fa692d1500881d698b1f77a4'])s.set('liveDiscovery:'+f,{block:8_000,hash});
  c.initializeLive(10_000,true);assert.equal(c.liveLag(10_020),320);
  assert.equal(s.one("SELECT COUNT(*) n FROM observations WHERE kind='discovery_gap'").n,3);s.close();
});
test('old sampled tokens release fresh slots while continuing horizon tracking', () => {
  const s=new Store(':memory:');const now=Date.now();const cfg={...config(),sampleSize:1,sampleSlotMs:30*60000};const c=new Collector(s,cfg);
  const old={...launch(now-40*60000),tokenAddress:token,transactionHash:hash};
  const fresh={...launch(now-60000),tokenAddress:'0x0000000000000000000000000000000000000066',transactionHash:('0x'+'cd'.repeat(32))};
  s.launch(old,'live');s.launch(fresh,'live');s.run('UPDATE tokens SET selected=1 WHERE token_address=?',token);
  c.enroll(now);assert.equal(s.one('SELECT selected FROM tokens WHERE token_address=?',fresh.tokenAddress).selected,1);
  assert.equal(s.selected(now).length,2);s.close();
});
test('a recent sampled token cannot block a newer live launch',()=>{
  const s=new Store(':memory:');const now=Date.now();const c=new Collector(s,{...config(),sampleSize:1});
  const old={...launch(now-120000),tokenAddress:token,transactionHash:hash};
  const fresh={...launch(now-60000),tokenAddress:'0x0000000000000000000000000000000000000066',transactionHash:('0x'+'cd'.repeat(32))};
  s.launch(old,'live');s.launch(fresh,'live');s.run('UPDATE tokens SET selected=1 WHERE token_address=?',token);
  c.enroll(now);assert.equal(s.one('SELECT selected FROM tokens WHERE token_address=?',fresh.tokenAddress).selected,1);s.close();
});
test('market polling reserves a batch for previously indexed older pools',async()=>{
  const s=new Store(':memory:');const now=Date.now();const c=new Collector(s,config());
  const older='0x0000000000000000000000000000000000000099';
  for(let i=0;i<7;i++){
    const addr='0x'+String(i+100).padStart(40,'0');
    const curveAddr=i===6?older:'0x'+String(i+200).padStart(40,'0');
    s.launch({...launch(now-(i===6?11:1)*60000),tokenAddress:addr,curveAddress:curveAddr,transactionHash:'0x'+String(i+1).padStart(64,'0')},'live');
    s.run('UPDATE tokens SET selected=1 WHERE token_address=?',addr);
    if(i===6)s.observation({token:addr,provider:'geckoterminal',kind:'market',fetchedAt:now-600000,payload:{resource:{}}});
  }
  (c as any).marketPosition=2;(c.gecko as any).available=()=>true;let requested='';
  (c.gecko as any).request=async(path:string)=>{requested=path;return {payload:{data:[],included:[]},fetchedAt:now,cacheAge:null}};
  await c.market();assert.match(requested,new RegExp(older));s.close();
});
test('overlapping live reads deduplicate launches and preserve original discovery time', async () => {
  const s=new Store(':memory:');const cfg={...config(),lookback:10,liveOverlapBlocks:10,confirmations:1};const c=new Collector(s,cfg);let head=102;
  (c.rpc as any).head=async()=>head;(c.rpc as any).assertCursor=async()=>{};(c.rpc as any).block=async(n:number)=>({number:n,time:1000,hash});
  (c.rpc as any).logs=async(address:string,_e:any,from:number)=>address.includes('7ed598')&&from<=101?[{...launchLog(),address,blockNumber:'0x65'}]:[];
  await c.discover();const first=s.one('SELECT discovered_at FROM tokens').discovered_at;head=103;await c.discover();
  assert.equal(s.one('SELECT COUNT(*) n FROM tokens').n,1);assert.equal(s.one('SELECT COUNT(*) n FROM observations WHERE kind=\'launch\'').n,1);
  assert.equal(s.one('SELECT discovered_at FROM tokens').discovered_at,first);s.close();
});
test('RPC 429 cooldown defers then permits a later live request', async () => {
  const s=new Store(':memory:');const rpc=new Rpc(s,{...config(),rpcSpacingMs:500});const prior=globalThis.fetch;let calls=0;
  try {
    globalThis.fetch=async()=>{calls++;return calls===1?new Response('{}',{status:429}):new Response('{"jsonrpc":"2.0","id":2,"result":"0x1237"}',{status:200});};
    await assert.rejects(()=>rpc.head());assert.equal(s.one("SELECT COUNT(*) n FROM observations WHERE provider='rpc' AND status=429").n,1);
    await assert.rejects(()=>rpc.head(),Deferred);s.set('rpcNext',0);
    assert.equal(await rpc.head(),4663);assert.equal(calls,2);
  } finally {globalThis.fetch=prior;s.close();}
});
