const $ = id => document.getElementById(id);
const BAG_KEY = 'aiter-bag-v1';
let cards = [];
let index = 0;
let moving = false;
let scanTimer = null;
let bagFilter = 'all';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
};
const bag = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(BAG_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch { return []; }
};
const money = value => value == null || !Number.isFinite(Number(value)) ? 'N/A' :
  Number(value) >= 1e6 ? `$${(Number(value) / 1e6).toFixed(1)}M` :
  Number(value) >= 1e3 ? `$${(Number(value) / 1e3).toFixed(1)}K` :
  `$${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const age = value => value < 3600000 ? `${Math.max(1, Math.floor(value / 60000))}M` : `${(value / 3600000).toFixed(1)}H`;
const safeUrl = url => typeof url === 'string' && (
  /^https:\/\/www\.geckoterminal\.com\/robinhood\/pools\/0x[0-9a-f]{40}$/i.test(url) ||
  /^https:\/\/robinhoodchain\.blockscout\.com\/token\/0x[0-9a-f]{40}$/i.test(url));
const safeSocialUrl = url => {
  try { const parsed=new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password; }
  catch { return false; }
};
const safeTradeUrl=url=>typeof url==='string'&&/^https:\/\/www\.ponsfamily\.com\/launchpad\/0x[0-9a-f]{40}$/i.test(url);
function event(name, fields = {}) {
  fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: name, ...fields }), keepalive: true }).catch(() => {});
}
function show(view) {
  for (const id of ['home', 'scan', 'results', 'bagPage', 'autoPage']) $(id).classList.toggle('hidden', id !== view);
  $('findNav').classList.toggle('active', !['bagPage','autoPage'].includes(view));
  $('agentNav').classList.remove('active');
  $('autoNav').classList.toggle('active', view === 'autoPage');
  $('bagNav').classList.toggle('active', view === 'bagPage');
  $('bagCount').textContent = bag().length || '';
  scrollTo({ top: 0, behavior: 'instant' });
}
async function connectAutoHunt() {
  if(!window.ethereum) throw Error('NO WALLET FOUND');
  const [address]=await window.ethereum.request({method:'eth_requestAccounts'});
  const challenge=await fetch('/api/auto-hunt/challenge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address})}).then(r=>r.json());
  if(!challenge.message) throw Error(challenge.error||'CHALLENGE FAILED');
  const signature=await window.ethereum.request({method:'personal_sign',params:[challenge.message,address]});
  const response=await fetch('/api/auto-hunt/session',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({address,message:challenge.message,signature})});
  const session=await response.json();
  if(!response.ok) throw Error(session.error||'ACCESS DENIED');
  sessionStorage.setItem('aiter-auto-session',session.token);
  return session.token;
}
async function renderAutoHunt() {
  show('autoPage');
  const status=$('autoStatus'),list=$('autoList');
  status.className='auto-status';status.textContent='CHECKING AGENT…';list.replaceChildren();
  try {
    const config=await fetch('/api/auto-hunt/config',{cache:'no-store'}).then(r=>r.json());
    if(!config.enabled) {
      status.textContent='AUTO HUNT IS OFFLINE';
      list.append(emptyPanel('AGENT OFFLINE.','AUTO HUNT has not been enabled on this server.',null));return;
    }
    let token=sessionStorage.getItem('aiter-auto-session');
    let response=await fetch('/api/auto-hunt',{cache:'no-store',headers:token?{authorization:`Bearer ${token}`}:{}});
    if(response.status===401 && !config.beta) {
      status.textContent='LOCK $AITER TO ACTIVATE';
      list.append(emptyPanel('CONNECT YOUR WALLET.','AUTO HUNT requires an active $AITER lock.','CONNECT WALLET',async()=>{
        try {await connectAutoHunt();renderAutoHunt();} catch(error) {status.textContent=error.message||'CONNECTION FAILED';}
      }));return;
    }
    const data=await response.json();if(!response.ok) throw Error(data.error||'AGENT UNAVAILABLE');
    status.className='auto-status live';
    status.textContent=config.beta?'AGENT LIVE · OPEN BETA':'AGENT LIVE · $AITER ACCESS ACTIVE';
    if(!data.signals.length) {list.append(emptyPanel('MARKET QUIET.','The agent is watching. No strict signals have appeared yet.',null));return;}
    for(const signal of data.signals) {
      const row=node('article','auto-signal'),head=node('div','auto-signal-head'),identity=node('div');
      identity.append(node('h3',null,signal.symbol?`$${signal.symbol}`:`${signal.tokenAddress.slice(0,8)}…`),
        node('p','bag-name',signal.name||signal.tokenAddress));
      const found=node('time',null,`${Math.max(1,Math.floor((Date.now()-Date.parse(signal.foundAt))/60000))}M AGO`);
      head.append(identity,found);row.append(head);
      const reasons=node('div','auto-reasons');for(const reason of signal.whyAiter||[])reasons.append(node('span',null,reason.toUpperCase()));row.append(reasons);
      const trades=signal.recentTrades!=null?`${signal.recentBuys} BUYS · ${signal.recentSells} SELLS · ${signal.recentBuyers??'N/A'} BUYERS`:
        `${signal.buys5m??'N/A'} BUYS · ${signal.sells5m??'N/A'} SELLS`;row.append(node('div','auto-signal-meta',`${age(signal.ageMs)} OLD · ${trades}`));
      if(safeUrl(signal.externalUrl)){const open=node('a',null,'OPEN TOKEN');open.href=signal.externalUrl;open.target='_blank';open.rel='noopener noreferrer';row.append(open);}list.append(row);
    }
  } catch(error) {status.textContent='AGENT SIGNAL LOST';list.append(emptyPanel('AUTO HUNT UNAVAILABLE.',error.message||'Try again shortly.','RETRY',renderAutoHunt));}
}
async function updateHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) throw Error('unavailable');
    const health = await response.json();
    $('liveLabel').textContent = health.status === 'ok' ? 'ROBINHOOD CHAIN · LIVE' : 'ROBINHOOD CHAIN · DATA STALE';
    document.querySelector('.status-line').classList.toggle('offline', health.status !== 'ok');
    const metrics = $('liveMetrics');
    metrics.replaceChildren();
    if (health.status !== 'ok') return health;
    if (Number.isInteger(health.activeTokens)) {
      const entry = node('span');
      entry.append(node('strong', null, String(health.activeTokens)), document.createTextNode(' ACTIVE'));
      metrics.append(entry);
    }
    if (health.lastSuccessfulDiscovery) {
      const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(health.lastSuccessfulDiscovery)) / 1000));
      if (Number.isFinite(elapsed) && elapsed < 90) {
        const entry = node('span');
        entry.append(node('strong', null, elapsed < 60 ? `${elapsed}S` : `${Math.floor(elapsed / 60)}M`), document.createTextNode(' SINCE SCAN'));
        metrics.append(entry);
      }
    }
    if (health.marketProviderStatus === 'ok') {
      const entry = node('span');
      entry.append(node('strong', null, 'MARKET'), document.createTextNode(' CONNECTED'));
      metrics.append(entry);
    }
    return health;
  } catch {
    $('liveLabel').textContent = 'ROBINHOOD CHAIN · SIGNAL CHECK';
    document.querySelector('.status-line').classList.add('offline');
    $('liveMetrics').replaceChildren();
  }
}
function metric(box, label, value) {
  const item = node('div');
  item.append(node('span', 'metric-label', label), node('span', 'metric-value', value));
  box.append(item);
}
function emptyPanel(title, copy, buttonText, action) {
  const panel = node('div', 'empty-panel');
  panel.append(node('div', 'mini-radar'), node('h3', null, title), node('p', null, copy));
  if (buttonText) {
    const button = node('button', null, buttonText);
    button.type = 'button';
    button.onclick = action;
    panel.append(button);
  }
  return panel;
}
async function loadMarketIntel() {
  try {
    const [mapResponse,recordResponse]=await Promise.all([fetch('/api/market-map',{cache:'no-store'}),fetch('/api/track-record',{cache:'no-store'})]);
    const market=await mapResponse.json(),record=await recordResponse.json();
    if(mapResponse.ok) {
      $('mapStatus').textContent='LIVE';$('marketMap').replaceChildren();
      for(const [label,value] of [['FRESH LAUNCHES',market.freshLaunches],['ACTIVE',market.active],['PASSED FILTERS',market.passed],['SIGNALS',market.signals]]) {
        const box=node('div');box.append(node('strong',null,value??'N/A'),node('span',null,label));$('marketMap').append(box);
      }
      $('rejectionList').replaceChildren();for(const [reason,count] of Object.entries(market.rejections||{}))$('rejectionList').append(node('span',null,`${String(reason).toUpperCase()} ${count}`));
    }
    if(recordResponse.ok) {
      $('recordStats').replaceChildren();
      const recordStat=(label,value)=>{const box=node('div');box.append(node('span',null,label),node('strong',null,value));$('recordStats').append(box);};
      recordStat('TOTAL FINDS',record.totalFinds);recordStat('1H COMPLETE',record.oneHour.completed);recordStat('1H MEDIAN MAX',record.oneHour.medianMax==null?'N/A':percent(record.oneHour.medianMax));recordStat('6H MEDIAN FINAL',record.sixHour.medianFinal==null?'N/A':percent(record.sixHour.medianFinal));
      $('recordList').replaceChildren();for(const entry of record.entries||[]) {const row=node('div','record-row');row.append(node('strong',null,entry.symbol?`$${entry.symbol}`:entry.tokenAddress.slice(0,8)),node('span',null,new Date(entry.foundAt).toLocaleString()),node('span',entry.oneHour.final==null?'pending':entry.oneHour.final>=0?'positive':'negative',entry.oneHour.final==null?'1H PENDING':`1H ${percent(entry.oneHour.final)}`));$('recordList').append(row);}
      const state=$('recordState');state.replaceChildren(node('strong',null,record.totalFinds?'VERIFIED DATA ACTIVE':'COLLECTING OUTCOMES'),node('span',null,record.totalFinds?`${record.totalFinds} SIGNALS RECORDED`:'NO COMPLETED SIGNALS YET'));
    }
  } catch { $('mapStatus').textContent='DATA UNAVAILABLE'; }
}
async function showTokenDetail(current) {
  const dialog=$('tokenDialog'),content=$('tokenDetail');content.replaceChildren(node('div','detail-loading','LOADING ONCHAIN DETAILS'));
  dialog.showModal();
  try {
    const response=await fetch(`/api/token-detail?token=${current.tokenAddress}`,{cache:'no-store'}),data=await response.json();if(!response.ok)throw Error();
    content.replaceChildren();const header=node('div','detail-header');header.append(node('div','eyebrow','SIGNAL DETAIL'),node('h2',null,data.token.symbol?`$${data.token.symbol}`:data.token.tokenAddress.slice(0,10)),node('p',null,data.token.name||data.token.tokenAddress));content.append(header);
    const grid=node('div','detail-grid');
    for(const [label,value] of [['AGE',age(Date.now()-Date.parse(data.token.createdAt))],['PHASE',data.token.phase],['TRADES',data.activity?.trades??'N/A'],['BUYERS',data.activity?.buyers??'N/A'],['DEV HOLDING',data.profile?.developer_holding_percentage==null?'NOT CHECKED':`${data.profile.developer_holding_percentage}%`],['HONEYPOT',data.profile?.is_honeypot??'NOT CHECKED']]) {const box=node('div');box.append(node('span',null,label),node('strong',null,value));grid.append(box);}content.append(grid);
    const flags=node('div','detail-flags');for(const flag of current.redFlags||[])flags.append(node('span',null,flag));if(!flags.childNodes.length)flags.append(node('span','clear','NO CONFIRMED FLAGS'));content.append(node('h3','detail-title','CHECKS'),flags);
    const history=node('div','detail-history');history.append(node('h3','detail-title','OBSERVATION HISTORY'),node('p',null,`${data.snapshots.length} VERIFIED MARKET SNAPSHOTS STORED`));content.append(history);
    const addresses=node('div','detail-addresses');addresses.append(node('span',null,'TOKEN'),node('code',null,data.token.tokenAddress),node('span',null,'DEPLOYER'),node('code',null,data.token.deployerAddress));content.append(addresses);
  } catch {content.replaceChildren(emptyPanel('DETAIL UNAVAILABLE.','Verified token data could not be loaded.',null));}
}
function shillSignal(current) {
  const activity=current.recentTrades!=null?`${current.recentTrades} recent trades`:current.buys5m!=null?`${current.buys5m+current.sells5m} trades in 5m`:'fresh onchain activity';
  const text=`AITER SIGNAL\n\n${current.symbol?`$${current.symbol}`:current.tokenAddress}\n${activity}\n${(current.whyAiter||[]).join('\n')}\n\nCA: ${current.tokenAddress}\n\nhttps://brief-summary-cad-tower.trycloudflare.com/`;
  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`,'_blank','noopener,noreferrer');event('token_shilled',{tokenAddress:current.tokenAddress});
}
function renderCard() {
  const area = $('cardArea');
  area.replaceChildren();
  if (index >= cards.length) {
    area.append(emptyPanel('SCAN COMPLETE.', 'You have seen every signal from this hunt.', 'SCAN AGAIN', hunt));
    return;
  }
  const current = cards[index];
  const stage = node('div', `card-stage${index < cards.length - 1 ? ' has-more' : ''}`);
  const card = node('article', 'card');
  const passBadge = node('div', 'swipe-badge pass', 'PASS');
  const bagBadge = node('div', 'swipe-badge bag', 'BAG');
  card.append(passBadge, bagBadge);
  const top = node('div', 'card-top');
  const identity = node('div', 'token-identity');
  const mark = node('div', 'token-mark', (current.symbol || '?').slice(0, 1).toUpperCase());
  mark.style.setProperty('--orb-angle', `${parseInt((current.tokenAddress || '00').slice(-2), 16) % 180 + 70}deg`);
  const heading = node('div', 'token-heading');
  heading.append(node('h3', null, current.symbol ? `$${current.symbol}` : `${current.tokenAddress.slice(0,8)}…`),
    node('p', 'token-name', current.name || current.tokenAddress));
  const addressRow=node('div','token-address');
  addressRow.append(node('span',null,`CA ${current.tokenAddress.slice(0,6)}…${current.tokenAddress.slice(-4)}`));
  const copyAddress=node('button','copy-address','COPY');
  copyAddress.type='button';copyAddress.setAttribute('aria-label','Copy contract address');
  copyAddress.onclick=async()=>{
    try {
      await navigator.clipboard.writeText(current.tokenAddress);
      copyAddress.textContent='COPIED';
      setTimeout(()=>{copyAddress.textContent='COPY';},1200);
    } catch {
      const input=document.createElement('textarea');input.value=current.tokenAddress;input.style.position='fixed';input.style.opacity='0';
      document.body.append(input);input.select();document.execCommand('copy');input.remove();
      copyAddress.textContent='COPIED';setTimeout(()=>{copyAddress.textContent='COPY';},1200);
    }
  };
  addressRow.append(copyAddress);heading.append(addressRow);
  const signals = node('div', 'token-signals');
  const addSignal = (label, url, kind = '') => {
    const el = url ? node('a', `token-signal ${kind}`, label) : node('span', `token-signal ${kind}`, label);
    if (url && safeSocialUrl(url)) { el.href=url; el.target='_blank'; el.rel='noopener noreferrer nofollow'; }
    signals.append(el);
  };
  if (current.socials) {
    if (current.socials.twitterUrl) addSignal('X', current.socials.twitterUrl, 'verified');
    if (current.socials.websiteUrl) addSignal('WEB', current.socials.websiteUrl, 'verified');
    if (current.socials.telegramUrl) addSignal('TG', current.socials.telegramUrl, 'verified');
    for (const flag of current.redFlags || []) addSignal(flag, null, flag === 'HONEYPOT' ? 'danger' : 'warning');
  } else addSignal('SOCIAL DATA NOT AVAILABLE', null, 'unknown');
  heading.append(signals);
  identity.append(mark, heading);
  top.append(identity, node('span', 'card-kicker', 'FRESH SIGNAL'));
  card.append(top);

  const why = node('div', 'why');
  why.append(node('h4', 'why-title', 'WHY AITER?'));
  for (const reason of current.whyAiter || []) why.append(node('p', 'why-item', reason));
  card.append(why);
  const metrics = node('div', 'metrics');
  if (current.marketCap != null || current.fdv != null)
    metric(metrics, current.marketCap != null ? 'MARKET CAP' : 'FDV', money(current.marketCap ?? current.fdv));
  metric(metrics, 'AGE', age(current.ageMs));
  if (current.liquidity != null) metric(metrics, 'LIQUIDITY', money(current.liquidity));
  if (current.volume5m != null) metric(metrics, 'VOLUME 5M', money(current.volume5m));
  metric(metrics, current.recentTrades != null ? 'RECENT BUYS / SELLS' : 'BUYS / SELLS 5M',
    current.recentTrades != null ? `${current.recentBuys} / ${current.recentSells}` : `${current.buys5m ?? 'N/A'} / ${current.sells5m ?? 'N/A'}`);
  const buyerValue=current.recentTrades != null ? current.recentBuyers : current.buyers5m;
  if (buyerValue != null) metric(metrics, current.recentTrades != null ? 'RECENT BUYERS' : 'BUYERS 5M', buyerValue);
  card.append(metrics);
  const actions = node('div', 'actions');
  const pass = node('button', 'action-btn pass-action', 'PASS');
  const save = node('button', 'action-btn bag-action', 'BAG');
  pass.type = save.type = 'button';
  pass.onclick = () => next('pass');
  save.onclick = () => next('bag');
  actions.append(pass, save);
  card.append(actions);
  const secondary=node('div','secondary-actions');const details=node('button',null,'DETAILS'),shill=node('button',null,'SHILL');details.type=shill.type='button';details.onclick=()=>showTokenDetail(current);shill.onclick=()=>shillSignal(current);secondary.append(details,shill);
  if(safeTradeUrl(current.tradeUrl)){const buy=node('a','instant-buy','INSTANT BUY');buy.href=current.tradeUrl;buy.target='_blank';buy.rel='noopener noreferrer';buy.onclick=()=>event('instant_buy_opened',{tokenAddress:current.tokenAddress});secondary.append(buy);}card.append(secondary);
  if (safeUrl(current.externalUrl)) {
    const open = node('a', 'open-link');
    open.append(document.createTextNode('OPEN TOKEN '), node('span', null, ''));
    open.href = current.externalUrl;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.onclick = () => event('token_opened', { tokenAddress: current.tokenAddress });
    card.append(open);
  }
  addDrag(card, passBadge, bagBadge);
  stage.append(card, node('p', 'card-progress', `${index + 1} OF ${cards.length} SIGNALS`));
  area.append(stage);
}
function addDrag(card, passBadge, bagBadge) {
  let startX = null, startY = null, dragging = false;
  const reset = () => {
    card.classList.remove('dragging');
    card.style.transform = '';
    passBadge.style.opacity = bagBadge.style.opacity = '0';
    startX = startY = null;
    dragging = false;
  };
  card.addEventListener('pointerdown', e => {
    if (moving || e.target.closest('button,a')) return;
    startX = e.clientX; startY = e.clientY;
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener('pointermove', e => {
    if (startX === null || moving) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!dragging && (Math.abs(dx) < 9 || Math.abs(dx) < Math.abs(dy))) return;
    dragging = true;
    card.classList.add('dragging');
    card.style.transform = `translateX(${Math.max(-125, Math.min(125, dx))}px) rotate(${Math.max(-5, Math.min(5, dx / 26))}deg)`;
    passBadge.style.opacity = String(dx < 0 ? Math.min(.9, Math.abs(dx) / 105) : 0);
    bagBadge.style.opacity = String(dx > 0 ? Math.min(.9, Math.abs(dx) / 105) : 0);
  });
  card.addEventListener('pointerup', e => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    if (dragging && Math.abs(dx) > 85) {
      card.style.transform = '';
      next(dx > 0 ? 'bag' : 'pass');
    } else reset();
  });
  card.addEventListener('pointercancel', reset);
}
function next(action) {
  if (moving || index >= cards.length) return;
  moving = true;
  const current = cards[index];
  const card = document.querySelector('.card');
  if (action === 'bag') {
    const saved = bag();
    if (!saved.some(item => item.tokenAddress?.toLowerCase() === current.tokenAddress.toLowerCase())) {
      saved.unshift({ tokenAddress: current.tokenAddress, symbol: current.symbol, name: current.name,
        fdv: current.fdv, marketCap: current.marketCap, price: current.price,
        baggedAt: new Date().toISOString(), externalUrl: current.externalUrl });
      try { localStorage.setItem(BAG_KEY, JSON.stringify(saved)); }
      catch {
        const button = card?.querySelector('.bag-action');
        if (button) button.textContent = 'SAVE UNAVAILABLE';
        moving = false;
        return;
      }
    }
    event('token_bagged', { tokenAddress: current.tokenAddress });
    const button = card?.querySelector('.bag-action');
    if (button) button.textContent = 'BAGGED';
  } else event('token_passed', { tokenAddress: current.tokenAddress });
  card?.classList.add(action === 'bag' ? 'leaving-right' : 'leaving-left');
  setTimeout(() => { index++; moving = false; renderCard(); $('bagCount').textContent = bag().length || ''; }, 230);
}
function startScanText() {
  const steps = ['FINDING FRESH LAUNCHES', 'CHECKING ACTIVITY', 'FILTERING NOISE'];
  let step = 0;
  $('scanTitle').textContent = 'SCANNING.';
  $('scanStep').textContent = steps[0];
  clearInterval(scanTimer);
  scanTimer = setInterval(() => {
    step = (step + 1) % steps.length;
    $('scanStep').textContent = steps[step];
    $('scanStep').classList.remove('changing');
    void $('scanStep').offsetWidth;
    $('scanStep').classList.add('changing');
  }, 460);
}
async function hunt() {
  if (moving) return;
  show('scan');
  startScanText();
  event('hunt_started');
  const started = Date.now();
  try {
    const response = await fetch('/api/find', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error('market unavailable');
    const result = await response.json();
    if (!Array.isArray(result.candidates)) throw Error('invalid result');
    const health = await updateHealth();
    const marketReady = result.marketAvailable && health?.status === 'ok';
    cards = result.candidates;
    index = 0;
    event('hunt_results_count', { count: cards.length });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 1050 - (Date.now() - started))));
    clearInterval(scanTimer);
    $('scanTitle').textContent = cards.length ? `${cards.length} SIGNAL${cards.length === 1 ? '' : 'S'} FOUND.` : marketReady ? 'RADAR CLEAR.' : 'DATA STALE.';
    $('scanStep').textContent = cards.length ? 'SIGNAL ACQUIRED' : marketReady ? 'NOTHING WORTH SHOWING' : 'FRESH DATA UNAVAILABLE';
    await new Promise(resolve => setTimeout(resolve, 280));
    $('resultCount').textContent = cards.length ? `${cards.length} SIGNAL${cards.length === 1 ? '' : 'S'} FOUND.` : marketReady ? 'RADAR CLEAR.' : health?.status === 'degraded' ? 'DATA STALE.' : 'SIGNAL LOST.';
    show('results');
    if (cards.length) renderCard();
    else {
      $('cardArea').replaceChildren(emptyPanel(
        marketReady ? 'NOTHING WORTH SHOWING.' : health?.status === 'degraded' ? 'MARKET DATA IS STALE.' : "AITER CAN'T REACH THE MARKET.",
        marketReady ? 'The market is quiet. AITER will keep watching.' : 'Fresh market data is unavailable right now.',
        'SCAN AGAIN', hunt));
    }
  } catch {
    clearInterval(scanTimer);
    $('resultCount').textContent = 'SIGNAL LOST.';
    show('results');
    $('cardArea').replaceChildren(emptyPanel("AITER CAN'T REACH THE MARKET.", 'The signal is unavailable right now.', 'RETRY', hunt));
    updateHealth();
  }
}
const pnlFor=(item,live)=>{
  const pairs=[[item.price,live?.price],[item.marketCap,live?.marketCap],[item.fdv,live?.fdv]];
  const pair=pairs.find(([before,after])=>Number(before)>0 && Number(after)>=0);
  return pair ? (Number(pair[1])/Number(pair[0])-1)*100 : null;
};
const percent=value=>`${value>=0?'+':''}${value.toFixed(Math.abs(value)>=100?0:1)}%`;
const holdTime=milliseconds=>{
  const hours=Math.max(0,milliseconds)/3600000;
  return hours<1?`${Math.max(1,Math.round(hours*60))}M`:hours<24?`${hours.toFixed(hours<10?1:0)}H`:`${(hours/24).toFixed(1)}D`;
};
function bagChart(saved,liveByToken) {
  const start=Math.min(...saved.map(item=>Date.parse(item.baggedAt)).filter(Number.isFinite)),end=Date.now();
  const points=[];
  if(Number.isFinite(start) && end>start) for(let i=0;i<30;i++) {
    const at=start+(end-start)*i/29,values=[];
    for(const item of saved) {
      const live=liveByToken.get(item.tokenAddress.toLowerCase()),bagged=Date.parse(item.baggedAt);
      if(!live || at<bagged)continue;
      const history=(live.history||[]).filter(point=>Date.parse(point.at)>=bagged && Date.parse(point.at)<=at);
      const observation=history.at(-1);if(!observation)continue;
      const value=pnlFor(item,observation);if(Number.isFinite(value))values.push(value);
    }
    if(values.length)points.push({at,value:values.reduce((a,b)=>a+b,0)/values.length});
  }
  const panel=node('div','bag-chart');
  const head=node('div','bag-chart-head');head.append(node('div',null,'AVERAGE PNL OVER TIME'),node('strong',null,points.length?percent(points.at(-1).value):'NO HISTORY'));
  panel.append(head);
  if(points.length<2){panel.append(node('div','bag-chart-empty','NOT ENOUGH VERIFIED HISTORY YET'));return panel;}
  const values=points.map(point=>point.value),min=Math.min(0,...values),max=Math.max(0,...values),range=Math.max(1,max-min);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 600 190');svg.setAttribute('preserveAspectRatio','none');
  const zero=180-(0-min)/range*160;
  const baseline=document.createElementNS(svg.namespaceURI,'line');baseline.setAttribute('x1','0');baseline.setAttribute('x2','600');baseline.setAttribute('y1',String(zero));baseline.setAttribute('y2',String(zero));baseline.setAttribute('class','bag-chart-zero');svg.append(baseline);
  const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',points.map((point,i)=>`${i?'L':'M'} ${i/(points.length-1)*600} ${180-(point.value-min)/range*160}`).join(' '));path.setAttribute('class',points.at(-1).value>=0?'bag-chart-line positive':'bag-chart-line negative');svg.append(path);panel.append(svg);
  const labels=node('div','bag-chart-labels');labels.append(node('span',null,new Date(start).toLocaleDateString()),node('span',null,'NOW'));panel.append(labels);return panel;
}
async function renderBag() {
  show('bagPage');
  event('bag_opened');
  const list = $('bagList');
  list.replaceChildren();
  const saved = bag();
  if (!saved.length) {
    list.append(emptyPanel('YOUR BAG IS EMPTY.', 'Find something worth keeping.', 'FIND SOMETHING', () => show('home')));
    return;
  }
  const loading=node('div','bag-loading','REFRESHING LIVE MARKET DATA…');list.append(loading);
  let liveByToken=new Map();
  try {
    const query=saved.slice(0,50).map(item=>item.tokenAddress).join(',');
    const response=await fetch(`/api/bag-market?tokens=${encodeURIComponent(query)}`,{cache:'no-store',signal:AbortSignal.timeout(10000)});
    const data=await response.json();
    if(response.ok && Array.isArray(data.tokens)) liveByToken=new Map(data.tokens.map(item=>[item.tokenAddress.toLowerCase(),item]));
  } catch { /* Individual rows will clearly show unavailable data. */ }
  loading.remove();
  const performance=saved.map(item=>pnlFor(item,liveByToken.get(item.tokenAddress.toLowerCase()))).filter(Number.isFinite);
  const analytics=node('section','bag-analytics');
  const analyticsHead=node('div','bag-analytics-head');analyticsHead.append(node('span',null,'BAG ANALYTICS'),node('small',null,'TRACKING ONLY · NOT A POSITION'));
  analytics.append(analyticsHead);
  const stats=node('div','bag-stats');
  const stat=(label,value,kind='')=>{const box=node('div',kind);box.append(node('span',null,label),node('strong',null,value));stats.append(box);};
  const average=performance.length?performance.reduce((a,b)=>a+b,0)/performance.length:null;
  const ranked=saved.map(item=>({item,pnl:pnlFor(item,liveByToken.get(item.tokenAddress.toLowerCase()))})).filter(entry=>Number.isFinite(entry.pnl)).sort((a,b)=>b.pnl-a.pnl);
  const averageHold=saved.reduce((sum,item)=>sum+Math.max(0,Date.now()-Date.parse(item.baggedAt)),0)/saved.length;
  stat('SAVED',String(saved.length));stat('LIVE PNL',`${performance.length} / ${saved.length}`);
  stat('AVG PNL',average===null?'N/A':percent(average),average===null?'':average>=0?'positive':'negative');
  stat('AVG HOLD',holdTime(averageHold));
  analytics.append(stats,bagChart(saved,liveByToken));
  const extremes=node('div','bag-extremes');
  const extreme=(label,entry,kind)=>{const box=node('div',kind);box.append(node('span',null,label),node('strong',null,entry?(entry.item.symbol?`$${entry.item.symbol}`:entry.item.tokenAddress.slice(0,8)):'N/A'),node('small',null,entry?percent(entry.pnl):'AWAITING DATA'));extremes.append(box);};
  extreme('BEST POSITION',ranked[0],ranked[0]?.pnl>=0?'positive':'negative');extreme('WORST POSITION',ranked.at(-1),ranked.at(-1)?.pnl>=0?'positive':'negative');
  analytics.append(extremes);list.append(analytics);
  const filters=node('div','bag-filters');
  for(const [key,label] of [['all','ALL'],['winners','WINNERS'],['losers','LOSERS'],['pending','NO DATA']]) {const button=node('button',bagFilter===key?'active':'',label);button.type='button';button.onclick=()=>{bagFilter=key;renderBag();};filters.append(button);}list.append(filters);
  const displayed=saved.filter(item=>{const pnl=pnlFor(item,liveByToken.get(item.tokenAddress.toLowerCase()));return bagFilter==='all'||bagFilter==='winners'&&pnl>0||bagFilter==='losers'&&pnl<0||bagFilter==='pending'&&pnl===null;});
  if(!displayed.length)list.append(node('div','bag-filter-empty','NO TOKENS IN THIS VIEW'));
  for (const item of displayed) {
    const row = node('div', 'bag-item');
    const left = node('div');
    left.append(node('h3', null, item.symbol ? `$${item.symbol}` : `${item.tokenAddress.slice(0,8)}…`),
      node('p', 'bag-name', item.name || item.tokenAddress));
    const live=liveByToken.get(item.tokenAddress.toLowerCase());
    const pnl=pnlFor(item,live);
    const meta = node('div', 'bag-meta');
    meta.append(document.createTextNode(`${item.marketCap != null ? 'MC' : 'FDV'} WHEN BAGGED `),
      node('strong', null, money(item.marketCap ?? item.fdv)),
      document.createTextNode(`  ·  ${new Date(item.baggedAt).toLocaleString()}`));
    if(live?.marketCap!=null || live?.fdv!=null) meta.append(document.createElement('br'),document.createTextNode(`CURRENT ${live.marketCap!=null?'MC':'FDV'} `),node('strong',null,money(live.marketCap??live.fdv)));
    left.append(meta);
    const side=node('div','bag-side');
    const result=node('div',`bag-pnl ${pnl===null?'pending':pnl>=0?'positive':'negative'}`);
    result.append(node('span',null,'SINCE BAGGED'),node('strong',null,pnl===null?'AWAITING DATA':percent(pnl)));
    side.append(result);
    const alert=pnl===null?'DATA PENDING':pnl>=50?'STRONG GAIN':pnl<=-35?'DRAWDOWN':null;
    if(alert)side.append(node('span',`bag-alert ${pnl===null?'pending':pnl>=0?'positive':'negative'}`,alert));
    row.append(left,side);
    if (safeUrl(item.externalUrl)) {
      const open = node('a', null, 'OPEN');
      open.href = item.externalUrl;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.onclick = () => event('token_opened', { tokenAddress: item.tokenAddress });
      side.append(open);
    }
    const remove=node('button','bag-remove','REMOVE');remove.type='button';remove.onclick=()=>{const remaining=bag().filter(saved=>saved.tokenAddress.toLowerCase()!==item.tokenAddress.toLowerCase());localStorage.setItem(BAG_KEY,JSON.stringify(remaining));renderBag();};side.append(remove);
    list.append(row);
  }
}
$('hunt').onclick = hunt;
$('huntAgain').onclick = hunt;
$('findNav').onclick = () => show('home');
$('agentNav').onclick = $('agentJump').onclick = () => {
  show('home');
  $('findNav').classList.remove('active');
  $('agentNav').classList.add('active');
  requestAnimationFrame(()=>$('agent').scrollIntoView({behavior:'smooth',block:'start'}));
};
$('autoNav').onclick = renderAutoHunt;
$('bagNav').onclick = renderBag;
$('bagCount').textContent = bag().length || '';
$('closeTokenDialog').onclick=()=>$('tokenDialog').close();
$('tokenDialog').onclick=e=>{if(e.target===$('tokenDialog'))$('tokenDialog').close();};
updateHealth();
loadMarketIntel();
setInterval(updateHealth, 30000);
