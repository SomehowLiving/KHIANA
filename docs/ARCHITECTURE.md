# Architecture

## The three apps

```
 client/  (Vite, :5173)        spectator/ (Vite, :5174)
   landing page, lobbies          full map, advisor channel,
   3D first-person game           ledger, end-of-game reveal
          │  WebSocket + HTTP            │
          └──────────────┬───────────────┘
                         ▼
              server/  (Node + Express, :8787)
     game engine · AI advisors · economy · x402 endpoints
             │                          │
             ▼                          ▼
     Groq / Anthropic API       Monad testnet (4 contracts)
```

- **client/**: the player's screen. `index.html` + `landing.js` is the lobby page; `play.html` + `main.js` is the game. `scene.js` renders the maze in Three.js, `character.js` builds the player figures, `audio.js` does sound.
- **spectator/**: the audience screen. One `main.js` that draws the whole board, the advisor channel and the reveal.
- **server/**: the authority. Every rule, every advisor and every payment lives here. Clients only send key presses and receive views.
- **contracts/**: Solidity, built and deployed with Hardhat.

## Server modules (`server/src/`)

| File | Job |
|---|---|
| `index.js` | Express + WebSocket server. HTTP routes, socket messages, starts the main room. |
| `config.js` | Every number in the game: timing, map size, economy, powerup prices, model settings. All overridable from `.env`. |
| `rooms.js` | Lobbies: room codes, seating humans, the host, auto-start, and the tick loop. |
| `game/engine.js` | The core: creates a game, runs each tick, settles payments, kills, win check, end of game. |
| `game/maze.js` | Maze generation, walkability, pathfinding (BFS). |
| `game/fog.js` | What each player can see, and the views sent to players and spectators. |
| `game/tasks.js` | The five tasks: placement, reveal schedule, completion checks. |
| `game/powerups.js` | Applies bought powerups for one tick, resolves conflicts and bounties. |
| `game/directions.js` | Turns a path into spoken directions ("turn left, then four steps"). |
| `agents/agent.js` | One advisor's turn: builds its context, calls the model or the scripted brain, parses actions. |
| `agents/prompts.js` | The prompts and the 8 personalities. |
| `agents/llm.js` | Calls Groq or Anthropic with a hard timeout; counts calls for `/proof`. |
| `agents/bots.js` | Moves players that have no human: follow the advisor's target. |
| `economy/ledger.js` | Every payment in a game, the end-of-game reveal, the payout split. |
| `economy/x402.js` | Settlement functions the engine calls (contact, bribe lock/release/refund, powerup, transfers). |
| `economy/x402-server.js` | The paid HTTP endpoints `/x402/contact`, `/x402/powerup`, `/x402/bribe`. |
| `economy/x402-client.js` | The advisor side of x402: request, read the 402, sign, retry. |
| `economy/credit.js` | KHIA token: signing EIP-3009 authorizations, balances. |
| `economy/stakes.js` | Staking advisors before a game and the on-chain payout after. |
| `economy/wallets.js` | Derives the engine + 8 advisor wallets, sends transactions. |
| `economy/roles.js` | Commit and reveal of the team assignments. |
| `economy/funding.js` | How much MON the engine needs (used by `npm run wallets` / `fund`). |
| `recording.js`, `playback.js` | Save a game and replay it to the spectator screen. |
| `headless.js` | Run a whole game as text in the terminal. |

## How data flows

**A player moves**
1. Client sends `{type: 'MOVE', dx, dy}` over the WebSocket.
2. Server checks it's the MOVE phase, the player is alive and not frozen, and the tile is walkable.
3. Server sends back a fresh **player view** (fog applied) and schedules a broadcast to everyone (at most ~15 per second).

**A tick runs** (every 15s, in `rooms.js` → `engine.runTick`)
1. All advisors think in parallel (model calls).
2. Their payments settle (on-chain if live).
3. Briefings go out.
4. 60% of the tick is the move window; then bots step and the server resolves tasks, kills, bounties and win.

**What each screen receives**
- **Player view** (`fog.playerView`): the maze layout, which tiles are lit right now, players on those tiles (team hidden unless it's you or a fellow Saboteur), the roster, your briefing, a compass bearing, your objective. Never the advisor channel or the ledger.
- **Spectator view** (`fog.spectatorView`): everything, including teams, the advisor channel, corrupted flags and the ledger.

Hidden information is removed **on the server**. It's never sent and hidden in CSS, because anyone could read it from the socket in devtools.

## HTTP routes

| Route | What |
|---|---|
| `GET /health` | Status: chain mode, whether the current game is on-chain, model status, tick. |
| `GET /proof` | Live evidence: model call counts, contract addresses, recent settlements with explorer links, powerups bought, each advisor's balance. |
| `GET /facilitator` | Whether the Monad x402 facilitator supports our network. |
| `GET /config` | Game settings for the clients. |
| `GET/POST /rooms`, `GET/DELETE /rooms/:code` | List, create, inspect, close lobbies. |
| `POST /game/start`, `/game/new`, `GET /game/reveal` | Start, reset, or get the end-of-game reveal (main table unless `room` is given). |
| `POST /x402/contact`, `/x402/powerup`, `/x402/bribe` | The paid endpoints advisors call. |

## WebSocket messages (client → server)

| Type | Meaning |
|---|---|
| `JOIN` | Take a seat (optionally rejoin with a saved token). |
| `SPECTATE` | Watch instead. |
| `SET_GOAL_WEIGHT` | Set your advisor's loyalty in the lobby. |
| `START` | Host starts the game. |
| `MOVE` | Move one tile (`dx`, `dy`) and report facing. |
| `FACE` | Report which way you're looking, so the advisor can say "turn left". |

## Rooms

- One room, `MAIN`, always exists. Others get a 4-letter code.
- The first human to join is the host. Empty seats are bots. A disconnect hands the seat back to a bot.
- A room auto-starts 90s after the first human joins (15s if full).
- **Only `MAIN` settles on-chain.** All rooms share the same 8 advisor wallets, so two live rooms would spend from the same balances.
