import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { acquireMovementControl } from './movementControl.js';

export interface LocalPosition { x: number; y: number; z: number }
type Box = [number, number, number, number, number, number];
type ObservedBlock = { shapes: Box[]; hazard: boolean };
export type LocalResult = { ok: true } | { ok: false; error: string };
const EPS = 0.001;
const WIDTH = 0.3;
const HEIGHT = 1.8;
const RADIUS = 12;
const MAX_NODES = 2048;
const MAX_READS = 24000;
const MAX_STEPS = 256;
const HAZARD = /water|lava|magma|fire|cactus|sweet_berry|powder_snow|campfire|bubble_column|wither_rose|portal|cobweb/;
const NARROW_SUPPORT = /fence|wall|pane|end_rod|chain/;
const distance = (a: LocalPosition, b: LocalPosition) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
// 実移動の微小な位置ずれで、詰まったedgeや訪問済みcellの記憶が失効しない。
const key = (p: LocalPosition) => `${Math.floor(p.x)},${Math.round(p.y * 2) / 2},${Math.floor(p.z)}`;
const pointKey = (p: LocalPosition) => `${p.x},${p.y},${p.z}`;
export const localEdgeKey = (a: LocalPosition, b: LocalPosition) => `${key(a)}>${key(b)}`;
export function readLocalPosition(p: unknown): LocalPosition | null {
  const v = p as LocalPosition | null;
  return v && [v.x, v.y, v.z].every(Number.isFinite) ? { x: v.x, y: v.y, z: v.z } : null;
}

/** 一回の探索に限った観測キャッシュ。次の移動前に作り直し、古い地形を安全根拠にしない。 */
export class LocalTerrain {
  private readonly blocks = new Map<string, ObservedBlock | null>();
  unknown = false;
  exhausted = false;
  constructor(private readonly bot: Pick<Bot, 'blockAt'>) {}

  private block(x: number, y: number, z: number): ObservedBlock | null {
    const id = `${x},${y},${z}`;
    if (this.blocks.has(id)) return this.blocks.get(id)!;
    if (this.blocks.size >= MAX_READS) { this.exhausted = true; return null; }
    let result: ObservedBlock | null = null;
    try {
      const b = this.bot.blockAt(new Vec3(x, y, z), false);
      if (b && typeof b.name === 'string') {
        const props = typeof b.getProperties === 'function' ? b.getProperties() : {};
        const waterlogged = props.waterlogged === true || props.waterlogged === 'true';
        const shapes = b.shapes;
        // collision shape不明をfull cubeや空気へ推定しない。
        if (Array.isArray(shapes) && shapes.every(s => s.length === 6 && s.every(Number.isFinite))) {
          result = { shapes: shapes as Box[], hazard: HAZARD.test(b.name) || waterlogged || NARROW_SUPPORT.test(b.name) };
        }
      }
    } catch { /* 未ロード・観測失敗は通行不可。 */ }
    if (!result) this.unknown = true;
    this.blocks.set(id, result);
    return result;
  }

  clearBody(p: LocalPosition): boolean {
    for (let x = Math.floor(p.x - WIDTH + EPS); x <= Math.floor(p.x + WIDTH - EPS); x++) {
      for (let z = Math.floor(p.z - WIDTH + EPS); z <= Math.floor(p.z + WIDTH - EPS); z++) {
        for (let y = Math.floor(p.y + EPS); y <= Math.floor(p.y + HEIGHT - EPS); y++) {
          const b = this.block(x, y, z);
          if (!b || b.hazard) return false;
          if (b.shapes.some(s => x + s[0] < p.x + WIDTH - EPS && x + s[3] > p.x - WIDTH + EPS &&
            z + s[2] < p.z + WIDTH - EPS && z + s[5] > p.z - WIDTH + EPS &&
            y + s[1] < p.y + HEIGHT - EPS && y + s[4] > p.y + EPS)) return false;
        }
      }
    }
    return true;
  }

  surfaces(x: number, z: number, nearY: number): LocalPosition[] {
    const out: LocalPosition[] = [];
    for (let y = Math.floor(nearY) - 2; y <= Math.floor(nearY) + 1; y++) {
      const b = this.block(Math.floor(x), y, Math.floor(z));
      if (!b || b.hazard) continue;
      const localX = x - Math.floor(x), localZ = z - Math.floor(z);
      const tops = b.shapes.filter(s => s[0] <= localX && s[3] >= localX && s[2] <= localZ && s[5] >= localZ).map(s => y + s[4]);
      for (const top of new Set(tops)) {
        const p = { x, y: top, z };
        if (Math.abs(top - nearY) <= 1 + EPS && this.clearBody(p)) out.push(p);
      }
    }
    return out.sort((a, b) => Math.abs(a.y - nearY) - Math.abs(b.y - nearY));
  }

