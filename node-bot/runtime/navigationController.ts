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
} as const;

export type RendezvousErrorCode = (typeof RENDEZVOUS_ERROR_CODES)[keyof typeof RENDEZVOUS_ERROR_CODES];

const PLAYER_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const DEFAULT_RENDEZVOUS_STOP_DISTANCE = 2;
const MIN_RENDEZVOUS_STOP_DISTANCE = 1;
const MAX_RENDEZVOUS_STOP_DISTANCE = 8;
const DEFAULT_RENDEZVOUS_TIMEOUT_MS = 30_000;
const DEFAULT_RENDEZVOUS_MAX_RETRIES = 2;
const TARGET_MOVED_DISTANCE = 1;
const HOSTILE_CLEARANCE_RADIUS = 4;
const MAX_RENDEZVOUS_SEGMENTS = 16;
const MAX_RENDEZVOUS_SEGMENT_DISTANCE = 16;

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
}

type RendezvousMovementFailure = { ok: false; error: RendezvousErrorCode };

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

  constructor(
    private readonly options: {
      moveGoalToleranceMeters: number;
      forcedMoveRetryWindowMs: number;
      forcedMoveMaxRetries: number;
      forcedMoveRetryDelayMs: number;
      /** 合流のpathfinder待機を有限にし、テストでは短い値を注入できる。 */
      rendezvousTimeoutMs?: number;
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
    if (!activeBot.pathfinder || typeof activeBot.pathfinder.goto !== 'function') {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.PATH_FAILED };
    }

    const botDimension = this.resolveBotDimension(activeBot);
    if (!botDimension) {
      return { ok: false, error: RENDEZVOUS_ERROR_CODES.DIMENSION_UNKNOWN };
    }

    const maxRetries = this.resolveRendezvousMaxRetries();
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const targetResolution = await this.resolveRendezvousTarget(activeBot, parsed.args.targetName, botDimension);
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

      const arrivedPosition = this.readRendezvousPosition(activeBot.entity.position);
      if (!arrivedPosition) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.BOT_UNAVAILABLE };
      }

      // 到着判定の直前にも対象を取り直す。Bridge観測値を成功条件としてキャッシュしない。
      const observedTarget = await this.resolveRendezvousTarget(activeBot, parsed.args.targetName, botDimension);
      if (!observedTarget.ok) {
        return { ok: false, error: observedTarget.error };
      }

      const observedTargetHazard = this.inspectRendezvousHazard(activeBot, observedTarget.target.position);
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
   * 未ロードの遠距離目的地へ一度に直行せず、観測可能な短い区間だけ進める。
   * 各区間の完了後に対象を再解決するため、Bridge の古い座標を無期限に追跡しない。
   */
  private async moveRendezvousSegments(
    targetBot: Bot,
    targetName: string,
    botDimension: string,
    stopDistance: number,
    initialTarget: RendezvousTargetSnapshot,
  ): Promise<RendezvousMovementResult | RendezvousMovementFailure> {
    let target = initialTarget;
    let previousBotPosition: RendezvousPosition | null = null;
    let targetMoved = false;

    for (let segment = 0; segment < MAX_RENDEZVOUS_SEGMENTS; segment += 1) {
      const botPosition = this.readRendezvousPosition(targetBot.entity?.position);
      if (!botPosition) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.BOT_UNAVAILABLE };
      }

      const currentHazard = this.inspectRendezvousHazard(targetBot, botPosition);
      if (currentHazard) {
        return { ok: false, error: currentHazard };
      }

      const distance = this.distanceBetween(botPosition, target.position);
      if (!Number.isFinite(distance)) {
        return { ok: false, error: RENDEZVOUS_ERROR_CODES.TARGET_UNAVAILABLE };
      }
      if (distance <= stopDistance) {
        return { ok: true, target };
      }

      // 目的地が遠距離かつBridge由来なら、未観測chunkのblockAt(null)を
      // 目的地の危険とも安全とも解釈しない。次のwaypointだけを検査する。
      if (target.source === 'entity' || distance <= MAX_RENDEZVOUS_SEGMENT_DISTANCE) {
        const targetHazard = this.inspectRendezvousHazard(targetBot, target.position);
        if (targetHazard) {
          return { ok: false, error: targetHazard };
        }
      }

      const waypoint = this.buildRendezvousWaypoint(botPosition, target.position, stopDistance);
      const waypointHazard = this.inspectRendezvousHazard(targetBot, waypoint);
      if (waypointHazard) {
        return { ok: false, error: waypointHazard };
      }
      const botWithEntities = targetBot as Bot & {
        entities?: Record<string, RendezvousEntity | undefined>;
      };
      if (this.hasNearbyHostileAlongSegment(targetBot, botPosition, waypoint, botWithEntities.entities)) {
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
        Math.min(stopDistance, this.options.moveGoalToleranceMeters),
      );
      const cautiousMovements = this.cautiousMovements ?? targetBot.pathfinder.movements;

      try {
        await this.gotoRendezvousWithTimeout(targetBot, goal, cautiousMovements);
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

      const observedTarget = await this.resolveRendezvousTarget(targetBot, targetName, botDimension);
      if (!observedTarget.ok) {
        return observedTarget;
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
      const verticalStep = Math.min(1, verticalDistance - stopDistance);
      return {
        x: origin.x,
        y: origin.y + Math.sign(target.y - origin.y) * verticalStep,
        z: origin.z,
      };
    }

    if (!Number.isFinite(horizontalDistance) || !Number.isFinite(verticalDistance)) {
      return { ...origin };
    }
    return { ...target };
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

  private inspectRendezvousHazard(targetBot: Bot, position: RendezvousPosition): RendezvousErrorCode | null {
    const botWithBlocks = targetBot as Bot & {
      blockAt?: (position: Vec3, forceLoad?: boolean) => unknown;
      entities?: Record<string, RendezvousEntity | undefined>;
    };
    if (typeof botWithBlocks.blockAt !== 'function') {
      return RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED;
    }

    const center = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    const checks = [center, center.offset(0, 1, 0), center.offset(0, -1, 0)];
    const blocks = [] as unknown[];
    try {
      for (const checkPosition of checks) {
        const block = botWithBlocks.blockAt(checkPosition, true);
        if (!block) {
          return RENDEZVOUS_ERROR_CODES.OBSERVATION_UNAVAILABLE;
        }
        blocks.push(block);
      }
    } catch {
      return RENDEZVOUS_ERROR_CODES.OBSERVATION_UNAVAILABLE;
    }

    if (blocks.some((block) => this.isRendezvousDangerousBlock(block))) {
      return RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED;
    }

    const below = blocks[2] as { boundingBox?: unknown; name?: unknown };
    const belowName = String(below.name ?? '').toLowerCase();
    if (below.boundingBox === 'empty' || belowName.includes('air')) {
      return RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED;
    }

    if (this.hasNearbyHostile(targetBot, position, botWithBlocks.entities)) {
      return RENDEZVOUS_ERROR_CODES.HAZARD_BLOCKED;
    }

    return null;
  }

  private isRendezvousDangerousBlock(block: unknown): boolean {
    if (!block || typeof block !== 'object') {
      return true;
    }
    const candidate = block as { liquid?: unknown; name?: unknown };
    const name = String(candidate.name ?? '').toLowerCase();
    return candidate.liquid === true || name.includes('water') || name.includes('lava') || name.includes('magma');
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

  private resolveRendezvousTimeoutMs(): number {
    const configured = this.options.rendezvousTimeoutMs;
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_RENDEZVOUS_TIMEOUT_MS;
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
  ): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        // timeout後の GoalChanged を通常移動のforcedMove retryへ渡さない。
        // 合流の再試行は呼び出し側の有限attemptだけが担当する。
        this.gotoRendezvousOnce(targetBot, goal, movements),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            try {
              targetBot.pathfinder.setGoal(null);
            } catch {
              // timeout分類を優先し、停止操作の例外は外部へ返さない。
            }
            reject(new Error('rendezvous timeout'));
          }, this.resolveRendezvousTimeoutMs());
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
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
