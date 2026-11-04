import { CONFIG, TEAM } from '../config.js';
import { distance, isWalkable } from './maze.js';
import { bearingTo, tileDistance } from './directions.js';

/**
 * SECURITY-CRITICAL MODULE.
 *
 * Fog of war is computed here, on the server, and the client is NEVER sent
 * state it shouldn't see. Do not "send everything and hide it in the renderer" —
 * anyone can open devtools and win the game. This is the one security property
 * that actually matters in this project.
 *
 * Line of sight uses Bresenham against wall tiles, so corners genuinely block
 * vision. Radius alone (a circle) feels wrong in a maze — you'd see through walls.
 */

export function visionRadiusFor(player, effects) {
  let r = CONFIG.GAME.VISION_RADIUS;
  if (effects.lantern?.has(player.id)) r *= 2;
  if (effects.blackout && !effects.blackoutSource?.has(player.id)) r = Math.max(1, Math.floor(r / 2));
  return r;
}

/** Bresenham line — returns true if nothing blocks the way. */
export function hasLineOfSight(maze, from, to) {
  let x0 = from.x, y0 = from.y;
  const x1 = to.x, y1 = to.y;
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (!(x0 === x1 && y0 === y1)) {
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
    if (x0 === x1 && y0 === y1) break;
    if (!isWalkable(maze, x0, y0)) return false;
  }
  return true;
}

/**
 * How far sight carries straight down an unobstructed corridor.
 * Scales with the same powerups that scale the near bubble.
 */
export function corridorSightFor(player, effects) {
  let reach = CONFIG.GAME.CORRIDOR_SIGHT;
  if (effects.lantern?.has(player.id)) reach *= 2;
  if (effects.blackout && !effects.blackoutSource?.has(player.id)) reach = Math.max(2, Math.floor(reach / 2));
  return reach;
}

/**
 * Set of "x,y" tile keys this player can currently see.
 *
 * Two components, because a single radius cannot express "you see the road
 * you are standing on":
 *
 *   NEAR BUBBLE  — a tight radius around you, so you always know your
 *                  immediate surroundings and which way the exits from this
 *                  tile lead.
 *   CORRIDOR RAY — sight carries much further straight down an open line, and
 *                  stops dead at the first wall.
 *
 * A plain radius lights a symmetric blob through nothing but line-of-sight,
 * which in a first-person view is wrong in both directions at once: too
 * generous sideways (you see into the mouths of side passages) and far too
 * mean forwards (a long straight corridor goes black three tiles out, even
 * though in reality you could see all the way down it).
 *
 * The flanking walls of a lit corridor tile are added too. Without them the
 * floor of the passage lights up between two black voids, which reads as a
 * bridge over a chasm rather than a hallway.
 */
export function computeVisible(maze, player, effects) {
  const radius = visionRadiusFor(player, effects);
  const reach = corridorSightFor(player, effects);
  const n = maze.tiles.length;
  const visible = new Set([`${player.pos.x},${player.pos.y}`]);

  const inBounds = (x, y) => x >= 0 && y >= 0 && x < n && y < n;

  // ── Near bubble ───────────────────────────────────────────────────────────
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = player.pos.x + dx, y = player.pos.y + dy;
      if (!inBounds(x, y)) continue;
      if (distance(player.pos, { x, y }) > radius) continue;
      if (!hasLineOfSight(maze, player.pos, { x, y })) continue;
      visible.add(`${x},${y}`);
    }
  }

  // ── Corridor rays ─────────────────────────────────────────────────────────
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (const [dx, dy] of DIRS) {
    for (let i = 1; i <= reach; i++) {
      const x = player.pos.x + dx * i, y = player.pos.y + dy * i;
      if (!inBounds(x, y)) break;

      if (!isWalkable(maze, x, y)) {
        visible.add(`${x},${y}`);   // you can see the wall you stop at
        break;
      }
      visible.add(`${x},${y}`);

      // The two walls flanking this stretch of corridor.
      for (const [px, py] of [[dy, dx], [-dy, -dx]]) {
        const fx = x + px, fy = y + py;
        if (inBounds(fx, fy) && !isWalkable(maze, fx, fy)) visible.add(`${fx},${fy}`);
      }
    }
  }

  return visible;
}

/**
 * Build the state packet for ONE human player. Everything they must not know
 * is stripped here, not in the client.
 */
