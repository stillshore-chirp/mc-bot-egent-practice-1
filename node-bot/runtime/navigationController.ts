import type { Bot } from 'mineflayer';
import mineflayerPathfinder from 'mineflayer-pathfinder';
import type { Movements as MovementsClass } from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
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
const DEFAULT_RENDEZVOUS_TIMEOUT_MS = 30_000;
const DEFAULT_RENDEZVOUS_DEADLINE_MS = 180_000;
const MAX_RENDEZVOUS_DEADLINE_MS = 600_000;
const DEFAULT_RENDEZVOUS_CANCEL_GRACE_MS = 250;
const MAX_RENDEZVOUS_CANCEL_GRACE_MS = 2_000;
const DEFAULT_RENDEZVOUS_MAX_RETRIES = 2;
const TARGET_MOVED_DISTANCE = 1;
const HOSTILE_CLEARANCE_RADIUS = 4;
const MAX_RENDEZVOUS_SEGMENTS = 16;
const MAX_RENDEZVOUS_SEGMENT_DISTANCE = 16;
const MAX_RENDEZVOUS_WAYPOINT_VERTICAL_ADJUSTMENT = 1;
const MAX_RENDEZVOUS_WAYPOINT_GOAL_TOLERANCE = 0.49;

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

interface RendezvousMovementResult {
  ok: true;
  target: RendezvousTargetSnapshot;
  /** 到着判定までにpathfinder.gotoを開始したか。安全停止ログへ固定値だけ渡す。 */
  gotoStarted: boolean;
}

type RendezvousMovementFailure = { ok: false; error: RendezvousErrorCode };

type RendezvousSafetyStopPhase = 'bot' | 'target' | 'waypoint' | 'arrival' | 'segment';

type RendezvousSafetyStopReason =
  | 'block_reader_absent'
  | 'observation_unavailable'
  | 'liquid_or_hazardous_block'
  | 'unsupported_floor'
  | 'nearby_hostile'
  | 'segment_hostile';

type RendezvousBlockClassification = 'solid' | 'empty' | 'hazard' | 'unknown';

type RendezvousWaypointInspection =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'block_reader_absent'
        | 'unsupported_floor'
        | 'liquid_or_hazardous_block'
        | 'observation_unavailable';
    };

type RendezvousWaypointSelection =
  | { ok: true; waypoint: RendezvousPosition }
  | { ok: false; error: RendezvousErrorCode };

interface RendezvousSafetyStopContext {
  phase: RendezvousSafetyStopPhase;
  gotoStarted: boolean;
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
  /** 同じBotの合流gotoを重ねず、未settleの停止処理中も次の合流を拒否する。 */
  private rendezvousInFlight: Promise<CommandResponse> | Promise<void> | null = null;
  private rendezvousCleanup: Promise<void> | null = null;
  private rendezvousActiveBot: Bot | null = null;
  private moveToInFlight: Promise<CommandResponse> | null = null;
  private moveToActiveBot: Bot | null = null;

  constructor(
    private readonly options: {
      moveGoalToleranceMeters: number;
      forcedMoveRetryWindowMs: number;
      forcedMoveMaxRetries: number;
      forcedMoveRetryDelayMs: number;
      /** 合流のpathfinder待機を有限にし、テストでは短い値を注入できる。 */
      rendezvousTimeoutMs?: number;
      /** Bridge照会・区間移動・再試行を含む合流全体の絶対期限。 */
      rendezvousDeadlineMs?: number;
      /** timeout後に非協調なfake/pathfinderのsettleを待つ有限grace。 */
      rendezvousCancelGraceMs?: number;
      /** 対象再解決を有限回に制限し、無期限追従へ変化させない。 */
      rendezvousMaxRetries?: number;
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

    if (shouldRestoreMovements) {
      activePathfinder.setMovements(movements);
    }

    try {
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
      if (shouldRestoreMovements) {
        activePathfinder.setMovements(previousMovements);
      }
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

  /**
   * チャット話者への一回限りの合流を実行する。
   *
   * 話者名の自然言語解釈は Python 側で済ませ、Node 側では Bot.players の完全一致か
   * 認証済みPaper Bridgeの完全一致照会だけを信頼する。対象の現在位置は区間ごとと
   * 到着直後に再観測し、移動中の対象を無期限に追いかけない。合流では掘削profileへ切り替えない。
   */
  async handleFollowPlayerCommand(
    args: Record<string, unknown>,
    dependencies: { getActiveBot: () => Bot | null },
  ): Promise<CommandResponse> {
    const parsed = this.parseRendezvousCommandArgs(args);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }

    const activeBot = dependencies.getActiveBot();
    if (!activeBot?.entity) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.BOT_UNAVAILABLE };
    }

    if (this.rendezvousInFlight) {
      if (this.rendezvousActiveBot === activeBot) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.BUSY };
      }

