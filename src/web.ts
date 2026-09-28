import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, parseAbi, recoverMessageAddress } from 'viem';
import type { Store } from './db.js';
import type { Config } from './config.js';
import { rank, rankDetailed } from './ranking.js';
import { FACTORIES } from './pons.js';
import { normalizeMarket } from './normalize.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../public');
const files: Record<string,[string,string]> = {
  '/':['index.html','text/html; charset=utf-8'], '/style.css':['style.css','text/css; charset=utf-8'],
  '/app.js':['app.js','text/javascript; charset=utf-8'], '/favicon.svg':['favicon.svg','image/svg+xml'],
};
const events = new Set(['hunt_started','hunt_results_count','token_passed','token_bagged','token_opened','token_shilled','instant_buy_opened','bag_opened']);
const lockAbi=parseAbi(['function lockedBalanceOf(address account) view returns (uint256)']);
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(body));
}
function health(store:Store,cfg:Config) {
  const now=Date.now();
  const head=store.get<number|null>('rpcHead',null);
  const cursors=FACTORIES.map(f=>store.get<{block:number}|null>(`liveDiscovery:${f.address}`,null)?.block ?? null);
  const liveCursor=cursors.every(n=>n!==null)?Math.min(...cursors as number[]):null;
  const last=store.get<number|null>('lastDiscoverySuccess',null);
  const market=store.one("SELECT fetched_at,error FROM observations WHERE provider='geckoterminal' AND kind='http' ORDER BY id DESC LIMIT 1");
  const marketStatus=!market?'unknown':market.error?'error':now-market.fetched_at>cfg.staleMs?'stale':'ok';
  const active=store.one("SELECT count(*) n FROM tokens WHERE discovery_origin='live' AND launch_time BETWEEN ? AND ?",now-3*60*60_000,now).n;
  const lag=head!==null&&liveCursor!==null?Math.max(0,head-liveCursor):null;
  const runStarted=store.get<number|null>('runStartedAt',null);
  const live=Boolean(last&&now-last<120_000&&lag!==null&&lag<=cfg.maxLiveLagBlocks);
  const status=!runStarted&&!head?'starting':!last||liveCursor===null?'scanning':live?'ready':'degraded';
  return {status,phase:status.toUpperCase(),deploymentMode:cfg.deploymentMode,
    rpcHead:head,liveCursor,cursorLagBlocks:lag,lastSuccessfulDiscovery:last?new Date(last).toISOString():null,
    activeTokens:active,marketProviderStatus:marketStatus};
}
const change=(initial:any,current:any)=>{
  for(const key of ['price','marketCap','fdv'])if(Number(initial?.[key])>0&&Number(current?.[key])>=0)return (Number(current[key])/Number(initial[key])-1)*100;
  return null;
};
const median=(values:number[])=>{if(!values.length)return null;const s=[...values].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
function trackRecord(store:Store,now=Date.now()) {
  const finds=store.all('SELECT token_address,found_at,payload FROM find_signals ORDER BY found_at DESC');
  const entries=finds.map(find=>{
    let initial:any={};try{initial=JSON.parse(find.payload);}catch{}
    const points=store.all('SELECT recorded_at,normalized FROM snapshots WHERE token_address=? AND recorded_at>=? AND recorded_at<=? ORDER BY recorded_at',find.token_address,find.found_at,find.found_at+6*60*60_000).flatMap(row=>{try{return [{at:row.recorded_at,value:JSON.parse(row.normalized)}];}catch{return [];}});
    const horizon=(hours:number)=>{
      const end=find.found_at+hours*60*60_000,window=points.filter(point=>point.at<=end),returns=window.map(point=>change(initial,point.value)).filter(Number.isFinite) as number[];
      const finalPoint=[...points].sort((a,b)=>Math.abs(a.at-end)-Math.abs(b.at-end))[0];
      return {complete:now>=end&&Boolean(finalPoint),max:returns.length?Math.max(...returns):null,final:finalPoint?change(initial,finalPoint.value):null};
    };
    return {tokenAddress:find.token_address,symbol:initial.symbol??null,name:initial.name??null,foundAt:new Date(find.found_at).toISOString(),oneHour:horizon(1),sixHour:horizon(6)};
  });
  const completed=(key:'oneHour'|'sixHour')=>entries.filter(entry=>entry[key].complete&&entry[key].final!==null);
  const stats=(key:'oneHour'|'sixHour')=>{const rows=completed(key),finals=rows.map(row=>row[key].final!) as number[],maxes=rows.map(row=>row[key].max).filter(Number.isFinite) as number[];return {completed:rows.length,medianFinal:median(finals),medianMax:median(maxes),reached50:maxes.length?maxes.filter(v=>v>=50).length/maxes.length*100:null,reached100:maxes.length?maxes.filter(v=>v>=100).length/maxes.length*100:null};};
  return {totalFinds:entries.length,oneHour:stats('oneHour'),sixHour:stats('sixHour'),entries:entries.slice(0,100)};
}
export function createWebServer(store:Store,cfg:Config) {
  const challenges=new Map<string,{message:string,expires:number}>();
  const sessions=new Map<string,{address:string,expires:number}>();
  const client=createPublicClient({transport:http(cfg.rpcUrl)});
  const body=async(req:IncomingMessage,limit=4096)=>{let raw='';for await(const part of req){raw+=part;if(raw.length>limit)throw new Error('Body too large');}return JSON.parse(raw||'{}');};
  const gateConfig=()=>({enabled:cfg.autoHuntEnabled,beta:cfg.autoHuntBeta,chainId:4663,
    tokenAddress:cfg.aiterTokenAddress,lockAddress:cfg.aiterLockAddress,minLocked:cfg.autoHuntMinLocked});
  const hasTokenAccess=async(address:string)=>{
    if(cfg.autoHuntBeta) return true;
    if(!cfg.aiterLockAddress || !/^\d+$/.test(cfg.autoHuntMinLocked)) return false;
    const locked=await client.readContract({address:cfg.aiterLockAddress,abi:lockAbi,functionName:'lockedBalanceOf',args:[address as `0x${string}`]});
    return locked>=BigInt(cfg.autoHuntMinLocked);
  };
  const authorized=(req:IncomingMessage)=>{
    if(cfg.autoHuntBeta) return true;
    const token=req.headers.authorization?.match(/^Bearer ([0-9a-f]{64})$/i)?.[1];
    const session=token?sessions.get(token):null;
    return Boolean(session && session.expires>Date.now());
  };
  return createServer(async(req:IncomingMessage,res:ServerResponse)=>{
    try {
      const path=new URL(req.url ?? '/', 'http://localhost').pathname;
      if(req.method==='GET' && path==='/api/health') return send(res,200,health(store,cfg));
      if(req.method==='GET' && path==='/api/auto-hunt/config') return send(res,200,gateConfig());
      if(req.method==='POST' && path==='/api/auto-hunt/challenge') {
        if(!cfg.autoHuntEnabled || cfg.autoHuntBeta) return send(res,409,{error:'Wallet authentication is not required'});
        const data=await body(req);const address=String(data.address??'').toLowerCase();
        if(!/^0x[0-9a-f]{40}$/.test(address)) return send(res,400,{error:'Invalid wallet address'});
        const nonce=randomBytes(16).toString('hex');
        const message=`AITER AUTO HUNT\nWallet: ${address}\nNonce: ${nonce}\nExpires: ${new Date(Date.now()+300_000).toISOString()}`;
        challenges.set(address,{message,expires:Date.now()+300_000});return send(res,200,{message});
      }
      if(req.method==='POST' && path==='/api/auto-hunt/session') {
        if(!cfg.autoHuntEnabled || cfg.autoHuntBeta) return send(res,409,{error:'Wallet authentication is not required'});
        const data=await body(req);const address=String(data.address??'').toLowerCase(),challenge=challenges.get(address);
        if(!challenge || challenge.expires<Date.now() || data.message!==challenge.message || typeof data.signature!=='string')
          return send(res,401,{error:'Challenge expired'});
        const recovered=(await recoverMessageAddress({message:challenge.message,signature:data.signature})).toLowerCase();
        challenges.delete(address);
        if(recovered!==address) return send(res,401,{error:'Invalid signature'});
        if(!await hasTokenAccess(address)) return send(res,402,{error:'LOCK $AITER TO ACTIVATE AUTO HUNT',...gateConfig()});
        const token=randomBytes(32).toString('hex');sessions.set(token,{address,expires:Date.now()+24*60*60_000});
        return send(res,200,{token,expiresAt:new Date(Date.now()+24*60*60_000).toISOString()});
      }
      if(req.method==='GET' && path==='/api/auto-hunt') {
        if(!cfg.autoHuntEnabled) return send(res,503,{error:'AUTO HUNT IS NOT ENABLED'});
        if(!authorized(req)) return send(res,401,{error:'CONNECT WALLET TO ACTIVATE AUTO HUNT',...gateConfig()});
        const rows=store.all('SELECT payload,found_at FROM auto_hunt_signals WHERE found_at>? ORDER BY found_at DESC LIMIT 20',Date.now()-3*60*60_000);
        const signals=rows.map(row=>({...JSON.parse(row.payload),foundAt:new Date(row.found_at).toISOString()}));
        return send(res,200,{signals,count:signals.length,lastPass:store.get<number|null>('lastAutoHuntPass',null)});
      }
      if(req.method==='GET' && path==='/api/find') {
        const candidates=rank(store,cfg);
        store.atomic(()=>{for(const candidate of candidates)store.run(
          'INSERT OR IGNORE INTO find_signals(token_address,found_at,data_timestamp,payload) VALUES (?,?,?,?)',
          candidate.tokenAddress,Date.now(),Date.parse(candidate.dataTimestamp),JSON.stringify(candidate));});
        const h=health(store,cfg);
        return send(res,200,{candidates,count:candidates.length,marketAvailable:h.status==='ready'&&h.marketProviderStatus==='ok',systemStatus:h.status,checkedAt:new Date().toISOString()});
      }
      if(req.method==='GET' && path==='/api/track-record') return send(res,200,trackRecord(store));
      if(req.method==='GET' && path==='/api/market-map') {
        const diagnostic=rankDetailed(store,cfg).diagnostic;
        return send(res,200,{freshLaunches:diagnostic.coverage.freshLaunches,active:diagnostic.coverage.eligibleWithActivity,
          passed:diagnostic.relaxedSurvivors,signals:diagnostic.resultCount,rejections:diagnostic.relaxedRejected,checkedAt:new Date().toISOString()});
      }
      if(req.method==='GET' && path==='/api/token-detail') {
        const address=(new URL(req.url??'/','http://localhost').searchParams.get('token')??'').toLowerCase();
        if(!/^0x[0-9a-f]{40}$/.test(address))return send(res,400,{error:'Invalid token'});
        const token=store.one('SELECT t.*,v.* FROM tokens t JOIN venues v USING(token_address) WHERE t.token_address=?',address);
        if(!token)return send(res,404,{error:'Token not found'});
        const info=store.one("SELECT payload,fetched_at FROM observations WHERE token_address=? AND kind='token_info' AND error IS NULL ORDER BY id DESC LIMIT 1",address);
        const snapshots=store.all('SELECT recorded_at,normalized FROM snapshots WHERE token_address=? ORDER BY recorded_at DESC LIMIT 80',address).reverse().flatMap(row=>{try{return [{at:new Date(row.recorded_at).toISOString(),...JSON.parse(row.normalized)}];}catch{return [];}});
        const activity=store.one(`SELECT COUNT(*) trades,SUM(CASE WHEN side='buy' THEN 1 ELSE 0 END) buys,SUM(CASE WHEN side='sell' THEN 1 ELSE 0 END) sells,COUNT(DISTINCT buyer_address) buyers FROM activity_events WHERE venue_address=?`,token.curve_address);
        return send(res,200,{token:{tokenAddress:address,name:token.name,symbol:token.symbol,createdAt:new Date(token.launch_time).toISOString(),deployerAddress:token.deployer_address,phase:token.phase},profile:info?JSON.parse(info.payload).attributes:null,activity,snapshots});
      }
      if(req.method==='GET' && path==='/api/bag-market') {
        const raw=new URL(req.url ?? '/', 'http://localhost').searchParams.get('tokens')??'';
        const tokens=[...new Set(raw.split(',').map(v=>v.toLowerCase()).filter(v=>/^0x[0-9a-f]{40}$/.test(v)))].slice(0,50);
        if(!tokens.length) return send(res,200,{tokens:[],checkedAt:new Date().toISOString()});
        const placeholders=tokens.map(()=>'?').join(',');
        const rows=store.all(`SELECT t.token_address,o.fetched_at,o.source_observation_time,o.payload
          FROM tokens t LEFT JOIN observations o ON o.id=(SELECT max(id) FROM observations
            WHERE token_address=t.token_address AND kind='market' AND error IS NULL)
          WHERE t.token_address IN (${placeholders})`,...tokens);
        const now=Date.now();
        const result=rows.map(row=>{
          let market:null|ReturnType<typeof normalizeMarket>=null;
          try {
            const payload=row.payload?JSON.parse(row.payload):null;
            const source=row.source_observation_time??null;
            const fresh=row.fetched_at && now-row.fetched_at<=cfg.staleMs && (!source || (source<=now+30_000 && now-source<=cfg.staleMs));
            if(fresh && payload?.resource) market=normalizeMarket(payload.resource,row.token_address);
          } catch { /* Unusable provider data remains unavailable. */ }
          const history=store.all(`SELECT fetched_at,source_observation_time,payload FROM observations
            WHERE token_address=? AND kind='market' AND error IS NULL AND payload IS NOT NULL AND fetched_at>?
            ORDER BY fetched_at DESC LIMIT 120`,row.token_address,now-24*60*60_000).reverse().flatMap(observation=>{
              try {
                const resource=JSON.parse(observation.payload)?.resource;
                if(!resource)return [];
                const point=normalizeMarket(resource,row.token_address);
                if(point.price===null && point.marketCap===null && point.fdv===null)return [];
                return [{at:new Date(observation.source_observation_time??observation.fetched_at).toISOString(),
                  price:point.price,marketCap:point.marketCap,fdv:point.fdv}];
              } catch {return [];}
            });
          return {tokenAddress:row.token_address,price:market?.price??null,fdv:market?.fdv??null,
            marketCap:market?.marketCap??null,liquidity:market?.providerLiquidityEstimate??null,
            dataTimestamp:market?new Date(row.source_observation_time??row.fetched_at).toISOString():null,
            status:market?'live':'unavailable',history};
        });
        return send(res,200,{tokens:result,checkedAt:new Date(now).toISOString()});
      }
      if(req.method==='POST' && path==='/api/events') {
        let data:any; try {data=await body(req,1024);} catch {return send(res,400,{error:'Invalid JSON'});}
        if(!events.has(data.event) || (data.tokenAddress!==undefined && !/^0x[0-9a-f]{40}$/i.test(data.tokenAddress)) ||
           (data.count!==undefined && (!Number.isInteger(data.count)||data.count<0||data.count>1000))) return send(res,400,{error:'Invalid event'});
        store.run('INSERT INTO product_events(event,token_address,count,occurred_at) VALUES (?,?,?,?)',data.event,data.tokenAddress??null,data.count??null,Date.now());
        return send(res,204,null);
      }
      if(req.method==='GET' && files[path]) {
        const [name,mime]=files[path];
        const data=await readFile(join(root,name));
        res.writeHead(200,{'content-type':mime,'cache-control':'no-cache','x-content-type-options':'nosniff'});res.end(data);return;
      }
      send(res,404,{error:'Not found'});
    } catch (e) {console.error('web:',(e as Error).message);send(res,500,{error:'AITER is unavailable'});}
  });
}
