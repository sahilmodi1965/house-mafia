/**
 * curator.js — minimal helpers for per-player private Supabase channels.
 *
 * Secret payloads (role assignments, Mafia partner reveal, Host investigation
 * results) must never touch the shared room channel, because every subscriber
 * to that channel receives every frame and can read secrets out of the
 * network panel. Instead we use one private channel per player, named
 * `room:<code>:player:<playerId>`. Only the game host and that one player
 * subscribe to it, so secrets are delivered point-to-point.
 *
 * This file is intentionally tiny. A fuller `viewFor(state, playerId)`
 * curator refactor is tracked separately and is out of scope here.
 */

/**
 * Canonical name for a player's private channel.
 * Stable per (roomCode, playerId) pair so both host and player can compute it.
 */
export function privateChannelName(roomCode, playerId) {
  return `room:${roomCode}:player:${playerId}`;
}

/**
 * Create and subscribe to a per-player private channel.
 * Returns a promise that resolves to the subscribed channel.
 *
 * Used by:
 *  - each joiner, to subscribe to their OWN private channel so they can
 *    receive secret payloads directed at them.
 *  - the host, to subscribe to EACH player's private channel so it can
 *    broadcast secrets to that player (Supabase requires the channel be
 *    subscribed before `channel.send()` will deliver).
 *
 * We ALSO attach a tiny buffer listener at subscribe-time: any `role:assign`
 * that arrives before the game loop attaches its real handler is stashed on
 * `ch.__bufferedRoleAssign`. game.js drains this buffer when it attaches.
 * This avoids a race where the host sends role:assign before the joiner's
 * game.js handler is wired up.
 */
export function subscribeToPrivate(supabase, roomCode, playerId) {
  const name = privateChannelName(roomCode, playerId);
  const ch = supabase.channel(name, {
    config: { broadcast: { self: true } },
  });
  ch.__bufferedRoleAssign = null;
  ch.on('broadcast', { event: 'role:assign' }, (msg) => {
    ch.__bufferedRoleAssign = msg.payload;
  });
  return new Promise((resolve, reject) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') resolve(ch);
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        reject(new Error(`Private channel ${name} failed: ${status}`));
      }
    });
  });
}
