import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { WoodService, ForestryClient, cargoDelta, explorationPoints, type WoodState } from '../runtime/forestry.js';
import { physicsFixture } from './localNavigationFixture.js';
import { navigateLocally } from '../runtime/localNavigation.js';
import { acquireMovementControl } from '../runtime/movementControl.js';
vi.mock('../runtime/localNavigation.js', async original => ({ ...await original<typeof import('../runtime/localNavigation.js')>(),
  navigateLocally: vi.fn(async (bot, options) => { const t=await options.target();bot.entity.position.set(t.position.x,t.position.y,t.position.z);return {ok:true}; }) }));
afterEach(()=>vi.clearAllMocks());
function fixture(pending=false) {
  const f=physicsFixture(p=>p.x===2&&p.z===0&&p.y===64?'chest':p.y<64?'dirt':p.x===4&&p.z===0&&p.y>=64&&p.y<=66?'oak_log':'air');
  let items=[{name:'oak_log',type:1,count:5},{name:'iron_axe',type:2,count:1}];
  const saves: WoodState[]=[];
  const state:WoodState={version:1,owner:'player',dimension:'overworld',home:{x:.5,y:64,z:.5},chest:{x:2,y:64,z:0},pending,baseline:{oak_log:5},trail:[]};
  const deposited:number[]=[];
  const close=vi.fn();
  const deposit=vi.fn(async (_type:number,_meta:unknown,n:number)=>{items[0].count-=n;deposited.push(n);});
  Object.assign(f.bot,{username:'helper',health:20,food:20,chat:vi.fn(),
    inventory:{items:()=>items,emptySlotCount:()=>30},findBlocks:vi.fn(()=>[new Vec3(4,64,0)]),
    canDigBlock:()=>true,canSeeBlock:()=>true,stopDigging:vi.fn(),waitForTicks:async()=>{},
    dig:vi.fn(async()=>{items[0].count++;}),openContainer:vi.fn(async()=>({deposit,close,firstEmptyContainerSlot:()=>0})),
  });
  const originalBlock=f.blockAt.getMockImplementation()!;
  const removed=new Set<string>();
  f.blockAt.mockImplementation((p:Vec3)=>removed.has(p.toString())?originalBlock(new Vec3(100,70,100)):originalBlock(p));
  vi.mocked(f.bot.dig).mockImplementation(async b=>{removed.add(b.position.toString());items[0].count++;});
  const guard={check:vi.fn(async()=>({allowed:true,reason:'natural_growth_verified',logs:[{x:4,y:66,z:0},{x:4,y:65,z:0},{x:4,y:64,z:0}]}))};
  const store={load:async()=>structuredClone(state),save:vi.fn(async s=>{saves.push(structuredClone(s));})};
  const service=new WoodService({owner:'player',getBot:()=>f.bot,store,guard});
  return {...f,service,guard,store,saves,deposit,deposited,items,close};
}
async function finish(f:ReturnType<typeof fixture>) { await vi.waitFor(()=>expect(f.service.busy).toBe(false)); }
describe('safe forestry workflow',()=>{
  it('既存所持品を残し新規収集分だけを収納する',async()=>{
    const f=fixture();await f.service.handleChat(f.bot,'player','!wood collect 3');await finish(f);
    expect(f.bot.dig).toHaveBeenCalledTimes(3);expect(f.deposited).toEqual([3]);expect(f.items[0].count).toBe(5);expect(f.items[1].count).toBe(1);
    expect(f.saves.at(-1)?.pending).toBe(false);expect(f.close).toHaveBeenCalled();
  });
  it('由来不明の木は掘らず探索後に帰還する',async()=>{
    const f=fixture();f.guard.check.mockResolvedValue({allowed:false,reason:'origin_unknown',logs:[]});
    await f.service.handleChat(f.bot,'player','!wood collect 3');await finish(f);
    expect(f.bot.dig).not.toHaveBeenCalled();expect(f.deposit).not.toHaveBeenCalled();expect(f.saves.at(-1)?.pending).toBe(false);
  });
  it('破壊直前の許可拒否は掘削へ進まない',async()=>{
    const f=fixture();f.guard.check.mockResolvedValueOnce({allowed:true,reason:'natural_growth_verified',logs:[{x:4,y:66,z:0},{x:4,y:65,z:0},{x:4,y:64,z:0}]}).mockResolvedValue({allowed:false,reason:'building_suspected',logs:[]});
    await f.service.handleChat(f.bot,'player','!wood collect 3');await finish(f);expect(f.bot.dig).not.toHaveBeenCalled();
  });
  it('収納が途中で失敗しても残量を保持し次回は残量だけを送る',async()=>{
    const f=fixture(true);f.items[0].count=8;
    f.deposit.mockImplementationOnce(async()=>{f.items[0].count-=1;throw new Error('full');});
    await f.service.handleChat(f.bot,'player','!wood return');await finish(f);
    expect(f.items[0].count).toBe(7);expect(f.saves.at(-1)?.pending??true).toBe(true);
    await f.service.handleChat(f.bot,'player','!wood return');await finish(f);
    expect(f.deposited).toEqual([2]);expect(f.items[0].count).toBe(5);
  });
  it('再起動で未収納作業を読み込んだ場合は新規収集を拒否する',async()=>{
    const f=fixture(true);await f.service.handleChat(f.bot,'player','!wood collect 3');expect(f.service.busy).toBe(false);expect(f.bot.findBlocks).not.toHaveBeenCalled();
  });
  it('担当者以外と範囲外件数を拒否する',async()=>{
    const f=fixture();await f.service.handleChat(f.bot,'other','!wood collect 3');await f.service.handleChat(f.bot,'player','!wood collect 100');
    expect(f.bot.findBlocks).not.toHaveBeenCalled();
  });
  it('帰路を確保できなければ収納成功にせず所持品を保持する',async()=>{
    const f=fixture(true);f.items[0].count=8;vi.mocked(navigateLocally).mockResolvedValueOnce({ok:false,error:'rendezvous_no_path'});
    await f.service.handleChat(f.bot,'player','!wood return');await finish(f);expect(f.deposit).not.toHaveBeenCalled();expect(f.items[0].count).toBe(8);
  });
  it('チェスト消失で別のチェストを選ばない',async()=>{
    const f=fixture(true);f.items[0].count=8;f.blockAt.mockReturnValue(null);
    await f.service.handleChat(f.bot,'player','!wood return');await finish(f);expect(f.bot.openContainer).not.toHaveBeenCalled();expect(f.items[0].count).toBe(8);
  });
  it('通常のチャットは専用処理へ取り込まない',async()=>{
    const f=fixture();expect(await f.service.handleChat(f.bot,'player','come here')).toBe(false);
  });
  it('作業記録がない帰還指示では無関係の増加分を収納しない',async()=>{
    const f=fixture();f.items[0].count=20;await f.service.handleChat(f.bot,'player','!wood return');expect(f.deposit).not.toHaveBeenCalled();
  });
  it('死亡・切断後は収納処理を継続しない',async()=>{
    const f=fixture(true);f.items[0].count=8;
    vi.mocked(navigateLocally).mockImplementationOnce(async()=>{f.bot.emit('death');return {ok:true};});
    await f.service.handleChat(f.bot,'player','!wood return');await finish(f);expect(f.deposit).not.toHaveBeenCalled();expect(f.items[0].count).toBe(8);
  });
  it('停止は実行中の掘削を解除して新規掘削を止める',async()=>{
    const f=fixture();let resolve:()=>void=()=>{};
    f.guard.check.mockImplementationOnce(()=>new Promise(r=>{resolve=()=>r({allowed:true,reason:'natural_growth_verified',logs:[{x:4,y:66,z:0},{x:4,y:65,z:0},{x:4,y:64,z:0}]});}));
    await f.service.handleChat(f.bot,'player','!wood collect 3');await vi.waitFor(()=>expect(f.guard.check).toHaveBeenCalled());
    await f.service.handleChat(f.bot,'player','!wood stop');resolve();await finish(f);expect(f.bot.dig).not.toHaveBeenCalled();expect(f.bot.stopDigging).toHaveBeenCalled();
  });
  it('開始時の所持品が減っている場合は自動収納を止める',async()=>{
    const f=fixture(true);f.items[0].count=2;await f.service.handleChat(f.bot,'player','!wood return');await finish(f);expect(f.deposit).not.toHaveBeenCalled();
  });
  it('特殊データ付きの木材を通常木材と混同して格納しない',async()=>{
    const f=fixture(true);f.items[0].count=8;Object.assign(f.items[0],{nbt:{customName:'example'}});
    await f.service.handleChat(f.bot,'player','!wood return');await finish(f);expect(f.deposit).not.toHaveBeenCalled();
  });
  it('チェストのclose失敗でも操作所有権を解放する',async()=>{
    const f=fixture(true);f.items[0].count=8;f.close.mockImplementation(()=>{throw new Error('closed');});
    await f.service.handleChat(f.bot,'player','!wood return');await finish(f);
    expect(f.saves.at(-1)?.pending).toBe(true);
    const release=acquireMovementControl(f.bot);expect(release).not.toBeNull();release?.();
  });
  it('記録解除は明示確認が必要で物品を変更しない',async()=>{
    const f=fixture(true);await f.service.handleChat(f.bot,'player','!wood reset');expect(f.saves).toHaveLength(0);
    await f.service.handleChat(f.bot,'player','!wood reset confirm');expect(f.saves.at(-1)?.pending).toBe(false);expect(f.deposit).not.toHaveBeenCalled();expect(f.items[0].count).toBe(5);
  });
  it('差分は許可した収集物だけ・探索は有限',()=>{
    expect(cargoDelta({oak_log:8,iron_axe:2},{oak_log:5})).toEqual({oak_log:3});
    expect(explorationPoints({x:0,y:64,z:0})).toHaveLength(12);
  });
});
describe('forestry contract fail closed',()=>{
  it.each([{allowed:false,reason:'origin_unknown',logs:[]},{allowed:true,reason:'natural_growth_verified',logs:[]}])('空の許可や未知を自然木へ変換しない',async result=>{
    const fetcher=vi.fn(async()=>({ok:true,json:async()=>result}));
    const c=new ForestryClient('https://bridge.invalid','example-key',fetcher as unknown as typeof fetch);
    const f=fixture();
    if(result.allowed) await expect(c.check(f.bot,{x:4,y:64,z:0})).rejects.toThrow('guard_unavailable');
    else expect((await c.check(f.bot,{x:4,y:64,z:0})).allowed).toBe(false);
  });
});
