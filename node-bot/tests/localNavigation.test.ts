import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { LocalTerrain, planLocalRoute, navigateLocally, walkLocalStep } from '../runtime/localNavigation.js';
import { drive, physicsFixture } from './localNavigationFixture.js';
import { acquireMovementControl } from '../runtime/movementControl.js';
import { createVptCommandHandlers } from '../runtime/commands/vptCommands.js';

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'info').mockImplementation(() => undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('local terrain and own route search', () => {
  it('壁を迂回する経路を自前で探索する', () => {
    const f = physicsFixture(p => p.y < 64 || (p.x === 2 && Math.abs(p.z) < 3 && p.y < 67) ? 'stone' : 'air');
    const route = planLocalRoute(new LocalTerrain(f.bot), f.entity.position, f.target.position, 1);
    expect(route.reached).toBe(true);
    expect(route.path.some(p => Math.abs(p.z) >= 3)).toBe(true);
    expect(f.bot.pathfinder.goto).not.toHaveBeenCalled();
  });

  it.each(['water', 'lava', 'magma_block', 'cactus', 'powder_snow'])('%sを避ける', name => {
    const f = physicsFixture(p => p.x === 2 && p.y === 63 ? name : p.y < 64 ? 'stone' : 'air');
    const route = planLocalRoute(new LocalTerrain(f.bot), f.entity.position, f.target.position, 1);
    expect(route.path.every(p => Math.floor(p.x) !== 2)).toBe(true);
    expect(route.reached).toBe(false);
  });

  it('未ロードと2段落下を通路と推定しない', () => {
    for (const missing of [true, false]) {
      const f = physicsFixture(p => p.x === 2 ? (missing ? null : p.y < 61 ? 'stone' : 'air') : p.y < 64 ? 'stone' : 'air');
      const route = planLocalRoute(new LocalTerrain(f.bot), f.entity.position, f.target.position, 1);
      expect(route.reached).toBe(false);
      expect(route.path.every(p => Math.floor(p.x) !== 2)).toBe(true);
    }
  });

  it('実ブロックのハーフ床と階段collision shapeから高さを得る', () => {
    const f = physicsFixture(p => p.y === 64 && p.x === 1 ? 'stone_slab' : p.y === 64 && p.x === 2 ? 'oak_stairs' : p.y < 64 ? 'stone' : 'air');
    const t = new LocalTerrain(f.bot);
    expect(t.surfaces(1.5, 0.5, 64).some(p => p.y === 64.5)).toBe(true);
    expect(t.surfaces(2.5, 0.5, 64.5).some(p => p.y === 65)).toBe(true);
  });

  it('低い天井の下では一段ジャンプを計画しない', () => {
    const f = physicsFixture(p => p.y < 64 || p.y === 66 || (p.x === 1 && p.y === 64) ? 'stone' : 'air');
    expect(new LocalTerrain(f.bot).edgeClear({ x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 65, z: 0.5 })).toBe(false);
  });

  it('waterloggedとcollision shape欠損は通行可能にしない', () => {
    const f = physicsFixture();
    f.blockAt.mockImplementation(() => ({ name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ waterlogged: true }) }));
    expect(new LocalTerrain(f.bot).standable(f.entity.position)).toBe(false);
    f.blockAt.mockImplementation(() => ({ name: 'air' }));
    const terrain = new LocalTerrain(f.bot);
    expect(terrain.clearBody(f.entity.position)).toBe(false);
    expect(terrain.unknown).toBe(true);
  });

  it('遠い対象には観測範囲内の前縁までの経路を返す', () => {
    const f = physicsFixture();
    const route = planLocalRoute(new LocalTerrain(f.bot), f.entity.position, { x: 100, y: 64, z: 0.5 }, 2);
    expect(route.reached).toBe(false);
    expect(route.path.length).toBeGreaterThan(0);
    expect(route.path.every(p => Math.abs(p.x - 0.5) <= 12)).toBe(true);
    expect(route.expanded).toBeLessThanOrEqual(2048);
  });
});