/**
 * What a Saboteur needs to know about the kill they are (or are not) making.
 *
 * Elimination is automatic: stand next to a Loyalist for ELIMINATION_TICKS with
 * no witness and they die. There is no button, deliberately, because the whole
 * premise is that a bought advisor kills you by ROUTING you rather than by
 * anyone hitting a key. But automatic and invisible are different things: with
 * no readout a saboteur standing on a victim cannot tell whether the mechanic
 * is broken, whether a witness is blocking them, or whether to hold position.
 *
 * Mirrors the rules in resolveEliminations exactly. If that changes, change
 * this, or the HUD starts lying about a kill that will not land.
 *
 * Returns null for Loyalists - they must never learn they are being stalked.
 */
function stalkStateFor(state, me) {
  if (me.team !== TEAM.SABOTEUR || !me.alive) return null;

  const loys = Object.values(state.players).filter(p => p.alive && p.team === TEAM.LOYALIST);
  const target = loys.find(l => distance(me.pos, l.pos) <= 1);
  if (!target) return { adjacent: false };

  const witness = loys.find(w =>
    w.id !== target.id &&
    computeVisible(state.maze, w, state.effects).has(`${target.pos.x},${target.pos.y}`)
  );

  const held = me.adjacentSince == null ? 0 : state.tick - me.adjacentSince;
  return {
    adjacent: true,
    target: { id: target.id, name: target.name },
    witnessed: Boolean(witness),
    witness: witness ? witness.name : null,
    ticksHeld: held,
    ticksNeeded: CONFIG.GAME.ELIMINATION_TICKS,
  };
}

export function playerView(state, playerId) {
  const me = state.players[playerId];
  if (!me) return null;

  const visible = computeVisible(state.maze, me, state.effects);

  /**
   * Teams are HIDDEN from players.
   *
   * They used to be public, which meant a Loyalist who saw a red silhouette
   * simply walked the other way and the saboteur could never close the
   * distance. Elimination needs a full tick of adjacency, so a visible killer
   * is a harmless one, and the corruption economy collapses with it: nobody
   * pays to misdirect a player who can already see the threat.
   *
   * The rule is: you always know your own team, and saboteurs know each other
   * because they have to coordinate. Everyone else reads as `null`, and the
   * client has no team to colour by. Concealment happens HERE, on the server.
   * Sending the real team and hiding it in CSS would leave it in the socket
   * frame for anyone with devtools open.
   */
  const knowsTeamOf = p =>
    p.id === playerId || (me.team === TEAM.SABOTEUR && p.team === TEAM.SABOTEUR);

  const others = Object.values(state.players)
    .filter(p => p.id !== playerId && p.alive)
    .filter(p => visible.has(`${p.pos.x},${p.pos.y}`))
    .filter(p => !(state.effects.ghost?.has(p.id) && p.team !== me.team))
    .map(p => ({
      id: p.id, name: p.name, pos: p.pos,
      team: knowsTeamOf(p) ? p.team : null,
    }));

  const decoys = (state.effects.decoys ?? [])
    .filter(d => d.hiddenFrom !== me.team && visible.has(`${d.pos.x},${d.pos.y}`))
    .map(d => ({ id: d.id, name: '???', team: null, pos: d.pos, decoy: true }));

  return {
    // The maze LAYOUT is not secret — the player is standing in it and would
    // map it by walking anyway. What's secret is what they can see RIGHT NOW:
    // which tiles are lit, and which players are where. Sending the layout lets
    // the client build geometry once; `visible` below is what actually gates
    // information, and it's computed here rather than in the renderer.
    maze: state.maze.tiles,
    you: {
      id: me.id, name: me.name, team: me.team, pos: me.pos, alive: me.alive,
      visionRadius: visionRadiusFor(me, state.effects),
      frozen: state.effects.freeze?.has(me.id) ?? false,
      sprinting: state.effects.sprint?.has(me.id) ?? false,
    },
    // Saboteurs only. Null for everyone else, so a Loyalist's client never
    // holds the information that someone is standing on them.
    stalk: stalkStateFor(state, me),
    visible: [...visible],
    others: [...others, ...decoys],
    // The extraction point is public, like the maze layout — it's a marked
    // exit, not a secret. `exitOpen` is what changes: until the tasks are
    // done, standing on it does nothing.
    exit: state.exit ?? null,
    exitOpen: state.tasksComplete >= CONFIG.GAME.TASKS_TO_WIN,
    survivorsToEscape: CONFIG.GAME.SURVIVORS_TO_ESCAPE,
    // Same concealment as `others`. Deaths stay public (you can see a body),
    // and the advisor's retainer stays public because that is the one thing
    // the game wants you reasoning about instead of team colour.
    roster: Object.values(state.players).map(p => ({
      id: p.id, name: p.name, alive: p.alive,
      team: knowsTeamOf(p) ? p.team : null,
      agentGoal: p.agent.goalWeight,   // public: how corruptible their advisor is
    })),
    tick: state.tick,
    totalTicks: CONFIG.GAME.TOTAL_TICKS,
    phase: state.phase,
    tasksComplete: state.tasksComplete,
    tasksToWin: CONFIG.GAME.TASKS_TO_WIN,
    briefing: me.agent.lastBriefing ?? null,

    /**
     * Where the advisor is pointing you, as a bearing rather than a
     * coordinate. The HUD draws an arrow; the player still cannot read a grid
     * reference, and still cannot verify the arrow is honest.
     */
    guide: me.agent.lastTarget ? {
      bearing: bearingTo(me.pos, me.agent.lastTarget),
      distance: tileDistance(me.pos, me.agent.lastTarget),
    } : null,

    /**
     * The objective, in one line, always on screen.
     * Playtesters could not tell what they were supposed to be doing, which
     * is fatal for a game whose whole tension depends on knowing the stakes.
     */
    objective: objectiveFor(state, me),
    started: Boolean(state.started),
    // NOTE: agent channel is deliberately absent. Players never see it.
  };
}