  standable(p: LocalPosition): boolean {
    if (!this.clearBody(p)) return false;
    let supported = false;
    // 段差の縁では身体の後端が支持される。中心cellだけで落下と誤判定しない。
    for (let x = Math.floor(p.x - WIDTH + EPS); x <= Math.floor(p.x + WIDTH - EPS); x++) {
      for (let z = Math.floor(p.z - WIDTH + EPS); z <= Math.floor(p.z + WIDTH - EPS); z++) {
        for (let y = Math.floor(p.y - EPS); y <= Math.floor(p.y); y++) {
          const b = this.block(x, y, z);
          if (!b || b.hazard) return false;
          if (b.shapes.some(s => Math.abs(y + s[4] - p.y) < 0.08 &&
            x + s[0] < p.x + WIDTH - EPS && x + s[3] > p.x - WIDTH + EPS &&
            z + s[2] < p.z + WIDTH - EPS && z + s[5] > p.z - WIDTH + EPS)) supported = true;
        }
      }
    }
    return supported;
  }

  /** cardinalな一歩だけ。上りは跳躍空間、下りは最大一段と全幅の通過空間を検査。 */
  edgeClear(a: LocalPosition, b: LocalPosition): boolean {
    if (Math.hypot(a.x - b.x, a.z - b.z) > 1.5 || Math.abs(a.y - b.y) > 1 + EPS || !this.standable(b)) return false;
    const jump = b.y - a.y > 0.6;
    const travelY = Math.max(a.y, b.y) + (jump ? 0.25 : 0);
    // 足上げ前と着地前の垂直空間も確認する。
    for (const p of [a, b]) {
      for (let y = p.y; y <= travelY + EPS; y += 0.2) if (!this.clearBody({ ...p, y })) return false;
    }
    for (let i = 0; i <= 8; i++) {
      if (!this.clearBody({ x: a.x + (b.x - a.x) * i / 8, y: travelY, z: a.z + (b.z - a.z) * i / 8 })) return false;
    }
    return true;
  }
}

export interface LocalPlan {
  path: LocalPosition[];
  reached: boolean;
  expanded: number;
  unknown: boolean;
}

/** 観測済みの歩行面を自前のA*で探索。未知領域へは踏み込まず、到達済みの前縁で再観測する。 */
export function planLocalRoute(terrain: LocalTerrain, origin: LocalPosition, target: LocalPosition,
  stopDistance: number, blocked = new Set<string>(), visits = new Map<string, number>(),
  dangerous: (p: LocalPosition) => boolean = () => false, deadlineAt = Infinity): LocalPlan {
  type Node = { p: LocalPosition; g: number; f: number; parent?: Node };
  const start: Node = { p: origin, g: 0, f: distance(origin, target) };
  const open = [start];
  const scores = new Map([[pointKey(origin), 0]]);
  let best = start, reached = false, expanded = 0;
  const progress = (n: Node) => distance(n.p, target) + (visits.get(key(n.p)) ?? 0) * 2;
  while (open.length && expanded < MAX_NODES && !terrain.exhausted && Date.now() < deadlineAt) {
    let index = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[index].f) index = i;
    const node = open.splice(index, 1)[0];
    if (node.g !== scores.get(pointKey(node.p))) continue;
    expanded++;
    if (progress(node) < progress(best)) best = node;
    if (distance(node.p, target) <= stopDistance) { best = node; reached = true; break; }
    const centered = { x: Math.floor(node.p.x) + 0.5, z: Math.floor(node.p.z) + 0.5 };
    const columns = [[centered.x + 1, centered.z], [centered.x - 1, centered.z],
      [centered.x, centered.z + 1], [centered.x, centered.z - 1]];
    // 実位置がcellの端にある場合、まず同じcellの中心へ安全に寄れる候補も含む。
    if (Math.hypot(node.p.x - centered.x, node.p.z - centered.z) > 0.05) columns.unshift([centered.x, centered.z]);
    for (const [x, z] of columns) {
      if (Math.abs(x - origin.x) > RADIUS || Math.abs(z - origin.z) > RADIUS) continue;
      for (const p of terrain.surfaces(x, z, node.p.y)) {
        if (Math.abs(p.y - origin.y) > 6 || dangerous(p) || blocked.has(localEdgeKey(node.p, p)) || !terrain.edgeClear(node.p, p)) continue;
        const g = node.g + distance(node.p, p) + (visits.get(key(p)) ?? 0) * 2;
        if (g >= (scores.get(pointKey(p)) ?? Infinity)) continue;
        scores.set(pointKey(p), g);
        open.push({ p, g, f: g + Math.max(0, distance(p, target) - stopDistance), parent: node });
      }
    }
  }
  const path: LocalPosition[] = [];
  while (best.parent) { path.unshift(best.p); best = best.parent; }
  return { path, reached, expanded, unknown: terrain.unknown };
}