describe('basic controls with installed Minecraft physics', () => {
  it.each([0, 1, -1])('平地・上り・下り(%s)をgotoなしで一歩進み入力を解除する', async rise => {
    const f = physicsFixture(p => p.y < 64 + (p.x >= 1 ? rise : 0) ? 'stone' : 'air');
    const result = await drive(walkLocalStep(f.bot, { x: 1.5, y: 64 + rise, z: 0.5 }, Date.now() + 10000, () => true), f);
    expect(result).toBe('arrived');
    expect(f.bot.entity.position.distanceTo(new Vec3(1.5, 64 + rise, 0.5))).toBeLessThan(0.35);
    expect(Object.values(f.control).every(v => !v)).toBe(true);
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    expect(f.bot.pathfinder.goto).not.toHaveBeenCalled();
  });

  it('実物理で壁を迂回し最新対象の近傍へ到達する', async () => {
    const f = physicsFixture(p => p.y < 64 || (p.x === 2 && Math.abs(p.z) < 2 && p.y < 67) ? 'stone' : 'air');
    const result = await drive(navigateLocally(f.bot, { stopDistance: 1, deadlineAt: Date.now() + 60000,
      current: () => true, target: async () => ({ ok: true, position: f.target.position.clone() }) }), f);
    expect(result).toEqual({ ok: true });
    expect(f.bot.entity.position.distanceTo(f.target.position)).toBeLessThanOrEqual(1);
    expect(f.bot.pathfinder.goto).not.toHaveBeenCalled();
  });

  it('cell中心以外からも中心への調整を探索して進む', async () => {
    const f = physicsFixture();
    f.entity.position.set(0.01, 64, 0.01);
    const result = await drive(navigateLocally(f.bot, { stopDistance: 1, deadlineAt: Date.now() + 60000,
      current: () => true, target: async () => ({ ok: true, position: f.target.position.clone() }) }), f);
    expect(result).toEqual({ ok: true });
    expect(f.bot.entity.position.distanceTo(f.target.position)).toBeLessThanOrEqual(1);
  });

  it('通行直前に地形が変われば入力を解除する', async () => {
    let changed = false;
    const f = physicsFixture(p => changed && p.x === 1 && p.y === 64 ? 'lava' : p.y < 64 ? 'stone' : 'air');
    const result = await drive(walkLocalStep(f.bot, { x: 1.5, y: 64, z: 0.5 }, Date.now() + 10000, () => true), f, i => { if (i === 1) changed = true; });
    expect(result).toBe('changed');
    expect(Object.values(f.control).every(v => !v)).toBe(true);
  });

  it('physics tickが止まっても有限時間で終了してlistenerを残さない', async () => {
    const f = physicsFixture();
    const result = walkLocalStep(f.bot, { x: 1.5, y: 64, z: 0.5 }, Date.now() + 10000, () => true);
    await vi.advanceTimersByTimeAsync(501);
    expect(await result).toBe('physics_stalled');
    expect(Object.values(f.control).every(v => !v)).toBe(true);
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
    expect(f.bot.listenerCount('end')).toBe(0);
  });

  it('動かない入力を30秒待たず詰まりとして返す', async () => {
    const f = physicsFixture();
    f.simulate = () => { f.bot.emit('physicsTick'); };
    const started = Date.now();
    const result = await drive(walkLocalStep(f.bot, { x: 1.5, y: 64, z: 0.5 }, Date.now() + 10000, () => true), f);
    expect(result).toBe('stuck');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(Object.values(f.control).every(v => !v)).toBe(true);
  });

  it('実collision shapeのハーフ床と階段を連続して上る', async () => {
    const f = physicsFixture(p => {
      if (p.z !== 0 && p.y < 68) return 'stone';
      if (p.x === 1 && p.y === 64) return 'stone_slab';
      if (p.x === 2 && p.y === 64) return 'oak_stairs';
      return p.y < (p.x >= 3 ? 65 : 64) ? 'stone' : 'air';
    });
    f.target.position.set(5.5, 65, 0.5);
    const result = await drive(navigateLocally(f.bot, { stopDistance: 1, deadlineAt: Date.now() + 60000,
      current: () => true, target: async () => ({ ok: true, position: f.target.position.clone() }) }), f);
    expect(result).toEqual({ ok: true });
    expect(f.bot.entity.position.distanceTo(f.target.position)).toBeLessThanOrEqual(1);
  });

  it('歩き始めに新しい障害物が現れたら再観測して別経路から到達する', async () => {
    let changed = false;
    const f = physicsFixture(p => p.y < 64 || (changed && p.x === 1 && p.z === 0 && p.y < 67) ? 'stone' : 'air');
    const result = await drive(navigateLocally(f.bot, { stopDistance: 1, deadlineAt: Date.now() + 60000,
      current: () => true, target: async () => ({ ok: true, position: f.target.position.clone() }) }), f,
      i => { if (i === 1) changed = true; });
    expect(result).toEqual({ ok: true });
    expect(console.info).toHaveBeenCalledWith('[LocalNavigation]', expect.objectContaining({ event: 'replan', reason: 'changed' }));
  });

  it('競合する移動とVPTの入力を奪わず拒否する', async () => {
    const f = physicsFixture();
    const release = acquireMovementControl(f.bot)!;
    const result = await navigateLocally(f.bot, { stopDistance: 1, deadlineAt: Date.now() + 10000,
      current: () => true, target: async () => ({ ok: true, position: f.target.position }) });
    expect(result).toEqual({ ok: false, error: 'rendezvous_busy' });
    expect(f.bot.clearControlStates).not.toHaveBeenCalled();
    const vpt = createVptCommandHandlers({ getActiveBot: () => f.bot, vptCommandsEnabled: true,
      vptTickIntervalMs: 50, vptMaxSequenceLength: 20, buildGeneralStatusSnapshot: vi.fn(),
      buildHotbarSnapshot: vi.fn(), computeNavigationHint: vi.fn() });
    expect(await vpt.handlePlayVptActionsCommand({ actions: [{ kind: 'control', control: 'forward', state: true, durationTicks: 2 }] })).toEqual({ ok: false, error: 'navigation_busy' });
    expect(f.bot.clearControlStates).not.toHaveBeenCalled();
    release();
    const newer = acquireMovementControl(f.bot)!;
    release();
    expect(acquireMovementControl(f.bot)).toBeNull();
    newer();
    const final = acquireMovementControl(f.bot);
    expect(final).not.toBeNull();
    final!();
  });
});
