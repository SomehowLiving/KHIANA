# Game Logic

Everything here lives in `server/src/game/` and `server/src/rooms.js`. Numbers come from `server/src/config.js` and can be changed through `.env`.

## 0. Table size: 4 or 8 players

Each lobby picks its size when it's opened. The main table is always 8. The size sets these rules (`config.rulesFor`), stored on the game as `state.rules`:

| Rule | 8 players | 4 players |
|---|---|---|
| Saboteurs | 2 | 1 |
| Saboteurs win when Loyalists alive ≤ | 2 | 1 |
| Loyalists needed at the exit | 3 | 2 |
| CONVERGE task tiles | 4 | 3 |
| Maze | 24×24 | 10×10 (`MAZE_SIZE_4`) |

Everything else (prices, ticks, tasks 1–4, kills, powerups) is the same. The 4-player numbers were tuned over 10 seeds each: 8 players split 4 Loyalist / 6 Saboteur wins, 4 players 5 / 5. A 24×24 maze with 4 players gave Loyalists 8 of 10, because one Saboteur rarely found anyone.

## 1. Creating a game (`engine.createGame`)

A game comes from one **seed** number. The same seed always gives the same maze, teams, starting spots and tasks, which makes games replayable and testable.

1. **Maze** (`maze.generateMaze`): a 24×24 grid carved with a recursive backtracker, which gives exactly one path between any two points. Then about 12% of inside walls are knocked out (`LOOP_CARVE_RATIO`). Loops matter: with one path you can't dodge anyone and you can't hide.
2. **Spawns**: 8 floor tiles, spread out (more than 6 tiles apart where possible).
3. **Teams**: 2 seats picked from the seed are Saboteurs, the rest Loyalists.
4. **Advisors**: each gets 5 KHIA, a personality, and a loyalty score: `[90, 75, 60, 45, 85, 55, 70, 40]` by seat. A human can change theirs in the lobby.
5. **Exit**: the floor tile whose *nearest* spawn is farthest away, so nobody starts next to it.
6. **Tasks**: 5 tiles sets, kept at least 5 tiles apart.

## 2. The tick (`engine.runTick` + `rooms.startRoom`)

Each tick is 15 seconds (`TICK_MS`), 40 ticks per game (`TOTAL_TICKS`).

```
tick++ ─► reveal due tasks ─► refund lapsed bribes
   │
   ▼
DELIBERATE  every living, un-jammed advisor decides, in parallel
   │
   ▼
SETTLE      per advisor: messages (contact fees) → accepts (bribes) → purchase
   │        powerups take effect for this tick
   ▼
BRIEF       each advisor's briefing + target sent to its player
   │        corrupted? mark the bribe "followed" and release its escrow
   ▼
MOVE        humans move freely for 60% of the tick
   │
   ▼
RESOLVE     bots step → tasks → kills → bounties → win check
```

- Agent decisions land only at tick boundaries. Movement is real time inside the tick.
- The next tick starts only after this one finishes. If settlement runs long, the tick runs long; ticks never overlap.
- An advisor whose model call fails or times out (8s) falls back to the scripted brain for that tick.

## 3. Vision and fog (`fog.js`)

- **Near bubble**: radius 2 around you (`VISION_RADIUS`).
- **Corridor sight**: up to 7 tiles straight down an open corridor (`CORRIDOR_SIGHT`), stopped by walls.
- Line of sight uses Bresenham lines, so walls block what's behind them.
- LANTERN doubles both; BLACKOUT halves everyone's except the buyer's.
- You see other players only on tiles you can see. GHOST hides a player from the enemy team.

What players **don't** get: other players' teams (except Saboteurs see each other), the advisor channel, the ledger, task details. Saboteurs get a small "stalk" readout: am I next to a Loyalist, is there a witness, how long have I held.

## 4. Tasks (`tasks.js`)

| # | Task | Done when | Revealed at tick |
|---|---|---|---|
| 1 | CALIBRATE | 1 player stands on the tile | 0 |
| 2 | BRIDGE | 2 tiles occupied in the same tick | 7 |
| 3 | SEQUENCE | 3 tiles stepped on in order | 14 |
| 4 | HOLD | 1 tile occupied for 2 ticks in a row (resets if left) | 21 |
| 5 | CONVERGE | 4 tiles occupied at once | 28 |

- Checked at the end of each tick.
- **Only advisors know** where tasks are and what they need. Players are only told where to walk.
- Any living player counts, Saboteurs included.

