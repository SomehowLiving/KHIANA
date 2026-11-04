import { CONFIG } from '../config.js';

/**
 * Powerups resolve at the TICK BOUNDARY, never mid-tick. All last exactly one
 * tick. Cost is burned — paid out to the shop endpoint via x402, which is what
 * gives the economy its deflationary pressure.
 *
 * Conflict rule: if two agents buy conflicting effects on the same target,
 * the more expensive purchase wins. Money is the tiebreaker — thematically
 * correct for this game and trivial to implement.
 */

export function emptyEffects() {
  return {
    reveal: new Set(),        // agentIds who see the full map this tick
    lantern: new Set(),       // playerIds with doubled vision
    sprint: new Set(),        // playerIds at 2x movement
    ghost: new Set(),         // playerIds invisible to the enemy team
    freeze: new Set(),        // playerIds who cannot move
    jam: new Set(),           // agentIds who cannot message
    whisper: new Set(),       // agentIds whose traffic is hidden from the reveal
    trace: new Map(),         // agentId -> targetPlayerId
    decoys: [],               // { id, pos, hiddenFrom }
    blackout: false,
    blackoutSource: new Set(),// playerIds exempt from blackout (the caster's own)
    auditResults: new Map(),  // agentId -> { target, bribed }
    bounties: [],             // { id, poster, targetPlayer, tile, amount, claimed }
  };
}

/**
 * @param {Array} purchases  [{ agentId, playerId, team, type, target, tile, amount, cost, ts }]
 */
export function applyPurchases(state, purchases) {
  const effects = emptyEffects();

  // Sort by cost descending so the expensive purchase lands first and wins
  // any conflict; equal costs fall back to settlement timestamp.
  const ordered = [...purchases].sort((a, b) => (b.cost - a.cost) || (a.ts - b.ts));
  const usedThisTick = new Set();   // one purchase per agent per tick
  const claimed = new Set();        // slot keys already taken by a dearer buy

  for (const p of ordered) {
    if (usedThisTick.has(p.agentId)) continue;
    const spec = CONFIG.POWERUPS[p.type];
    if (!spec) continue;
    if (spec.team && spec.team !== p.team) continue;   // team-restricted

    // Slot conflicts. Because `ordered` is cost-descending, the first claimant
    // of a slot is by definition the most expensive one, so anything arriving
    // later loses. Without this, LANTERN (0.75) silently cancelled BLACKOUT
    // (2.00) back to normal vision — the cheap item beating the dear one,
    // which is the exact opposite of the documented rule.
    const conflict = CONFIG.POWERUP_CONFLICTS.CLAIMS[p.type];
    if (conflict) {
      const key = slotKey(conflict, p);
      const loses = key === null
        ? false
        : claimed.has(key) || (conflict.scope !== 'global' && claimed.has(`${conflict.slot}:*`));
      if (loses) continue;          // outbid: no effect, and the buy is not consumed
      if (key !== null) claimed.add(key);
    }

    usedThisTick.add(p.agentId);

    switch (p.type) {
      case 'REVEAL':
        effects.reveal.add(p.agentId);
        break;

      case 'LANTERN':
        effects.lantern.add(p.playerId);
        break;

      case 'SPRINT':
        effects.sprint.add(p.playerId);
        break;

      case 'GHOST':
        // Ghost beats Reveal on the same target: Reveal is cheaper (1.0 < 1.5).
        effects.ghost.add(p.playerId);
        break;

      case 'WHISPER':
        // "A message its human never sees" (docs/POWERUPS.md #5).
        //
        // Humans never see agent messages at all in this design, so read
        // literally the powerup is a no-op — it was an empty case burning
        // 0.50 for nothing. The one place a human DOES learn what their agent
        // was told is the end-of-game ledger reveal, so that is what a whisper
        // buys: this agent's messages and bribes this tick are struck from the
        // per-player reveal.
        //
        // The audience still sees every whisper live on the spectator channel.
        // Only the victim is kept in the dark, permanently — which is the
        // dramatic irony the whole product is built around, sold for 0.50.
        effects.whisper.add(p.agentId);
        break;

      case 'TRACE':
        if (p.target) effects.trace.set(p.agentId, p.target);
        break;

      case 'DECOY':
        effects.decoys.push({
          id: `decoy_${p.agentId}_${state.tick}`,
          pos: p.tile,
          hiddenFrom: p.team,   // your own team isn't fooled by your decoy
        });
        break;

      case 'JAM':
        if (p.target) effects.jam.add(p.target);
        break;

      case 'FREEZE':
        if (p.target) effects.freeze.add(p.target);
        break;

      case 'BLACKOUT':
        effects.blackout = true;
        effects.blackoutSource.add(p.playerId);
        break;

      case 'AUDIT': {
        const target = state.players[p.target];
        if (target) {
          const recent = target.agent.bribesReceived.filter(
            b => state.tick - b.tick <= 3
          );
          // Deliberately reports only WHETHER, never from whom. This is what
          // makes a 0.1 MON nuisance payment a viable bluff.
          effects.auditResults.set(p.agentId, {
            target: p.target,
            bribed: recent.length > 0,
          });
        }
        break;
      }

      case 'BOUNTY':
        effects.bounties.push({
          id: `bounty_${p.agentId}_${state.tick}`,
          poster: p.agentId,
          targetPlayer: p.target,
          tile: p.tile,
          amount: Math.max(p.amount ?? CONFIG.POWERUPS.BOUNTY.cost, CONFIG.POWERUPS.BOUNTY.cost),
          claimed: false,
        });
        break;
    }
  }

  // Bounties persist across ticks until claimed or the game ends.
  effects.bounties.push(...(state.effects?.bounties ?? []).filter(b => !b.claimed));
  return effects;
}

/**
 * Check standing bounties against the board. Called after MOVE.
 * The agent responsible for a player's position claims the reward — which
 * creates the perfect deniable betrayal: "I didn't sell you out, I was just
 * routing you efficiently."
 */
export function resolveBounties(state) {
  const claims = [];
  for (const b of state.effects.bounties) {
    if (b.claimed) continue;
    const target = state.players[b.targetPlayer];
    if (!target?.alive) continue;
    if (target.pos.x === b.tile.x && target.pos.y === b.tile.y) {
      b.claimed = true;
      claims.push({ bounty: b, claimant: target.agent.id, amount: b.amount });
    }
  }
  return claims;
}

/**
 * Which slot a purchase occupies, or null if it can't be resolved.
 *
 * A 'global' buy claims `slot:*`, which every per-player claim on that slot
 * then defers to — that is how BLACKOUT outranks LANTERN for everyone at once
 * without needing to enumerate the eight players it affects.
 */
function slotKey(conflict, p) {
  if (conflict.scope === 'global') return `${conflict.slot}:*`;
  const subject = conflict.scope === 'target' ? p.target : p.playerId;
  return subject ? `${conflict.slot}:${subject}` : null;
}

export function affordablePowerups(agent, team) {
  return Object.entries(CONFIG.POWERUPS)
    .filter(([, spec]) => !spec.team || spec.team === team)
    .filter(([, spec]) => spec.cost <= agent.balance)
    .map(([name, spec]) => ({ name, cost: spec.cost, desc: spec.desc }));
}
