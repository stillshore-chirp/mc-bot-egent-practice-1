/** Botごとの操作排他。別Botへの再接続と独立し、二重releaseでも新ownerを解放しない。 */
const owners = new WeakMap<object, symbol>();
export function acquireMovementControl(bot: object): (() => void) | null {
  if (owners.has(bot)) return null;
  const owner = Symbol();
  owners.set(bot, owner);
  return () => { if (owners.get(bot) === owner) owners.delete(bot); };
}
