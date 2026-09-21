// 日本語コメント：NavigationController の異常系挙動を集中的に検証するユニットテスト
// 役割：座標バリデーションと Bot 未接続時の扱い、強制移動記録のレート制御を安全に確認する
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from 'mineflayer';
import { drive, physicsFixture } from './localNavigationFixture.js';
import type { Movements as MovementsClass } from 'mineflayer-pathfinder';

import {
  NavigationController,
  RENDEZVOUS_ERROR_CODES,
} from '../runtime/navigationController.js';
import type { PlayerPositionBridgeClient } from '../runtime/playerPositionBridge.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * 実際の mineflayer へ依存せずに pathfinder を模倣するための極小モック。
 * コマンド実行フローが bot オブジェクトへアクセスした際にクラッシュしないよう、必要最低限の構造を持たせている。
 */
function createFakeBot(): Bot {
  const fakeMovements = createFakeMovements();
  return {
    entity: {
      position: { x: 0, y: 0, z: 0 },
    },
    pathfinder: {
      goto: vi.fn(),
      setMovements: vi.fn(),
      movements: fakeMovements,
    },
  } as unknown as Bot;
}

/**
 * Movements クラスの形状だけを満たす素朴なモック。
 * NavigationController が移動プロファイルを設定する際にも型エラーが発生しないようにするための保険として用意。
 */
function createFakeMovements(): MovementsClass {
  return {} as MovementsClass;
}

/**
 * テストごとに同じ設定値で NavigationController を初期化する補助関数。
 * 強制移動のリトライ閾値など、実装で利用する定数をテスト環境でも再現性高く扱うためにまとめている。
 */
function createController(): NavigationController {
  return new NavigationController({
    moveGoalToleranceMeters: 2,
    forcedMoveRetryWindowMs: 2_000,
    forcedMoveMaxRetries: 2,
    forcedMoveRetryDelayMs: 300,
    pathfinder: {
      allowParkour: true,
      allowSprinting: true,
      digCost: { enable: 1, disable: 96 },
    },
  });
}

describe('NavigationController recordForcedMove', () => {
  it('短時間に連続して記録された場合は二重ログを抑制する', () => {
    const controller = createController();

    const firstLog = controller.recordForcedMove(1_000);
    const secondLog = controller.recordForcedMove(1_500);
    const thirdLog = controller.recordForcedMove(2_200);

    expect(firstLog).toBe(true);
    expect(secondLog).toBe(false);
    expect(thirdLog).toBe(true);
  });
});

describe('NavigationController handleMoveToCommand (abnormal)', () => {
  it('無効な座標が渡された場合は即座に失敗し、Bot は参照しない', async () => {
    const controller = createController();
    const fakeBot = createFakeBot();
    const getActiveBot = vi.fn(() => fakeBot);

    const response = await controller.handleMoveToCommand({ x: 'nan', y: 2, z: 3 }, { getActiveBot });

    expect(response.ok).toBe(false);
    expect(response.error).toBe('Invalid coordinates');
    expect(getActiveBot).not.toHaveBeenCalled();
    expect(controller.getLastMoveTarget()).toBeNull();
  });

  it('Bot が未接続の場合は安全に拒否する', async () => {
    const controller = createController();
    const getActiveBot = vi.fn<() => Bot | null>(() => null);

    const response = await controller.handleMoveToCommand({ x: 1, y: 64, z: 1 }, { getActiveBot });

    expect(response.ok).toBe(false);
    expect(response.error).toBe('Bot is not connected to the Minecraft server yet');
    expect(controller.getLastMoveTarget()).toBeNull();
    expect(getActiveBot).toHaveBeenCalledTimes(1);
  });
});

