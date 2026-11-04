import { CONFIG } from '../config.js';
import { clockFor } from './clock.js';

/**
 * Server-authoritative flashlight.
 *
 * The client only ever asks to switch it on or off. Whether that is allowed
 * (night, alive, charged), how much battery is left, and what the beam reveals
 * are all decided here, so a modified client cannot see further than the rules
 * allow: the extra sight is computed into `visible` in playerView, never drawn
 * by the client on its own.
 *
 * The battery integrates lazily from timestamps rather than on a timer, so it
 * stays exact however often (or rarely) state is sent.
 */

export function gameClock(state, now = Date.now()) {
  if (state.started && state.clockStartedAt == null) state.clockStartedAt = now;
  return clockFor({
    startedAt: state.started ? state.clockStartedAt : null,
    now,
    cycleMs: CONFIG.DAY.CYCLE_MS,
    startHour: CONFIG.DAY.START_HOUR,
  });
}

function advance(state, p, now) {
  const D = CONFIG.DAY;
  const f = (p.flashlight ??= { on: false, battery: D.BATTERY_MAX, at: now });
  const dt = Math.max(0, now - f.at) / 1000;
  if (f.on) {
    f.battery = Math.max(0, f.battery - D.BATTERY_DRAIN_PER_S * dt);
    if (f.battery === 0) f.on = false;
  } else {
    f.battery = Math.min(D.BATTERY_MAX, f.battery + D.BATTERY_RECHARGE_PER_S * dt);
  }
  // Dawn and death both put the light out.
  if (f.on && (!p.alive || gameClock(state, now).phase !== 'NIGHT')) f.on = false;
  f.at = now;
  return f;
}

/** What the HUD shows. `available` is false by day and when dead. */
export function flashlightState(state, p, now = Date.now()) {
  const f = advance(state, p, now);
  return {
    on: f.on,
    battery: Math.round(f.battery),
    max: CONFIG.DAY.BATTERY_MAX,
    available: p.alive && gameClock(state, now).phase === 'NIGHT',
  };
}

/**
 * Toggle request from a player. Returns { ok, reason } so the client can tell
 * a rule (DAY, EMPTY, DEAD) apart from a network problem.
 */
export function setFlashlight(state, playerId, on, now = Date.now()) {
  const p = state.players[playerId];
  if (!p) return { ok: false, reason: 'NO_SEAT' };
  const f = advance(state, p, now);
  if (!on) { f.on = false; return { ok: true }; }
  if (!p.alive) return { ok: false, reason: 'DEAD' };
  if (gameClock(state, now).phase !== 'NIGHT') return { ok: false, reason: 'DAY' };
  if (f.battery < CONFIG.DAY.BATTERY_MIN_TO_START) return { ok: false, reason: 'EMPTY' };
  f.on = true;
  return { ok: true };
}
