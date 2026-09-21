import type { Bot } from 'mineflayer';
import mineflayerPathfinder from 'mineflayer-pathfinder';
import type { Movements as MovementsClass } from 'mineflayer-pathfinder';
import { navigateLocally } from './localNavigation.js';
import { acquireMovementControl } from './movementControl.js';
import type { PlayerPositionBridgeClient } from './playerPositionBridge.js';
import type { CommandResponse } from './types.js';

const { goals } = mineflayerPathfinder as typeof import('mineflayer-pathfinder');

/**
 * 合流コマンドが外部へ返す、機械判定可能な安全エラー。
 * プレイヤー名、座標、pathfinder の raw exception はこの境界から返さない。
 */
export const RENDEZVOUS_ERROR_CODES = {
  INVALID_ARGS: 'rendezvous_invalid_args',
  BOT_UNAVAILABLE: 'rendezvous_bot_unavailable',
  TARGET_INVALID: 'rendezvous_target_invalid',
  TARGET_UNAVAILABLE: 'rendezvous_target_unavailable',
  TARGET_OFFLINE: 'rendezvous_target_offline',
  POSITION_SERVICE_UNAVAILABLE: 'rendezvous_position_service_unavailable',
  DIMENSION_UNKNOWN: 'rendezvous_dimension_unknown',
  DIMENSION_MISMATCH: 'rendezvous_dimension_mismatch',
  OBSERVATION_UNAVAILABLE: 'rendezvous_observation_unavailable',
  HAZARD_BLOCKED: 'rendezvous_hazard_blocked',
  NO_PATH: 'rendezvous_no_path',
  TIMEOUT: 'rendezvous_timeout',
  TARGET_MOVED: 'rendezvous_target_moved',
  ARRIVAL_UNCONFIRMED: 'rendezvous_arrival_unconfirmed',
  DISTANCE_LIMIT: 'rendezvous_distance_limit',
  PATH_FAILED: 'rendezvous_path_failed',
  LINE_OF_SIGHT_UNSUPPORTED: 'rendezvous_line_of_sight_unsupported',
  BUSY: 'rendezvous_busy',
  NAVIGATION_BUSY: 'navigation_busy',
} as const;

export type RendezvousErrorCode = (typeof RENDEZVOUS_ERROR_CODES)[keyof typeof RENDEZVOUS_ERROR_CODES];

const PLAYER_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const DEFAULT_RENDEZVOUS_STOP_DISTANCE = 2;
const MIN_RENDEZVOUS_STOP_DISTANCE = 1;
const MAX_RENDEZVOUS_STOP_DISTANCE = 8;
const DEFAULT_RENDEZVOUS_DEADLINE_MS = 180_000;
const MAX_RENDEZVOUS_DEADLINE_MS = 600_000;

interface RendezvousPosition {
  x: number;
  y: number;
  z: number;
}

interface RendezvousEntity {
  type?: unknown;
  username?: unknown;
  isValid?: unknown;
  position?: unknown;
  dimension?: unknown;
  kind?: unknown;
}

interface RendezvousPlayer {
  username?: unknown;
  entity?: RendezvousEntity | null;
  dimension?: unknown;
}

interface RendezvousTargetSnapshot {
  entity: RendezvousEntity | null;
  position: RendezvousPosition;
  source: 'entity' | 'bridge';
  observedAt: number;
}

interface RendezvousCommandArgs {
  targetName: string;
  stopDistance: number;
  maintainLineOfSight: boolean;
}

type RendezvousResolution =
  | { ok: true; target: RendezvousTargetSnapshot }
  | { ok: false; error: RendezvousErrorCode };

/**
 * Mineflayer の移動系処理を集約し、bot.ts のコンテキストサイズを抑制するコントローラー。
 *
 * - 強制移動検知に伴うリトライ判定
 * - 移動プロファイル（慎重/掘削許可）の管理
 * - moveTo コマンドの実装本体
 */
export class NavigationController {
  private lastMoveTarget: { x: number; y: number; z: number } | null = null;
  private lastForcedMoveAt = 0;
  private lastForcedMoveLoggedAt = 0;
  private cautiousMovements: MovementsClass | null = null;
  private digPermissiveMovements: MovementsClass | null = null;
  /** 同じBotへの操作入力を重ねない。 */
  private rendezvousInFlight: Promise<CommandResponse> | Promise<void> | null = null;
  private rendezvousActiveBot: Bot | null = null;
  private moveToInFlight: Promise<CommandResponse> | null = null;
  private moveToActiveBot: Bot | null = null;