describe('NavigationController own local rendezvous', () => {
  const options = { target: 'player', stopDistance: 1, maintainLineOfSight: true };
  function controller(extra: { rendezvousDeadlineMs?: number; playerPositionBridge?: Pick<PlayerPositionBridgeClient, 'lookup'> } = {}) {
    return new NavigationController({ moveGoalToleranceMeters: 2, forcedMoveRetryWindowMs: 2000,
      forcedMoveMaxRetries: 0, forcedMoveRetryDelayMs: 0,
      pathfinder: { allowParkour: false, allowSprinting: false, digCost: { enable: 1, disable: 96 } }, ...extra });
  }
  it('pathfinderが存在しなくても基本操作で話者に到達する', async () => {
    vi.useFakeTimers();
    const f = physicsFixture();
    delete (f.bot as unknown as { pathfinder?: unknown }).pathfinder;
    const result = await drive(controller().handleFollowPlayerCommand(options, { getActiveBot: () => f.bot }), f);
    expect(result).toEqual({ ok: true });
    expect(f.bot.entity.position.distanceTo(f.target.position)).toBeLessThanOrEqual(1);
    expect(Object.values(f.control).every(Boolean)).toBe(false);
  });
  it.each([
    [{ ...options, target: ' bad ' }, 'rendezvous_target_invalid'],
    [{ ...options, stopDistance: 0 }, 'rendezvous_invalid_args'],
    [{ ...options, maintainLineOfSight: false }, 'rendezvous_line_of_sight_unsupported'],
  ])('無効な入力は操作前に拒否する', async (args, error) => {
    const getActiveBot = vi.fn();
    expect(await controller().handleFollowPlayerCommand(args, { getActiveBot })).toEqual({ ok: false, error });
    expect(getActiveBot).not.toHaveBeenCalled();
  });
  it('接続前と対象不在を固定エラーで返す', async () => {
    expect(await controller().handleFollowPlayerCommand(options, { getActiveBot: () => null })).toEqual({ ok: false, error: 'rendezvous_bot_unavailable' });
    const f = physicsFixture(); f.bot.players = {};
    expect(await controller().handleFollowPlayerCommand(options, { getActiveBot: () => f.bot })).toEqual({ ok: false, error: 'rendezvous_target_unavailable' });
    expect(f.bot.setControlState).not.toHaveBeenCalled();
  });
  it('対象名とentityの不一致を拒否する', async () => {
    const f = physicsFixture(); f.target.username = 'other';
    expect(await controller().handleFollowPlayerCommand(options, { getActiveBot: () => f.bot })).toEqual({ ok: false, error: 'rendezvous_target_unavailable' });
  });
  it.each(['nether', 'unknown'])('dimension不一致・不明(%s)を拒否する', async dimension => {
    const f = physicsFixture(); f.bot.players = {};
    const lookup = vi.fn(async () => ({ position: { x: 4, y: 64, z: 0 }, dimension, observedAt: Date.now() }));
    const result = await controller({ playerPositionBridge: { lookup } }).handleFollowPlayerCommand(options, { getActiveBot: () => f.bot });
    expect(result).toEqual({ ok: false, error: dimension === 'unknown' ? 'rendezvous_dimension_unknown' : 'rendezvous_dimension_mismatch' });
    expect(f.bot.setControlState).not.toHaveBeenCalled();
  });
  it('Bridgeのofflineと照会障害を区別する', async () => {
    for (const kind of ['not_found', 'unavailable']) {
      const f = physicsFixture(); f.bot.players = {};
      const lookup = vi.fn(async () => { throw { kind }; });
      const result = await controller({ playerPositionBridge: { lookup } }).handleFollowPlayerCommand(options, { getActiveBot: () => f.bot });
      expect(result).toEqual({ ok: false, error: kind === 'not_found' ? 'rendezvous_target_offline' : 'rendezvous_position_service_unavailable' });
    }
  });
  it('未解消のBridge照会にも全体期限を適用する', async () => {
    vi.useFakeTimers();
    const f = physicsFixture(); f.bot.players = {};
    const lookup = vi.fn(() => new Promise<never>(() => undefined));
    const command = controller({ rendezvousDeadlineMs: 20, playerPositionBridge: { lookup } }).handleFollowPlayerCommand(options, { getActiveBot: () => f.bot });
    await vi.advanceTimersByTimeAsync(21);
    expect(await command).toEqual({ ok: false, error: 'rendezvous_timeout' });
    expect(f.bot.listenerCount('physicsTick')).toBe(0);
  });
  it('対象が移動したら次の一歩で計画を更新する', async () => {
    vi.useFakeTimers();
    const f = physicsFixture();
    const result = await drive(controller().handleFollowPlayerCommand(options, { getActiveBot: () => f.bot }), f,
      i => { if (i === 10) f.target.position.z = 3.5; });
    expect(result).toEqual({ ok: true });
    expect(f.bot.entity.position.distanceTo(f.target.position)).toBeLessThanOrEqual(1);
  });
  it('移動中の対象離脱とBot切替で停止する', async () => {
    vi.useFakeTimers();
    const f = physicsFixture();
    const result = await drive(controller().handleFollowPlayerCommand(options, { getActiveBot: () => f.bot }), f,
      i => { if (i === 2) f.bot.players = {}; });
    expect(result).toEqual({ ok: false, error: 'rendezvous_target_unavailable' });
    expect(Object.values(f.control).every(v => !v)).toBe(true);
    const g = physicsFixture(); let current: Bot | null = g.bot;
    const changed = await drive(controller().handleFollowPlayerCommand(options, { getActiveBot: () => current }), g,
      i => { if (i === 2) current = null; });
    expect(changed).toEqual({ ok: false, error: 'rendezvous_bot_unavailable' });
    expect(Object.values(g.control).every(v => !v)).toBe(true);
  });
  it('合流中は競合する合流・moveToを拒否し終了後にlockを解放する', async () => {
    vi.useFakeTimers();
    const f = physicsFixture(), c = controller();
    const pending = c.handleFollowPlayerCommand(options, { getActiveBot: () => f.bot });
    expect(await c.handleFollowPlayerCommand(options, { getActiveBot: () => f.bot })).toEqual({ ok: false, error: 'rendezvous_busy' });
    expect(await c.handleMoveToCommand({ x: 1, y: 64, z: 0 }, { getActiveBot: () => f.bot })).toEqual({ ok: false, error: 'navigation_busy' });
    await expect(c.gotoWithForcedMoveRetry(f.bot, {} as never, {} as MovementsClass)).rejects.toThrow('navigation_busy');
    expect(await drive(pending, f)).toEqual({ ok: true });
    expect(await c.handleFollowPlayerCommand(options, { getActiveBot: () => f.bot })).toEqual({ ok: true });
  });
  it('移動中のdimension変更は専用エラーで入力解除する', async () => {
    vi.useFakeTimers();
    const f = physicsFixture();
    const result = await drive(controller().handleFollowPlayerCommand(options, { getActiveBot: () => f.bot }), f,
      i => { if (i === 2) f.bot.game.dimension = 'the_nether'; });
    expect(result).toEqual({ ok: false, error: 'rendezvous_dimension_mismatch' });
    expect(Object.values(f.control).every(v => !v)).toBe(true);
  });
  it('観測不能・足場危険は開始せず、診断へraw情報を載せない', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const f = physicsFixture(() => null);
    const result = await controller().handleFollowPlayerCommand(options, { getActiveBot: () => f.bot });
    expect(result).toEqual({ ok: false, error: 'rendezvous_observation_unavailable' });
    expect(f.bot.setControlState).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('player');
    expect(JSON.stringify(log.mock.calls)).not.toContain('position');
  });
});
