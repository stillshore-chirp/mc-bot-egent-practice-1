import { describe, expect, it, vi } from 'vitest';

import {
  PlayerPositionBridgeClient,
  PlayerPositionLookupError,
} from '../runtime/playerPositionBridge.js';

const NOW = Date.parse('2026-09-21T00:00:00.000Z');

describe('PlayerPositionBridgeClient', () => {
  it('認証付きの完全一致位置照会を固定payloadで送信し、観測値を検証する', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://bridge.test/v1/players/position');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('X-API-Key')).toBe('example-api-key');
      expect(init?.body).toBe(JSON.stringify({ player: 'player' }));
      return new Response(
        JSON.stringify({
          ok: true,
          position: { x: 12, y: 64, z: -4 },
          dimension: 'minecraft:overworld',
          observed_at: '2026-09-20T23:59:59.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const client = new PlayerPositionBridgeClient(
      { baseUrl: 'http://bridge.test/', apiKey: 'example-api-key', maxObservationAgeMs: 2_000 },
      { fetch: fetcher, now: () => NOW },
    );

    await expect(client.lookup('player')).resolves.toEqual({
      position: { x: 12, y: 64, z: -4 },
      dimension: 'minecraft:overworld',
      observedAt: NOW - 1_000,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('404は対象不在、その他のHTTP失敗は照会不能へ固定分類する', async () => {
    const notFound = new PlayerPositionBridgeClient(
      { baseUrl: 'http://bridge.test', apiKey: 'key' },
      { fetch: vi.fn(async () => new Response('', { status: 404 })) },
    );
    await expect(notFound.lookup('player')).rejects.toMatchObject({ kind: 'not_found' });

    const unavailable = new PlayerPositionBridgeClient(
      { baseUrl: 'http://bridge.test', apiKey: 'key' },
      { fetch: vi.fn(async () => new Response('', { status: 503 })) },
    );
    await expect(unavailable.lookup('player')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('401は認証失敗として固定分類する', async () => {
    const unauthorized = new PlayerPositionBridgeClient(
      { baseUrl: 'http://bridge.test', apiKey: 'example-api-key' },
      { fetch: vi.fn(async () => new Response('', { status: 401 })) },
    );

    await expect(unauthorized.lookup('player')).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('古い観測値・不正な名前・不正な座標を受理しない', async () => {
    const stale = new PlayerPositionBridgeClient(
      { baseUrl: 'http://bridge.test', apiKey: 'key', maxObservationAgeMs: 1_000 },
      {
        fetch: vi.fn(async () => new Response(JSON.stringify({
          position: { x: 1, y: 2, z: 3 },
          dimension: 'overworld',
          observed_at: NOW - 2_000,
        }), { status: 200 })),
        now: () => NOW,
      },
    );
    await expect(stale.lookup('player')).rejects.toMatchObject({ kind: 'stale' });

    const invalidName = new PlayerPositionBridgeClient(
      { baseUrl: 'http://bridge.test', apiKey: 'key' },
      { fetch: vi.fn() },
    );
    await expect(invalidName.lookup('player name')).rejects.toMatchObject({ kind: 'invalid' });

    const invalidPosition = new PlayerPositionBridgeClient(
      { baseUrl: 'http://bridge.test', apiKey: 'key' },
      {
        fetch: vi.fn(async () => new Response(JSON.stringify({
          position: { x: '1', y: 2, z: 3 },
          dimension: 'overworld',
          observed_at: NOW,
        }), { status: 200 })),
        now: () => NOW,
      },
    );
    await expect(invalidPosition.lookup('player')).rejects.toBeInstanceOf(PlayerPositionLookupError);
    await expect(invalidPosition.lookup('player')).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('malformed JSONとtimeoutをraw例外へ変換し、timeout時はfetchをabortする', async () => {
    const malformed = new PlayerPositionBridgeClient(
      { baseUrl: 'http://bridge.test', apiKey: 'example-api-key' },
      { fetch: vi.fn(async () => new Response('{malformed', { status: 200 })) },
    );
    await expect(malformed.lookup('player')).rejects.toMatchObject({ kind: 'invalid' });

    let aborted = false;
    const timeout = new PlayerPositionBridgeClient(
      { baseUrl: 'http://bridge.test', apiKey: 'example-api-key', timeoutMs: 5 },
      {
        fetch: vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        })),
      },
    );
    await expect(timeout.lookup('player')).rejects.toMatchObject({ kind: 'timeout' });
    expect(aborted).toBe(true);
  });
});
