/**
 * Paper Bridge の権威的なプレイヤー位置照会を隔離するクライアント。
 *
 * このクライアントは対象名を完全一致で送信するだけで、自然言語を解釈しない。
 * HTTP 応答は座標・dimension・観測時刻を厳格に検証し、外部へ raw response や
 * 認証情報を返さない。実接続は DI された fetch に閉じ込め、unit test では呼び出さない。
 */

export interface PlayerPosition {
  x: number;
  y: number;
  z: number;
}

export interface PlayerPositionObservation {
  position: PlayerPosition;
  dimension: string;
  observedAt: number;
}

export type PlayerPositionLookupFailure =
  | 'not_found'
  | 'unavailable'
  | 'unauthorized'
  | 'invalid'
  | 'stale'
  | 'timeout';

export class PlayerPositionLookupError extends Error {
  readonly kind: PlayerPositionLookupFailure;

  constructor(kind: PlayerPositionLookupFailure) {
    super(kind);
    this.name = 'PlayerPositionLookupError';
    this.kind = kind;
  }
}

export interface PlayerPositionBridgeConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxObservationAgeMs?: number;
}

export interface PlayerPositionBridgeDependencies {
  fetch?: typeof fetch;
  now?: () => number;
}

const PLAYER_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_OBSERVATION_AGE_MS = 10_000;

export class PlayerPositionBridgeClient {
  private readonly config: Required<PlayerPositionBridgeConfig>;

  private readonly fetcher: typeof fetch;

  private readonly now: () => number;

  constructor(config: PlayerPositionBridgeConfig, dependencies: PlayerPositionBridgeDependencies = {}) {
    this.config = {
      baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
      apiKey: config.apiKey.trim(),
      timeoutMs: this.resolvePositiveNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS),
      maxObservationAgeMs: this.resolvePositiveNumber(config.maxObservationAgeMs, DEFAULT_MAX_OBSERVATION_AGE_MS),
    };
    this.fetcher = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
  }

  async lookup(targetName: string): Promise<PlayerPositionObservation> {
    if (!PLAYER_USERNAME_PATTERN.test(targetName)) {
      throw new PlayerPositionLookupError('invalid');
    }
    if (!this.config.baseUrl || !this.config.apiKey) {
      throw new PlayerPositionLookupError('unavailable');
    }

    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new PlayerPositionLookupError('timeout'));
      }, this.config.timeoutMs);
    });

    try {
      const response = await Promise.race([
        this.fetcher(`${this.config.baseUrl}/v1/players/position`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.config.apiKey,
          },
          body: JSON.stringify({ player: targetName }),
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);

      if (!response.ok) {
        if (response.status === 404) {
          throw new PlayerPositionLookupError('not_found');
        }
        if (response.status === 401 || response.status === 403) {
          throw new PlayerPositionLookupError('unauthorized');
        }
        throw new PlayerPositionLookupError('unavailable');
      }

      let payload: unknown;
      try {
        payload = await Promise.race([response.json(), timeoutPromise]);
      } catch (error) {
        if (error instanceof PlayerPositionLookupError) {
          throw error;
        }
        if (controller.signal.aborted) {
          throw new PlayerPositionLookupError('timeout');
        }
        throw new PlayerPositionLookupError('invalid');
      }
      return this.parseObservation(payload);
    } catch (error) {
      if (error instanceof PlayerPositionLookupError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new PlayerPositionLookupError('timeout');
      }
      throw new PlayerPositionLookupError('unavailable');
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private parseObservation(payload: unknown): PlayerPositionObservation {
    if (!payload || typeof payload !== 'object') {
      throw new PlayerPositionLookupError('invalid');
    }
    const candidate = payload as {
      position?: unknown;
      dimension?: unknown;
      observed_at?: unknown;
    };
    const position = this.parsePosition(candidate.position);
    const dimension = this.parseDimension(candidate.dimension);
    const observedAt = this.parseObservedAt(candidate.observed_at);
    if (!position || !dimension || observedAt === null) {
      throw new PlayerPositionLookupError('invalid');
    }

    if (Math.abs(this.now() - observedAt) > this.config.maxObservationAgeMs) {
      throw new PlayerPositionLookupError('stale');
    }

    return { position, dimension, observedAt };
  }

  private parsePosition(rawPosition: unknown): PlayerPosition | null {
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

  private parseDimension(rawDimension: unknown): string | null {
    if (typeof rawDimension !== 'string') {
      return null;
    }
    const dimension = rawDimension.trim().toLowerCase();
    return dimension && dimension !== 'unknown' ? dimension : null;
  }

  private parseObservedAt(rawObservedAt: unknown): number | null {
    if (typeof rawObservedAt === 'number' && Number.isFinite(rawObservedAt)) {
      return rawObservedAt < 1_000_000_000_000 ? rawObservedAt * 1_000 : rawObservedAt;
    }
    if (typeof rawObservedAt === 'string') {
      const parsed = Date.parse(rawObservedAt);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private resolvePositiveNumber(raw: number | undefined, fallback: number): number {
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }
}
