// 日本語コメント：NavigationController の異常系挙動を集中的に検証するユニットテスト
// 役割：座標バリデーションと Bot 未接続時の扱い、強制移動記録のレート制御を安全に確認する
import { describe, expect, it, vi } from 'vitest';
import type { Bot } from 'mineflayer';
import type { Movements as MovementsClass } from 'mineflayer-pathfinder';

import {
  NavigationController,
  RENDEZVOUS_ERROR_CODES,
} from '../runtime/navigationController.js';
import type { PlayerPositionBridgeClient } from '../runtime/playerPositionBridge.js';

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

interface RendezvousBotFixture {
  bot: Bot;
  botEntity: { position: { x: number; y: number; z: number } };
  targetEntity: {
    type: 'player';
    username: string;
    isValid: boolean;
    position: { x: number; y: number; z: number };
  };
  goto: ReturnType<typeof vi.fn>;
  setGoal: ReturnType<typeof vi.fn>;
  setMovements: ReturnType<typeof vi.fn>;
  blocks: { targetLiquid: boolean; currentLiquid: boolean; voidBelow: boolean };
}

function createRendezvousBotFixture(): RendezvousBotFixture {
  const cautiousMovements = createFakeMovements();
  const botEntity = { position: { x: 0, y: 64, z: 0 } };
  const targetEntity = {
    type: 'player' as const,
    username: 'player',
    isValid: true,
    position: { x: 4, y: 64, z: 0 },
  };
  const blocks = { targetLiquid: false, currentLiquid: false, voidBelow: false };
  const setGoal = vi.fn();
  const setMovements = vi.fn();
  const goto = vi.fn(async () => {
    botEntity.position = { ...targetEntity.position };
  });
  const blockAt = vi.fn((position: { x: number; y: number; z: number }) => {
    const isTarget = position.x === Math.floor(targetEntity.position.x) && position.z === Math.floor(targetEntity.position.z);
    const isCurrent = position.x === Math.floor(botEntity.position.x) && position.z === Math.floor(botEntity.position.z);
    const isBelow = position.y === 63;
    if ((isTarget && blocks.targetLiquid) || (isCurrent && blocks.currentLiquid)) {
      return { name: 'water', liquid: true, boundingBox: 'liquid' };
    }
    if (isBelow && ((isTarget && blocks.voidBelow) || (isCurrent && blocks.voidBelow))) {
      return { name: 'air', boundingBox: 'empty' };
    }
    if (isBelow) {
      return { name: 'stone', boundingBox: 'block' };
    }
    return { name: 'air', boundingBox: 'empty' };
  });
  const bot = {
    username: 'bot',
    entity: botEntity,
    game: { dimension: 'overworld' },
    players: { player: { username: 'player', entity: targetEntity } },
    entities: { target: targetEntity },
    blockAt,
    pathfinder: {
      goto,
      setGoal,
      setMovements,
      movements: cautiousMovements,
    },
  } as unknown as Bot;
  return { bot, botEntity, targetEntity, goto, setGoal, setMovements, blocks };
}