/**
 * One sentence telling this player what winning looks like right now.
 * Team-specific, phase-specific, and short enough to read at a glance.
 */
function objectiveFor(state, me) {
  const done = state.tasksComplete;
  const need = CONFIG.GAME.TASKS_TO_WIN;

  if (!me.alive) return 'You are dead. Watch how it ends.';
  if (state.winner) return `${state.winner} win.`;
  if (!state.started) return 'Waiting for the host to start.';

  if (me.team === TEAM.SABOTEUR) {
    const loyal = Object.values(state.players).filter(p => p.alive && p.team === TEAM.LOYALIST).length;
    return `Cut the loyalists to ${CONFIG.GAME.LOYALISTS_ALIVE_TO_LOSE} (${loyal} left), or stall the tasks past the clock.`;
  }

  if (done >= need) {
    return `All tasks done. Get ${CONFIG.GAME.SURVIVORS_TO_ESCAPE} of you to the exit.`;
  }
  return `Complete ${need - done} more task${need - done === 1 ? '' : 's'}, then escape with ${CONFIG.GAME.SURVIVORS_TO_ESCAPE}.`;
}

/** Spectators see everything. This is the demo view. */
export function spectatorView(state) {
  return {
    maze: state.maze.tiles,
    players: Object.values(state.players).map(p => ({
      id: p.id, name: p.name, team: p.team, pos: p.pos, alive: p.alive,
      balance: Number(p.agent.balance.toFixed(2)),
      goalWeight: p.agent.goalWeight,
      bribed: p.agent.bribesReceived.length > 0,
      lastBriefing: p.agent.lastBriefing,
      briefingIsCorrupted: p.agent.lastBriefingCorrupted ?? false,
    })),
    channel: state.channel.slice(-60),
    ledger: state.ledger,
    tasks: state.tasks,
    exit: state.exit ?? null,
    exitOpen: state.tasksComplete >= CONFIG.GAME.TASKS_TO_WIN,
    survivorsToEscape: CONFIG.GAME.SURVIVORS_TO_ESCAPE,
    tick: state.tick,
    totalTicks: CONFIG.GAME.TOTAL_TICKS,
    phase: state.phase,
    tasksComplete: state.tasksComplete,
    winner: state.winner,
    // Mock runs mint well-formed but fake tx hashes, which are indistinguishable
    // from real ones by inspection. The spectator needs to be told, or it
    // renders explorer links to transactions that do not exist — the worst
    // possible thing to put on screen in front of an audience.
    mockChain: CONFIG.MOCK_CHAIN,
    explorer: CONFIG.CHAIN.EXPLORER,
  };
}