      // reconnect後の新しいBotは、切断済み旧Botの未settle Promiseと分離する。
      // 旧Bot側のcleanupが後から解消しても、新しいBotのlockを触らない。
      this.rendezvousInFlight = null;
      this.rendezvousCleanup = null;
      this.rendezvousActiveBot = null;
    }

    if (this.moveToInFlight && this.moveToActiveBot === activeBot) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.BUSY };
    }

    const command = this.executeFollowPlayerCommand(parsed, { getActiveBot: () => activeBot });
    this.rendezvousActiveBot = activeBot;
    this.rendezvousInFlight = command;
    try {
      return await command;
    } finally {
      this.releaseRendezvousWhenSettled(command);
    }
  }

  private async executeFollowPlayerCommand(
    parsed: { args: RendezvousCommandArgs },
    dependencies: { getActiveBot: () => Bot | null },
  ): Promise<CommandResponse> {
    const activeBot = dependencies.getActiveBot();
    if (!activeBot?.entity) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.BOT_UNAVAILABLE };
    }
    if (!activeBot.pathfinder || typeof activeBot.pathfinder.goto !== 'function') {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.PATH_FAILED };
    }

    const rendezvousDeadlineAt = Date.now() + this.resolveRendezvousDeadlineMs();
    const botDimension = this.resolveBotDimension(activeBot);
    if (!botDimension) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.DIMENSION_UNKNOWN };
    }

    const maxRetries = this.resolveRendezvousMaxRetries();
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (this.isRendezvousDeadlineExpired(rendezvousDeadlineAt)) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT };
      }

      const targetResolution = await this.resolveRendezvousTargetWithDeadline(
        activeBot,
        parsed.args.targetName,
        botDimension,
        rendezvousDeadlineAt,
      );
      if (!targetResolution.ok) {
        return { ok: false, error: targetResolution.error };
      }

      let movement: RendezvousMovementResult | RendezvousMovementFailure;
      try {
        movement = await this.moveRendezvousSegments(
          activeBot,
          parsed.args.targetName,
          botDimension,
          parsed.args.stopDistance,
          targetResolution.target,
          rendezvousDeadlineAt,
        );
      } catch {
        movement = { ok: false, error: RENDEZVOUS_ERROR_CODES.PATH_FAILED };
      }
      if (!movement.ok) {
        // timeout後の内部gotoが解消する前に次のgotoを重ねると危険なため、
        // timeoutはここで停止し、再試行はしない。
        if (
          (movement.error === RENDEZVOUS_ERROR_CODES.NO_PATH ||
            movement.error === RENDEZVOUS_ERROR_CODES.PATH_FAILED) &&
          attempt < maxRetries
        ) {
          continue;
        }
        return { ok: false, error: movement.error };
      }

      if (this.isRendezvousDeadlineExpired(rendezvousDeadlineAt)) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT };
      }

      const arrivedPosition = this.readRendezvousPosition(activeBot.entity.position);
      if (!arrivedPosition) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.BOT_UNAVAILABLE };
      }

      // 到着判定の直前にも対象を取り直す。Bridge観測値を成功条件としてキャッシュしない。
      const observedTarget = await this.resolveRendezvousTargetWithDeadline(
        activeBot,
        parsed.args.targetName,
        botDimension,
        rendezvousDeadlineAt,
      );
      if (!observedTarget.ok) {
        return { ok: false, error: observedTarget.error };
      }

      if (this.isRendezvousDeadlineExpired(rendezvousDeadlineAt)) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT };
      }

      const observedTargetHazard = this.inspectRendezvousHazard(
        activeBot,
        observedTarget.target.position,
        { phase: 'arrival', gotoStarted: movement.gotoStarted },
      );
      if (observedTargetHazard) {
        return { ok: false, error: observedTargetHazard };
      }

      const targetMovedDistance = this.distanceBetween(
        movement.target.position,
        observedTarget.target.position,
      );
      const arrivalDistance = this.distanceBetween(arrivedPosition, observedTarget.target.position);

      if (Number.isFinite(arrivalDistance) && arrivalDistance <= parsed.args.stopDistance) {
        return { ok: true };
      }

      if (attempt < maxRetries) {
        continue;
      }

      return {
        ok: false,
        error:
          targetMovedDistance > TARGET_MOVED_DISTANCE
            ? RENDEZVOUS_ERROR_CODES.TARGET_MOVED
            : RENDEZVOUS_ERROR_CODES.ARRIVAL_UNCONFIRMED,
      };
    }

    return { ok: false, error: RENDEZVOUS_ERROR_CODES.PATH_FAILED };
  }

  /**
   * timeout後にgoto Promiseがまだ解消していない場合は、そのPromiseをlockの対象に残す。
   * これにより、有限graceを超える非協調fakeでも返答後の並行gotoを許可しない。
   */
  private releaseRendezvousWhenSettled(command: Promise<CommandResponse>): void {
    if (this.rendezvousInFlight !== command) {
      return;
    }

    const cleanup = this.rendezvousCleanup;
    if (!cleanup) {
      this.rendezvousInFlight = null;
      this.rendezvousActiveBot = null;
      return;
    }

    this.rendezvousInFlight = cleanup;
    void cleanup.then(() => {
      if (this.rendezvousInFlight === cleanup) {
        this.rendezvousInFlight = null;
        this.rendezvousCleanup = null;
        this.rendezvousActiveBot = null;
      }
    });
  }

  /**
   * 未ロードの遠距離目的地へ一度に直行せず、観測可能な短い区間だけ進める。
   * 各区間の完了後に対象を再解決するため、Bridge の古い座標を無期限に追跡しない。
   */
  private async moveRendezvousSegments(
    targetBot: Bot,
    targetName: string,
    botDimension: string,
    stopDistance: number,
    initialTarget: RendezvousTargetSnapshot,
    rendezvousDeadlineAt: number,
  ): Promise<RendezvousMovementResult | RendezvousMovementFailure> {
    let target = initialTarget;
    let previousBotPosition: RendezvousPosition | null = null;
    let targetMoved = false;
    let gotoStarted = false;

    for (let segment = 0; segment < MAX_RENDEZVOUS_SEGMENTS; segment += 1) {
      if (this.isRendezvousDeadlineExpired(rendezvousDeadlineAt)) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT };
      }

      const botPosition = this.readRendezvousPosition(targetBot.entity?.position);
      if (!botPosition) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.BOT_UNAVAILABLE };
      }

      const currentHazard = this.inspectRendezvousHazard(
        targetBot,
        botPosition,
        { phase: 'bot', gotoStarted },
      );
      if (currentHazard) {
        return { ok: false, error: currentHazard };
      }

      const distance = this.distanceBetween(botPosition, target.position);
      if (!Number.isFinite(distance)) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_UNAVAILABLE };
      }
      if (distance <= stopDistance) {
        return { ok: true, target, gotoStarted };
      }

      // 目的地が遠距離かつBridge由来なら、未観測chunkのblockAt(null)を
      // 目的地の危険とも安全とも解釈しない。次のwaypointだけを検査する。
      if (target.source === 'entity' || distance <= MAX_RENDEZVOUS_SEGMENT_DISTANCE) {
        const targetHazard = this.inspectRendezvousHazard(
          targetBot,
          target.position,
          { phase: 'target', gotoStarted },
        );
        if (targetHazard) {
          return { ok: false, error: targetHazard };
        }
      }

      const waypointSelection = this.selectRendezvousWaypoint(
        targetBot,
        botPosition,
        target.position,
        stopDistance,
        { phase: 'waypoint', gotoStarted },
      );
      if (!waypointSelection.ok) {
        return waypointSelection;
      }
      const waypoint = waypointSelection.waypoint;
      const botWithEntities = targetBot as Bot & {
        entities?: Record<string, RendezvousEntity | undefined>;
      };
      if (this.hasNearbyHostileAlongSegment(targetBot, botPosition, waypoint, botWithEntities.entities)) {
        this.logRendezvousSafetyStop(
          { phase: 'segment', gotoStarted },
          'segment_hostile',
          RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED,
        );
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED };
      }

      if (previousBotPosition && this.distanceBetween(previousBotPosition, botPosition) < 0.25) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.NO_PATH };
      }
      previousBotPosition = botPosition;

      const goal = new goals.GoalNear(
        waypoint.x,
        waypoint.y,
        waypoint.z,
        Math.min(
          stopDistance,
          this.options.moveGoalToleranceMeters,
          MAX_RENDEZVOUS_WAYPOINT_GOAL_TOLERANCE,
        ),
      );
      const cautiousMovements = this.cautiousMovements ?? targetBot.pathfinder.movements;

      gotoStarted = true;
      try {
        await this.gotoRendezvousWithTimeout(targetBot, goal, cautiousMovements, rendezvousDeadlineAt);
      } catch (error) {
        return { ok: false, error: this.classifyRendezvousPathError(error) };
      }

      const afterMovePosition = this.readRendezvousPosition(targetBot.entity?.position);
      if (!afterMovePosition) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.BOT_UNAVAILABLE };
      }
      if (this.distanceBetween(botPosition, afterMovePosition) < 0.25) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.NO_PATH };
      }

      if (this.isRendezvousDeadlineExpired(rendezvousDeadlineAt)) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT };
      }

      const observedTarget = await this.resolveRendezvousTargetWithDeadline(
        targetBot,
        targetName,
        botDimension,
        rendezvousDeadlineAt,
      );
      if (!observedTarget.ok) {
        return observedTarget;
      }
      if (this.isRendezvousDeadlineExpired(rendezvousDeadlineAt)) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.TIMEOUT };
      }
      targetMoved = targetMoved || this.distanceBetween(target.position, observedTarget.target.position) > TARGET_MOVED_DISTANCE;
      target = observedTarget.target;
    }

    return {
      ok: false,
      error: targetMoved ? RENDEZVOUS_ERROR_CODES.TARGET_MOVED : RENDEZVOUS_ERROR_CODES.DISTANCE_LIMIT,
    };
  }

  private buildRendezvousWaypoint(
    origin: RendezvousPosition,
    target: RendezvousPosition,
    stopDistance: number,
  ): RendezvousPosition {
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const horizontalDistance = Math.sqrt(dx ** 2 + dz ** 2);
    const verticalDistance = Math.abs(target.y - origin.y);
    const horizontalTravel = Math.min(
      MAX_RENDEZVOUS_SEGMENT_DISTANCE,
      Math.max(0, horizontalDistance - stopDistance),
    );
    if (Number.isFinite(horizontalDistance) && horizontalDistance > stopDistance && horizontalTravel > 0) {
      return {
        x: origin.x + (dx / horizontalDistance) * horizontalTravel,
        y: origin.y,
        z: origin.z + (dz / horizontalDistance) * horizontalTravel,
      };
    }

    // 高低差は一度に飛ばさず、現在のx/zで一段ずつ観測する。
    // 空中・地中の直線waypointを生成しないため、未観測ならhazard判定で停止する。
    if (Number.isFinite(verticalDistance) && verticalDistance > stopDistance) {
      const verticalStep = MAX_RENDEZVOUS_WAYPOINT_VERTICAL_ADJUSTMENT;
      return {
        x: origin.x,
        y: origin.y + Math.sign(target.y - origin.y) * verticalStep,
        z: origin.z,
      };
    }

    if (!Number.isFinite(horizontalDistance) || !Number.isFinite(verticalDistance)) {
      return { ...origin };
    }

    // stopDistanceは3次元距離なので、水平距離が短くても高低差2段以上を
    // 1回のGoalNearへ渡さない。次の区間で再観測しながら一段ずつ進める。
    const verticalStep = Math.min(MAX_RENDEZVOUS_WAYPOINT_VERTICAL_ADJUSTMENT, verticalDistance);
    return {
      x: target.x,
      y: origin.y + Math.sign(target.y - origin.y) * verticalStep,
      z: target.z,
    };
  }

  /** raw waypointと同じXZ列だけを、目的地方向へ最大一段補正する。 */
  private selectRendezvousWaypoint(
    targetBot: Bot,
    origin: RendezvousPosition,
    target: RendezvousPosition,
    stopDistance: number,
    context: RendezvousSafetyStopContext,
  ): RendezvousWaypointSelection {
    const rawWaypoint = this.normalizeRendezvousWaypoint(
      this.buildRendezvousWaypoint(origin, target, stopDistance),
    );
    const originCell = this.normalizeRendezvousWaypoint(origin);
    const candidates = [rawWaypoint];
    const verticalDirection = Math.sign(target.y - origin.y);
    if (verticalDirection !== 0) {
      candidates.push({
        ...rawWaypoint,
        y: rawWaypoint.y + verticalDirection * MAX_RENDEZVOUS_WAYPOINT_VERTICAL_ADJUSTMENT,
      });
    }

    let safeCandidateInOriginCell = false;
    for (const candidate of candidates) {
      if (Math.abs(candidate.y - originCell.y) > MAX_RENDEZVOUS_WAYPOINT_VERTICAL_ADJUSTMENT) {
        continue;
      }
      const inspection = this.inspectRendezvousWaypointBlocks(targetBot, candidate);
      if (inspection.ok) {
        if (
          candidate.x === originCell.x &&
          candidate.y === originCell.y &&
          candidate.z === originCell.z
        ) {
          safeCandidateInOriginCell = true;
          continue;
        }
        return { ok: true, waypoint: candidate };
      }
      if (inspection.reason !== 'unsupported_floor') {
        return this.failRendezvousWaypointSelection(context, inspection.reason);
      }
    }
    if (safeCandidateInOriginCell) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.NO_PATH };
    }
    return this.failRendezvousWaypointSelection(context, 'unsupported_floor');
  }

  private failRendezvousWaypointSelection(
    context: RendezvousSafetyStopContext,
    reason:
      | 'block_reader_absent'
      | 'unsupported_floor'
      | 'liquid_or_hazardous_block'
      | 'observation_unavailable',
  ): RendezvousWaypointSelection {
    const error = reason === 'observation_unavailable'
      ? RENDEZVOUS_ERROR_CODES.OBSERVATION_UNAVAILABLE
      : RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED;
    return {
      ok: false,
      error: this.logAndReturnRendezvousSafetyStop(context, reason, error),
    };
  }

  private normalizeRendezvousWaypoint(position: RendezvousPosition): RendezvousPosition {
    return {
      x: Math.floor(position.x),
      y: Math.floor(position.y),
      z: Math.floor(position.z),
    };
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

  private inspectRendezvousWaypointBlocks(
    targetBot: Bot,
    position: RendezvousPosition,
  ): RendezvousWaypointInspection {
    const botWithBlocks = targetBot as Bot & {
      blockAt?: (position: Vec3, forceLoad?: boolean) => unknown;
    };
    if (typeof botWithBlocks.blockAt !== 'function') {
      return { ok: false, reason: 'block_reader_absent' };
    }

    const center = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    const checks = [center, center.offset(0, 1, 0), center.offset(0, -1, 0)];
    const blocks: unknown[] = [];
    try {
      for (const checkPosition of checks) {
        const block = botWithBlocks.blockAt(checkPosition, true);
        if (!block) {
          return { ok: false, reason: 'observation_unavailable' };
        }
        blocks.push(block);
      }
    } catch {
      return { ok: false, reason: 'observation_unavailable' };
    }

    const classifications = blocks.map((block) => this.classifyRendezvousBlock(block));
    if (classifications.some((classification) => classification === 'unknown')) {
      return { ok: false, reason: 'observation_unavailable' };
    }
    if (classifications.some((classification) => classification === 'hazard')) {
      return { ok: false, reason: 'liquid_or_hazardous_block' };
    }
    if (
      classifications[0] !== 'empty' ||
      classifications[1] !== 'empty' ||
      classifications[2] !== 'solid'
    ) {
      return { ok: false, reason: 'unsupported_floor' };
    }

    return { ok: true };
  }

  private inspectRendezvousHazard(
    targetBot: Bot,
    position: RendezvousPosition,
    context: RendezvousSafetyStopContext,
  ): RendezvousErrorCode | null {
    const botWithBlocks = targetBot as Bot & {
      blockAt?: (position: Vec3, forceLoad?: boolean) => unknown;
      entities?: Record<string, RendezvousEntity | undefined>;
    };
    if (typeof botWithBlocks.blockAt !== 'function') {
      return this.logAndReturnRendezvousSafetyStop(
        context,
        'block_reader_absent',
        RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED,
      );
    }

    const inspection = this.inspectRendezvousWaypointBlocks(targetBot, position);
    if (!inspection.ok && inspection.reason === 'observation_unavailable') {
      return this.logAndReturnRendezvousSafetyStop(
        context,
        'observation_unavailable',
        RENDEZVOUS_ERROR_CODES.OBSERVATION_UNAVAILABLE,
      );
    }
    if (!inspection.ok && inspection.reason === 'liquid_or_hazardous_block') {
      return this.logAndReturnRendezvousSafetyStop(
        context,
        'liquid_or_hazardous_block',
        RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED,
      );
    }
    if (!inspection.ok) {
      return this.logAndReturnRendezvousSafetyStop(
        context,
        'unsupported_floor',
        RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED,
      );
    }

    if (this.hasNearbyHostile(targetBot, position, botWithBlocks.entities)) {
      return this.logAndReturnRendezvousSafetyStop(
        context,
        'nearby_hostile',
        RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED,
      );
    }

    return null;
  }

  private logAndReturnRendezvousSafetyStop(
    context: RendezvousSafetyStopContext,
    reason: RendezvousSafetyStopReason,
    error: RendezvousErrorCode,
  ): RendezvousErrorCode {
    this.logRendezvousSafetyStop(context, reason, error);
    return error;
  }

  /** 安全停止の診断値は固定enumだけに限定し、world/entityの値をログへ渡さない。 */
  private logRendezvousSafetyStop(
    context: RendezvousSafetyStopContext,
    reason: RendezvousSafetyStopReason,
    error: RendezvousErrorCode,
  ): void {
    console.warn('[RendezvousSafetyStop]', {
      phase: context.phase,
      reason,
      error,
      gotoStarted: context.gotoStarted,
    });
  }

  private classifyRendezvousBlock(block: unknown): RendezvousBlockClassification {
    if (!block || typeof block !== 'object') {
      return 'unknown';
    }
    const candidate = block as {
      boundingBox?: unknown;
      liquid?: unknown;
      name?: unknown;
      properties?: unknown;
      isWaterlogged?: unknown;
      waterlogged?: unknown;
    };
    if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
      return 'unknown';
    }
    if (typeof candidate.boundingBox !== 'string' || candidate.boundingBox.trim() === '') {
      return 'unknown';
    }

    const name = candidate.name.toLowerCase();
    const normalizedName = name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name;
    const boundingBox = candidate.boundingBox.toLowerCase();
    if (
      candidate.liquid === true ||
      candidate.isWaterlogged === true ||
      (typeof candidate.isWaterlogged === 'string' && candidate.isWaterlogged.toLowerCase() === 'true') ||
      candidate.waterlogged === true ||
      (typeof candidate.waterlogged === 'string' && candidate.waterlogged.toLowerCase() === 'true') ||
      this.isRendezvousWaterlogged(candidate.properties) ||
      boundingBox === 'liquid' ||
      normalizedName === 'bubble_column' ||
      name.includes('water') ||
      name.includes('lava') ||
      name.includes('magma')
    ) {
      return 'hazard';
    }
    const isAirName = normalizedName === 'air' || normalizedName === 'cave_air' || normalizedName === 'void_air';
    if (boundingBox === 'empty' || isAirName) {
      return 'empty';
    }
    if (boundingBox === 'block') {
      return 'solid';
    }
    return 'unknown';
  }

  private isRendezvousWaterlogged(properties: unknown): boolean {
    if (!properties || typeof properties !== 'object') {
      return false;
    }
    const waterlogged = (properties as { waterlogged?: unknown }).waterlogged;
    return waterlogged === true || (typeof waterlogged === 'string' && waterlogged.toLowerCase() === 'true');
  }

  private hasNearbyHostile(
    targetBot: Bot,
    position: RendezvousPosition,
    entities: Record<string, RendezvousEntity | undefined> | undefined,
  ): boolean {
    for (const entity of Object.values(entities ?? {})) {
      if (!entity || entity === targetBot.entity) {
        continue;
      }
      const type = String(entity.type ?? '').toLowerCase();
      const kind = String(entity.kind ?? '').toLowerCase();
      if (type !== 'hostile' && !kind.includes('hostile')) {
        continue;
      }
      const entityPosition = this.readRendezvousPosition(entity.position);
      if (entityPosition && this.distanceBetween(position, entityPosition) <= HOSTILE_CLEARANCE_RADIUS) {
        return true;
      }
    }
    return false;
  }

  private hasNearbyHostileAlongSegment(
    targetBot: Bot,
    start: RendezvousPosition,
    end: RendezvousPosition,
    entities: Record<string, RendezvousEntity | undefined> | undefined,
  ): boolean {
    const distance = this.distanceBetween(start, end);
    const sampleCount = Math.max(1, Math.ceil(distance / (HOSTILE_CLEARANCE_RADIUS / 2)));
    for (let index = 0; index <= sampleCount; index += 1) {
      const ratio = index / sampleCount;
      const sample = {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio,
        z: start.z + (end.z - start.z) * ratio,
      };
      if (this.hasNearbyHostile(targetBot, sample, entities)) {
        return true;
      }
    }
    return false;
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

  private isRendezvousDeadlineExpired(rendezvousDeadlineAt: number): boolean {
    return this.resolveRendezvousRemainingMs(rendezvousDeadlineAt) <= 0;
  }

  private resolveRendezvousTimeoutMs(rendezvousDeadlineAt?: number): number {
    const configured = this.options.rendezvousTimeoutMs;
    const segmentTimeoutMs = typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_RENDEZVOUS_TIMEOUT_MS;
    if (rendezvousDeadlineAt === undefined) {
      return segmentTimeoutMs;
    }
    return Math.min(segmentTimeoutMs, this.resolveRendezvousRemainingMs(rendezvousDeadlineAt));
  }

  private resolveRendezvousCancelGraceMs(): number {
    const configured = this.options.rendezvousCancelGraceMs;
    if (typeof configured !== 'number' || !Number.isFinite(configured) || configured < 0) {
      return DEFAULT_RENDEZVOUS_CANCEL_GRACE_MS;
    }
    return Math.min(Math.floor(configured), MAX_RENDEZVOUS_CANCEL_GRACE_MS);
  }

  private resolveRendezvousMaxRetries(): number {
    const configured = this.options.rendezvousMaxRetries;
    return typeof configured === 'number' && Number.isInteger(configured) && configured >= 0
      ? Math.min(configured, 3)
      : DEFAULT_RENDEZVOUS_MAX_RETRIES;
  }

  private async gotoRendezvousWithTimeout(
    targetBot: Bot,
    goal: InstanceType<typeof goals.GoalNear>,
    movements: MovementsClass,
    rendezvousDeadlineAt?: number,
  ): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | null = null;
    let timedOut = false;
    let gotoSettled = false;
    if (rendezvousDeadlineAt !== undefined && this.isRendezvousDeadlineExpired(rendezvousDeadlineAt)) {
      this.stopRendezvousMovement(targetBot);
      throw new Error('rendezvous timeout');
    }
    const gotoPromise = this.gotoRendezvousOnce(targetBot, goal, movements);
    const gotoSettlement = gotoPromise.then(
      () => {
        gotoSettled = true;
      },
      () => {
        gotoSettled = true;
      },
    );
    this.rendezvousCleanup = gotoSettlement;

    try {
      await Promise.race([
        gotoPromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            this.stopRendezvousMovement(targetBot);
            reject(new Error('rendezvous timeout'));
          }, this.resolveRendezvousTimeoutMs(rendezvousDeadlineAt));
        }),
      ]);
      // gotoのfinally（movement profileの復元）まで完了してから返す。
      await gotoSettlement;
      if (this.rendezvousCleanup === gotoSettlement) {
        this.rendezvousCleanup = null;
      }
    } catch (error) {
      if (!timedOut) {
        await gotoSettlement;
        if (this.rendezvousCleanup === gotoSettlement) {
          this.rendezvousCleanup = null;
        }
        throw error;
      }

      // mineflayerのsetGoal(null)は通常次のevent loopでgotoをrejectする。
      // 非協調fakeでも有限graceだけ待ち、返答後に既存gotoが動き続けないようにする。
      await Promise.race([gotoSettlement, this.delay(this.resolveRendezvousCancelGraceMs())]);
      if (gotoSettled && this.rendezvousCleanup === gotoSettlement) {
        this.rendezvousCleanup = null;
      } else if (!gotoSettled) {
        // pathfinderが停止イベントを返さない境界では、Bot自体を切断して
        // 制御不能な移動を残さない。切断操作の例外はtimeout分類へ隠す。
        this.disconnectRendezvousBot(targetBot);
      }
      throw error;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private stopRendezvousMovement(targetBot: Bot): void {
    try {
      targetBot.pathfinder.setGoal(null);
    } catch {
      // 停止操作の一部が失敗しても固定timeout分類を維持する。
    }
    try {
      const pathfinder = targetBot.pathfinder as typeof targetBot.pathfinder & {
        stop?: () => void;
      };
      pathfinder.stop?.();
    } catch {
      // 停止操作の一部が失敗しても固定timeout分類を維持する。
    }
    try {
      const stoppableBot = targetBot as Bot & {
        clearControlStates?: () => void;
        stopDigging?: () => void;
      };
      stoppableBot.clearControlStates?.();
      stoppableBot.stopDigging?.();
    } catch {
      // 停止操作の一部が失敗しても固定timeout分類を維持する。
    }
  }

  private disconnectRendezvousBot(targetBot: Bot): void {
    try {
      const disconnectableBot = targetBot as Bot & { quit?: () => void };
      disconnectableBot.quit?.();
    } catch {
      // timeout分類と、未解消cleanupのlockを維持する。
    }
  }

  private async gotoRendezvousOnce(
    targetBot: Bot,
    goal: InstanceType<typeof goals.GoalNear>,
    movements: MovementsClass,
  ): Promise<void> {
    const { pathfinder: activePathfinder } = targetBot;
    const previousMovements = activePathfinder.movements;
    const shouldRestoreMovements = previousMovements !== movements;
    if (shouldRestoreMovements) {
      activePathfinder.setMovements(movements);
    }
    try {
      await activePathfinder.goto(goal);
    } finally {
      if (shouldRestoreMovements) {
        activePathfinder.setMovements(previousMovements);
      }
    }
  }

  private classifyRendezvousPathError(error: unknown): RendezvousErrorCode {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (message.includes('timeout') || message.includes('timed out')) {
      return RENDEZVOUS_ERROR_CODES.TIMEOUT;
    }
    if (message.includes('no path') || message.includes('nopath')) {
      return RENDEZVOUS_ERROR_CODES.NO_PATH;
    }
    return RENDEZVOUS_ERROR_CODES.PATH_FAILED;
  }

  private distanceBetween(first: RendezvousPosition, second: RendezvousPosition): number {
    return Math.sqrt(
      (first.x - second.x) ** 2 +
        (first.y - second.y) ** 2 +
        (first.z - second.z) ** 2,
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
