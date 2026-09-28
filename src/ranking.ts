import type { Store } from './db.js';
import type { Config } from './config.js';
import { normalizeMarket } from './normalize.js';

export const rankingConfig = {
  maxAgeMs: 3*60*60_000, maxResults: 10, fallbackBelow: 3,
  normal: { minTrades: 8, minBuys: 4, minLiquidity: 5_000, minSize: 8_000 },
  relaxed: { minTrades: 3, minBuys: 2, minLiquidity: 1_000 },
  weights: { buyers: 4, pressure: 2, volumeToSize: 3, liquidity: 1, freshness: 1, sizeFit: 1 },
};
type Counts = Record<string,number>;
const inc = (counts: Counts, key: string) => { counts[key]=(counts[key]??0)+1; };
const validAddress = (value: unknown): value is string => typeof value==='string' && /^0x[0-9a-f]{40}$/i.test(value);

export function rankDetailed(store: Store, cfg: Config, now = Date.now()) {
  const boundary=store.get<{block:number;time:number;at:number}|null>('activityBoundary',null);
  const cursor=store.get<number|null>('activityCursor',null);
  const safeTime=store.get<number|null>('activitySafeTime',null);
  const activityFresh=boundary!==null && cursor!==null && safeTime!==null &&
    now-store.get('lastActivitySuccess',0)<=90_000 && now-store.get('lastDiscoverySuccess',0)<=90_000 &&
    now-safeTime<=90_000 && now-boundary.time<=300_000 &&
    store.get('rpcHead',0)-cursor<=cfg.maxLiveLagBlocks;
  const rows=store.all(`SELECT t.*,v.curve_address,v.pool_address,v.pool_id,v.phase,
    o.fetched_at,o.source_observation_time,o.payload,info.payload AS info_payload,info.fetched_at AS info_fetched_at,
    a.trades AS recent_trades,a.buys AS recent_buys,a.sells AS recent_sells,
    a.buyers AS recent_buyers,a.known_buyers AS known_buyers
    FROM tokens t JOIN venues v USING(token_address)
    LEFT JOIN observations o ON o.id=(SELECT max(id) FROM observations
      WHERE token_address=t.token_address AND kind='market' AND error IS NULL)
    LEFT JOIN observations info ON info.id=(SELECT max(id) FROM observations
      WHERE token_address=t.token_address AND kind='token_info' AND error IS NULL)
    LEFT JOIN (SELECT venue_address,COUNT(*) trades,
      SUM(CASE WHEN side='buy' THEN 1 ELSE 0 END) buys,
      SUM(CASE WHEN side='sell' THEN 1 ELSE 0 END) sells,
      COUNT(DISTINCT CASE WHEN side='buy' THEN buyer_address END) buyers,
      SUM(CASE WHEN side='buy' AND buyer_address IS NOT NULL THEN 1 ELSE 0 END) known_buyers
      FROM activity_events WHERE block_number>=? AND block_number<=? GROUP BY venue_address) a
      ON a.venue_address=v.curve_address
    WHERE t.discovery_origin='live' AND t.launch_time BETWEEN ? AND ?`,
    activityFresh ? boundary.block : Number.MAX_SAFE_INTEGER, activityFresh ? cursor : 0,
    now-rankingConfig.maxAgeMs,now);
  const coverage: Counts={freshLaunches:rows.length,withMarketData:0,withPriceOrFdv:0,withLiquidity:0,
    withVolume5m:0,withBuysSells:0,withBuyers5m:0,withRecentRpcActivity:0,eligibleWithActivity:0,
    missingMarketData:0,staleMarketData:0};
  const normalRejected: Counts={}, relaxedRejected: Counts={};
  const normal: any[]=[], relaxed: any[]=[];
  for(const row of rows) {
    let market: ReturnType<typeof normalizeMarket>|null=null;
    if(row.payload) {
      try {
        const payload=JSON.parse(row.payload);
        if(payload.resource) {
          coverage.withMarketData++;
          const observedAge=now-row.fetched_at+(payload.httpCacheAgeMs??0);
          if(observedAge<=cfg.staleMs && observedAge>=-30_000) {
            const m=normalizeMarket(payload.resource,row.token_address);
            if(m.sourceObservationTime===null ||
              (m.sourceObservationTime<=now+30_000 && now-m.sourceObservationTime<=cfg.staleMs)) market=m;
          }
        }
      } catch { /* Malformed provider data is unavailable, never zero. */ }
    }
    if(!row.payload) coverage.missingMarketData++;
    else if(!market) coverage.staleMarketData++;
    const x=market?.windows.m5;
    const size=market?.marketCap??market?.fdv??null;
    if(market?.price!=null || size!==null) coverage.withPriceOrFdv++;
    if(market?.providerLiquidityEstimate!=null) coverage.withLiquidity++;
    if(x?.volume!=null) coverage.withVolume5m++;
    if(x?.buys!=null && x?.sells!=null) coverage.withBuysSells++;
    if(x?.buyers!=null) coverage.withBuyers5m++;
    if(activityFresh && row.recent_trades>0) coverage.withRecentRpcActivity++;
    const rpcTrades=activityFresh?Number(row.recent_trades??0):0;
    const marketTrades=Number(x?.buys??0)+Number(x?.sells??0);
    const useRpc=rpcTrades>0;
    const trades=useRpc?rpcTrades:marketTrades;
    const buys=useRpc?Number(row.recent_buys):Number(x?.buys??0);
    const sells=useRpc?Number(row.recent_sells):Number(x?.sells??0);
    const buyers=useRpc ? row.known_buyers>0?Number(row.recent_buyers):null : x?.buyers??null;
    if(trades>0) coverage.eligibleWithActivity++;
    const venue=row.phase==='pool-created'?row.pool_id:row.curve_address??row.pool_address;
    const basic=!validAddress(row.token_address)||!validAddress(venue)?'invalid venue or token':
      !useRpc && !market?(row.payload?'stale market / no recent trades':'missing market / no recent trades'):
      trades<rankingConfig.relaxed.minTrades||buys<rankingConfig.relaxed.minBuys?'insufficient activity':
      market?.providerLiquidityEstimate!=null && market.providerLiquidityEstimate<rankingConfig.relaxed.minLiquidity?
        'confirmed thin liquidity':null;
    if(basic) {inc(relaxedRejected,basic);inc(normalRejected,basic);continue;}
    const normalReason=trades<rankingConfig.normal.minTrades||buys<rankingConfig.normal.minBuys?
      'insufficient activity':market?.providerLiquidityEstimate!=null &&
      market.providerLiquidityEstimate<rankingConfig.normal.minLiquidity?'liquidity filter':
      size!==null && size<rankingConfig.normal.minSize?'size filter':null;
    if(normalReason) inc(normalRejected,normalReason);
    const ageMs=now-row.launch_time,pressure=buys/Math.max(1,trades);
    const volumeToSize=x?.volume!=null && size!==null && size>0?x.volume/size:null;
    const liquidityToSize=market?.providerLiquidityEstimate!=null && size!==null && size>0?
      market.providerLiquidityEstimate/size:null;
    const score=rankingConfig.weights.buyers*Math.log1p(buyers??buys) +
      rankingConfig.weights.pressure*pressure +
      rankingConfig.weights.volumeToSize*Math.min(2,(volumeToSize??0)*20) +
      rankingConfig.weights.liquidity*Math.min(2,(liquidityToSize??0)*5) +
      rankingConfig.weights.freshness*Math.max(0,1-ageMs/rankingConfig.maxAgeMs) +
      rankingConfig.weights.sizeFit*(size!==null && size>=10_000 && size<=150_000?1:0) + Math.log1p(trades);
    const reasons=[
      {signal:trades>=8,value:trades,text:'Strong recent trading activity'},
      {signal:buys>sells,value:pressure*10,text:'Buy pressure'},
      {signal:buyers!==null && buyers>=4,value:buyers??0,text:'Multiple buyers active'},
      {signal:volumeToSize!==null && volumeToSize>=.04,value:(volumeToSize??0)*100,text:'High volume for its size'},
      {signal:ageMs<30*60_000 && trades>=3,value:3,text:'Fresh launch with active trading'},
      {signal:trades>=3 && trades<8,value:2,text:'Recent trading activity'},
    ].filter(r=>r.signal).sort((a,b)=>b.value-a.value).slice(0,3).map(r=>r.text);
    if(reasons.length<2) {inc(normalRejected,'insufficient reasons');inc(relaxedRejected,'insufficient reasons');continue;}
    let profile:any=null;
    try { profile=row.info_payload?JSON.parse(row.info_payload)?.attributes:null; } catch { /* unavailable */ }
    const website=Array.isArray(profile?.websites)?profile.websites.find((v:unknown)=>typeof v==='string' && /^https:\/\//i.test(v as string))??null:null;
    const twitter=typeof profile?.twitter_handle==='string' && profile.twitter_handle.trim()?`https://x.com/${profile.twitter_handle.replace(/^@/,'')}`:null;
    const telegram=typeof profile?.telegram_handle==='string' && profile.telegram_handle.trim()?`https://t.me/${profile.telegram_handle.replace(/^@/,'')}`:null;
    const devHolding=Number(profile?.developer_holding_percentage);
    const redFlags:string[]=profile?[!twitter?'NO X':null,!website?'NO WEBSITE':null,
      profile.gt_verified===false?'UNVERIFIED PROFILE':null,profile.is_honeypot===true?'HONEYPOT':null,
      Number.isFinite(devHolding)&&devHolding>10?'HIGH DEV HOLDINGS':null].filter(Boolean) as string[]:[];
    if(market?.providerLiquidityEstimate!=null && market.providerLiquidityEstimate<5_000)redFlags.push('THIN LIQUIDITY');
    if(buyers!==null && buys>=10 && buyers/Math.max(1,buys)<.25)redFlags.push('REPEATED BUYERS');
    const candidate={tokenAddress:row.token_address,name:row.name??null,symbol:row.symbol??null,
      createdAt:new Date(row.launch_time).toISOString(),ageMs,price:market?.price??null,fdv:market?.fdv??null,
      marketCap:market?.marketCap??null,liquidity:market?.providerLiquidityEstimate??null,
      volume5m:x?.volume??null,buys5m:x?.buys??null,sells5m:x?.sells??null,buyers5m:x?.buyers??null,
      recentTrades:useRpc?trades:null,recentBuys:useRpc?buys:null,recentSells:useRpc?sells:null,
      recentBuyers:useRpc?buyers:null,whyAiter:reasons,
      socials:profile?{twitterUrl:twitter,websiteUrl:website,telegramUrl:telegram}:null,
      redFlags,profileTimestamp:row.info_fetched_at?new Date(row.info_fetched_at).toISOString():null,
      externalUrl:market!==null?`https://www.geckoterminal.com/robinhood/pools/${venue}`:
        `https://robinhoodchain.blockscout.com/token/${row.token_address}`,
      tradeUrl:`https://www.ponsfamily.com/launchpad/${row.token_address}`,
      dataTimestamp:new Date(useRpc?safeTime!:row.source_observation_time??row.fetched_at).toISOString(),score};
    relaxed.push(candidate);
    if(!normalReason) normal.push(candidate);
  }
  const chosen=normal.length>=rankingConfig.fallbackBelow?normal:relaxed;
  const candidates=chosen.sort((a,b)=>b.score-a.score).slice(0,rankingConfig.maxResults).map(({score,...candidate})=>candidate);
  return {candidates,diagnostic:{coverage,normalRejected,relaxedRejected,normalSurvivors:normal.length,
    relaxedSurvivors:relaxed.length,resultCount:candidates.length,mode:normal.length>=rankingConfig.fallbackBelow?'normal':'relaxed',
    activityFresh,activityCursor:cursor,activityWindowStart:boundary?new Date(boundary.time).toISOString():null}};
}
export function rank(store:Store,cfg:Config,now=Date.now()) {return rankDetailed(store,cfg,now).candidates;}
export function rankAutoHunt(store:Store,cfg:Config,now=Date.now()) {
  const result=rankDetailed(store,cfg,now);
  return result.candidates.filter((candidate:any)=>{
    const trades=candidate.recentTrades ?? ((candidate.buys5m??0)+(candidate.sells5m??0));
    const buys=candidate.recentBuys ?? candidate.buys5m ?? 0;
    const buyers=candidate.recentBuyers ?? candidate.buyers5m;
    return trades>=20 && buys/trades>=.55 && (buyers===null || buyers===undefined || buyers>=8) &&
      now-Date.parse(candidate.dataTimestamp)<=90_000;
  }).slice(0,5);
}