function createRendezvousController(
  options: {
    timeoutMs?: number;
    maxRetries?: number;
    playerPositionBridge?: Pick<PlayerPositionBridgeClient, 'lookup'>;
  } = {},
): NavigationController {
  const controller = new NavigationController({
    moveGoalToleranceMeters: 2,
    forcedMoveRetryWindowMs: 2_000,
    forcedMoveMaxRetries: 0,
    forcedMoveRetryDelayMs: 0,
    rendezvousTimeoutMs: options.timeoutMs ?? 100,
    rendezvousMaxRetries: options.maxRetries ?? 1,
    playerPositionBridge: options.playerPositionBridge,
    pathfinder: {
      allowParkour: true,
      allowSprinting: true,
      digCost: { enable: 1, disable: 96 },
    },
  });
  return controller;
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

describe('NavigationController handleFollowPlayerCommand', () => {
  it('完全一致で観測できるプレイヤーへ慎重profileの一点合流を行う', async () => {
    const controller = createRendezvousController();
    const fixture = createRendezvousBotFixture();
    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: true });
    expect(fixture.goto).toHaveBeenCalledTimes(1);
    expect(fixture.setGoal).not.toHaveBeenCalledWith(null);
  });

  it('不正なtargetはBot参照前に拒否し、target文字列をエラーへ含めない', async () => {
    const controller = createRendezvousController();
    const getActiveBot = vi.fn(() => createRendezvousBotFixture().bot);
    const response = await controller.handleFollowPlayerCommand(
      { target: '../player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_INVALID });
    expect(getActiveBot).not.toHaveBeenCalled();
  });

  it('連続視線維持を要求するfalseは黙って無視せず非対応として拒否する', async () => {
    const controller = createRendezvousController();
    const getActiveBot = vi.fn(() => createRendezvousBotFixture().bot);
    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: false },
      { getActiveBot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.LINE_OF_SIGHT_UNSUPPORTED });
    expect(getActiveBot).not.toHaveBeenCalled();
  });

  it('offline対象はpathfinderを呼ばず安全な固定エラーを返す', async () => {
    const controller = createRendezvousController();
    const fixture = createRendezvousBotFixture();
    (fixture.bot as unknown as { players: Record<string, unknown> }).players = {};
    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_UNAVAILABLE });
    expect(fixture.goto).not.toHaveBeenCalled();
  });

  it('entity欠損時はDIしたPaper位置照会へフォールバックし、到着直前にも再照会する', async () => {
    const fixture = createRendezvousBotFixture();
    (fixture.bot as unknown as { players: Record<string, unknown> }).players = {};
    const lookup = vi.fn(async () => ({
      position: { x: 4, y: 64, z: 0 },
      dimension: 'minecraft:overworld',
      observedAt: Date.now(),
    }));
    const controller = createRendezvousController({ playerPositionBridge: { lookup } });

    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: true });
    expect(lookup.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.goto).toHaveBeenCalledTimes(1);
  });

  it('Bridgeの対象不在はオフライン、503等は位置照会不能へ分類する', async () => {
    const fixture = createRendezvousBotFixture();
    (fixture.bot as unknown as { players: Record<string, unknown> }).players = {};
    const offlineController = createRendezvousController({
      playerPositionBridge: { lookup: vi.fn(async () => { throw { kind: 'not_found' }; }) },
    });
    await expect(offlineController.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    )).resolves.toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_OFFLINE });

    const unavailableController = createRendezvousController({
      playerPositionBridge: { lookup: vi.fn(async () => { throw { kind: 'unavailable' }; }) },
    });
    await expect(unavailableController.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    )).resolves.toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.POSITION_SERVICE_UNAVAILABLE });
  });

  it('遠距離Bridge対象はwaypointを有限区間で進み、目的地chunk未観測なら成功扱いにしない', async () => {
    const fixture = createRendezvousBotFixture();
    (fixture.bot as unknown as { players: Record<string, unknown> }).players = {};
    const remoteTarget = { x: 100, y: 64, z: 0 };
    const lookup = vi.fn(async () => ({
      position: remoteTarget,
      dimension: 'minecraft:overworld',
      observedAt: Date.now(),
    }));
    fixture.goto.mockImplementation(async () => {
      fixture.botEntity.position = {
        x: Math.min(96, fixture.botEntity.position.x + 16),
        y: 64,
        z: 0,
      };
    });
    const blockAt = (fixture.bot as unknown as { blockAt: ReturnType<typeof vi.fn> }).blockAt;
    blockAt.mockImplementation((position: { x: number; y: number; z: number }) => {
      if (position.x >= 100) return null;
      if (position.y === 63) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    });
    const controller = createRendezvousController({ playerPositionBridge: { lookup } });

    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.OBSERVATION_UNAVAILABLE });
    expect(fixture.goto.mock.calls.length).toBeGreaterThan(1);
    expect(fixture.goto.mock.calls.every(([goal]) => (goal as { x?: number }).x !== remoteTarget.x)).toBe(true);
  });

  it('静止した遠距離対象でも区間上限を越えて無期限に追跡しない', async () => {
    const fixture = createRendezvousBotFixture();
    (fixture.bot as unknown as { players: Record<string, unknown> }).players = {};
    const lookup = vi.fn(async () => ({
      position: { x: 500, y: 64, z: 0 },
      dimension: 'overworld',
      observedAt: Date.now(),
    }));
    fixture.goto.mockImplementation(async () => {
      fixture.botEntity.position = {
        x: fixture.botEntity.position.x + 16,
        y: 64,
        z: 0,
      };
    });
    const controller = createRendezvousController({ playerPositionBridge: { lookup } });

    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.DISTANCE_LIMIT });
    expect(fixture.goto).toHaveBeenCalledTimes(16);
  });

  it('targetのdimension不一致は移動前に拒否する', async () => {
    const controller = createRendezvousController();
    const fixture = createRendezvousBotFixture();
    (fixture.bot as unknown as { players: Record<string, { username: string; entity: unknown; dimension: string }> }).players.player.dimension = 'the_nether';
    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.DIMENSION_MISMATCH });
    expect(fixture.goto).not.toHaveBeenCalled();
  });

  it('現在位置または対象位置のhazardを検知したら掘削fallbackなしで停止する', async () => {
    const controller = createRendezvousController();
    const fixture = createRendezvousBotFixture();
    fixture.blocks.targetLiquid = true;
    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED });
    expect(fixture.goto).not.toHaveBeenCalled();
  });

  it('waypoint間の既知hostileも点検し、危険区間へ進まない', async () => {
    const controller = createRendezvousController();
    const fixture = createRendezvousBotFixture();
    (fixture.bot as unknown as { entities: Record<string, unknown> }).entities.hostile = {
      type: 'hostile',
      position: { x: 1, y: 64, z: 0 },
    };

    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED });
    expect(fixture.goto).not.toHaveBeenCalled();
  });

  it('対象が移動した場合は有限回だけ再解決して新位置へ到着を再確認する', async () => {
    const controller = createRendezvousController({ maxRetries: 1 });
    const fixture = createRendezvousBotFixture();
    fixture.goto.mockImplementationOnce(async () => {
      fixture.targetEntity.position = { x: 20, y: 64, z: 0 };
      fixture.botEntity.position = { x: 0, y: 64, z: 0 };
    });

    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: true });
    expect(fixture.goto).toHaveBeenCalledTimes(2);
  });

  it('移動中に対象が離脱した場合は到着扱いにせず停止する', async () => {
    const controller = createRendezvousController({ maxRetries: 1 });
    const fixture = createRendezvousBotFixture();
    fixture.goto.mockImplementationOnce(async () => {
      (fixture.bot as unknown as { players: Record<string, { username: string; entity: unknown }> }).players.player.entity = null;
    });

    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_UNAVAILABLE });
    expect(fixture.goto).toHaveBeenCalledTimes(1);
  });

  it('NoPathは有限retry後に固定enumで返し、掘削profileへ切り替えない', async () => {
    const controller = createRendezvousController({ maxRetries: 1 });
    const fixture = createRendezvousBotFixture();
    const digMovements = createFakeMovements();
    controller.setMovementProfiles(createFakeMovements(), digMovements);
    fixture.goto.mockRejectedValue(new Error('NoPath'));

    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.NO_PATH });
    expect(fixture.goto).toHaveBeenCalledTimes(2);
    expect(fixture.setMovements.mock.calls.some(([movements]) => movements === digMovements)).toBe(false);
  });

  it('pathfinder timeoutは停止操作後に固定enumで返す', async () => {
    const controller = createRendezvousController({ timeoutMs: 1, maxRetries: 1 });
    const fixture = createRendezvousBotFixture();
    fixture.goto.mockImplementation(() => new Promise<void>(() => undefined));

    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT });
    expect(fixture.setGoal).toHaveBeenCalledWith(null);
    expect(fixture.goto).toHaveBeenCalledTimes(1);
  });
});