function hostileNear(bot: Bot, p: LocalPosition): boolean {
  return Object.values(bot.entities ?? {}).some(e => e && e !== bot.entity &&
    (e.kind === 'Hostile mobs' || /hostile/i.test(String(e.type) + String(e.kind))) &&
    readLocalPosition(e.position) && distance(p, e.position) <= 4);
}

/** 座標・対象名・raw例外は診断境界へ渡さない。 */
function event(name: 'planned' | 'step_started' | 'step_completed' | 'replan' | 'stopped',
  reason: 'route' | 'frontier' | 'stuck' | 'changed' | 'arrived' | 'failed' | 'timeout' | 'physics_stalled' | 'unavailable' | 'no_path', count = 0): void {
  console.info('[LocalNavigation]', { event: name, reason, count: Math.min(MAX_STEPS, Math.max(0, count)) });
}

function releaseControls(bot: Bot): void {
  try { bot.clearControlStates(); }
  catch {
    for (const control of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const) {
      try { bot.setControlState(control, false); } catch { /* 切断後のpacket書込み失敗を外へ出さない。 */ }
    }
  }
}

/** 物理tickを待つ間にもwall-clock期限を持ち、切断・physics停止でlistenerを残さない。 */
function tick(bot: Bot, deadlineAt: number): Promise<'tick' | 'ended' | 'timeout'> {
  return new Promise(resolve => {
    const finish = (result: 'tick' | 'ended' | 'timeout') => { clearTimeout(timer); bot.removeListener('physicsTick', onTick); bot.removeListener('end', onEnd); resolve(result); };
    const onTick = () => finish('tick'), onEnd = () => finish('ended');
    const timer = setTimeout(() => finish('timeout'), Math.max(0, Math.min(500, deadlineAt - Date.now())));
    bot.once('physicsTick', onTick);
    bot.once('end', onEnd);
  });
}

export async function walkLocalStep(bot: Bot, destination: LocalPosition, deadlineAt: number,
  current: () => boolean): Promise<'arrived' | 'stuck' | 'changed' | 'timeout' | 'physics_stalled' | 'unavailable'> {
  const origin = readLocalPosition(bot.entity?.position);
  if (!origin) return 'unavailable';
  const until = Math.min(deadlineAt, Date.now() + 4000);
  let bestDistance = distance(origin, destination), progressAt = Date.now();
  let lookFailed = false;
  try {
    releaseControls(bot);
    while (Date.now() < until) {
      if (!current()) return 'unavailable';
      const p = readLocalPosition(bot.entity?.position);
      if (!p) return 'unavailable';
      const terrain = new LocalTerrain(bot);
      const dx = destination.x - origin.x, dz = destination.z - origin.z;
      const projection = Math.max(0, Math.min(1, ((p.x - origin.x) * dx + (p.z - origin.z) * dz) / Math.max(EPS, dx * dx + dz * dz)));
      const deviation = Math.hypot(p.x - origin.x - projection * dx, p.z - origin.z - projection * dz);
      // 一段降りる瞬間は支持がなくても正常。計画した着地面と落下幅で判定する。
      if (deviation > 0.5 || p.y < Math.min(origin.y, destination.y) - 0.25 ||
        !terrain.clearBody(p) ||
        hostileNear(bot, p) || hostileNear(bot, destination) || !terrain.edgeClear(origin, destination)) return 'changed';
      const horizontal = Math.hypot(p.x - destination.x, p.z - destination.z);
      if (horizontal < 0.2 && Math.abs(p.y - destination.y) < 0.15 && bot.entity.onGround) {
        releaseControls(bot);
        // 入力解除後の慣性まで見届けてから次の観測へ進む。
        for (let i = 0; i < 10; i++) {
          const v = bot.entity?.velocity;
          if (v && Math.hypot(v.x, v.z) < 0.025 && bot.entity.onGround) return 'arrived';
          const update = await tick(bot, deadlineAt);
          if (!current() || update === 'ended') return 'unavailable';
          if (update === 'timeout') return Date.now() >= deadlineAt ? 'timeout' : 'physics_stalled';
        }
        return 'stuck';
      }
      const d = distance(p, destination);
      if (d < bestDistance - 0.04) { bestDistance = d; progressAt = Date.now(); }
      if (Date.now() - progressAt > 1200) return 'stuck';
      if (lookFailed) return 'unavailable';
      void bot.look(Math.atan2(-(destination.x - p.x), -(destination.z - p.z)), 0, true).catch(() => { lookFailed = true; });
      bot.setControlState('forward', horizontal >= 0.16);
      bot.setControlState('jump', destination.y > p.y + 0.6 && bot.entity.onGround);
      const update = await tick(bot, until);
      if (!current() || update === 'ended') return 'unavailable';
      if (update === 'timeout') return Date.now() >= deadlineAt ? 'timeout' : Date.now() >= until ? 'stuck' : 'physics_stalled';
    }
    return Date.now() >= deadlineAt ? 'timeout' : 'stuck';
  } finally {
    releaseControls(bot);
    // 失敗時にも慣性を落としてから再計画する。接続断やtick停止では有限で抜ける。
    for (let i = 0; i < 10 && current() && Date.now() < deadlineAt; i++) {
      const v = bot.entity?.velocity;
      if (!v || (Math.hypot(v.x, v.z) < 0.025 && bot.entity.onGround)) break;
      if (await tick(bot, Math.min(deadlineAt, Date.now() + 100)) !== 'tick') break;
    }
  }
}