  constructor(
    private readonly options: {
      moveGoalToleranceMeters: number;
      forcedMoveRetryWindowMs: number;
      forcedMoveMaxRetries: number;
      forcedMoveRetryDelayMs: number;
      /** Bridge照会・区間移動・再試行を含む合流全体の絶対期限。 */
      rendezvousDeadlineMs?: number;
      /** entityが未観測の対象だけへ使うPaper Bridge位置照会。 */
      playerPositionBridge?: Pick<PlayerPositionBridgeClient, 'lookup'>;
      // mineflayer-pathfinder の挙動を環境変数経由で注入し、bot.ts 側のハードコーディングを回避する。
      pathfinder: {
        allowParkour: boolean;
        allowSprinting: boolean;
        digCost: { enable: number; disable: number };
      };
    },
  ) {}

  setMovementProfiles(cautious: MovementsClass, digPermissive: MovementsClass): void {
    this.cautiousMovements = cautious;
    this.digPermissiveMovements = digPermissive;
  }

  getCautiousMovements(): MovementsClass | null {
    return this.cautiousMovements;
  }

  getDigPermissiveMovements(): MovementsClass | null {
    return this.digPermissiveMovements;
  }

  getLastMoveTarget(): { x: number; y: number; z: number } | null {
    return this.lastMoveTarget;
  }

  recordMoveTarget(target: { x: number; y: number; z: number }): void {
    this.lastMoveTarget = target;
  }

  /**
   * forcedMove イベント発火時にタイムスタンプを記録し、追加ログ出力が必要か返す。
   */
  recordForcedMove(now: number): boolean {
    this.lastForcedMoveAt = now;
    const shouldLog = now - this.lastForcedMoveLoggedAt >= 1_000;
    if (shouldLog) {
      this.lastForcedMoveLoggedAt = now;
    }
    return shouldLog;
  }

  configureMovementProfile(movements: MovementsClass, allowDigging: boolean): void {
    const mutable = movements as MovementsClass & {
      canDig?: boolean;
      digCost?: number;
      allowParkour?: boolean;
      allowSprinting?: boolean;
    };
    mutable.allowParkour = this.options.pathfinder.allowParkour;
    mutable.allowSprinting = this.options.pathfinder.allowSprinting;
    mutable.canDig = allowDigging;

    if (allowDigging) {
      mutable.digCost = this.options.pathfinder.digCost.enable;
      return;
    }

    const currentCost = mutable.digCost ?? this.options.pathfinder.digCost.enable;
    mutable.digCost = Math.max(currentCost, this.options.pathfinder.digCost.disable);
  }

  private resolveGoalNearTolerance(targetBot: Bot, target: { x: number; y: number; z: number }): number {
    const entity = targetBot.entity;

    if (!entity) {
      return this.options.moveGoalToleranceMeters;
    }

    const verticalGap = Math.abs(target.y - entity.position.y);

    if (verticalGap >= 2) {
      const tightenedTolerance = Math.min(this.options.moveGoalToleranceMeters, 1);
      return Math.max(1, tightenedTolerance);
    }

    return this.options.moveGoalToleranceMeters;
  }

  private shouldRetryDueToForcedMove(error: unknown): boolean {
    if (Date.now() - this.lastForcedMoveAt > this.options.forcedMoveRetryWindowMs) {
      return false;
    }

    const message = error instanceof Error ? error.message : String(error);
    return message.includes('GoalChanged');
  }

