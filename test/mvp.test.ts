import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { config } from '../src/config.js';
import { rank, rankAutoHunt } from '../src/ranking.js';
import { createWebServer } from '../src/web.js';
import { Readable } from 'node:stream';

const token='0x0000000000000000000000000000000000000011';
const pool='0x0000000000000000000000000000000000000022';
function seed(s:Store,now:number,missing=false) {
  s.run(`INSERT INTO tokens(token_address,deployer_address,factory,protocol_version,quote_asset,launch_block,launch_time,discovered_at,block_hash,transaction_hash,log_index,discovery_origin,name,symbol)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,token,pool,pool,'pons-v2',pool,1,now-600000,now-590000,'0x1','0x2',1,'live','Aiter Test','TEST');
  s.run(`INSERT INTO venues(token_address,curve_address,venue_type,phase,updated_at) VALUES (?,?,?,?,?)`,token,pool,'curve','not-graduated',now);
  const resource={attributes:{address:pool,base_token_price_usd:'0.01',fdv_usd:'70000',reserve_in_usd:'18000',transactions:{m5:{buys:30,sells:10,buyers:missing?null:20,sellers:8}},volume_usd:{m5:'9000'}},relationships:{base_token:{data:{id:'robinhood_'+token}},quote_token:{data:{id:'robinhood_'+pool}}}};
  s.observation({token,provider:'geckoterminal',kind:'market',fetchedAt:now,sourceTime:now,payload:{resource}});
}
test('ranking only returns fresh live tokens with real critical fields and hides score',()=>{
  const now=Date.now(),s=new Store(':memory:');seed(s,now);
  const cards=rank(s,config(),now);assert.equal(cards.length,1);assert.equal(cards[0].symbol,'TEST');assert.ok(cards[0].whyAiter.length>=2);
  assert.equal('score' in cards[0],false);assert.match(cards[0].externalUrl,/geckoterminal.com\/robinhood\/pools/);
  assert.equal(cards[0].tradeUrl,`https://www.ponsfamily.com/launchpad/${token}`);
  assert.equal(rank(s,config(),now+240000).length,0);s.close();
});
test('missing buyer data remains null while real trading still qualifies',()=>{const now=Date.now(),s=new Store(':memory:');seed(s,now,true);const cards=rank(s,config(),now);assert.equal(cards.length,1);assert.equal(cards[0].buyers5m,null);s.close()});
test('fresh RPC trades can rank a token without a Gecko market record',()=>{
  const now=Date.now(),s=new Store(':memory:');seed(s,now);s.run('DELETE FROM observations');
  s.set('activityBoundary',{block:900,time:now-240000,at:now});s.set('activityCursor',1000);
  s.set('activitySafeTime',now-1000);s.set('lastActivitySuccess',now);s.set('lastDiscoverySuccess',now);s.set('rpcHead',1010);
  for(let i=0;i<9;i++)s.run('INSERT INTO activity_events VALUES (?,?,?,?,?,?,?)',`0x${i.toString(16).padStart(64,'0')}`,i,pool,990,'0x1',i<7?'buy':'sell',i<7?`0x${(i+1).toString(16).padStart(40,'0')}`:null);
  const cards=rank(s,config(),now);assert.equal(cards.length,1);assert.equal(cards[0].fdv,null);
  assert.equal(cards[0].recentBuys,7);assert.equal(cards[0].recentBuyers,7);
  assert.match(cards[0].externalUrl,/robinhoodchain\.blockscout\.com\/token/);
  assert.equal(rank(s,config(),now+91_000).length,0);s.close();
});
test('AUTO HUNT uses strict fresh signals and open beta serves persisted finds',async()=>{
  const now=Date.now(),s=new Store(':memory:');seed(s,now);
  const cfg={...config(),chain:'robinhood' as const,autoHuntEnabled:true,autoHuntBeta:true};
  const signals=rankAutoHunt(s,cfg,now);assert.equal(signals.length,1);
  s.run('INSERT INTO auto_hunt_signals(token_address,found_at,data_timestamp,payload) VALUES (?,?,?,?)',
    token,now,Date.parse(signals[0].dataTimestamp),JSON.stringify(signals[0]));
  const server=createWebServer(s,cfg);
  const call=(url:string)=>new Promise<{status:number;body:string}>(resolve=>{
    const req=Readable.from([]) as any;req.url=url;req.method='GET';req.headers={};
    const res={statusCode:200,writeHead(code:number){this.statusCode=code},end(content?:string){resolve({status:this.statusCode,body:content??''})}};
    server.emit('request',req,res);
  });
  const response=await call('/api/auto-hunt'),data=JSON.parse(response.body);
  assert.equal(response.status,200);assert.equal(data.count,1);assert.equal(data.signals[0].tokenAddress,token);s.close();
});
test('health and find handlers return JSON without fabricating candidates',async()=>{
  const s=new Store(':memory:'),server=createWebServer(s,{...config(),chain:'robinhood'});
  const call=(url:string,method='GET',body='')=>new Promise<{status:number;body:string}>(resolve=>{
    const req=Readable.from(body?[body]:[]) as any;req.url=url;req.method=method;
    const res={statusCode:200,writeHead(code:number){this.statusCode=code},end(content?:string){resolve({status:this.statusCode,body:content??''})}};
    server.emit('request',req,res);
  });
  try {
    const find=JSON.parse((await call('/api/find')).body);assert.deepEqual(find.candidates,[]);
    const health=JSON.parse((await call('/api/health')).body);assert.equal(health.status,'starting');assert.equal(health.phase,'STARTING');
    assert.equal(health.deploymentMode,'full');
    seed(s,Date.now());const populated=JSON.parse((await call('/api/find')).body);assert.equal(populated.candidates.length,1);
    const record=JSON.parse((await call('/api/track-record')).body);assert.equal(record.totalFinds,1);assert.equal(record.entries[0].tokenAddress,token);
    const map=JSON.parse((await call('/api/market-map')).body);assert.equal(typeof map.freshLaunches,'number');
    const detail=JSON.parse((await call(`/api/token-detail?token=${token}`)).body);assert.equal(detail.token.symbol,'TEST');
    const bagMarket=JSON.parse((await call(`/api/bag-market?tokens=${token}`)).body);
    assert.equal(bagMarket.tokens.length,1);assert.equal(bagMarket.tokens[0].price,0.01);assert.equal(bagMarket.tokens[0].status,'live');
    assert.equal(bagMarket.tokens[0].history.length,1);assert.equal(bagMarket.tokens[0].history[0].fdv,70000);
    assert.equal((await call('/api/events','POST',JSON.stringify({event:'hunt_started'}))).status,204);
    assert.equal(s.one('SELECT COUNT(*) n FROM product_events').n,1);
  } finally {s.close()}
});
