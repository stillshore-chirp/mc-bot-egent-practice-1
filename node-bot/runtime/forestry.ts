import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { LocalTerrain, navigateLocally, readLocalPosition, type LocalPosition } from './localNavigation.js';
import { acquireMovementControl } from './movementControl.js';

const LOGS = new Set(['oak_log', 'birch_log', 'spruce_log']);
const CARGO = new Set([...LOGS, 'oak_sapling', 'birch_sapling', 'spruce_sapling', 'stick', 'apple']);
const REASONS = new Set(['natural_growth_verified','origin_unknown','out_of_range','unnatural_ground','observation_unknown','protected_or_unknown','world_changed','building_suspected','tree_shape_unknown','reach_or_order']);
function ordinaryCargo(bot: Bot): boolean {
  return bot.inventory.items().filter(i=>CARGO.has(i.name)).every(i=>{
    const components=(i as unknown as {components?: unknown}).components;
    return !i.nbt && (i.metadata??0)===0 && (!components || (Array.isArray(components)&&components.length===0));
  });
}
type Phase = 'idle' | 'searching' | 'harvesting' | 'returning' | 'depositing' | 'blocked';
export interface WoodState {
  version: 1; owner: string; dimension: string; home: LocalPosition; chest: LocalPosition;
  pending: boolean; baseline: Record<string, number>; trail: LocalPosition[];
}
export interface WoodStore { load(): Promise<WoodState | null>; save(state: WoodState): Promise<void> }
export class FileWoodStore implements WoodStore {
  constructor(private readonly path = 'var/wood/state.json') {}
  async load(): Promise<WoodState | null> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('state_unavailable'); }
    if (raw.length > 32768) throw new Error('state_invalid');
    const s = JSON.parse(raw) as WoodState;
    if (s.version !== 1 || !/^[A-Za-z0-9_]{3,16}$/.test(s.owner) || typeof s.dimension !== 'string' ||
      !readLocalPosition(s.home) || !readLocalPosition(s.chest) || typeof s.pending !== 'boolean' ||
      !Array.isArray(s.trail) || s.trail.length > 64 || s.trail.some(p => !readLocalPosition(p)) ||
      !s.baseline || Object.entries(s.baseline).some(([k,v]) => !CARGO.has(k) || !Number.isInteger(v) || v < 0 || v > 2304)) throw new Error('state_invalid');
    return s;
  }
  async save(state: WoodState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(`${this.path}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${this.path}.tmp`, this.path);
  }
}
export function cargoCounts(bot: Bot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of bot.inventory.items()) if (CARGO.has(item.name)) counts[item.name] = (counts[item.name] ?? 0) + item.count;
  return counts;
}
export function cargoDelta(current: Record<string, number>, baseline: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(current).filter(([k,n]) => CARGO.has(k) && n > (baseline[k] ?? 0)).map(([k,n]) => [k, n - (baseline[k] ?? 0)]));
}
export function explorationPoints(home: LocalPosition): LocalPosition[] {
  return [6, 12, 18].flatMap(r => [[r,0],[0,r],[-r,0],[0,-r]].map(([x,z]) => ({ x: home.x+x, y: home.y, z: home.z+z })));
}
export interface WoodCheck { allowed: boolean; reason: string; logs: LocalPosition[] }
export class ForestryClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}
  async finish(bot: Bot): Promise<void> {
    const result=await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}/v1/forestry/check`,{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':this.apiKey},body:JSON.stringify({bot:bot.username,release:true}),signal:AbortSignal.timeout(3000)});
    if(!result.ok) throw new Error('guard_unavailable');
  }
  async check(bot: Bot, position: LocalPosition, grant = false): Promise<WoodCheck> {
    if (!this.baseUrl || !this.apiKey) throw new Error('guard_unavailable');
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}/v1/forestry/check`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': this.apiKey },
        body: JSON.stringify({ bot: bot.username, x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z), grant }), signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error('guard_unavailable');
      const result = await response.json() as WoodCheck;
      if (typeof result.allowed !== 'boolean' || !REASONS.has(result.reason) ||
        !Array.isArray(result.logs) || result.logs.length > 6 || result.logs.some(p => !readLocalPosition(p) || ![p.x,p.y,p.z].every(Number.isInteger) || Math.hypot(p.x-position.x,p.y-position.y,p.z-position.z)>8) ||
        (result.allowed && (result.reason !== 'natural_growth_verified' || result.logs.length === 0))) throw new Error('guard_invalid');
      return result;
    } catch { throw new Error('guard_unavailable'); }
  }
}
const messages: Record<string,string> = {
  operation_failed: '動作の完了を確認できなかったため止めました。所持品と経路を確認し、!wood return で帰還・収納してください。',
  unregistered: '帰還先が未登録です。Botを拠点へ連れて行き、!wood base x y z で近くの収納チェストを登録してください。',
  busy: '木材作業中です。!wood status で確認、!wood stop で停止できます。',
  pending: '前回の収集物が未整理です。!wood return で帰還・収納を先に行ってください。',
  guard_unavailable: '木の履歴・保護確認ができないため伐採を止めました。Bridgeの接続と対応版を確認してください。',
  chest_unavailable: '登録チェストを利用できません。収集物は投棄せず保持します。チェストを確認して !wood return で再試行してください。',
  storage_incomplete: '収納を完了できませんでした。残りは所持しています。チェストの空きを確保して !wood return で再試行してください。',
  route_unavailable: '帰還または接近経路を確保できません。所持品は投棄していません。通路を確認して !wood return で再試行してください。',
  stopped: '木材作業を停止しました。収集物は所持しています。!wood return で帰還・収納できます。',
  disconnected: '接続またはディメンションが変わったため停止しました。再接続後に所持品を確認し、!wood return を使ってください。',
  state_unavailable: '作業記録を読み書きできないため開始できません。記録ファイルを確認してください。',
  unhealthy: '体力・空腹に余裕がないため作業を止めました。回復後に !wood return で帰還・収納してください。',
  inventory_changed: '開始時より所持品が減っているため自動収納を止めました。死亡・紛失・手動移動の有無と所持品を確認してください。',
  inventory_unsupported: '特殊なデータ付きの木材等があるため自動処理を止めました。通常の収集物と分けてから再試行してください。',
  changed: '木や周囲の状態が変わったため伐採を止め、帰還します。',
};
export class WoodService {
  busy = false;
  private phase: Phase = 'idle';
  private stopped = false;
  private interrupted = false;
  private state: WoodState | null = null;
  private ready: Promise<void>;
  private stateError = false;
  constructor(private readonly deps: { owner: string; getBot: () => Bot | null; store: WoodStore; guard: Pick<ForestryClient, 'check'> & Partial<Pick<ForestryClient, 'finish'>> }) {
    this.ready = deps.store.load().then(s => { this.state = s; if(s?.pending) this.phase='blocked'; }).catch(() => { this.stateError=true; });
  }
  private say(bot: Bot, text: string) { if (this.deps.getBot()===bot) { try { bot.chat(text); } catch { /* 切断時は固定診断を残す。 */ } } }
  private report(bot: Bot, phase: Phase) { this.phase=phase; console.info('[WoodCollection]',{event:'phase',phase}); }
  private async save() { if(!this.state) throw new Error('unregistered'); await this.deps.store.save(this.state).catch(() => { throw new Error('state_unavailable'); }); }
  private valid(bot: Bot) { return !this.interrupted && this.deps.getBot()===bot && !!bot.entity && bot.game.dimension===this.state?.dimension; }
  private check(bot: Bot) { if(!this.valid(bot)) throw new Error('disconnected'); if(this.stopped) throw new Error('stopped'); if(bot.health<6 || bot.food<6) throw new Error('unhealthy'); }
  private chest(bot: Bot) {
    const block=this.state && bot.blockAt(new Vec3(this.state.chest.x,this.state.chest.y,this.state.chest.z));
    if(!block || block.name!=='chest' || block.getProperties().type!=='single') throw new Error('chest_unavailable');
    return block;
  }
  /** 認識した木材コマンドはPythonへ重複転送しない。非同期作業はbusyを同期的に獲得する。 */
  async handleChat(bot: Bot, username: string, text: string): Promise<boolean> {
    const message=text.trim();
    if(!message.startsWith('!wood') && message!=='木材を集めて') return false;
    if(!this.deps.owner || username!==this.deps.owner) { this.say(bot,'木材作業は設定済みの担当プレイヤーだけが操作できます。管理者に WOOD_OWNER の設定を確認してください。'); return true; }
    await this.ready;
    if(this.stateError || (this.state && this.state.owner!==username)) { this.say(bot,messages.state_unavailable);return true; }
    const parts=message==='木材を集めて' ? ['!wood','collect','16'] : message.split(/\s+/);
    if(parts[1]==='stop') { this.stopped=true; if(this.busy) { bot.clearControlStates();bot.stopDigging();if(bot.currentWindow)bot.closeWindow(bot.currentWindow); } this.say(bot,messages.stopped);return true; }
    if(parts[1]==='status') {
      const labels: Record<Phase,string>={idle:'待機中',searching:'探索中',harvesting:'伐採中',returning:'帰還中',depositing:'収納中',blocked:'途中停止'};
      this.say(bot,`木材作業: ${labels[this.phase]}。${this.state?.pending ? '帰還・収納が未完了です。' : '未収納の作業記録はありません。'} !wood return / !wood stop`);return true;
    }
    if(this.busy) { this.say(bot,messages.busy);return true; }
    if(parts[1]==='reset') {
      if(parts.length!==3 || parts[2]!=='confirm') { this.say(bot,'所持品を確認後、!wood reset confirm で作業記録を解除できます。収納は行わず、持ち物はそのまま残します。');return true; }
      this.busy=true;
      try { if(this.state) { this.state.pending=false;this.state.baseline={};this.state.trail=[];await this.save(); }this.phase='idle';this.say(bot,'作業記録を解除しました。収集物は収納していません。必要なら拠点を再登録してください。'); }
      catch { this.stateError=true;this.say(bot,messages.state_unavailable); }
      finally { this.busy=false; }return true;
    }
    if(parts[1]==='base') {
      if(this.state?.pending) { this.say(bot,messages.pending);return true; }
      const xyz=parts.slice(2).map(Number);
      if(parts.length!==5 || !xyz.every(Number.isInteger) || xyz.some(n => Math.abs(n)>30000000) || !bot.entity || bot.entity.position.distanceTo(new Vec3(xyz[0],xyz[1],xyz[2]))>4) { this.say(bot,'Botから4ブロック以内のチェストを !wood base x y z で指定してください。');return true; }
      this.busy=true;
      const previous=this.state;
      try {
        if(!new LocalTerrain(bot).standable(bot.entity.position)) throw new Error('route_unavailable');
        this.state={version:1,owner:username,dimension:bot.game.dimension,home:readLocalPosition(bot.entity.position)!,chest:{x:xyz[0],y:xyz[1],z:xyz[2]},pending:false,baseline:{},trail:[]};
        this.chest(bot);await this.save();this.say(bot,'帰還先と収納チェストを登録しました。!wood collect 16 で探索・収集を開始できます。');
      } catch { this.state=previous;this.say(bot,'登録できませんでした。足場・単独チェスト・記録先を確認してください。'); }
      finally { this.busy=false; }
      return true;
    }
    if(parts[1]!=='collect' && parts[1]!=='return') { this.say(bot,'!wood base x y z / !wood collect 16 / !wood return / !wood status / !wood stop');return true; }
    if(!this.state) { this.say(bot,messages.unregistered);return true; }
    if(parts[1]==='return' && !this.state.pending) { this.say(bot,'帰還・収納待ちの木材作業はありません。');return true; }
    if(parts[1]==='collect' && this.state.pending) { this.say(bot,messages.pending);return true; }
    const probe=acquireMovementControl(bot);
    if(!probe || bot.pathfinder?.isMoving?.() || bot.targetDigBlock) { probe?.();this.say(bot,'別の移動・採掘が実行中です。終了後に木材作業を開始してください。');return true; }
    probe();
    const amount=Number(parts[2] ?? 16);
    if(parts[1]==='collect' && (!Number.isInteger(amount)||amount<1||amount>64||parts.length>3)) { this.say(bot,'収集目標は1〜64個です。例: !wood collect 16');return true; }
    this.busy=true;this.stopped=false;this.interrupted=false;
    void this.run(bot,parts[1]==='collect',amount).catch(()=>{this.phase='blocked';console.warn('[WoodCollection]',{event:'cleanup_failed'});}).finally(() => { this.busy=false; });
    return true;
  }
  private async go(bot: Bot, target: LocalPosition, limit=25000, stopDistance=1.4) {
    this.check(bot);
    const result=await navigateLocally(bot,{stopDistance,deadlineAt:Date.now()+limit,current:()=>this.valid(bot)&&!this.stopped&&bot.health>=6&&bot.food>=6,target:async()=>({ok:true,position:target})});
    this.check(bot);if(!result.ok) throw new Error('route_unavailable');
  }
  private async run(bot: Bot, collect: boolean, amount: number) {
    const interrupt=()=>{this.interrupted=true;try {bot.clearControlStates();bot.stopDigging();} catch { /* 切断後の解除はbest effort。 */ }};
    bot.once('death',interrupt);bot.once('end',interrupt);
    try {
      this.check(bot);
      const state=this.state!;
      if(collect) {
        if(!ordinaryCargo(bot)) throw new Error('inventory_unsupported');
        if(bot.entity.position.distanceTo(new Vec3(state.home.x,state.home.y,state.home.z))>4) throw new Error('route_unavailable');
        // 出発前に開けることと空きを確認する。既存内容は移動しない。
        const destination=this.chest(bot);
        const release=acquireMovementControl(bot);if(!release) throw new Error('busy');
        let preview: Awaited<ReturnType<Bot['openContainer']>> | null=null;
        try {
          preview=await bounded(bot.openContainer(destination),5000,()=>{if(bot.currentWindow)bot.closeWindow(bot.currentWindow);});
          if(preview.firstEmptyContainerSlot()===null) throw new Error('chest_unavailable');
        } finally { preview?.close();release(); }
        this.check(bot);
        state.pending=true;state.baseline=cargoCounts(bot);state.trail=[readLocalPosition(bot.entity.position)!];await this.save();
        this.say(bot,'自然成長の履歴と周囲を確認しながら木材を探索します。判定できない木は伐採しません。!wood stop で停止できます。');
        const deadline=Date.now()+180000;
        let harvested=0;
        const seen=new Set<string>();
        for(const target of [state.home,...explorationPoints(state.home)]) {
          this.check(bot);
          if(Date.now()>=deadline || bot.health<12 || bot.food<12 || bot.inventory.emptySlotCount()<3 || harvested>=amount || state.trail.length>=60) break;
          this.report(bot,'searching');
          try { await this.go(bot,target); } catch(e) { this.check(bot);continue; }
          state.trail.push(readLocalPosition(bot.entity.position)!);await this.save();
          const candidates=bot.findBlocks({matching:b=>LOGS.has(b.name),maxDistance:10,count:24});
          for(const candidate of candidates) {
            if(seen.has(candidate.toString()) || Date.now()>=deadline || bot.inventory.emptySlotCount()<3 || state.trail.length>=60) continue;
            seen.add(candidate.toString());this.check(bot);
            const check=await this.deps.guard.check(bot,candidate);
            if(!check.allowed) { console.info('[WoodCollection]',{event:'candidate_skipped',reason:check.reason});continue; }
            check.logs.forEach(p=>seen.add(new Vec3(p.x,p.y,p.z).toString()));
            if(check.logs.length>amount-harvested) continue;
            harvested+=check.logs.length;
            await this.harvest(bot,check.logs);
            await this.pickup(bot,check.logs[check.logs.length-1]);
            await this.save();
            if(harvested>=amount) break;
          }
        }
      }
      await this.returnAndStore(bot);
    } catch(error) {
      const wasCollecting=['searching','harvesting'].includes(this.phase);
      const reason=this.stopped ? 'stopped' : error instanceof Error && Object.hasOwn(messages,error.message) ? error.message : this.phase==='depositing' ? 'storage_incomplete' : 'operation_failed';
      this.report(bot,'blocked');console.info('[WoodCollection]',{event:'stopped',reason});this.say(bot,messages[reason]);
      // 停止・切断以外の収集失敗では帰還を試みる。失敗時は再操作用記録を保持する。
      if(collect && wasCollecting && !this.stopped && this.valid(bot) && this.state?.pending && ['changed','guard_unavailable','route_unavailable','storage_incomplete','operation_failed'].includes(reason)) {
        try { await this.returnAndStore(bot); } catch { this.report(bot,'blocked');this.say(bot,messages.route_unavailable); }
      }
    } finally {
      bot.removeListener('death',interrupt);bot.removeListener('end',interrupt);
      if(this.deps.getBot()===bot) { bot.stopDigging();bot.clearControlStates(); }
      await this.deps.guard.finish?.(bot).catch(()=>{console.warn('[WoodCollection]',{event:'guard_release_failed'});this.say(bot,'伐採用の安全制御を解除できませんでした。Bridge接続を確認してください。');});
    }
  }
  private async harvest(bot: Bot, logs: LocalPosition[]) {
    const bottom=logs[logs.length-1];
    const terrain=new LocalTerrain(bot);
    const adjacent=[[1,0],[-1,0],[0,1],[0,-1]].flatMap(([x,z])=>terrain.surfaces(bottom.x+x+.5,bottom.z+z+.5,bottom.y));
    if(!adjacent.length) throw new Error('route_unavailable');
    let arrived=false;
    for(const p of adjacent) { try { await this.go(bot,p);arrived=true;break; } catch { this.check(bot); } }
    if(!arrived) throw new Error('route_unavailable');
    this.state!.trail.push(readLocalPosition(bot.entity.position)!);await this.save();this.report(bot,'harvesting');
    const release=acquireMovementControl(bot);if(!release) throw new Error('busy');
    try {
      for(const p of logs) {
        this.check(bot);const b=bot.blockAt(new Vec3(p.x,p.y,p.z));
        if(!b || !LOGS.has(b.name) || !bot.canDigBlock(b) || !bot.canSeeBlock(b)) throw new Error('changed');
        const check=await this.deps.guard.check(bot,p,true);this.check(bot);
        if(!check.allowed) throw new Error('changed');
        await bounded(bot.dig(b,true),10000,()=>bot.stopDigging());this.check(bot);
        if(bot.blockAt(b.position)?.name===b.name) throw new Error('changed');
      }
    } finally { bot.stopDigging();release(); }
  }
  private async pickup(bot: Bot, root: LocalPosition) {
    // 原木破壊直後の落下を待ってから、観測できた近傍itemへ基本操作で近づく。
    await bounded(bot.waitForTicks(20),2000,()=>{});this.check(bot);
    await this.go(bot,{x:root.x+.5,y:root.y,z:root.z+.5},25000,.35);
    for(const e of Object.values(bot.entities).filter(e=>e.name==='item' && e.position.distanceTo(bot.entity.position)<4).slice(0,8)) {
      try { await this.go(bot,readLocalPosition(e.position)!,10000,.35); } catch { this.check(bot); }
    }
    await bounded(bot.waitForTicks(10),1500,()=>{});
  }
  private async returnAndStore(bot: Bot) {
    const state=this.state!;this.report(bot,'returning');this.say(bot,'収集を終え、登録拠点へ帰還します。');
    const deadline=Date.now()+180000;
    for(const p of [...state.trail].reverse()) { if(Date.now()>=deadline) throw new Error('route_unavailable');await this.go(bot,p,Math.min(25000,deadline-Date.now())); }
    if(Date.now()>=deadline) throw new Error('route_unavailable');
    await this.go(bot,state.home,Math.min(25000,deadline-Date.now()));this.check(bot);
    const inventory=cargoCounts(bot);
    if(!ordinaryCargo(bot)) throw new Error('inventory_unsupported');
    if(Object.entries(state.baseline).some(([name,count])=>(inventory[name]??0)<count)) throw new Error('inventory_changed');
    this.report(bot,'depositing');
    const b=this.chest(bot);if(b.position.distanceTo(bot.entity.position)>4) throw new Error('chest_unavailable');
    const release=acquireMovementControl(bot);if(!release) throw new Error('busy');
    let chest: Awaited<ReturnType<Bot['openContainer']>> | null=null;
    let stored=0;
    try {
      chest=await bounded(bot.openContainer(b),5000,()=>{if(bot.currentWindow) bot.closeWindow(bot.currentWindow);});
      for(const [name,count] of Object.entries(cargoDelta(cargoCounts(bot),state.baseline))) {
        this.check(bot);this.chest(bot);
        const item=bot.inventory.items().find(i=>i.name===name);if(!item) throw new Error('storage_incomplete');
        const before=cargoCounts(bot)[name] ?? 0;
        await bounded(chest.deposit(item.type,null,count),5000,()=>chest?.close());
        const after=cargoCounts(bot)[name] ?? 0;
        if(before-after!==count) throw new Error('storage_incomplete');
        stored+=count;await this.save();
      }
      if(Object.keys(cargoDelta(cargoCounts(bot),state.baseline)).length) throw new Error('storage_incomplete');
      state.pending=false;state.trail=[];await this.save();this.report(bot,'idle');
      this.say(bot,stored>0 ? `帰還し、収集物${stored}個を登録チェストに収納しました。` : '帰還しました。今回収納できる収集物はありません。履歴不明の木は伐採していません。');
    } finally { chest?.close();release(); }
  }
}
async function bounded<T>(operation: Promise<T>, ms: number, cancel: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let expired=false;
  void operation.then(()=>{if(expired) cancel();},()=>{}).catch(()=>{});
  try { return await Promise.race([operation,new Promise<never>((_,reject)=> { timer=setTimeout(()=>{expired=true;try {cancel();} finally {reject(new Error('storage_incomplete'));}},ms); })]); }
  finally { clearTimeout(timer!); }
}