  private isNoPathError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.toLowerCase().includes('no path');
  }

  async gotoWithForcedMoveRetry(
    targetBot: Bot,
    goal: InstanceType<typeof goals.GoalNear>,
    movements: MovementsClass,
  ): Promise<void> {
    const { pathfinder: activePathfinder } = targetBot;
    const previousMovements = activePathfinder.movements;
    const shouldRestoreMovements = previousMovements !== movements;

    const release = acquireMovementControl(targetBot);
    if (!release) throw new Error('navigation_busy');
    try {
      if (shouldRestoreMovements) activePathfinder.setMovements(movements);
      for (let attempt = 0; attempt <= this.options.forcedMoveMaxRetries; attempt++) {
        try {
          await activePathfinder.goto(goal);
          return;
        } catch (error) {
          if (this.shouldRetryDueToForcedMove(error) && attempt < this.options.forcedMoveMaxRetries) {
            console.warn(
              `[MoveToCommand] retrying due to forcedMove correction (attempt ${attempt + 1}/${this.options.forcedMoveMaxRetries})`,
            );
            await this.delay(this.options.forcedMoveRetryDelayMs);
            continue;
          }

          throw error;
        }
      }
    } finally {
      try { if (shouldRestoreMovements) activePathfinder.setMovements(previousMovements); }
      finally { release(); }
    }

    throw new Error('Pathfinding failed after forcedMove retries');
  }

  async handleMoveToCommand(
    args: Record<string, unknown>,
    dependencies: { getActiveBot: () => Bot | null },
  ): Promise<CommandResponse> {
    const x = Number(args.x);
    const y = Number(args.y);
    const z = Number(args.z);

    if ([x, y, z].some((value) => Number.isNaN(value))) {
      console.warn('[MoveToCommand] invalid coordinate(s) detected', { x, y, z });
      return { ok: false, error: 'Invalid coordinates' };
    }

    const activeBot = dependencies.getActiveBot();

    if (!activeBot) {
      console.warn('[MoveToCommand] rejected because bot is unavailable');
      return { ok: false, error: 'Bot is not connected to the Minecraft server yet' };
    }

    if (
      (this.rendezvousInFlight && this.rendezvousActiveBot === activeBot) ||
      (this.moveToInFlight && this.moveToActiveBot === activeBot)
    ) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.NAVIGATION_BUSY };
    }

    const command = this.executeMoveToCommand(activeBot, { x, y, z });
    this.moveToActiveBot = activeBot;
    this.moveToInFlight = command;
    try {
      return await command;
    } finally {
      if (this.moveToInFlight === command) {
        this.moveToInFlight = null;
        this.moveToActiveBot = null;
      }
    }
  }

  private async executeMoveToCommand(
    activeBot: Bot,
    target: { x: number; y: number; z: number },
  ): Promise<CommandResponse> {
    const { x, y, z } = target;

    this.recordMoveTarget({ x, y, z });
    const tolerance = this.resolveGoalNearTolerance(activeBot, { x, y, z });
    const goal = new goals.GoalNear(x, y, z, tolerance);
    const preferredMovements = this.cautiousMovements ?? activeBot.pathfinder.movements;
    const fallbackMovements = this.digPermissiveMovements;

    try {
      await this.gotoWithForcedMoveRetry(activeBot, goal, preferredMovements);
      const { position } = activeBot.entity;
      console.log(
        `[MoveToCommand] pathfinder completed near (${x}, ${y}, ${z}) actual=(${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)}) tolerance=${tolerance} profile=cautious`,
      );
      return { ok: true };
    } catch (primaryError) {
      if (this.isNoPathError(primaryError) && fallbackMovements) {
        console.warn(
          '[MoveToCommand] no walkable route found without digging. Retrying with digging-enabled fallback profile.',
        );

        try {
          await this.gotoWithForcedMoveRetry(activeBot, goal, fallbackMovements);
          const { position } = activeBot.entity;
          console.log(
            `[MoveToCommand] fallback pathfinder completed near (${x}, ${y}, ${z}) actual=(${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)}) tolerance=${tolerance} profile=dig-enabled`,
          );
          return { ok: true };
        } catch (fallbackError) {
          console.error('[Pathfinder] dig-enabled fallback also failed', fallbackError);
          return { ok: false, error: 'Pathfinding failed' };
        }
      }

      console.error('[Pathfinder] failed to move', primaryError);
      return { ok: false, error: 'Pathfinding failed' };
    }
  }

  /** 話者を毎歩再解決し、局所観測・自前探索・基本操作で合流する。 */
  async handleFollowPlayerCommand(
    args: Record<string, unknown>,
    dependencies: { getActiveBot: () => Bot | null },
  ): Promise<CommandResponse> {
    const parsed = this.parseRendezvousCommandArgs(args);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const bot = dependencies.getActiveBot();
    if (!bot?.entity) return { ok: false, error: RENDEZVOUS_ERROR_CODES.BOT_UNAVAILABLE };
    if ((this.rendezvousInFlight && this.rendezvousActiveBot === bot) ||
        (this.moveToInFlight && this.moveToActiveBot === bot)) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.BUSY };
    }
    const dimension = this.resolveBotDimension(bot);
    if (!dimension) return { ok: false, error: RENDEZVOUS_ERROR_CODES.DIMENSION_UNKNOWN };
    const deadlineAt = Date.now() + this.resolveRendezvousDeadlineMs();
    const command = navigateLocally(bot, {
      stopDistance: parsed.args.stopDistance,
      deadlineAt,
      current: () => dependencies.getActiveBot() === bot && !!bot.entity,
      dimensionMatches: () => this.resolveBotDimension(bot) === dimension,
      target: async () => {
        const resolved = await this.resolveRendezvousTargetWithDeadline(bot, parsed.args.targetName, dimension, deadlineAt);
        return resolved.ok ? { ok: true, position: resolved.target.position } : resolved;
      },
    });
    this.rendezvousActiveBot = bot;
    this.rendezvousInFlight = command;
    try { return await command; }
    finally {
      if (this.rendezvousInFlight === command) {
        this.rendezvousInFlight = null;
        this.rendezvousActiveBot = null;
      }
    }
  }

  private parseRendezvousCommandArgs(
    args: Record<string, unknown>,
  ): { ok: true; args: RendezvousCommandArgs } | { ok: false; error: RendezvousErrorCode } {
    const targetRaw = args.target;
    if (typeof targetRaw !== 'string') {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_INVALID };
    }
    const targetName = targetRaw.trim();
    if (targetRaw !== targetName || !PLAYER_USERNAME_PATTERN.test(targetName)) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_INVALID };
    }

    const stopDistanceRaw = args.stopDistance;
    const stopDistance = stopDistanceRaw === undefined ? DEFAULT_RENDEZVOUS_STOP_DISTANCE : stopDistanceRaw;
    if (
      typeof stopDistance !== 'number' ||
      !Number.isFinite(stopDistance) ||
      !Number.isInteger(stopDistance) ||
      stopDistance < MIN_RENDEZVOUS_STOP_DISTANCE ||
      stopDistance > MAX_RENDEZVOUS_STOP_DISTANCE
    ) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.INVALID_ARGS };
    }

    const maintainLineOfSightRaw = args.maintainLineOfSight;
    if (maintainLineOfSightRaw !== undefined && typeof maintainLineOfSightRaw !== 'boolean') {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.INVALID_ARGS };
    }
    if (maintainLineOfSightRaw === false) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.LINE_OF_SIGHT_UNSUPPORTED };
    }

    return {
      ok: true,
      args: {
        targetName,
        stopDistance,
        // trueは到着直前の再観測を要求する契約。移動中の連続LOS追従は提供しない。
        maintainLineOfSight: maintainLineOfSightRaw ?? true,
      },
    };
  }

  private resolveBotDimension(targetBot: Bot): string | null {
    const game = (targetBot as Bot & { game?: { dimension?: unknown } }).game;
    return this.normalizeDimension(game?.dimension);
  }

  private async resolveRendezvousTarget(
    targetBot: Bot,
    targetName: string,
    botDimension: string,
  ): Promise<RendezvousResolution> {
    let player: RendezvousPlayer | undefined;
    try {
      const players = (targetBot as Bot & { players?: Record<string, RendezvousPlayer | undefined> }).players;
      player = players?.[targetName];
    } catch {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_UNAVAILABLE };
    }
    if (player !== undefined && (typeof player !== 'object' || player.username !== targetName)) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_UNAVAILABLE };
    }

    if (player && typeof player === 'object') {
      try {
        const dimensionError = this.validateTargetDimensions(player, player.entity, botDimension);
        if (dimensionError) {
          return { ok: false, error: dimensionError };
        }

        const entity = player.entity;
        if (entity) {
          if (
            entity.type !== 'player' ||
            entity.isValid !== true ||
            entity.username !== targetName
          ) {
            return { ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_UNAVAILABLE };
          }

          const position = this.readRendezvousPosition(entity.position);
          if (!position) {
            return { ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_UNAVAILABLE };
          }

          return {
            ok: true,
            target: { entity, position, source: 'entity', observedAt: Date.now() },
          };
        }
      } catch {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_UNAVAILABLE };
      }
    }

    const bridge = this.options.playerPositionBridge;
    if (!bridge) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_UNAVAILABLE };
    }

    try {
      const observation = await bridge.lookup(targetName);
      const position = this.readRendezvousPosition(observation.position);
      const dimension = this.normalizeDimension(observation.dimension);
      if (!position || !Number.isFinite(observation.observedAt)) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.POSITION_SERVICE_UNAVAILABLE };
      }
      if (!dimension) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.DIMENSION_UNKNOWN };
      }
      if (dimension !== botDimension) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.DIMENSION_MISMATCH };
      }
      return {
        ok: true,
        target: {
          entity: null,
          position,
          source: 'bridge',
          observedAt: observation.observedAt,
        },
      };
    } catch (error) {
      const kind = this.readBridgeFailureKind(error);
      if (kind === 'not_found') {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_OFFLINE };
      }
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.POSITION_SERVICE_UNAVAILABLE };
    }
  }

  private async resolveRendezvousTargetWithDeadline(
    targetBot: Bot,
    targetName: string,
    botDimension: string,
    rendezvousDeadlineAt: number,
  ): Promise<RendezvousResolution> {
    const remainingMs = this.resolveRendezvousRemainingMs(rendezvousDeadlineAt);
    if (remainingMs <= 0) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT };
    }

    let timeoutHandle: NodeJS.Timeout | null = null;
    const targetResolution = this.resolveRendezvousTarget(targetBot, targetName, botDimension);
    try {
      return await Promise.race([
        targetResolution,
        new Promise<RendezvousResolution>((resolve) => {
          timeoutHandle = setTimeout(() => {
            resolve({ ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT });
          }, remainingMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private readBridgeFailureKind(error: unknown): string {
    if (!error || typeof error !== 'object') {
      return 'unavailable';
    }
    const kind = (error as { kind?: unknown }).kind;
    return typeof kind === 'string' ? kind : 'unavailable';
  }

  private validateTargetDimensions(
    player: RendezvousPlayer,
    entity: RendezvousEntity | null | undefined,
    botDimension: string,
  ): RendezvousErrorCode | null {
    for (const rawDimension of [player.dimension, entity?.dimension]) {
      if (rawDimension === undefined) {
        continue;
      }
      const dimension = this.normalizeDimension(rawDimension);
      if (!dimension) {
        return RENDEZVOUS_ERROR_CODES.DIMENSION_UNKNOWN;
      }
      if (dimension !== botDimension) {
        return RENDEZVOUS_ERROR_CODES.DIMENSION_MISMATCH;
      }
    }
    return null;
  }

  private normalizeDimension(rawDimension: unknown): string | null {
    if (typeof rawDimension !== 'string') {
      return null;
    }
    let dimension = rawDimension.trim().toLowerCase();
    if (dimension.startsWith('minecraft:')) {
      dimension = dimension.slice('minecraft:'.length);
    }
    if (dimension === 'the_nether') {
      dimension = 'nether';
    } else if (dimension === 'the_end') {
      dimension = 'end';
    }
    if (!dimension || dimension === 'unknown') {
      return null;
    }
    return dimension;
  }

  private readRendezvousPosition(rawPosition: unknown): RendezvousPosition | null {
    if (!rawPosition || typeof rawPosition !== 'object') {
      return null;
    }
    const candidate = rawPosition as { x?: unknown; y?: unknown; z?: unknown };
    if (
      typeof candidate.x !== 'number' ||
      typeof candidate.y !== 'number' ||
      typeof candidate.z !== 'number' ||
      !Number.isFinite(candidate.x) ||
      !Number.isFinite(candidate.y) ||
      !Number.isFinite(candidate.z)
    ) {
      return null;
    }
    return { x: candidate.x, y: candidate.y, z: candidate.z };
  }

  private resolveRendezvousDeadlineMs(): number {
    const configured = this.options.rendezvousDeadlineMs;
    if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
      return DEFAULT_RENDEZVOUS_DEADLINE_MS;
    }
    return Math.min(Math.floor(configured), MAX_RENDEZVOUS_DEADLINE_MS);
  }

  private resolveRendezvousRemainingMs(rendezvousDeadlineAt: number): number {
    return Math.max(0, rendezvousDeadlineAt - Date.now());
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