## 5. Kills (`engine.resolveEliminations`)

There's no attack button. Each tick, for each Saboteur:

1. Find a living Loyalist next to it (distance ≤ 1).
2. If any *other* living Loyalist can see the **victim's** tile, it's witnessed: the timer resets.
3. Otherwise start a timer. After 1 full tick (`ELIMINATION_TICKS`) of staying adjacent, the Loyalist dies.
4. A Saboteur can kill at most one player per tick.

So the way to kill someone is to get them alone and keep them still, which is exactly what a bribed advisor can arrange.

## 6. Powerups (`powerups.js`, prices in `config.js`)

- Bought in the SETTLE phase, active for **this tick only**.
- Max 3 per advisor per game, 1 per tick. Some are team-only.
- **Conflicts**: if two purchases fight over the same slot (movement, vision, comms), the more expensive wins. FREEZE beats SPRINT, BLACKOUT beats LANTERN. GHOST beats REVEAL and TRACE when someone looks for a ghosted player.

| Powerup | Cost | Team | Effect |
|---|---|---|---|
| WHISPER | 0.50 | both | This tick's bribes are hidden from the victim's end-of-game reveal |
| LANTERN | 0.75 | both | Your player's vision doubles |
| SPRINT | 0.75 | both | Your player moves 2 tiles per step |
| REVEAL | 1.00 | both | Your advisor sees every player's position |
| DECOY | 1.00 | both | A fake player appears on a tile (not shown to your own team) |
| BOUNTY | ≥1.00 | both | Reward to whichever advisor gets a named player to a named tile |
| TRACE | 1.25 | both | See the last 3 tiles a named player walked |
| GHOST | 1.50 | both | Your player is invisible to the enemy team |
| JAM | 1.50 | both | A named advisor can't message next tick |
| FREEZE | 2.00 | Saboteur | A named player can't move |
| BLACKOUT | 2.00 | Saboteur | Everyone else's vision halves |
| AUDIT | 2.50 | Loyalist | Learn **whether** a named advisor took a bribe in the last 3 ticks (not from whom) |

All but BOUNTY burn their cost. BOUNTY holds the reward back from the poster; it's paid if delivered, returned at game end if not.

**Design rules** the prices must keep: a bribe (~1.00) stays cheaper than FREEZE; AUDIT costs more than a typical bribe; Saboteur items are the expensive ones.

## 7. Money inside a game

| Action | From → To |
|---|---|
| Contact fee 0.25 | sender → recipient advisor |
| Bribe | payer → escrow → bribed advisor (on delivery) or back to payer (if undelivered) |
| Powerup | buyer → burned |
| Bounty claim | poster → advisor of the delivered player |
| Payout | everyone → surviving winners, split evenly |

Rules that keep the books honest:
- A payment's money leaves the payer's balance **before** it's sent and comes back if it fails.
- The receiver is credited only **after** it lands. A bribe's taker is paid when the escrow releases.

## 8. Winning (`engine.checkWin`)

Checked at the end of every tick, in this order:
1. **Saboteurs win** if 2 or fewer Loyalists are alive.
2. **Loyalists win** if all 5 tasks are done **and** 3 living Loyalists stand on the exit together.
3. **At tick 40**: Loyalists win with 3+ tasks done, otherwise Saboteurs.

## 9. End of game (`engine.endGame`)

1. Unclaimed bounties go back to their posters.
2. **Payout**: all advisors' KHIA is pooled and split evenly among surviving players on the winning team. Dead players' advisors get nothing, whatever bribes they took. That's what stops betrayal from being free.
3. **Reveal**: per player, who paid their advisor, how much, for what instruction, and whether it was followed (WHISPERed bribes are left out of the victim's copy).
4. **Role proof**: the team assignments are revealed on-chain and checked against the hash published at the start.
5. Any bribe still in escrow is refunded to its payer.

On a live game, steps 2, 4 and 5 happen on-chain after the reveal screen appears, and the reveal updates when they land.

## 10. Lobby and bots (`rooms.js`, `agents/bots.js`)

- 8 seats, all bots until humans take them. Humans get a random free seat.
- Bots walk toward their advisor's target along the shortest path, up to 5 tiles per tick (`STEPS_PER_TICK`), roughly how far a human gets in one move window.
- Bots trust their advisor completely, so a bribed advisor misleads a bot exactly as it would a person.
