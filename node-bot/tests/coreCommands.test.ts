import { describe, expect, it, vi } from 'vitest';

import {
  createCoreCommandHandlers,
  type CoreCommandDependencies,
} from '../runtime/commands/coreCommands.js';

describe('core command chat logging', () => {
  it('送信本文をログへ出さず、長さだけを記録する', () => {
    const message = 'player secret message';
    const sendChat = vi.fn(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const handlers = createCoreCommandHandlers({
      chatCommandMessenger: { sendChat },
    } as unknown as CoreCommandDependencies);

    try {
      expect(handlers.handleChatCommand({ text: message })).toEqual({ ok: true });
      expect(sendChat).toHaveBeenCalledWith(message);
      expect(log).toHaveBeenCalledWith(
        `[ChatCommand] sent in-game chat message length=${message.length}`,
      );
      expect(log.mock.calls.flat().some((value) => typeof value === 'string' && value.includes(message))).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});
