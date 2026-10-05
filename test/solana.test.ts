import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { Store } from '../src/db.js';
import { config } from '../src/config.js';
import { createWebServer } from '../src/web.js';
import { isSolanaAddress, rankSolana, solanaHealth } from '../src/solana.js';

const mint='AbCdEfGhijkMNopQRstUVwxyz123456789ABCDE';
const pool='9xQeWvG816bUx9EPjHmaT23yvVMY4i8cJjqMeKz8YpW';
const pool2='7YttLkHDoNj9wyDur5A1wSKJuuzjQtY8ocH9VhWZQmF3';
const sol='So11111111111111111111111111111111111111112';
function seed(s:Store,now:number,address=pool,liquidity:any=12000,fdv:any=50000,buys=18,sells=4) {
  s.run(`INSERT INTO solana_pools(pool_address,mint_address,quote_mint,quote_symbol,dex_id,name,symbol,image_url,created_at,discovered_at,fetched_at,
    price,fdv,market_cap,liquidity,volume_5m,buys_5m,sells_5m,buyers_5m,sellers_5m,price_change_5m,payload)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,address,mint,sol,'SOL','test-dex','Mixed Case Token','MIX',null,now-300000,now,now,
    .00005,fdv,null,liquidity,5000,buys,sells,12,3,8,JSON.stringify({real:true}));
}
const call=(server:any,url:string,method='GET',body='')=>new Promise<{status:number;body:string}>(resolve=>{
  const req=Readable.from(body?[body]:[]) as any;req.url=url;req.method=method;req.headers={};
  const res={statusCode:200,writeHead(code:number){this.statusCode=code},end(content?:string){resolve({status:this.statusCode,body:content??''})}};
  server.emit('request',req,res);
});

test('Solana mint validation is case-sensitive and accepts base58 without EVM assumptions',()=>{
  assert.equal(isSolanaAddress(mint),true);assert.equal(isSolanaAddress('0x0000000000000000000000000000000000000011'),false);
  assert.notEqual(mint,mint.toLowerCase());
});
test('Solana ranking preserves mint case, tolerates optional metrics and deduplicates pools',()=>{
  const now=Date.now(),s=new Store(':memory:'),cfg={...config(),chain:'solana' as const};
  seed(s,now,pool,12000,50000,18,4);seed(s,now,pool2,null,null,8,2);
  const cards=rankSolana(s,cfg,now);assert.equal(cards.length,1);assert.equal(cards[0].mintAddress,mint);
  assert.equal(cards[0].poolAddress,pool);assert.equal(cards[0].chain,'solana');assert.ok(cards[0].whyAiter.length>=2);
  assert.match(cards[0].externalUrl,new RegExp(`/solana/pools/${pool}$`));assert.equal('score' in cards[0],false);s.close();
});
test('Solana health, find, details, events and cold start use only Solana tables',async()=>{
  const now=Date.now(),s=new Store(':memory:'),cfg={...config(),chain:'solana' as const},server=createWebServer(s,cfg);
  try {
    const cold=JSON.parse((await call(server,'/api/health')).body);assert.equal(cold.chain,'solana');assert.equal(cold.phase,'STARTING');
    seed(s,now);s.set('solanaRunStartedAt',now);s.set('solanaLastDiscoverySuccess',now);
    const health=solanaHealth(s,cfg,now);assert.equal(health.status,'ready');assert.equal(health.freshPools,1);
    const find=JSON.parse((await call(server,'/api/find')).body);assert.equal(find.count,1);assert.equal(find.candidates[0].tokenAddress,mint);
    const detail=JSON.parse((await call(server,`/api/token-detail?token=${mint}`)).body);assert.equal(detail.token.mintAddress,mint);
    const bag=JSON.parse((await call(server,`/api/bag-market?tokens=${mint}`)).body);assert.equal(bag.tokens[0].tokenAddress,mint);
    assert.equal((await call(server,'/api/events','POST',JSON.stringify({event:'token_bagged',tokenAddress:mint,chain:'solana'}))).status,204);
    assert.equal(s.one('SELECT chain FROM product_events').chain,'solana');
    assert.equal(s.one('SELECT COUNT(*) n FROM find_signals').n,0);
  } finally {s.close();}
});
