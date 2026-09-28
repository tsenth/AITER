import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { config } from './config.js';
import { Store } from './db.js';
import { Collector } from './collector.js';
import { report, status } from './report.js';
import { createWebServer } from './web.js';
import { rankDetailed } from './ranking.js';
import { FACTORIES } from './pons.js';

const cfg = config();
const command = process.argv[2] ?? 'help';
if (!['start', 'web', 'report', 'status', 'diagnose'].includes(command)) {
  console.log('Usage: npm start -- [--run-seconds N] | npm run web | npm run report | npm run status | npm run diagnose');
  process.exit(command === 'help' ? 0 : 1);
}
if (command !== 'start' && command !== 'web' && !existsSync(cfg.dbPath)) throw new Error('Database does not exist; start the collector first.');
const store = new Store(cfg.dbPath);
let locked = false;
const lockPath = cfg.dbPath + '.lock';
try {
  if (command === 'start' || command === 'web') {
    if (existsSync(lockPath)) {
      const pid = Number(readFileSync(lockPath, 'utf8'));
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (alive) throw new Error('Another collector may own this database. Stop it before starting a second process.');
      unlinkSync(lockPath);
    }
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); locked = true;
    const index = process.argv.indexOf('--run-seconds');
    const seconds = index < 0 ? undefined : Number(process.argv[index+1]);
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) throw new Error('--run-seconds requires a positive number');
    const server = command === 'web' ? createWebServer(store,cfg) : null;
    if (server) {
      const port=Number(process.env.PORT ?? 3000);
      if (!Number.isInteger(port)||port<1||port>65535) throw new Error('PORT must be a valid port');
      const host=process.env.HOST ?? '127.0.0.1';
      if (!['127.0.0.1','0.0.0.0'].includes(host)) throw new Error('HOST must be 127.0.0.1 or 0.0.0.0');
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
      console.log(`AITER listening on ${host}:${port} in ${cfg.deploymentMode} mode using ${cfg.dbPath}`);
    }
    try { await new Collector(store, cfg).run(seconds); }
    finally {if(server) await new Promise<void>(resolve=>server.close(()=>resolve()));}
  } else if (command === 'report') console.log(JSON.stringify(report(store), null, 2));
  else if (command === 'diagnose') {
    const now=Date.now(),head=store.get<number|null>('rpcHead',null);
    const cursors=FACTORIES.map(f=>store.get<{block:number}|null>(`liveDiscovery:${f.address}`,null)?.block??null);
    const liveCursor=cursors.every(n=>n!==null)?Math.min(...cursors as number[]):null;
    const launches=Object.fromEntries([5,15,60,180].map(minutes=>[`${minutes}m`,store.one(
      "SELECT count(*) n FROM tokens WHERE discovery_origin='live' AND launch_time BETWEEN ? AND ?",
      now-minutes*60_000,now).n]));
    console.log(JSON.stringify({rpcHead:head,liveCursor,cursorLag:head!==null&&liveCursor!==null?head-liveCursor:null,
      launches,...rankDetailed(store,cfg,now).diagnostic},null,2));
  }
  else console.log(status(store));
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
finally { if (locked) unlinkSync(lockPath); store.close(); }
