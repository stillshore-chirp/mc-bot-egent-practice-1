import { WebSocket } from 'ws';
import type { Tracer } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';

import { isSupportedCommandType, startCommandServer } from '../runtime/server.js';
import type { CommandResponse } from '../runtime/types.js';

interface FakeTracerFixture {
  tracer: Tracer;
  span: {
    end: ReturnType<typeof vi.fn>;
    setAttribute: ReturnType<typeof vi.fn>;
    setAttributes: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
}

function createFakeTracer(): FakeTracerFixture {
  const span = {
    end: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
  };
  return {
    tracer: {
      startActiveSpan: vi.fn(async (_name: string, callback: (activeSpan: typeof span) => unknown) => callback(span)),
    } as unknown as Tracer,
    span,
  };
}

function waitForListening(server: ReturnType<typeof startCommandServer>): Promise<void> {
  if (server.address()) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForSocketMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(data.toString()));
    socket.once('error', reject);
  });
}

function closeSocket(socket: WebSocket | null): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.close();
  });
}

describe('command server command contract', () => {
  it('followPlayer is accepted by the Node command allow-list', () => {
    expect(isSupportedCommandType('followPlayer')).toBe(true);
  });

  it('unknown command names remain rejected', () => {
    expect(isSupportedCommandType('followPlayerRaw')).toBe(false);
    expect(isSupportedCommandType({ type: 'followPlayer' })).toBe(false);
  });

  it('gatherStatusは完全な応答をwireへ送り、ログは固定値だけにする', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sentinelName = 'SentinelPlayer';
    // 整数3桁はランダムUUID/ポートと偶然一致する。小数付きの識別可能な座標を使う。
    const sentinelPosition = { x: 731.125811, y: 811.375907, z: 907.625731 };
    const sentinelResponse: CommandResponse = {
      ok: false,
      error: 'raw-error-sentinel',
      data: {
        player: sentinelName,
        position: sentinelPosition,
        inventory: [{ item: 'diamond-sentinel', count: 64 }],
        perception: 'raw-perception-sentinel',
      },
    };
    const telemetry = createFakeTracer();
    const server = startCommandServer(
      { host: '127.0.0.1', port: 0 },
      {
        tracer: telemetry.tracer,
        executeCommand: vi.fn(async () => sentinelResponse),
      },
    );
    let socket: WebSocket | null = null;

    try {
      await waitForListening(server);
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('test server did not expose a TCP address');
      }

      socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
      await waitForSocketOpen(socket);
      const responsePromise = waitForSocketMessage(socket);
      socket.send(JSON.stringify({ type: 'gatherStatus', args: {} }));

      await expect(responsePromise).resolves.toBe(JSON.stringify(sentinelResponse));
      expect(telemetry.span.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'command_error' }),
      );
      const serializedSpanStatus = JSON.stringify(telemetry.span.setStatus.mock.calls);
      expect(serializedSpanStatus).not.toContain('raw-error-sentinel');
      expect(serializedSpanStatus).not.toContain(sentinelName);
      for (const value of Object.values(sentinelPosition)) expect(serializedSpanStatus).not.toContain(String(value));
      const sendLog = log.mock.calls.find(([message]) => message === '[WS] sending gatherStatus response');
      expect(sendLog).toEqual([
        '[WS] sending gatherStatus response',
        { ok: false, errorClass: 'command_error' },
      ]);
      const serializedLogs = JSON.stringify(log.mock.calls);
      expect(serializedLogs).not.toContain(sentinelName);
      for (const value of Object.values(sentinelPosition)) expect(serializedLogs).not.toContain(String(value));
      expect(serializedLogs).not.toContain('diamond-sentinel');
      expect(serializedLogs).not.toContain('raw-perception-sentinel');
      expect(serializedLogs).not.toContain('raw-error-sentinel');
    } finally {
      await closeSocket(socket);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
