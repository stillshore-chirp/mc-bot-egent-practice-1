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
  stop: ReturnType<typeof vi.fn>;
  clearControlStates: ReturnType<typeof vi.fn>;
  stopDigging: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
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
  const stop = vi.fn();
  const clearControlStates = vi.fn();
  const stopDigging = vi.fn();
  const quit = vi.fn();
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
    clearControlStates,
    stopDigging,
    quit,
    pathfinder: {
      goto,
      setGoal,
      stop,
      setMovements,
      movements: cautiousMovements,
    },
  } as unknown as Bot;
  return {
    bot,
    botEntity,
    targetEntity,
    goto,
    setGoal,
    stop,
    clearControlStates,
    stopDigging,
    quit,
    setMovements,
    blocks,
  };
}

function createRendezvousController(
  options: {
    timeoutMs?: number;
    deadlineMs?: number;
    cancelGraceMs?: number;
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
    rendezvousDeadlineMs: options.deadlineMs ?? 180_000,
    rendezvousCancelGraceMs: options.cancelGraceMs ?? 25,
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

  it('合流中の同一BotへのmoveToはnavigation_busyで拒否する', async () => {
    const controller = createRendezvousController({ maxRetries: 0 });
    const fixture = createRendezvousBotFixture();
    let resolveGoto!: () => void;
    fixture.goto.mockImplementation(() => new Promise<void>((resolve) => {
      resolveGoto = resolve;
    }));

    const followPromise = controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const moveResponse = await controller.handleMoveToCommand(
      { x: 8, y: 64, z: 0 },
      { getActiveBot: () => fixture.bot },
    );
    expect(moveResponse).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.NAVIGATION_BUSY });
    expect(fixture.goto).toHaveBeenCalledTimes(1);

    fixture.botEntity.position = { x: 2, y: 64, z: 0 };
    resolveGoto();
    await expect(followPromise).resolves.toEqual({ ok: true });
  });

  it('moveTo中の同一Botへの合流はrendezvous_busyで拒否する', async () => {
    const controller = createRendezvousController({ maxRetries: 0 });
    const fixture = createRendezvousBotFixture();
    let resolveGoto!: () => void;
    fixture.goto.mockImplementation(() => new Promise<void>((resolve) => {
      resolveGoto = resolve;
    }));

    const movePromise = controller.handleMoveToCommand(
      { x: 8, y: 64, z: 0 },
      { getActiveBot: () => fixture.bot },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const followResponse = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );
    expect(followResponse).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.BUSY });
    expect(fixture.goto).toHaveBeenCalledTimes(1);

    resolveGoto();
    await expect(movePromise).resolves.toEqual({ ok: true });
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
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    expect(fixture.clearControlStates).toHaveBeenCalledTimes(1);
    expect(fixture.stopDigging).toHaveBeenCalledTimes(1);
    expect(fixture.goto).toHaveBeenCalledTimes(1);

    const secondResponse = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );
    expect(secondResponse).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.BUSY });
  });

  it('合流全体のdeadlineは区間timeoutを残時間へ切り詰め、新しい区間を開始しない', async () => {
    const controller = createRendezvousController({
      timeoutMs: 100,
      deadlineMs: 5,
      cancelGraceMs: 5,
      maxRetries: 0,
    });
    const fixture = createRendezvousBotFixture();
    fixture.goto.mockImplementation(() => new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    }));

    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT });
    expect(fixture.goto).toHaveBeenCalledTimes(1);
    expect(fixture.setGoal).toHaveBeenCalledWith(null);
  });

  it('Bridge照会がdeadlineを越えた場合はtimeoutを返し、移動を開始しない', async () => {
    const fixture = createRendezvousBotFixture();
    (fixture.bot as unknown as { players: Record<string, unknown> }).players = {};
    const lookup = vi.fn(() => new Promise<{
      position: { x: number; y: number; z: number };
      dimension: string;
      observedAt: number;
    }>((resolve) => {
      setTimeout(() => resolve({
        position: { x: 4, y: 64, z: 0 },
        dimension: 'overworld',
        observedAt: Date.now(),
      }), 20);
    }));
    const controller = createRendezvousController({
      timeoutMs: 100,
      deadlineMs: 5,
      maxRetries: 0,
      playerPositionBridge: { lookup },
    });

    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(fixture.goto).not.toHaveBeenCalled();
  });

  it('timeout後の遅延gotoはsettleを待ってから返答し、返答後の移動を残さない', async () => {
    const controller = createRendezvousController({ timeoutMs: 1, cancelGraceMs: 40, maxRetries: 0 });
    const fixture = createRendezvousBotFixture();
    fixture.goto.mockImplementation(() => new Promise<void>((resolve) => {
      setTimeout(() => {
        fixture.botEntity.position = { x: 2, y: 64, z: 0 };
        resolve();
      }, 10);
    }));

    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );
    const positionAtResponse = { ...fixture.botEntity.position };
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT });
    expect(positionAtResponse).toEqual({ x: 2, y: 64, z: 0 });
    expect(fixture.botEntity.position).toEqual(positionAtResponse);
    expect(fixture.setGoal).toHaveBeenCalledWith(null);
  });

  it('grace後もgotoが非協調ならBotを切断し、返答後の移動を残さない', async () => {
    const controller = createRendezvousController({ timeoutMs: 1, cancelGraceMs: 5, maxRetries: 0 });
    const fixture = createRendezvousBotFixture();
    let disconnected = false;
    fixture.quit.mockImplementation(() => {
      disconnected = true;
    });
    fixture.goto.mockImplementation(() => new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!disconnected) {
          fixture.botEntity.position = { x: 2, y: 64, z: 0 };
        }
        resolve();
      }, 30);
    }));

    const response = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );
    const positionAtResponse = { ...fixture.botEntity.position };
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(response).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT });
    expect(fixture.quit).toHaveBeenCalledTimes(1);
    expect(fixture.botEntity.position).toEqual(positionAtResponse);
  });

  it('再接続した新しいBotは旧Botの未解消cleanup lockから分離する', async () => {
    const controller = createRendezvousController({ timeoutMs: 1, cancelGraceMs: 5, maxRetries: 0 });
    const oldFixture = createRendezvousBotFixture();
    oldFixture.goto.mockImplementation(() => new Promise<void>(() => undefined));

    const oldResponse = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => oldFixture.bot },
    );
    expect(oldResponse).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT });
    expect(oldFixture.quit).toHaveBeenCalledTimes(1);

    const newFixture = createRendezvousBotFixture();
    const newResponse = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => newFixture.bot },
    );

    expect(newResponse).toEqual({ ok: true });
    expect(newFixture.goto).toHaveBeenCalledTimes(1);
  });

  it('同じControllerの合流gotoを並行実行せずbusyを返す', async () => {
    const controller = createRendezvousController({ timeoutMs: 100, maxRetries: 0 });
    const fixture = createRendezvousBotFixture();
    let resolveGoto!: () => void;
    fixture.goto.mockImplementation(() => new Promise<void>((resolve) => {
      resolveGoto = () => {
        fixture.botEntity.position = { x: 2, y: 64, z: 0 };
        resolve();
      };
    }));

    const firstResponsePromise = controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondResponse = await controller.handleFollowPlayerCommand(
      { target: 'player', stopDistance: 2, maintainLineOfSight: true },
      { getActiveBot: () => fixture.bot },
    );
    expect(secondResponse).toEqual({ ok: false, error: RENDEZVOUS_ERROR_CODES.BUSY });
    expect(fixture.goto).toHaveBeenCalledTimes(1);

    resolveGoto();
    await expect(firstResponsePromise).resolves.toEqual({ ok: true });
  });
});
