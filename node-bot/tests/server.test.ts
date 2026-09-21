import { describe, expect, it } from 'vitest';

import { isSupportedCommandType } from '../runtime/server.js';

describe('command server command contract', () => {
  it('followPlayer is accepted by the Node command allow-list', () => {
    expect(isSupportedCommandType('followPlayer')).toBe(true);
  });

  it('unknown command names remain rejected', () => {
    expect(isSupportedCommandType('followPlayerRaw')).toBe(false);
    expect(isSupportedCommandType({ type: 'followPlayer' })).toBe(false);
  });
});
