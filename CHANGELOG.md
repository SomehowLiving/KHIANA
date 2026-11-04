# Changelog

All notable changes to Khiana are recorded here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## MAINTENANCE PROTOCOL — read this before every commit

**This file must be updated on every codebase change. No exceptions.**

When working in Claude Code, treat a changelog entry as part of the change itself, not a follow-up task. A code edit without a changelog entry is an incomplete edit.

### Rules

1. Add entries under `## [Unreleased]` as you work.
2. Use these categories only: `Added`, `Changed`, `Fixed`, `Removed`, `Balance`, `Docs`.
3. **`Balance` is project-specific and mandatory for any economy change.** Record the old value, the new value, and the reason. Powerup pricing is the most fragile part of this game — an untracked price change is how the design silently breaks.
4. One line per change. Write what changed for a *player or a developer*, not what changed in the diff.
5. On release, move `[Unreleased]` into a versioned section with the date.
6. Reference the build phase in brackets where relevant: `[Phase 3]`.

### Good vs. bad entries

```
✅ Balance: Freeze 1.50 → 2.00 MON. Force was cheaper than bribery, which
   inverts the game's central thesis. [Phase 4]
❌ Balance: updated powerup costs

✅ Fixed: fog-of-war visibility was computed client-side, letting anyone
   read the full map from devtools. Now server-authoritative. [Phase 2]
❌ Fixed: fog bug
```

### Invariants to re-check after any `Balance` entry

See `docs/POWERUPS.md`. Briefly: bribery cheaper than Freeze; Audit dearer than a typical bribe; nobody affords more than 3 powerups per game; Reveal dearer than Lantern.

---

## [Unreleased]