export async function navigateLocally(bot: Bot, options: {
  stopDistance: number; deadlineAt: number; current: () => boolean;
  dimensionMatches?: () => boolean;
  target: () => Promise<{ ok: true; position: LocalPosition } | { ok: false; error: string }>;
}): Promise<LocalResult> {
  const blocked = new Set<string>(), visits = new Map<string, number>();
  let failures = 0;
  let release: (() => void) | null = null;
  const fail = (error: string): LocalResult => {
    event('stopped', error === 'rendezvous_timeout' ? 'timeout' : error === 'rendezvous_no_path' ? 'no_path' : error === 'rendezvous_bot_unavailable' ? 'unavailable' : 'failed');
    return { ok: false, error };
  };
  try {
    if (typeof bot.setControlState !== 'function' || typeof bot.look !== 'function' || typeof bot.blockAt !== 'function') return fail('rendezvous_path_failed');
    // 別の経路実行中なら制御を奪わない。探索機能そのものは呼び出さない。
    if (bot.pathfinder?.isMoving?.() || bot.targetDigBlock) return fail('rendezvous_busy');
    release = acquireMovementControl(bot);
    if (!release) return fail('rendezvous_busy');
    for (let step = 0; step < MAX_STEPS; step++) {
      if (Date.now() >= options.deadlineAt) return fail('rendezvous_timeout');
      if (!options.current()) return fail('rendezvous_bot_unavailable');
      if (options.dimensionMatches && !options.dimensionMatches()) return fail('rendezvous_dimension_mismatch');
      const target = await options.target();
      if (!target.ok) return fail(target.error);
      if (Date.now() >= options.deadlineAt) return fail('rendezvous_timeout');
      const origin = readLocalPosition(bot.entity?.position);
      if (!origin || !options.current()) return fail('rendezvous_bot_unavailable');
      if (options.dimensionMatches && !options.dimensionMatches()) return fail('rendezvous_dimension_mismatch');
      const terrain = new LocalTerrain(bot);
      if (!terrain.standable(origin)) return fail(terrain.unknown ? 'rendezvous_observation_unavailable' : 'rendezvous_hazard_blocked');
      if (hostileNear(bot, origin) || hostileNear(bot, target.position)) return fail('rendezvous_hazard_blocked');
      if (distance(origin, target.position) <= options.stopDistance) { event('stopped', 'arrived'); return { ok: true }; }
      const route = planLocalRoute(terrain, origin, target.position, options.stopDistance, blocked, visits, p => hostileNear(bot, p), options.deadlineAt);
      event('planned', route.reached ? 'route' : 'frontier', route.path.length);
      if (Date.now() >= options.deadlineAt) return fail('rendezvous_timeout');
      const next = route.path[0];
      if (!next) return fail(route.unknown ? 'rendezvous_observation_unavailable' : 'rendezvous_no_path');
      event('step_started', 'route', step);
      const result = await walkLocalStep(bot, next, options.deadlineAt,
        () => options.current() && (options.dimensionMatches?.() ?? true));
      if (result === 'timeout') return fail('rendezvous_timeout');
      if (result === 'physics_stalled') { event('stopped', 'physics_stalled'); return { ok: false, error: 'rendezvous_timeout' }; }
      if (result === 'unavailable') return fail(options.dimensionMatches && !options.dimensionMatches()
        ? 'rendezvous_dimension_mismatch' : 'rendezvous_bot_unavailable');
      if (result !== 'arrived') {
        blocked.add(localEdgeKey(origin, next));
        visits.set(key(next), (visits.get(key(next)) ?? 0) + 4);
        event('replan', result);
        if (++failures >= 8) return fail('rendezvous_no_path');
      } else {
        visits.set(key(next), (visits.get(key(next)) ?? 0) + 1);
        event('step_completed', 'route', step);
      }
    }
    return fail('rendezvous_distance_limit');
  } catch { return fail('rendezvous_path_failed'); }
  finally { if (release) { releaseControls(bot); release(); } }
}
