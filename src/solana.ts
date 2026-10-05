import type { Config } from './config.js';
import type { Store } from './db.js';

const SOL='So11111111111111111111111111111111111111112';
const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const quoteSymbols:Record<string,string>={[SOL]:'SOL',[USDC]:'USDC'};
export const solanaRankingConfig={
  maxAgeMs:3*60*60_000,maxResults:10,fallbackBelow:3,
  normal:{minTrades:10,minBuys:5,minLiquidity:5_000,minSize:10_000},
  relaxed:{minTrades:3,minBuys:2,minLiquidity:1_000,minSize:3_000},
  weights:{activity:3,buyers:3,pressure:2,volumeToSize:3,liquidity:1,freshness:2,sizeFit:1},
};
export const isSolanaAddress=(value:unknown):value is string=>typeof value==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const finite=(value:unknown)=>{const n=Number(value);return value!==null&&value!==''&&Number.isFinite(n)?n:null;};
const integerOrNull=(value:unknown)=>{const n=finite(value);return n===null?null:Math.max(0,Math.trunc(n));};
const strip=(id:unknown)=>typeof id==='string'&&id.startsWith('solana_')?id.slice(7):null;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
type Counts=Record<string,number>;
const inc=(counts:Counts,key:string)=>{counts[key]=(counts[key]??0)+1;};