### Added
- **Deployed.** Game on Vercel (https://khiana-gold.vercel.app), spectator on Vercel (https://khiana-spectator.vercel.app), server on Railway (root `server/`, health check `/health`). Steps in `docs/DEVELOPMENT.md`.
- **Gemini and OpenAI as model providers** (`LLM_PROVIDER=gemini|openai`), through the existing OpenAI-compatible client. `LLM_RPM` caps model calls per minute so a free tier's limit sends extra advisors to the scripted brain instead of to a 429. Failed calls now record why in `/health`. [Phase 9]
- **Paid tables with Connect Wallet.** A lobby can charge an entry fee in MON (0.01 or 0.1). Players connect their own browser wallet, pay into the new `KhianaPot` contract, and sign a message to claim their seat; the server checks both on chain before seating. Surviving paying winners split the pot; if none won, entrants are refunded. Anyone can force full refunds after the pot's deadline. `npm run pot:test`: 17/17 on Monad testnet. [Phase 9]
- **Platform revenue.** A 5% rake on paid-table pots (MON) and a 5% fee on every released bribe (KHIA), both to `TREASURY_ADDRESS` and capped at 20% in the contracts. [Phase 9]
- **4-player tables.** Each lobby chooses 4 or 8 seats when opened; the main table stays 8. A 4-seat game has 1 Saboteur, Saboteurs win at ≤1 Loyalist alive, 2 escape, CONVERGE needs 3 tiles, and the maze is 10×10. Staking and payout cover only the seats in play. Verified: a 4-seat game on Monad testnet passes `game:onchain` 11/11. [Phase 8]
- `npm run game:onchain` — plays a full bot game on chain, then proves the books balance: every ledger entry has a transaction, every escrow closed, supply fell by exactly what was burned, and every agent wallet equals the engine's balance to the unit. Wired into `khiana.sh verify`. [Phase 1]
- Agents are staked exactly `STARTING_MON` KHIA on chain before every live game, from the engine treasury (`economy/stakes.js`). Without this a second game started from whatever the first left behind. [Phase 1]
- The end-of-game payout now settles on chain, as signed agent-to-agent transfers computed in wei from on-chain balances. It previously happened in memory only. [Phase 1]
- `/health` and `/proof` report whether the current game is actually on chain, and `/proof` lists the engine's balance for every agent so anyone can check it against the token. [Phase 1]
- `KHIA_SUPPLY` (default 1000) sizes the treasury minted at deploy. [Phase 1]
- `server/integration.test.mjs` — spawns the server, connects a player and a spectator, asserts the information boundary, tears down. Run after any change to `fog.js` or `index.js`. **19/19 passing.** [Phase 0]

### Fixed
- Some models open briefings with a list marker ("0. Move forward…"); it is now stripped before the briefing reaches the player. [Phase 9]
- **Escrowed bribes were never released.** Nothing called `releaseEscrow`, so on chain every bribe sat in custody until it refunded to the payer, while the game credited the taker immediately. The engine now releases when the bought briefing goes out and refunds bribes that lapse undelivered; the taker is credited only on release. [Phase 1]
- **Failed payments still moved money in the game.** A contact fee or bribe whose transaction failed was booked anyway, so the ledger drifted from the chain. Balances are now reserved before a payment and restored if it fails. [Phase 1]
- **An LLM agent could take money that was never offered.** Accepts were executed exactly as the accepting agent wrote them: any payer, any amount. They must now match a real, unaccepted offer in the agent's inbox, on that offer's terms. Accepting a counter-offer also charged the wrong side; it now charges the agent that accepts. [Phase 1]
- **Bounty claims never reached the chain**, and the poster paid twice (the reward burned at posting, then paid again on claim). See Balance. [Phase 1]
- **Ticks could overlap.** The loop was a `setInterval` that fired whether or not the previous tick's settlement had finished. Each tick now completes before the next starts, with a full MOVE window. [Phase 1]
- **A busy tick could not settle within the tick.** The engine waited 1.5s and a receipt between every transaction. That gap guards native value sends; the engine sends only zero-value calls, so these are now pipelined with a locally tracked nonce that resyncs if another process shares the key. [Phase 1]
- **Every room settled on chain** with the same eight agent wallets. Only the main table does now; other lobbies play mocked. [Phase 1]
- **`CREDIT_ADDRESS` was missing** from `.env.example` and the deploy script's paste block, so live mode failed on its first payment. [Phase 1]
- **`npm run phase1` could pass against a mock server.** It never started a resource server of its own, so a MOCK_CHAIN dev server on the same port answered and every payment "confirmed" with no transaction. It now boots its own; its checks also measured native MON from before KHIA. The x402 client now refuses a mocked reply during a live settlement. [Phase 1]
- `npm run wallets` / `npm run fund` asked for 5.5 MON per agent. Agents only sign; only the engine needs MON. [Phase 1]
- **Player state packets did not include maze geometry**, so the client could never build the scene and rendered an empty world. `playerView` now sends `maze.tiles`. The layout isn't secret — a player standing in the maze would map it by walking — the secret is the `visible` set, which is still computed server-side. [Phase 2]
- **Eliminations never fired.** The witness check counted anyone who could see *either* the killer or the victim, so with eight players converging on shared task tiles there was always a witness somewhere and no kill ever resolved across four seeds. Now checks the victim's tile only: seeing a murder requires seeing the person being murdered. Also fixed the adjacency timer resetting on the first non-adjacent Loyalist in the loop rather than only when the saboteur is next to nobody. Verified: kills now occur on ~3 of 5 seeds. [Phase 2]
- Visibility is now computed once per tick and cached in `resolveEliminations` instead of twice per saboteur–victim pair. Bresenham sweeps are the hot path here. [Phase 2]

### Balance
- 4-player tables: maze 10×10. At 24×24 Loyalists won 8 of 10 seeds because one Saboteur rarely met anyone; at 10×10 it is 5 / 5, with most games reaching tick 31–40. [Phase 8]
- BOUNTY no longer burns. The reward (≥ 1.00) is set aside from the poster's balance when posted, paid to the claimant's agent on chain if delivered, and returned at game end if not. Previously the poster paid 2× the reward. [Phase 1]
- Token supply: fixed 40 → `KHIA_SUPPLY` (default 1000) minted once into the engine treasury, still with no mint. 40 staked exactly one game; burns left too little to stake a second. [Phase 1]
- **Bot movement 1 → 5 steps per tick (`STEPS_PER_TICK`).** A human gets the full 15-second MOVE window and covers several tiles; a bot taking one step under-moved by roughly 5x, so task tiles were never reached and every game stalled at 1/5 tasks forever. Tasks now land at 2–4 of 5. [Phase 8]
- **Saboteur bribe targets now offset by agent index.** Both saboteurs sorted Loyalists by loyalty and bribed the cheapest, so the same agent was bought every tick and the other five Loyalists were never pressured. Honoured betrayals went from 4 to 8 per game. [Phase 3]
- **AUDIT gated to once per agent per game, balance ≥ 3.0, staggered by tick.** Unchecked, every Loyalist audited every tick and the entire 40 MON supply burned before tick 20, which kills the negotiation layer. Burn is now ~10–15 of 40 MON. Audit must stay a painful once-or-twice-per-game decision. [Phase 4]

### Verified
- On a local Hardhat chain with 1s blocks: `game:onchain` 11/11 across consecutive bot games (re-staking from the previous game's leftovers each time), and a scripted-LLM game covering a lapsed bribe refunded on chain, a forged accept ignored, an inflated accept settled at the offered price, and a counter-offer paid by the right side. `x402` 22/22, `phase1` 22/22. Not yet run against Monad testnet.
- Balance across seeds 42, 7, 99, 2024, 555: tasks 2–4 of 5, wins split 2 Loyalist / 3 Saboteur, 10–15 MON burned per game.
- Client and spectator both build clean under Vite.
- Fog restricts a player to ~20 of 2401 tiles.
- Player state contains neither `channel` nor `ledger`.

---

## [0.1.0] — 2026-08-16

Initial scaffold.

### Added
- Monorepo structure: `server/`, `client/`, `spectator/`, `contracts/`, `docs/` [Phase 0]
- Express + WebSocket server, tick engine skeleton, health endpoint [Phase 0]
- Maze generation — recursive backtracker with loop carving [Phase 2]
- Server-authoritative fog of war, radius 3 [Phase 2]
- Task system: 5 types (Calibrate, Bridge, Sequence, Hold, Converge) [Phase 2]
- Elimination rule: adjacency, one full tick, no witnesses [Phase 2]
- Agent loop with two-goal weighting and deterministic fallback brain [Phase 3]
- Agent-to-agent messaging and bribe negotiation [Phase 3]
- 12 powerups with tick-boundary resolution [Phase 4]
- three.js isometric client with fog rendering and WASD movement [Phase 5]
- Spectator view: live agent channel, bribe ticker, treasury bars [Phase 6]
- Ledger reveal screen [Phase 7]
- Bot fill for empty seats [Phase 8]
- `MOCK_CHAIN` mode for offline development [Phase 8]
- Solidity: `KhianaEscrow`, `RoleCommit`, `PowerupShop` [Phase 1]
- x402 payment client with facilitator fallback [Phase 1]

### Docs
- `docs/PRD.md` — product requirements
- `docs/POWERUPS.md` — 12-item catalogue with balance invariants
- `docs/BUILD_PHASES.md` — nine phases with time budget
- `docs/DEMO_SCRIPT.md` — stage plan
- `CHANGELOG.md` — this file

### Known gaps
- x402 settlement path is **unverified against live Monad testnet**. Built to spec from the docs, runs in mock mode. Phase 1 exists to validate it — do that first.
- Contracts compile but are untested. No test suite.
- Agent prompts are first-draft and will need tuning for personality distinctness.
