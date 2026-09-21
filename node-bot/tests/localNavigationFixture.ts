import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { vi } from 'vitest';

const require = createRequire(import.meta.url);
const mcData = require('minecraft-data')('1.21.1');
const Block = require('prismarine-block')('1.21.1');
const { Physics, PlayerState } = require('prismarine-physics');

/** 実ライブラリのcollision shapeと物理計算で基本操作を検証する。server接続の証跡ではない。 */
export function physicsFixture(world: (p: Vec3) => string | null = p => p.y < 64 ? 'stone' : 'air') {
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const emitter = new EventEmitter();
  const entity = { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true,
    yaw: 0, pitch: 0, effects: {}, attributes: {}, isInWater: false, isInLava: false, isInWeb: false,
    isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false };
  const target = { type: 'player', username: 'player', isValid: true, position: new Vec3(4.5, 64, 0.5) };
  const blockAt = vi.fn((p: Vec3) => {
    const pos = p.floored(), name = world(pos);
    if (name === null) return null;
    const block = Block.fromStateId(mcData.blocksByName[name].defaultState, 0);
    block.position = pos;
    return block;
  });
  const bot = Object.assign(emitter, {
    version: '1.21.1', entity, game: { dimension: 'overworld' }, players: { player: { username: 'player', entity: target } },
    entities: { target }, inventory: { slots: [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    blockAt, controlState: control,
    setControlState: vi.fn((name: string, value: boolean) => { control[name] = value; }),
    clearControlStates: vi.fn(() => { for (const name of Object.keys(control)) control[name] = false; }),
    look: vi.fn(async (yaw: number, pitch: number) => { entity.yaw = yaw; entity.pitch = pitch; }),
    pathfinder: { goto: vi.fn(() => { throw new Error('pathfinder must not run'); }), isMoving: () => false },
  }) as unknown as Bot;
  const physics = Physics(mcData, { getBlock: blockAt });
  const simulate = () => {
    physics.simulatePlayer(new PlayerState(bot, control), { getBlock: blockAt }).apply(bot);
    bot.emit('physicsTick');
  };
  return { bot, entity, target, control, simulate, blockAt };
}

export async function drive<T>(promise: Promise<T>, fixture: ReturnType<typeof physicsFixture>,
  beforeTick?: (index: number) => void): Promise<T> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 4000 && !done; i++) {
    await vi.advanceTimersByTimeAsync(50);
    beforeTick?.(i);
    fixture.simulate();
  }
  if (!done) throw new Error('navigation did not settle within test budget');
  return promise;
}