export class SolanaCollector {
  private stopped=false;
  constructor(private store:Store,private cfg:Config){}
  private async page(page:number) {
    const url=`${this.cfg.geckoBase}/networks/solana/new_pools?page=${page}&include=base_token,quote_token,dex`;
    const response=await fetch(url,{headers:{accept:'application/json;version=20230203','user-agent':'AITER/0.1'}});
    if(!response.ok)throw new Error(`GeckoTerminal ${response.status}`);
    return response.json() as Promise<any>;
  }
  async discover() {
    const fetchedAt=Date.now();let seen=0;
    for(let page=1;page<=this.cfg.solanaNewPoolPages;page++) {
      if(page>1)await sleep(700);
      const body=await this.page(page);
      const included=new Map((body.included??[]).map((item:any)=>[item.id,item]));
      this.store.atomic(()=>{
        for(const resource of body.data??[]) {
          const a=resource?.attributes??{},r=resource?.relationships??{};
          const pool=String(a.address??strip(resource?.id)??'');
          const mint=strip(r.base_token?.data?.id),quote=strip(r.quote_token?.data?.id);
          if(!isSolanaAddress(pool)||!isSolanaAddress(mint)||!isSolanaAddress(quote)||!quoteSymbols[quote])continue;
          const token:any=included.get(r.base_token?.data?.id),tokenA=token?.attributes??{};
          const quoteToken:any=included.get(r.quote_token?.data?.id),quoteA=quoteToken?.attributes??{};
          const created=Date.parse(a.pool_created_at);
          if(!Number.isFinite(created)||created>fetchedAt+30_000||fetchedAt-created>6*60*60_000)continue;
          const m5=a.transactions?.m5??{};
          this.store.run(`INSERT INTO solana_pools(pool_address,mint_address,quote_mint,quote_symbol,dex_id,name,symbol,image_url,
            created_at,discovered_at,fetched_at,price,fdv,market_cap,liquidity,volume_5m,buys_5m,sells_5m,buyers_5m,sellers_5m,price_change_5m,payload)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(pool_address) DO UPDATE SET
            mint_address=excluded.mint_address,quote_mint=excluded.quote_mint,quote_symbol=excluded.quote_symbol,dex_id=excluded.dex_id,
            name=excluded.name,symbol=excluded.symbol,image_url=excluded.image_url,created_at=excluded.created_at,fetched_at=excluded.fetched_at,
            price=excluded.price,fdv=excluded.fdv,market_cap=excluded.market_cap,liquidity=excluded.liquidity,volume_5m=excluded.volume_5m,
            buys_5m=excluded.buys_5m,sells_5m=excluded.sells_5m,buyers_5m=excluded.buyers_5m,sellers_5m=excluded.sellers_5m,
            price_change_5m=excluded.price_change_5m,payload=excluded.payload`,
            pool,mint,quote,quoteA.symbol??quoteSymbols[quote],r.dex?.data?.id??null,tokenA.name??null,tokenA.symbol??null,tokenA.image_url??null,
            created,fetchedAt,fetchedAt,finite(a.base_token_price_usd),finite(a.fdv_usd),finite(a.market_cap_usd),finite(a.reserve_in_usd),
            finite(a.volume_usd?.m5),integerOrNull(m5.buys),integerOrNull(m5.sells),integerOrNull(m5.buyers),integerOrNull(m5.sellers),
            finite(a.price_change_percentage?.m5),JSON.stringify(resource));seen++;
        }
      });
    }
    this.store.run('DELETE FROM solana_pools WHERE created_at<? OR fetched_at<?',fetchedAt-6*60*60_000,fetchedAt-30*60_000);
    this.store.set('solanaLastDiscoverySuccess',fetchedAt);this.store.set('solanaLastDiscoveryCount',seen);
    this.store.set('solanaProviderError',null);
    return seen;
  }
  async run(seconds?:number) {
    const started=Date.now();this.store.set('solanaRunStartedAt',started);
    const stop=()=>{this.stopped=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
    const timer=seconds===undefined?undefined:setTimeout(stop,seconds*1000);
    console.log('AITER SOLANA COLLECTOR: Ctrl+C stops safely.');
    try {
      while(!this.stopped) {
        const begin=Date.now();
        try {const count=await this.discover();console.log(`SOLANA new pools refreshed: ${count}`);}
        catch(e){const message=(e as Error).message;this.store.set('solanaProviderError',{message,at:Date.now()});console.error(`solana discovery: ${message}`);}
        while(!this.stopped&&Date.now()<begin+this.cfg.solanaDiscoveryMs)await sleep(Math.min(500,begin+this.cfg.solanaDiscoveryMs-Date.now()));
      }
    } finally {if(timer)clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  }
}

export function rankSolanaDetailed(store:Store,cfg:Config,now=Date.now()) {
  const rows=store.all('SELECT * FROM solana_pools WHERE created_at BETWEEN ? AND ? AND fetched_at>=? ORDER BY created_at DESC',
    now-solanaRankingConfig.maxAgeMs,now,now-cfg.staleMs);
  const coverage:Counts={freshLaunches:rows.length,eligibleWithActivity:0,withPriceOrFdv:0,withLiquidity:0,withVolume5m:0,withBuysSells:0,withBuyers5m:0};
  const normalRejected:Counts={},relaxedRejected:Counts={};
  const normal=new Map<string,any>(),relaxed=new Map<string,any>();
  for(const row of rows) {
    const trades=row.buys_5m===null||row.sells_5m===null?null:Number(row.buys_5m)+Number(row.sells_5m);
    const buys=row.buys_5m===null?null:Number(row.buys_5m),sells=row.sells_5m===null?null:Number(row.sells_5m);
    const size=row.market_cap??row.fdv??null,liquidity=row.liquidity??null,volume=row.volume_5m??null,buyers=row.buyers_5m??null;
    if(row.price!==null||size!==null)coverage.withPriceOrFdv++;if(liquidity!==null)coverage.withLiquidity++;
    if(volume!==null)coverage.withVolume5m++;if(trades!==null)coverage.withBuysSells++;if(buyers!==null)coverage.withBuyers5m++;
    if(trades!==null&&trades>0)coverage.eligibleWithActivity++;
    const basic=!isSolanaAddress(row.mint_address)||!isSolanaAddress(row.pool_address)?'invalid address':
      !quoteSymbols[row.quote_mint]?'unsupported quote':trades===null||buys===null?'missing activity':
      trades<solanaRankingConfig.relaxed.minTrades||buys<solanaRankingConfig.relaxed.minBuys?'insufficient activity':
      liquidity!==null&&liquidity<solanaRankingConfig.relaxed.minLiquidity?'confirmed thin liquidity':
      size!==null&&size<solanaRankingConfig.relaxed.minSize?'confirmed tiny size':null;
    if(basic){inc(normalRejected,basic);inc(relaxedRejected,basic);continue;}
    const normalReason=trades!<solanaRankingConfig.normal.minTrades||buys!<solanaRankingConfig.normal.minBuys?'insufficient activity':
      liquidity!==null&&liquidity<solanaRankingConfig.normal.minLiquidity?'liquidity filter':
      size!==null&&size<solanaRankingConfig.normal.minSize?'size filter':null;
    if(normalReason)inc(normalRejected,normalReason);
    const ageMs=now-row.created_at,pressure=buys!/Math.max(1,trades!),volumeToSize=volume!==null&&size&&size>0?volume/size:null;
    const liquidityToSize=liquidity!==null&&size&&size>0?liquidity/size:null;
    const score=solanaRankingConfig.weights.activity*Math.log1p(trades!)+solanaRankingConfig.weights.buyers*Math.log1p(buyers??buys!)+
      solanaRankingConfig.weights.pressure*pressure+solanaRankingConfig.weights.volumeToSize*Math.min(3,(volumeToSize??0)*20)+
      solanaRankingConfig.weights.liquidity*Math.min(2,(liquidityToSize??0)*4)+solanaRankingConfig.weights.freshness*Math.max(0,1-ageMs/solanaRankingConfig.maxAgeMs)+
      solanaRankingConfig.weights.sizeFit*(size!==null&&size>=10_000&&size<=150_000?1:0);
    const reasons=[
      {ok:trades!>=20,value:trades!,text:'Strong buying activity'},
      {ok:buys!>sells!,value:pressure*20,text:'Buy pressure'},
      {ok:buyers!==null&&buyers>=5,value:buyers??0,text:'Multiple buyers active'},
      {ok:volumeToSize!==null&&volumeToSize>=.03,value:(volumeToSize??0)*100,text:'High volume for its size'},
      {ok:liquidity!==null&&liquidity>=10_000,value:4,text:'Healthy liquidity'},
      {ok:ageMs<30*60_000&&trades!>=3,value:3,text:'Active fresh launch'},
      {ok:trades!>=3,value:2,text:'Recent trading activity'},
    ].filter(x=>x.ok).sort((a,b)=>b.value-a.value).slice(0,3).map(x=>x.text);
    if(reasons.length<2){inc(normalRejected,'insufficient reasons');inc(relaxedRejected,'insufficient reasons');continue;}
    const redFlags:string[]=[];if(liquidity!==null&&liquidity<5_000)redFlags.push('THIN LIQUIDITY');
    const candidate={chain:'solana',tokenAddress:row.mint_address,mintAddress:row.mint_address,poolAddress:row.pool_address,
      name:row.name??null,symbol:row.symbol??null,createdAt:new Date(row.created_at).toISOString(),ageMs,
      price:row.price??null,fdv:row.fdv??null,marketCap:row.market_cap??null,liquidity,volume5m:volume,
      buys5m:buys,sells5m:sells,buyers5m:buyers,priceChange5m:row.price_change_5m??null,
      recentTrades:null,recentBuys:null,recentSells:null,recentBuyers:null,whyAiter:reasons,socials:null,redFlags,
      externalUrl:`https://www.geckoterminal.com/solana/pools/${row.pool_address}`,
      dataTimestamp:new Date(row.fetched_at).toISOString(),score};
    const keep=(map:Map<string,any>)=>{const old=map.get(row.mint_address);if(!old||old.score<score)map.set(row.mint_address,candidate);};
    keep(relaxed);if(!normalReason)keep(normal);
  }
  const source=normal.size>=solanaRankingConfig.fallbackBelow?normal:relaxed;
  const candidates=[...source.values()].sort((a,b)=>b.score-a.score).slice(0,solanaRankingConfig.maxResults).map(({score,...x})=>x);
  return {candidates,diagnostic:{coverage,normalRejected,relaxedRejected,normalSurvivors:normal.size,relaxedSurvivors:relaxed.size,
    resultCount:candidates.length,mode:normal.size>=solanaRankingConfig.fallbackBelow?'normal':'relaxed'}};
}
export const rankSolana=(store:Store,cfg:Config,now=Date.now())=>rankSolanaDetailed(store,cfg,now).candidates;

export function solanaHealth(store:Store,cfg:Config,now=Date.now()) {
  const last=store.get<number|null>('solanaLastDiscoverySuccess',null),started=store.get<number|null>('solanaRunStartedAt',null);
  const error=store.get<{message:string;at:number}|null>('solanaProviderError',null);
  const freshPools=store.one('SELECT COUNT(*) n FROM solana_pools WHERE created_at BETWEEN ? AND ? AND fetched_at>=?',now-3*60*60_000,now,now-cfg.staleMs).n;
  const tracked=store.one('SELECT COUNT(DISTINCT mint_address) n FROM solana_pools WHERE created_at BETWEEN ? AND ? AND fetched_at>=?',now-3*60*60_000,now,now-cfg.staleMs).n;
  const eligible=rankSolanaDetailed(store,cfg,now).diagnostic.relaxedSurvivors;
  const current=Boolean(last&&now-last<=cfg.solanaDiscoveryMs*2+30_000);
  const status=!started?'starting':!last?'scanning':current?'ready':'degraded';
  const providerStatus=!last?'unknown':error&&error.at>last?'error':current?'ok':'stale';
  return {chain:'solana',status,phase:status.toUpperCase(),deploymentMode:cfg.deploymentMode,lastSuccessfulDiscovery:last?new Date(last).toISOString():null,
    freshPools,activeTokens:tracked,eligibleCandidates:eligible,marketProviderStatus:providerStatus,provider:'geckoterminal'};
}
