// 日本語コメント：Paper Bridge のプレイヤー位置照会設定を一箇所で正規化する
// 役割：URL・API keyをログへ出さず、Node側clientへDI可能な設定として渡す

export interface PlayerPositionBridgeResolution {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxObservationAgeMs: number;
  enabled: boolean;
  warnings: string[];
}

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:19071';
const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_OBSERVATION_AGE_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10_000;
const MIN_MAX_OBSERVATION_AGE_MS = 1_000;
const MAX_MAX_OBSERVATION_AGE_MS = 120_000;

export function resolvePlayerPositionBridgeConfig(
  rawUrl: string | undefined,
  rawApiKey: string | undefined,
  rawTimeoutMs?: string,
  rawMaxObservationAgeMs?: string,
): PlayerPositionBridgeResolution {
  const warnings: string[] = [];
  const baseUrl = resolveBridgeUrl(rawUrl, warnings);
  const apiKey = (rawApiKey ?? '').trim();
  const timeoutMs = parseBoundedPositiveInt(
    rawTimeoutMs,
    DEFAULT_TIMEOUT_MS,
    'BRIDGE_PLAYER_POSITION_TIMEOUT_MS',
    warnings,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );
  const maxObservationAgeMs = parseBoundedPositiveInt(
    rawMaxObservationAgeMs,
    DEFAULT_MAX_OBSERVATION_AGE_MS,
    'BRIDGE_PLAYER_POSITION_MAX_AGE_MS',
    warnings,
    MIN_MAX_OBSERVATION_AGE_MS,
    MAX_MAX_OBSERVATION_AGE_MS,
  );

  if (!apiKey) {
    warnings.push('BRIDGE_API_KEY が未設定のため Paper Bridge のプレイヤー位置照会を無効化します。');
  }

  return {
    baseUrl,
    apiKey,
    timeoutMs,
    maxObservationAgeMs,
    enabled: apiKey.length > 0,
    warnings,
  };
}

function resolveBridgeUrl(rawUrl: string | undefined, warnings: string[]): string {
  const candidate = (rawUrl ?? '').trim().replace(/\/+$/, '');
  if (!candidate) {
    return DEFAULT_BRIDGE_URL;
  }
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('unsupported bridge URL');
    }
    return candidate;
  } catch {
    warnings.push('BRIDGE_URL は安全なHTTP(S)接続先として解釈できないため既定値を利用します。');
    return DEFAULT_BRIDGE_URL;
  }
}

function parseBoundedPositiveInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  warnings: string[],
  minimum: number,
  maximum: number,
): number {
  const sanitized = (raw ?? '').trim();
  if (!sanitized) {
    return fallback;
  }
  if (!/^\d+$/.test(sanitized)) {
    warnings.push(`${label} は許容範囲外のため既定値を利用します。`);
    return fallback;
  }
  const parsed = Number(sanitized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    warnings.push(`${label} は許容範囲外のため既定値を利用します。`);
    return fallback;
  }
  return parsed;
}
